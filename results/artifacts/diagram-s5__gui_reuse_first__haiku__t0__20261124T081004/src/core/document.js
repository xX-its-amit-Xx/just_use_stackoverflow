import { DiagramError } from './errors.js';
import { SHAPE_TYPES, CONNECTOR, clone, cmpTs, cmpStr, isNum, randomId, sortObj } from './util.js';
import { aabbOf, boxToRect, containsPoint } from './geometry.js';
import { routeConnector } from './route.js';
import { layeredLayout, gridLayout } from './layout.js';
import { renderSVG } from './svg.js';

export const DEFAULT_LAYER = 'default';
const MAX_HISTORY = 500;
const SHAPE_NUMERIC = ['x', 'y', 'width', 'height', 'rotation'];
const STANDARD_EL = ['id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'style', 'text', 'layer', 'groupId', 'z'];
const STANDARD_CN = ['id', 'type', 'source', 'target', 'routing', 'waypoints', 'label', 'style', 'layer', 'groupId', 'z'];
const STANDARD_LY = ['id', 'name', 'visible', 'locked', 'order'];

/*
 * Replicated document.
 *
 * State is a set of last-writer-wins registers, one per (kind, entity id, field).
 * A write is {k: 'el'|'ly', id, f, v, t: [lamport, actor]}. Every local operation is
 * compiled to concrete writes (e.g. a move becomes absolute x/y writes) and emitted as an
 * envelope {id, actor, lamport, writes}. Because every replica resolves each register by
 * the maximum timestamp, replicas that hold the same set of envelopes converge regardless
 * of arrival order. Deletion is an `alive` register, so remove beats concurrent updates.
 */
export class Document {
  constructor({ id, actor } = {}) {
    this.id = String(id ?? randomId('doc-'));
    this.actor = String(actor ?? 'anon');
    this._clock = 0;
    this._ents = { el: new Map(), ly: new Map() };
    this._listeners = new Map();
    this._pending = [];
    this._seen = new Set();
    this._undo = [];
    this._redo = [];
    this._tx = null;
    this._noRecord = false;
  }

  // ---------- events ----------
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
    return () => {
      const arr = this._listeners.get(event);
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  _emit(event, payload) {
    for (const cb of this._listeners.get(event) || []) cb(payload);
  }

  // ---------- low-level register store ----------
  _cur(k, id, f) {
    const e = this._ents[k].get(id);
    return e ? e.get(f) : undefined;
  }

  _applyWrite(w) {
    let ent = this._ents[w.k].get(w.id);
    if (!ent) {
      ent = new Map();
      this._ents[w.k].set(w.id, ent);
    }
    const cur = ent.get(w.f);
    if (!cur || cmpTs(w.t, cur.t) > 0) ent.set(w.f, { v: w.v, t: w.t });
  }

  _bootstrap(k, id, fields) {
    const ent = new Map();
    for (const [f, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined) ent.set(f, { v: clone(v), t: [0, ''] });
    }
    ent.set('alive', { v: true, t: [0, ''] });
    this._ents[k].set(id, ent);
  }

  _isAlive(k, id) {
    const ent = this._ents[k].get(id);
    const a = ent && ent.get('alive');
    return !!(a && a.v === true);
  }

  // Compile planned writes into one local envelope, apply it and record history.
  _commit(planned) {
    if (!planned.length) return null;
    const lamport = ++this._clock;
    const writes = planned.map(p => {
      const cur = this._cur(p.k, p.id, p.f);
      return {
        k: p.k,
        id: p.id,
        f: p.f,
        v: p.v === undefined ? null : clone(p.v),
        before: cur && cur.v !== undefined ? clone(cur.v) : null,
      };
    });
    const env = {
      id: `${this.actor}@${lamport}`,
      actor: this.actor,
      lamport,
      writes: writes.map(w => ({ k: w.k, id: w.id, f: w.f, v: clone(w.v), t: [lamport, this.actor] })),
    };
    for (const w of env.writes) this._applyWrite(w);
    this._seen.add(env.id);
    this._pending.push(env);
    this._record(writes.map(w => ({ k: w.k, id: w.id, f: w.f, before: w.before, after: w.v })));
    this._emit('op', env);
    return env;
  }

  // ---------- history ----------
  _record(list) {
    if (this._noRecord || !list.length) return;
    if (this._tx) {
      this._tx.push(...list);
      return;
    }
    this._pushUndo(list);
  }

  _pushUndo(list) {
    const merged = mergeSteps(list);
    if (!merged.length) return;
    this._undo.push(merged);
    if (this._undo.length > MAX_HISTORY) this._undo.shift();
    this._redo = [];
  }

  transaction(fn) {
    if (this._tx) return fn(this);
    this._tx = [];
    let result;
    try {
      result = fn(this);
    } catch (err) {
      const steps = this._tx;
      this._tx = null;
      const merged = mergeSteps(steps);
      if (merged.length) {
        const prev = this._noRecord;
        this._noRecord = true;
        try {
          this._commit(merged.map(w => ({ k: w.k, id: w.id, f: w.f, v: w.before })));
        } finally {
          this._noRecord = prev;
        }
      }
      throw err;
    }
    const steps = this._tx;
    this._tx = null;
    this._pushUndo(steps);
    return result;
  }

  undo() {
    const step = this._undo.pop();
    if (!step) return false;
    this._noRecord = true;
    try {
      this._commit(step.map(w => ({ k: w.k, id: w.id, f: w.f, v: w.before })));
    } finally {
      this._noRecord = false;
    }
    this._redo.push(step);
    return true;
  }

  redo() {
    const step = this._redo.pop();
    if (!step) return false;
    this._noRecord = true;
    try {
      this._commit(step.map(w => ({ k: w.k, id: w.id, f: w.f, v: w.after })));
    } finally {
      this._noRecord = false;
    }
    this._undo.push(step);
    return true;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  // ---------- collaboration ----------
  pendingOps() {
    const out = this._pending;
    this._pending = [];
    return out;
  }

  receive(remoteOps) {
    const list = Array.isArray(remoteOps) ? remoteOps : [remoteOps];
    for (const env of list) {
      if (!env || typeof env.id !== 'string' || !Array.isArray(env.writes) || !isNum(env.lamport)) {
        throw new DiagramError('invalid remote operation');
      }
      for (const w of env.writes) {
        if (!w || (w.k !== 'el' && w.k !== 'ly') || typeof w.id !== 'string' || typeof w.f !== 'string') {
          throw new DiagramError('invalid remote write');
        }
      }
    }
    for (const env of list) {
      if (this._seen.has(env.id)) continue;
      this._seen.add(env.id);
      this._clock = Math.max(this._clock, env.lamport);
      const actor = String(env.actor ?? '');
      for (const w of env.writes) {
        this._applyWrite({ k: w.k, id: w.id, f: w.f, v: w.v === undefined ? null : w.v, t: [env.lamport, actor] });
      }
    }
  }

  // ---------- reads ----------
  _layerOrder() {
    const m = new Map();
    for (const [id] of this._ents.ly) {
      const l = this._materializeLayer(id);
      if (l) m.set(id, l.order);
    }
    return m;
  }

  _materializeLayer(id) {
    if (!this._isAlive('ly', id)) return undefined;
    const ent = this._ents.ly.get(id);
    const raw = {};
    for (const [f, { v }] of ent) {
      if (f === 'alive' || v === null || v === undefined) continue;
      raw[f] = v;
    }
    const out = {
      id,
      name: raw.name ?? id,
      visible: raw.visible !== false,
      locked: raw.locked === true,
      order: isNum(raw.order) ? raw.order : 0,
    };
    for (const k of Object.keys(raw).sort()) if (!STANDARD_LY.includes(k)) out[k] = clone(raw[k]);
    return out;
  }

  _endpointLive(ep) {
    return !!(ep && typeof ep.elementId === 'string' && this._isAlive('el', ep.elementId) &&
      this._raw(ep.elementId).type !== CONNECTOR);
  }

  _raw(id) {
    const ent = this._ents.el.get(id);
    const raw = {};
    if (!ent) return raw;
    for (const [f, { v }] of ent) {
      if (f === 'alive' || v === null || v === undefined) continue;
      raw[f] = v;
    }
    return raw;
  }

  _materialize(id) {
    if (!this._isAlive('el', id)) return undefined;
    const ent = this._ents.el.get(id);
    const raw = {};
    const style = {};
    for (const [f, { v }] of ent) {
      if (f === 'alive' || v === null || v === undefined) continue;
      if (f.startsWith('style.')) style[f.slice(6)] = v;
      else raw[f] = v;
    }
    if (!raw.type) return undefined;
    let out;
    if (raw.type === CONNECTOR) {
      if (!this._endpointLive(raw.source) || !this._endpointLive(raw.target)) return undefined;
      out = {
        id,
        type: CONNECTOR,
        source: clone(raw.source),
        target: clone(raw.target),
        routing: raw.routing ?? 'straight',
        waypoints: clone(raw.waypoints ?? []),
        label: raw.label ?? '',
        style: sortObj(style),
        layer: raw.layer ?? DEFAULT_LAYER,
        groupId: raw.groupId ?? null,
        z: isNum(raw.z) ? raw.z : 0,
      };
    } else {
      out = {
        id,
        type: raw.type,
        x: isNum(raw.x) ? raw.x : 0,
        y: isNum(raw.y) ? raw.y : 0,
        width: isNum(raw.width) ? raw.width : 0,
        height: isNum(raw.height) ? raw.height : 0,
        rotation: isNum(raw.rotation) ? raw.rotation : 0,
        style: sortObj(style),
        text: raw.text ?? '',
        layer: raw.layer ?? DEFAULT_LAYER,
        groupId: raw.groupId ?? null,
        z: isNum(raw.z) ? raw.z : 0,
      };
    }
    for (const k of Object.keys(raw).sort()) {
      if (!STANDARD_EL.includes(k) && !STANDARD_CN.includes(k) && !(k in out)) out[k] = clone(raw[k]);
    }
    return out;
  }

  _allIds(kind) {
    return [...this._ents[kind].keys()];
  }

  get(id) {
    return this._materialize(String(id));
  }

  layers() {
    return this._allIds('ly')
      .map(id => this._materializeLayer(id))
      .filter(Boolean)
      .sort((a, b) => a.order - b.order || cmpStr(a.id, b.id));
  }

  getLayer(id) {
    return this._materializeLayer(String(id));
  }

  elements(filter = {}) {
    const lorder = this._layerOrder();
    const list = this._allIds('el')
      .map(id => this._materialize(id))
      .filter(Boolean)
      .filter(el => filter.layer === undefined || el.layer === filter.layer)
      .filter(el => filter.type === undefined || el.type === filter.type);
    list.sort((a, b) =>
      (lorder.get(a.layer) ?? 0) - (lorder.get(b.layer) ?? 0) || a.z - b.z || cmpStr(a.id, b.id));
    return list;
  }

  _visibleShapes() {
    const lay = new Map(this.layers().map(l => [l.id, l]));
    return this.elements().filter(el => el.type !== CONNECTOR && lay.get(el.layer)?.visible);
  }

  hitTest(x, y) {
    const shapes = this._visibleShapes();
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (containsPoint(shapes[i], x, y)) return shapes[i];
    }
    return null;
  }

  select(rect) {
    const r = normalizeRect(rect);
    return this._visibleShapes().filter(el => {
      const b = aabbOf(el);
      return b.left >= r.x && b.top >= r.y && b.right <= r.x + r.width && b.bottom <= r.y + r.height;
    });
  }

  bounds(ids) {
    let list;
    if (ids === undefined) list = this._visibleShapes();
    else list = this._requireMany(ids);
    const boxes = [];
    for (const el of list) {
      if (el.type === CONNECTOR) {
        for (const p of this.route(el.id)) boxes.push({ left: p[0], top: p[1], right: p[0], bottom: p[1] });
      } else {
        boxes.push(aabbOf(el));
      }
    }
    if (!boxes.length) return null;
    return boxToRect(unionBoxes(boxes));
  }

  // ---------- routing ----------
  route(id) {
    const c = this._materialize(String(id));
    if (!c || c.type !== CONNECTOR) throw new DiagramError(`unknown connector: ${id}`);
    const s = this._materialize(c.source.elementId);
    const t = this._materialize(c.target.elementId);
    if (!s || !t) throw new DiagramError(`connector ${id} has missing endpoints`);
    const shapes = this._visibleOrAllShapes();
    return routeConnector({ connector: c, source: s, target: t, shapes });
  }

  _visibleOrAllShapes() {
    return this.elements().filter(el => el.type !== CONNECTOR);
  }

  // ---------- geometry helpers (undoable) ----------
  align(ids, mode) {
    const valid = ['left', 'center', 'right', 'top', 'middle', 'bottom'];
    if (!valid.includes(mode)) throw new DiagramError(`unknown alignment: ${mode}`);
    const list = this._requireMany(ids).filter(el => el.type !== CONNECTOR);
    if (!list.length) return this;
    const items = list.map(el => ({ el, box: aabbOf(el) }));
    const minL = Math.min(...items.map(i => i.box.left));
    const maxR = Math.max(...items.map(i => i.box.right));
    const minT = Math.min(...items.map(i => i.box.top));
    const maxB = Math.max(...items.map(i => i.box.bottom));
    const cx = (minL + maxR) / 2;
    const cy = (minT + maxB) / 2;
    this.transaction(() => {
      for (const { el, box } of items) {
        let dx = 0, dy = 0;
        switch (mode) {
          case 'left': dx = minL - box.left; break;
          case 'right': dx = maxR - box.right; break;
          case 'center': dx = cx - (box.left + box.right) / 2; break;
          case 'top': dy = minT - box.top; break;
          case 'bottom': dy = maxB - box.bottom; break;
          case 'middle': dy = cy - (box.top + box.bottom) / 2; break;
        }
        if (dx || dy) this.apply({ type: 'move', ids: [el.id], dx, dy });
      }
    });
    return this;
  }

  distribute(ids, axis) {
    if (axis !== 'horizontal' && axis !== 'vertical') throw new DiagramError(`unknown axis: ${axis}`);
    const list = this._requireMany(ids).filter(el => el.type !== CONNECTOR);
    if (list.length < 3) return this;
    const h = axis === 'horizontal';
    const items = list.map(el => {
      const b = aabbOf(el);
      return { el, a: h ? b.left : b.top, b: h ? b.right : b.bottom, size: h ? b.right - b.left : b.bottom - b.top, box: b };
    }).sort((p, q) => p.a - q.a || cmpStr(p.el.id, q.el.id));
    const first = items[0];
    const last = items[items.length - 1];
    const middle = items.slice(1, -1);
    const W = middle.reduce((s, it) => s + it.size, 0);
    const gap = (last.a - first.b - W) / (items.length - 1);
    this.transaction(() => {
      let cur = first.b + gap;
      for (const it of middle) {
        const delta = cur - it.a;
        if (delta) this.apply({ type: 'move', ids: [it.el.id], dx: h ? delta : 0, dy: h ? 0 : delta });
        cur += it.size + gap;
      }
    });
    return this;
  }

  layout(kind, opts = {}) {
    if (kind === 'layered') {
      const shapes = this.elements().filter(el => el.type !== CONNECTOR);
      const ids = new Set(shapes.map(s => s.id));
      const edges = this.elements()
        .filter(el => el.type === CONNECTOR && ids.has(el.source.elementId) && ids.has(el.target.elementId))
        .map(c => ({ v: c.source.elementId, w: c.target.elementId }));
      const pos = layeredLayout(
        shapes.map(s => ({ id: s.id, width: s.width, height: s.height })),
        edges,
        { direction: opts.direction === 'LR' ? 'LR' : 'TB', spacing: isNum(opts.spacing) ? opts.spacing : 50 },
      );
      this._applyPositions(shapes, pos);
    } else if (kind === 'grid') {
      const shapes = this.elements().filter(el => el.type !== CONNECTOR);
      const pos = gridLayout(
        shapes.map(s => ({ id: s.id, width: s.width, height: s.height })),
        { spacing: isNum(opts.spacing) ? opts.spacing : 40 },
      );
      this._applyPositions(shapes, pos);
    } else {
      throw new DiagramError(`unknown layout: ${kind}`);
    }
    return this;
  }

  _applyPositions(shapes, pos) {
    this.transaction(() => {
      for (const s of shapes) {
        const p = pos.get(s.id);
        if (p && (p.x !== s.x || p.y !== s.y)) this.apply({ type: 'update', id: s.id, patch: { x: p.x, y: p.y } });
      }
    });
  }

  // ---------- serialization ----------
  toJSON() {
    return { id: this.id, layers: this.layers(), elements: this.elements() };
  }

  toSVG(opts = {}) {
    return renderSVG(this, opts);
  }

  // Make this replica's state equal `json` with a single undoable local operation.
  restore(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const planned = [];
    const wantLayers = new Map((data.layers || []).map(l => [l.id, l]));
    const wantEls = new Map((data.elements || []).map(e => [e.id, e]));
    for (const id of this._allIds('ly')) {
      if (!this._isAlive('ly', id) && !wantLayers.has(id)) continue;
      if (!wantLayers.has(id)) planned.push({ k: 'ly', id, f: 'alive', v: false });
    }
    for (const [id, l] of wantLayers) {
      const fields = flattenFields(l, STANDARD_LY);
      planned.push(...this._fieldWrites('ly', id, fields));
      planned.push({ k: 'ly', id, f: 'alive', v: true });
    }
    for (const id of this._allIds('el')) {
      if (this._isAlive('el', id) && !wantEls.has(id)) planned.push({ k: 'el', id, f: 'alive', v: false });
    }
    for (const [id, e] of wantEls) {
      planned.push(...this._fieldWrites('el', id, flattenElement(e)));
      planned.push({ k: 'el', id, f: 'alive', v: true });
    }
    this._commit(planned);
    return this;
  }

  // Writes setting `fields` on an entity and nulling any live field not present in `fields`.
  _fieldWrites(k, id, fields) {
    const out = [];
    const ent = this._ents[k].get(id);
    if (ent) {
      for (const [f, { v }] of ent) {
        if (f === 'alive' || v === null || v === undefined) continue;
        if (!(f in fields)) out.push({ k, id, f, v: null });
      }
    }
    for (const [f, v] of Object.entries(fields)) out.push({ k, id, f, v: v === undefined ? null : v });
    return out;
  }

  // ---------- operations ----------
  apply(op) {
    const planned = this._plan(op);
    if (planned.length) this._commit(planned);
    return this;
  }

  _plan(op) {
    if (!op || typeof op !== 'object') throw new DiagramError('invalid operation');
    switch (op.type) {
      case 'add': return this._planAdd(op.element);
      case 'update': return this._planUpdate(op);
      case 'remove': return this._planRemove(op.id);
      case 'move': return this._planMove(op);
      case 'resize': return this._planResize(op);
      case 'rotate': return this._planRotate(op);
      case 'group': return this._planGroup(op);
      case 'ungroup': return this._planUngroup(op);
      case 'reorder': return this._planReorder(op);
      case 'addLayer': return this._planAddLayer(op);
      case 'updateLayer': return this._planUpdateLayer(op);
      case 'removeLayer': return this._planRemoveLayer(op);
      case 'setStyle': return this._planSetStyle(op);
      default:
        throw new DiagramError(`unknown operation type: ${op.type}`);
    }
  }

  _requireElement(id) {
    const el = this._materialize(String(id));
    if (!el) throw new DiagramError(`unknown element: ${id}`);
    return el;
  }

  _requireMany(ids) {
    const arr = Array.isArray(ids) ? ids : [ids];
    const seen = new Set();
    const out = [];
    for (const id of arr) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      out.push(this._requireElement(id));
    }
    return out;
  }

  _requireLayer(id) {
    const l = this._materializeLayer(String(id));
    if (!l) throw new DiagramError(`unknown layer: ${id}`);
    return l;
  }

  _assertLayerEditable(layerId) {
    const l = this._requireLayer(layerId);
    if (l.locked) throw new DiagramError(`layer is locked: ${l.id}`);
  }

  _assertEditable(el) {
    this._assertLayerEditable(el.layer);
  }

  _nextZ(layerId) {
    let max = null;
    for (const id of this._allIds('el')) {
      const e = this._materialize(id);
      if (e && e.layer === layerId && (max === null || e.z > max)) max = e.z;
    }
    return max === null ? 0 : max + 1;
  }

  _normalizeEndpoint(ep) {
    if (!ep || typeof ep !== 'object' || typeof ep.elementId !== 'string') {
      throw new DiagramError('connector endpoint requires elementId');
    }
    const target = this._materialize(ep.elementId);
    if (!target || target.type === CONNECTOR) throw new DiagramError(`unknown element: ${ep.elementId}`);
    const out = { elementId: ep.elementId };
    if (ep.port !== undefined && ep.port !== null) out.port = String(ep.port);
    return out;
  }

  _normalizeWaypoints(wps) {
    if (wps === undefined || wps === null) return [];
    if (!Array.isArray(wps)) throw new DiagramError('waypoints must be an array');
    return wps.map(p => {
      const pt = Array.isArray(p) ? p : [p && p.x, p && p.y];
      if (!isNum(pt[0]) || !isNum(pt[1])) throw new DiagramError('invalid waypoint');
      return [pt[0], pt[1]];
    });
  }

  _planAdd(input) {
    if (!input || typeof input !== 'object') throw new DiagramError('add requires an element');
    const type = input.type;
    const isConn = type === CONNECTOR;
    if (!isConn && !SHAPE_TYPES.includes(type)) throw new DiagramError(`unknown element type: ${type}`);
    const id = input.id !== undefined && input.id !== null ? String(input.id) : randomId('e-');
    if (this._isAlive('el', id)) throw new DiagramError(`duplicate element id: ${id}`);
    const layer = input.layer !== undefined ? String(input.layer) : DEFAULT_LAYER;
    this._assertLayerEditable(layer);
    const z = isNum(input.z) ? input.z : this._nextZ(layer);
    const base = { type, layer, groupId: input.groupId ?? null, z };
    if (isConn) {
      base.source = this._normalizeEndpoint(input.source);
      base.target = this._normalizeEndpoint(input.target);
      if (base.source.elementId === id || base.target.elementId === id) throw new DiagramError('connector cannot attach to itself');
      const routing = input.routing ?? 'straight';
      if (routing !== 'straight' && routing !== 'orthogonal') throw new DiagramError(`unknown routing: ${routing}`);
      base.routing = routing;
      base.waypoints = this._normalizeWaypoints(input.waypoints);
      base.label = input.label ?? '';
      base.style = input.style ?? {};
    } else {
      for (const k of SHAPE_NUMERIC) {
        const v = input[k];
        if (v !== undefined && v !== null && !isNum(v)) throw new DiagramError(`${k} must be a number`);
        base[k] = v ?? 0;
      }
      base.text = input.text ?? '';
      base.style = input.style ?? {};
    }
    if (typeof base.style !== 'object' || Array.isArray(base.style)) throw new DiagramError('style must be an object');
    for (const k of Object.keys(input)) {
      if (k !== 'id' && !(k in base)) base[k] = clone(input[k]);
    }
    const fields = flattenElement(base);
    const planned = this._fieldWrites('el', id, fields);
    planned.push({ k: 'el', id, f: 'alive', v: true });
    return planned.map(p => ({ ...p, id }));
  }

  _planUpdate(op) {
    const cur = this._requireElement(op.id);
    this._assertEditable(cur);
    const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
    const planned = [];
    for (const [f, raw] of Object.entries(patch)) {
      if (f === 'id' || f === 'alive') continue;
      if (f === 'type') {
        if (raw !== cur.type) throw new DiagramError('cannot change element type');
        continue;
      }
      if (f === 'style') {
        if (!raw || typeof raw !== 'object') throw new DiagramError('style must be an object');
        for (const [sk, sv] of Object.entries(raw)) planned.push({ k: 'el', id: cur.id, f: `style.${sk}`, v: sv ?? null });
        continue;
      }
      let v = raw;
      if (f === 'layer') this._assertLayerEditable(raw);
      if (f === 'source' || f === 'target') {
        if (cur.type !== CONNECTOR) throw new DiagramError(`${f} only applies to connectors`);
        v = this._normalizeEndpoint(raw);
      }
      if (f === 'waypoints') v = this._normalizeWaypoints(raw);
      if ((SHAPE_NUMERIC.includes(f) || f === 'z') && v !== null && !isNum(v)) throw new DiagramError(`${f} must be a number`);
      planned.push({ k: 'el', id: cur.id, f, v: v === undefined ? null : v });
    }
    return planned;
  }

  _planRemove(rawId) {
    const el = this._requireElement(rawId);
    this._assertEditable(el);
    const planned = [{ k: 'el', id: el.id, f: 'alive', v: false }];
    if (el.type !== CONNECTOR) {
      for (const c of this.elements().filter(e => e.type === CONNECTOR)) {
        if (c.source.elementId === el.id || c.target.elementId === el.id) {
          this._assertEditable(c);
          planned.push({ k: 'el', id: c.id, f: 'alive', v: false });
        }
      }
    }
    return planned;
  }

  _planMove(op) {
    const dx = op.dx ?? 0, dy = op.dy ?? 0;
    if (!isNum(dx) || !isNum(dy)) throw new DiagramError('move requires numeric dx, dy');
    const planned = [];
    for (const el of this._requireMany(op.ids)) {
      this._assertEditable(el);
      if (el.type === CONNECTOR) {
        if (el.waypoints.length) {
          planned.push({ k: 'el', id: el.id, f: 'waypoints', v: el.waypoints.map(([x, y]) => [x + dx, y + dy]) });
        }
      } else {
        planned.push({ k: 'el', id: el.id, f: 'x', v: el.x + dx });
        planned.push({ k: 'el', id: el.id, f: 'y', v: el.y + dy });
      }
    }
    return planned;
  }

  _planResize(op) {
    const el = this._requireElement(op.id);
    if (el.type === CONNECTOR) throw new DiagramError('connectors cannot be resized');
    this._assertEditable(el);
    const b = op.box;
    if (!b || !isNum(b.x) || !isNum(b.y) || !isNum(b.width) || !isNum(b.height)) throw new DiagramError('resize requires a numeric box');
    if (b.width < 0 || b.height < 0) throw new DiagramError('box size must be non-negative');
    let w = b.width, h = b.height;
    if (op.keepAspect && el.width > 0 && el.height > 0) {
      const s = Math.min(b.width / el.width, b.height / el.height);
      w = el.width * s;
      h = el.height * s;
    }
    return [
      { k: 'el', id: el.id, f: 'x', v: b.x },
      { k: 'el', id: el.id, f: 'y', v: b.y },
      { k: 'el', id: el.id, f: 'width', v: w },
      { k: 'el', id: el.id, f: 'height', v: h },
    ];
  }

  _planRotate(op) {
    const el = this._requireElement(op.id);
    if (el.type === CONNECTOR) throw new DiagramError('connectors cannot be rotated');
    this._assertEditable(el);
    if (!isNum(op.deg)) throw new DiagramError('rotate requires numeric deg');
    return [{ k: 'el', id: el.id, f: 'rotation', v: op.deg }];
  }

  _planGroup(op) {
    const members = this._requireMany(op.ids);
    const groupId = op.groupId !== undefined && op.groupId !== null ? String(op.groupId) : randomId('g-');
    const planned = [];
    for (const el of members) {
      this._assertEditable(el);
      planned.push({ k: 'el', id: el.id, f: 'groupId', v: groupId });
    }
    return planned;
  }

  _planUngroup(op) {
    const gid = String(op.groupId);
    const members = this.elements().filter(el => el.groupId === gid);
    if (!members.length) throw new DiagramError(`unknown group: ${gid}`);
    const planned = [];
    for (const el of members) {
      this._assertEditable(el);
      planned.push({ k: 'el', id: el.id, f: 'groupId', v: null });
    }
    return planned;
  }

  _planReorder(op) {
    const el = this._requireElement(op.id);
    this._assertEditable(el);
    const sibs = this.elements().filter(e => e.layer === el.layer);
    sibs.sort((a, b) => a.z - b.z || cmpStr(a.id, b.id));
    const i = sibs.findIndex(e => e.id === el.id);
    let z;
    switch (op.to) {
      case 'front': z = sibs[sibs.length - 1].z + 1; break;
      case 'back': z = sibs[0].z - 1; break;
      case 'forward': {
        if (i + 1 >= sibs.length) { z = el.z; break; }
        const above = sibs[i + 1];
        const next = sibs[i + 2];
        z = next ? (above.z + next.z) / 2 : above.z + 1;
        break;
      }
      case 'backward': {
        if (i - 1 < 0) { z = el.z; break; }
        const below = sibs[i - 1];
        const prev = sibs[i - 2];
        z = prev ? (below.z + prev.z) / 2 : below.z - 1;
        break;
      }
      default:
        throw new DiagramError(`unknown reorder target: ${op.to}`);
    }
    return [{ k: 'el', id: el.id, f: 'z', v: z }];
  }

  _planAddLayer(op) {
    const input = op.layer;
    if (!input || typeof input !== 'object') throw new DiagramError('addLayer requires a layer');
    const id = input.id !== undefined ? String(input.id) : randomId('l-');
    if (this._isAlive('ly', id)) throw new DiagramError(`duplicate layer id: ${id}`);
    const orders = this.layers().map(l => l.order);
    const order = isNum(input.order) ? input.order : (orders.length ? Math.max(...orders) + 1 : 0);
    const fields = {
      name: input.name ?? id,
      visible: input.visible !== false,
      locked: input.locked === true,
      order,
    };
    for (const [k, v] of Object.entries(input)) if (!(k in fields) && k !== 'id') fields[k] = clone(v);
    const planned = this._fieldWrites('ly', id, fields).map(p => ({ ...p, id }));
    planned.push({ k: 'ly', id, f: 'alive', v: true });
    return planned;
  }

  _planUpdateLayer(op) {
    const l = this._requireLayer(op.id);
    const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
    const planned = [];
    for (const [f, v] of Object.entries(patch)) {
      if (f === 'id' || f === 'alive') continue;
      if (f === 'order' && !isNum(v)) throw new DiagramError('order must be a number');
      planned.push({ k: 'ly', id: l.id, f, v: v === undefined ? null : v });
    }
    return planned;
  }

  _planRemoveLayer(op) {
    const l = this._requireLayer(op.id);
    if (this.layers().length <= 1) throw new DiagramError('cannot remove the last layer');
    if (l.locked) throw new DiagramError(`layer is locked: ${l.id}`);
    const dead = new Set(this.elements().filter(e => e.layer === l.id).map(e => e.id));
    for (const c of this.elements().filter(e => e.type === CONNECTOR)) {
      if (dead.has(c.source.elementId) || dead.has(c.target.elementId)) dead.add(c.id);
    }
    const planned = [{ k: 'ly', id: l.id, f: 'alive', v: false }];
    for (const id of dead) planned.push({ k: 'el', id, f: 'alive', v: false });
    return planned;
  }

  _planSetStyle(op) {
    if (!op.style || typeof op.style !== 'object') throw new DiagramError('setStyle requires a style object');
    const planned = [];
    for (const el of this._requireMany(op.ids)) {
      this._assertEditable(el);
      for (const [sk, sv] of Object.entries(op.style)) {
        planned.push({ k: 'el', id: el.id, f: `style.${sk}`, v: sv ?? null });
      }
    }
    return planned;
  }
}

function normalizeRect(r) {
  if (!r) throw new DiagramError('rect required');
  const x = r.x ?? r.left ?? 0;
  const y = r.y ?? r.top ?? 0;
  const width = r.width ?? ((r.right ?? x) - x);
  const height = r.height ?? ((r.bottom ?? y) - y);
  return { x, y, width, height };
}

function unionBoxes(boxes) {
  return boxes.reduce((u, b) => ({
    left: Math.min(u.left, b.left),
    top: Math.min(u.top, b.top),
    right: Math.max(u.right, b.right),
    bottom: Math.max(u.bottom, b.bottom),
  }));
}

function mergeSteps(list) {
  const merged = new Map();
  for (const w of list) {
    const key = `${w.k}\u0000${w.id}\u0000${w.f}`;
    const m = merged.get(key);
    if (m) m.after = w.after;
    else merged.set(key, { k: w.k, id: w.id, f: w.f, before: w.before, after: w.after });
  }
  return [...merged.values()];
}

function flattenElement(e) {
  const out = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id') continue;
    if (k === 'style') {
      for (const [sk, sv] of Object.entries(v || {})) out[`style.${sk}`] = sv;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function flattenFields(obj, known) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (k !== 'id') out[k] = v;
  return out;
}

export function fromJSON(json, opts = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || typeof data !== 'object') throw new DiagramError('invalid document JSON');
  const doc = new Document({ id: data.id ?? opts.id, actor: opts.actor ?? 'local' });
  for (const l of data.layers || []) {
    doc._bootstrap('ly', String(l.id), flattenFields(l));
  }
  if (!(data.layers || []).length) {
    doc._bootstrap('ly', DEFAULT_LAYER, { name: 'Layer 1', visible: true, locked: false, order: 0 });
  }
  for (const e of data.elements || []) {
    if (!e || typeof e.id !== 'string' || !(e.type === CONNECTOR || SHAPE_TYPES.includes(e.type))) {
      throw new DiagramError('invalid element in JSON');
    }
    doc._bootstrap('el', e.id, flattenElement(e));
  }
  return doc;
}

export function createDocument(opts = {}) {
  const doc = new Document(opts);
  doc._bootstrap('ly', DEFAULT_LAYER, { name: 'Layer 1', visible: true, locked: false, order: 0 });
  return doc;
}
