// Diagram document: CRDT state, operations, history, queries, layout and
// serialization. Every public operation is compiled at its origin into
// absolute "writes" (register assignments stamped with a Lamport clock and the
// actor id). Writes are last-writer-wins per register and remove-wins for
// lifecycle, so replicas that hold the same set of batches converge.
import dagre from '../vendor/dagre.esm.js';
import { generateKeyBetween } from '../vendor/fractional-indexing.js';
import { DiagramError } from './errors.js';
import { aabb, boundaryToward, centerOf, orthogonalRoute, portPoint, sideAnchor, containsPoint } from './geometry.js';

export const SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);
export const DEFAULT_LAYER = 'default';
const HISTORY_LIMIT = 500;

const randomUUID = () => globalThis.crypto.randomUUID();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const newId = (prefix) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

// Stamps are [lamportClock, actorId]; compare lexicographically; null is lowest.
function cmpStamp(a, b) {
  if (a === b) return 0;
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

// Keeps the fractional key ordering valid when two keys are equal or inverted.
function between(a, b) {
  if (a != null && b != null && a >= b) b = null;
  return generateKeyBetween(a ?? null, b ?? null);
}

export class Document {
  constructor({ id, actor } = {}) {
    this.id = id ?? newId('doc');
    this.actor = actor ?? randomUUID();
    this._ents = new Map(); // id -> { kind, created, removed, f: Map<prop, {v, t}> }
    this._clock = 0;
    this._batchN = 0;
    this._seen = new Set();
    this._pending = [];
    this._listeners = { op: [], change: [] };
    this._undo = [];
    this._redo = [];
    this._tx = null;
    // The default layer exists at the origin stamp so every replica starts identical.
    this._ents.set(DEFAULT_LAYER, {
      kind: 'layer', created: [0, ''], removed: null,
      f: new Map([
        ['name', { v: 'Layer 1', t: [0, ''] }], ['visible', { v: true, t: [0, ''] }],
        ['locked', { v: false, t: [0, ''] }], ['order', { v: 0, t: [0, ''] }],
      ]),
    });
  }

  // ---------- events ----------
  on(name, cb) {
    if (!this._listeners[name]) throw new DiagramError(`unknown event: ${name}`);
    this._listeners[name].push(cb);
    return () => {
      this._listeners[name] = this._listeners[name].filter((f) => f !== cb);
    };
  }

  _emit(name, payload) {
    for (const cb of [...this._listeners[name]]) cb(payload);
  }

  // ---------- raw state ----------
  _alive(id) {
    const ent = this._ents.get(id);
    return !!(ent && ent.kind && ent.created && (!ent.removed || cmpStamp(ent.created, ent.removed) > 0));
  }

  _fieldValue(id, p) {
    return this._ents.get(id)?.f.get(p)?.v;
  }

  _apply(w) {
    let ent = this._ents.get(w.e);
    if (!ent) {
      ent = { kind: null, created: null, removed: null, f: new Map() };
      this._ents.set(w.e, ent);
    }
    if (w.k && !ent.kind) ent.kind = w.k;
    if (w.s === 'c') {
      if (cmpStamp(w.t, ent.created) > 0) ent.created = w.t;
    } else if (w.s === 'd') {
      if (cmpStamp(w.t, ent.removed) > 0) ent.removed = w.t;
    } else {
      const cur = ent.f.get(w.p);
      if (!cur || cmpStamp(w.t, cur.t) > 0) ent.f.set(w.p, { v: w.v, t: w.t });
    }
  }

  // Records the pre-transaction state of an entity or a field (once per tx).
  _touch(id, p) {
    const tx = this._tx;
    const ent = this._ents.get(id);
    if (p === undefined) {
      const key = `${id}\u0001`;
      if (tx.touched.has(key)) return;
      tx.touched.set(key, {
        type: 'e', e: id,
        raw: { existed: !!ent, kind: ent?.kind ?? null, created: ent?.created ?? null, removed: ent?.removed ?? null },
        before: { alive: this._alive(id) },
      });
    } else {
      const key = `${id}\u0000${p}`;
      if (tx.touched.has(key)) return;
      tx.touched.set(key, {
        type: 'f', e: id, p,
        raw: { exists: !!(ent && ent.f.has(p)), reg: ent?.f.get(p) },
        before: { v: this._fieldValue(id, p) },
      });
    }
  }

  // Local write: stamps, applies and records it in the current transaction.
  _local(w) {
    const full = { ...w, t: [++this._clock, this.actor] };
    if (full.v !== undefined) full.v = clone(full.v);
    this._touch(w.e);
    if (w.s === 'f') this._touch(w.e, w.p);
    this._apply(full);
    this._tx.writes.push(full);
  }

  _rollback(tx) {
    for (const rec of [...tx.touched.values()].reverse()) {
      if (rec.type === 'e') {
        if (!rec.raw.existed) this._ents.delete(rec.e);
        else {
          const ent = this._ents.get(rec.e);
          ent.kind = rec.raw.kind; ent.created = rec.raw.created; ent.removed = rec.raw.removed;
        }
      } else {
        const ent = this._ents.get(rec.e);
        if (rec.raw.exists) ent.f.set(rec.p, rec.raw.reg);
        else ent.f.delete(rec.p);
      }
    }
  }

  // Runs fn as one undoable, atomically-emitted step. Nested calls are flattened.
  transaction(fn) {
    if (this._tx) return fn();
    this._tx = { touched: new Map(), writes: [] };
    const tx = this._tx;
    let result;
    try {
      result = fn();
    } catch (err) {
      this._rollback(tx);
      this._tx = null;
      throw err;
    }
    this._tx = null;
    if (tx.writes.length === 0) return result;
    const entry = new Map();
    for (const [key, rec] of tx.touched) {
      entry.set(key, {
        type: rec.type, e: rec.e, p: rec.p,
        before: rec.before,
        after: rec.type === 'f' ? { v: this._fieldValue(rec.e, rec.p) } : { alive: this._alive(rec.e) },
      });
    }
    this._undo.push(entry);
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this._redo = [];
    this._flush(tx.writes);
    return result;
  }

  _flush(writes) {
    const batch = { id: `${this.actor}:${randomUUID()}`, actor: this.actor, writes };
    this._seen.add(batch.id);
    this._pending.push(batch);
    this._emit('op', batch);
    this._emit('change', { local: true });
  }

  _replay(entry, which) {
    this._tx = { touched: new Map(), writes: [] };
    const tx = this._tx;
    try {
      for (const rec of entry.values()) {
        if (rec.type === 'f') {
          const v = rec[which].v;
          this._local({ e: rec.e, s: 'f', p: rec.p, v: v === undefined ? null : v });
        }
      }
      for (const rec of entry.values()) {
        if (rec.type === 'e') {
          const want = rec[which].alive, now = this._alive(rec.e);
          const ent = this._ents.get(rec.e);
          if (want && !now) this._local({ e: rec.e, s: 'c', k: ent.kind });
          else if (!want && now) this._local({ e: rec.e, s: 'd' });
        }
      }
    } finally {
      this._tx = null;
    }
    if (tx.writes.length) this._flush(tx.writes);
  }

  undo() {
    const entry = this._undo.pop();
    if (!entry) return false;
    this._replay(entry, 'before');
    this._redo.push(entry);
    return true;
  }

  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._replay(entry, 'after');
    this._undo.push(entry);
    return true;
  }

  // ---------- sync ----------
  pendingOps() {
    const out = this._pending;
    this._pending = [];
    return out;
  }

  receive(remoteOps) {
    const list = Array.isArray(remoteOps) ? remoteOps : [remoteOps];
    let applied = 0;
    for (const batch of list) {
      if (!batch || typeof batch.id !== 'string' || !Array.isArray(batch.writes)) {
        throw new DiagramError('invalid remote op');
      }
      if (this._seen.has(batch.id)) continue;
      this._seen.add(batch.id);
      for (const w of batch.writes) {
        if (!w || typeof w.e !== 'string' || !['c', 'd', 'f'].includes(w.s)
          || !Array.isArray(w.t) || typeof w.t[0] !== 'number') {
          throw new DiagramError('invalid write in remote op');
        }
        if (w.t[0] > this._clock) this._clock = w.t[0];
        this._apply(w);
      }
      applied++;
    }
    if (applied) this._emit('change', { local: false });
    return applied;
  }

  // ---------- operations ----------
  apply(op) {
    return this.transaction(() => this._applyOp(op));
  }

  _applyOp(op) {
    if (!op || typeof op !== 'object') throw new DiagramError('operation must be an object');
    switch (op.type) {
      case 'add': return this._opAdd(op.element);
      case 'update': return this._opUpdate(op.id, op.patch);
      case 'remove': return this._opRemove(op.id);
      case 'move': return this._opMove(op.ids, op.dx, op.dy);
      case 'resize': return this._opResize(op.id, op.box, op.keepAspect);
      case 'rotate': return this._opRotate(op.id, op.deg);
      case 'group': return this._opGroup(op.ids, op.groupId);
      case 'ungroup': return this._opUngroup(op.groupId);
      case 'reorder': return this._opReorder(op.id, op.to);
      case 'addLayer': return this._opAddLayer(op.layer);
      case 'updateLayer': return this._opUpdateLayer(op.id, op.patch);
      case 'removeLayer': return this._opRemoveLayer(op.id);
      case 'setStyle': return this._opSetStyle(op.ids, op.style);
      default: throw new DiagramError(`unknown operation type: ${op.type}`);
    }
  }

  _requireElement(id) {
    if (!this._alive(id) || this._ents.get(id).kind !== 'element') {
      throw new DiagramError(`unknown element: ${id}`);
    }
    return this.get(id);
  }

  _requireShape(id) {
    const el = this._requireElement(id);
    if (el.type === 'connector') throw new DiagramError(`operation not supported on connector: ${id}`);
    return el;
  }

  _requireLayer(id) {
    if (!this._alive(id) || this._ents.get(id).kind !== 'layer') throw new DiagramError(`unknown layer: ${id}`);
    return this._layer(id);
  }

  _assertEditableLayer(layerId) {
    if (this._requireLayer(layerId).locked) throw new DiagramError(`layer is locked: ${layerId}`);
  }

  _assertEditable(el) {
    this._assertEditableLayer(el.layer);
  }

  _checkEndpoint(ep) {
    if (!ep || typeof ep !== 'object' || typeof ep.elementId !== 'string') {
      throw new DiagramError('connector endpoint needs an elementId');
    }
    const target = this.get(ep.elementId);
    if (!target || target.type === 'connector') throw new DiagramError(`unknown element: ${ep.elementId}`);
  }

  _num(v, def, name) {
    if (v === undefined || v === null) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new DiagramError(`${name} must be a finite number`);
    return v;
  }

  _opAdd(element) {
    if (!element || typeof element !== 'object') throw new DiagramError('add: element required');
    const el = clone(element);
    const isConn = el.type === 'connector';
    if (!isConn && !SHAPE_TYPES.has(el.type)) throw new DiagramError(`unknown element type: ${el.type}`);
    if (el.id === undefined || el.id === null) el.id = newId(isConn ? 'c' : 'e');
    el.id = String(el.id);
    if (this._alive(el.id)) throw new DiagramError(`duplicate id: ${el.id}`);
    const layerId = el.layer ?? DEFAULT_LAYER;
    this._assertEditableLayer(layerId);
    const values = { ...el, layer: layerId, style: el.style ?? {} };
    values.groupId = el.groupId ?? null;
    if (isConn) {
      this._checkEndpoint(el.source);
      this._checkEndpoint(el.target);
      values.routing = el.routing ?? 'straight';
      if (!['straight', 'orthogonal'].includes(values.routing)) throw new DiagramError(`unknown routing: ${values.routing}`);
      values.waypoints = el.waypoints ?? [];
      values.label = el.label ?? '';
    } else {
      values.x = this._num(el.x, 0, 'x');
      values.y = this._num(el.y, 0, 'y');
      values.width = this._num(el.width, 0, 'width');
      values.height = this._num(el.height, 0, 'height');
      values.rotation = this._num(el.rotation, 0, 'rotation');
      values.text = el.text ?? '';
    }
    values.z = typeof el.z === 'string' ? el.z : this._topKey(layerId);
    this._local({ e: el.id, s: 'c', k: 'element' });
    for (const [p, v] of Object.entries(values)) {
      if (p === 'id' || p === 'style' || v === undefined) continue;
      this._local({ e: el.id, s: 'f', p, v });
    }
    for (const [k, v] of Object.entries(values.style)) {
      this._local({ e: el.id, s: 'f', p: `style.${k}`, v: v ?? null });
    }
    return this.get(el.id);
  }

  _opUpdate(id, patch) {
    const el = this._requireElement(id);
    this._assertEditable(el);
    if (!patch || typeof patch !== 'object') throw new DiagramError('update: patch required');
    for (const [key, v] of Object.entries(patch)) {
      if (key === 'id') throw new DiagramError('cannot change element id');
      if (key === 'style') {
        for (const [sk, sv] of Object.entries(v || {})) this._local({ e: id, s: 'f', p: `style.${sk}`, v: sv ?? null });
        continue;
      }
      if (key === 'layer') { this._assertEditableLayer(v); }
      if (key === 'source' || key === 'target') this._checkEndpoint(v);
      if (key === 'x' || key === 'y' || key === 'width' || key === 'height' || key === 'rotation') this._num(v, 0, key);
      this._local({ e: id, s: 'f', p: key, v: v === undefined ? null : v });
    }
    return this.get(id);
  }

  _connectorsOf(id) {
    return this._allElements().filter((e) => e.type === 'connector'
      && (e.source?.elementId === id || e.target?.elementId === id));
  }

  _opRemove(id) {
    const el = this._requireElement(id);
    const targets = new Map([[el.id, el]]);
    for (const c of this._connectorsOf(id)) targets.set(c.id, c);
    for (const t of targets.values()) {
      this._assertEditable(t);
      this._local({ e: t.id, s: 'd' });
    }
  }

  _opMove(ids, dx, dy) {
    if (!Array.isArray(ids)) throw new DiagramError('move: ids must be an array');
    this._num(dx, 0, 'dx'); this._num(dy, 0, 'dy');
    for (const id of new Set(ids)) {
      const el = this._requireElement(id);
      this._assertEditable(el);
      if (el.type === 'connector') {
        if (el.waypoints?.length) {
          this._local({ e: id, s: 'f', p: 'waypoints', v: el.waypoints.map(([x, y]) => [x + dx, y + dy]) });
        }
      } else {
        this._local({ e: id, s: 'f', p: 'x', v: el.x + dx });
        this._local({ e: id, s: 'f', p: 'y', v: el.y + dy });
      }
    }
  }

  _opResize(id, box, keepAspect) {
    const el = this._requireShape(id);
    this._assertEditable(el);
    if (!box || typeof box !== 'object') throw new DiagramError('resize: box required');
    let { x, y, width, height } = box;
    for (const [n, v] of [['x', x], ['y', y], ['width', width], ['height', height]]) this._num(v, 0, n);
    if (width < 0 || height < 0) throw new DiagramError('resize: negative size');
    if (keepAspect && el.width > 0 && el.height > 0) {
      const r = el.width / el.height;
      const relW = Math.abs(width - el.width) / el.width;
      const relH = Math.abs(height - el.height) / el.height;
      if (relW >= relH) height = width / r; else width = height * r;
    }
    this._local({ e: id, s: 'f', p: 'x', v: x });
    this._local({ e: id, s: 'f', p: 'y', v: y });
    this._local({ e: id, s: 'f', p: 'width', v: width });
    this._local({ e: id, s: 'f', p: 'height', v: height });
  }

  _opRotate(id, deg) {
    const el = this._requireShape(id);
    this._assertEditable(el);
    this._local({ e: id, s: 'f', p: 'rotation', v: this._num(deg, 0, 'deg') });
  }

  _opGroup(ids, groupId) {
    if (!Array.isArray(ids) || ids.length === 0) throw new DiagramError('group: ids required');
    const gid = groupId ?? newId('g');
    for (const id of new Set(ids)) {
      const el = this._requireElement(id);
      this._assertEditable(el);
      this._local({ e: id, s: 'f', p: 'groupId', v: gid });
    }
    return gid;
  }

  _opUngroup(groupId) {
    const members = this._allElements().filter((e) => e.groupId === groupId);
    if (members.length === 0) throw new DiagramError(`unknown group: ${groupId}`);
    for (const m of members) {
      this._assertEditable(m);
      this._local({ e: m.id, s: 'f', p: 'groupId', v: null });
    }
  }

  _opReorder(id, to) {
    const el = this._requireElement(id);
    this._assertEditable(el);
    const all = this._layerElements(el.layer);
    const i = all.findIndex((e) => e.id === id);
    const others = all.filter((e) => e.id !== id);
    let z;
    switch (to) {
      case 'front': z = between(others.at(-1)?.z ?? null, null); break;
      case 'back': z = between(null, others[0]?.z ?? null); break;
      case 'forward': {
        if (i === all.length - 1) return;
        const next = all[i + 1], after = all[i + 2];
        z = between(next.z, after?.z ?? null);
        break;
      }
      case 'backward': {
        if (i === 0) return;
        const prev = all[i - 1], before = all[i - 2];
        z = between(before?.z ?? null, prev.z);
        break;
      }
      default: throw new DiagramError(`unknown reorder target: ${to}`);
    }
    this._local({ e: id, s: 'f', p: 'z', v: z });
  }

  _opAddLayer(layer) {
    if (!layer || typeof layer !== 'object' || layer.id === undefined) throw new DiagramError('addLayer: layer.id required');
    const id = String(layer.id);
    if (this._alive(id)) throw new DiagramError(`duplicate layer: ${id}`);
    const order = layer.order ?? (this._layers().reduce((m, l) => Math.max(m, l.order), -1) + 1);
    this._local({ e: id, s: 'c', k: 'layer' });
    this._local({ e: id, s: 'f', p: 'name', v: layer.name ?? id });
    this._local({ e: id, s: 'f', p: 'visible', v: layer.visible ?? true });
    this._local({ e: id, s: 'f', p: 'locked', v: layer.locked ?? false });
    this._local({ e: id, s: 'f', p: 'order', v: order });
  }

  _opUpdateLayer(id, patch) {
    this._requireLayer(id);
    if (!patch || typeof patch !== 'object') throw new DiagramError('updateLayer: patch required');
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') throw new DiagramError('cannot change layer id');
      this._local({ e: id, s: 'f', p: k, v: v === undefined ? null : v });
    }
  }

  _opRemoveLayer(id) {
    const layer = this._requireLayer(id);
    if (layer.locked) throw new DiagramError(`layer is locked: ${id}`);
    const targets = new Map();
    for (const e of this._allElements()) {
      if (e.layer === id) {
        targets.set(e.id, e);
        for (const c of this._connectorsOf(e.id)) targets.set(c.id, c);
      }
    }
    for (const t of targets.values()) {
      this._assertEditable(t);
      this._local({ e: t.id, s: 'd' });
    }
    this._local({ e: id, s: 'd' });
  }

  _opSetStyle(ids, style) {
    if (!Array.isArray(ids)) throw new DiagramError('setStyle: ids must be an array');
    if (!style || typeof style !== 'object') throw new DiagramError('setStyle: style required');
    for (const id of new Set(ids)) {
      const el = this._requireElement(id);
      this._assertEditable(el);
      for (const [k, v] of Object.entries(style)) this._local({ e: id, s: 'f', p: `style.${k}`, v: v ?? null });
    }
  }

  // Replaces the diagram content with a snapshot (used by version restore); undoable.
  restore(json) {
    return this.transaction(() => {
      const wantLayers = new Map((json.layers || []).map((l) => [l.id, l]));
      const wantEls = new Map((json.elements || []).map((e) => [e.id, e]));
      for (const [id, l] of wantLayers) {
        if (!this._alive(id)) this._opAddLayer(l);
        else this._opUpdateLayer(id, { name: l.name, visible: l.visible, locked: l.locked, order: l.order });
      }
      for (const [id, e] of wantEls) {
        if (!this._alive(id)) { this._opAdd(e); continue; }
        const cur = this.get(id);
        const patch = { ...e };
        delete patch.id;
        patch.style = {};
        for (const k of Object.keys(cur.style || {})) if (!(e.style || {})[k]) patch.style[k] = null;
        for (const k of Object.keys(cur)) if (!(k in e) && k !== 'id' && k !== 'style') patch[k] = null;
        this._opUpdate(id, patch);
      }
      for (const e of this._allElements()) if (!wantEls.has(e.id)) this._opRemove(e.id);
      for (const l of this._layers()) if (!wantLayers.has(l.id)) this._opRemoveLayer(l.id);
    });
  }

  // ---------- queries ----------
  _allElements() {
    const out = [];
    for (const [id, ent] of this._ents) {
      if (ent.kind === 'element' && this._alive(id)) out.push(this._materialize(id));
    }
    return out;
  }

  _layers() {
    const out = [];
    for (const [id, ent] of this._ents) if (ent.kind === 'layer' && this._alive(id)) out.push(this._layer(id));
    return out;
  }

  _layer(id) {
    const f = (p, d) => { const v = this._fieldValue(id, p); return v === undefined || v === null ? d : v; };
    return { id, name: f('name', id), visible: f('visible', true), locked: f('locked', false), order: f('order', 0) };
  }

  _materialize(id) {
    const ent = this._ents.get(id);
    const out = { id, style: {} };
    for (const [p, reg] of ent.f) {
      if (reg.v === null || reg.v === undefined) continue;
      if (p.startsWith('style.')) out.style[p.slice(6)] = clone(reg.v);
      else out[p] = clone(reg.v);
    }
    if (out.type === 'connector') {
      out.routing ??= 'straight';
      out.waypoints ??= [];
      out.label ??= '';
    } else {
      out.x ??= 0; out.y ??= 0; out.width ??= 0; out.height ??= 0; out.rotation ??= 0;
      out.text ??= '';
    }
    out.layer ??= DEFAULT_LAYER;
    out.groupId ??= null;
    out.z ??= '';
    return out;
  }

  _layerOrder(layerId) {
    return this._alive(layerId) ? this._layer(layerId).order : 0;
  }

  _sortElements(list) {
    return list.sort((a, b) => (this._layerOrder(a.layer) - this._layerOrder(b.layer))
      || (a.z < b.z ? -1 : a.z > b.z ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  _layerElements(layerId) {
    return this._sortElements(this._allElements().filter((e) => e.layer === layerId));
  }

  _topKey(layerId) {
    const els = this._layerElements(layerId);
    return between(els.at(-1)?.z ?? null, null);
  }

  // Connectors whose endpoints are both alive are the only visible connectors.
  _isLive(el) {
    if (el.type !== 'connector') return true;
    return this._alive(el.source.elementId) && this._alive(el.target.elementId);
  }

  get(id) {
    if (!this._alive(id) || this._ents.get(id).kind !== 'element') return undefined;
    return this._materialize(id);
  }

  elements({ layer, type } = {}) {
    return this._sortElements(this._allElements())
      .filter((e) => this._isLive(e))
      .filter((e) => (layer === undefined || e.layer === layer))
      .filter((e) => (type === undefined || e.type === type));
  }

  _layerVisible(layerId) {
    return this._alive(layerId) ? this._layer(layerId).visible !== false : true;
  }

  hitTest(x, y) {
    const list = this.elements().filter((e) => e.type !== 'connector' && this._layerVisible(e.layer));
    for (let i = list.length - 1; i >= 0; i--) {
      if (containsPoint(list[i], x, y)) return list[i];
    }
    return null;
  }

  select(rect) {
    return this.elements().filter((e) => {
      if (e.type === 'connector') return false;
      const b = aabb(e);
      return b.x >= rect.x && b.y >= rect.y
        && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height;
    });
  }

  bounds(ids) {
    let pts = [];
    const list = ids ? ids.map((id) => this.get(id) || this._requireElement(id)) : this.elements();
    for (const e of list) {
      if (e.type === 'connector') {
        pts.push(...this.route(e.id));
      } else {
        const b = aabb(e);
        pts.push([b.x, b.y], [b.x + b.width, b.y + b.height]);
      }
    }
    if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  // Polyline of a connector as [x, y] points.
  route(connectorId) {
    const c = this.get(connectorId);
    if (!c || c.type !== 'connector') throw new DiagramError(`unknown connector: ${connectorId}`);
    const src = this.get(c.source.elementId), tgt = this.get(c.target.elementId);
    if (!src || !tgt) return [];
    const wps = c.waypoints || [];
    if (c.routing === 'orthogonal') {
      const r = this._orthogonal(c, src, tgt);
      if (r) return r;
    }
    const sc = centerOf(src), tc = centerOf(tgt);
    const start = portPoint(src, c.source.port) ?? boundaryToward(src, wps[0]?.[0] ?? tc[0], wps[0]?.[1] ?? tc[1]);
    const end = portPoint(tgt, c.target.port) ?? boundaryToward(tgt, wps.at(-1)?.[0] ?? sc[0], wps.at(-1)?.[1] ?? sc[1]);
    return [start, ...wps.map((p) => [p[0], p[1]]), end];
  }

  _orthogonal(c, src, tgt) {
    const sb = aabb(src), tb = aabb(tgt);
    const sc = centerOf(sb.width ? sb : src), tc = centerOf(tb.width ? tb : tgt);
    const dx = tc[0] - sc[0], dy = tc[1] - sc[1];
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sSide = c.source.port ?? (horizontal ? (dx >= 0 ? 'e' : 'w') : (dy >= 0 ? 's' : 'n'));
    const tSide = c.target.port ?? (horizontal ? (dx >= 0 ? 'w' : 'e') : (dy >= 0 ? 'n' : 's'));
    const start = sideAnchor(sb, sSide);
    const end = sideAnchor(tb, tSide);
    const all = this._allElements().filter((e) => e.type !== 'connector').map((e) => aabb(e));
    const boxes = [...all, { x: start[0], y: start[1], width: 0, height: 0 }, { x: end[0], y: end[1], width: 0, height: 0 }];
    const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width)), maxY = Math.max(...boxes.map((b) => b.y + b.height));
    const frame = { x: minX - 100, y: minY - 100, width: maxX - minX + 200, height: maxY - minY + 200 };
    const pts = orthogonalRoute(start, end, all, frame);
    return pts ? pts.map((p) => [p[0], p[1]]) : null;
  }

  // ---------- geometry operations ----------
  align(ids, mode) {
    const list = ids.map((id) => this._requireShape(id));
    if (list.length === 0) return;
    const boxes = list.map((e) => ({ id: e.id, b: aabb(e) }));
    const minX = Math.min(...boxes.map((x) => x.b.x));
    const maxX = Math.max(...boxes.map((x) => x.b.x + x.b.width));
    const minY = Math.min(...boxes.map((x) => x.b.y));
    const maxY = Math.max(...boxes.map((x) => x.b.y + x.b.height));
    this.transaction(() => {
      for (const { id, b } of boxes) {
        let dx = 0, dy = 0;
        switch (mode) {
          case 'left': dx = minX - b.x; break;
          case 'right': dx = maxX - (b.x + b.width); break;
          case 'center': dx = (minX + maxX) / 2 - (b.x + b.width / 2); break;
          case 'top': dy = minY - b.y; break;
          case 'bottom': dy = maxY - (b.y + b.height); break;
          case 'middle': dy = (minY + maxY) / 2 - (b.y + b.height / 2); break;
          default: throw new DiagramError(`unknown align mode: ${mode}`);
        }
        if (dx || dy) this._opMove([id], dx, dy);
      }
    });
  }

  distribute(ids, axis) {
    if (axis !== 'horizontal' && axis !== 'vertical') throw new DiagramError(`unknown axis: ${axis}`);
    const horiz = axis === 'horizontal';
    const list = ids.map((id) => this._requireShape(id)).map((e) => ({ id: e.id, b: aabb(e) }));
    if (list.length < 3) return;
    const pos = (x) => (horiz ? x.b.x : x.b.y), size = (x) => (horiz ? x.b.width : x.b.height);
    list.sort((a, b) => pos(a) - pos(b));
    const first = list[0], last = list.at(-1);
    const sumSize = list.reduce((s, x) => s + size(x), 0);
    const span = (pos(last) + size(last)) - pos(first);
    const gap = (span - sumSize) / (list.length - 1);
    this.transaction(() => {
      let cursor = pos(first);
      for (const item of list) {
        const delta = cursor - pos(item);
        if (delta) this._opMove([item.id], horiz ? delta : 0, horiz ? 0 : delta);
        cursor += size(item) + gap;
      }
    });
  }

  layout(name, opts = {}) {
    if (name === 'layered') return this._layeredLayout(opts);
    if (name === 'grid') return this._gridLayout(opts);
    throw new DiagramError(`unknown layout: ${name}`);
  }

  _layeredLayout(opts) {
    const dir = opts.direction ?? 'TB';
    if (dir !== 'TB' && dir !== 'LR') throw new DiagramError(`unknown direction: ${dir}`);
    const spacing = this._num(opts.spacing, 50, 'spacing');
    const shapes = this.elements().filter((e) => e.type !== 'connector');
    if (shapes.length === 0) return;
    const ids = new Set(shapes.map((s) => s.id));
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: dir, nodesep: spacing, ranksep: spacing, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const s of shapes) g.setNode(s.id, { width: s.width, height: s.height });
    for (const c of this.elements({ type: 'connector' })) {
      const a = c.source.elementId, b = c.target.elementId;
      if (ids.has(a) && ids.has(b) && a !== b) g.setEdge(a, b, {});
    }
    dagre.layout(g);
    const placed = shapes.map((s) => {
      const n = g.node(s.id);
      return { s, x: n.x - s.width / 2, y: n.y - s.height / 2 };
    });
    const oldMinX = Math.min(...shapes.map((s) => s.x)), oldMinY = Math.min(...shapes.map((s) => s.y));
    const newMinX = Math.min(...placed.map((p) => p.x)), newMinY = Math.min(...placed.map((p) => p.y));
    this.transaction(() => {
      for (const p of placed) {
        if (this._layerLocked(p.s.layer)) continue;
        this._opUpdate(p.s.id, { x: p.x - newMinX + oldMinX, y: p.y - newMinY + oldMinY });
      }
    });
  }

  _layerLocked(id) {
    return this._layer(id).locked === true;
  }

  _gridLayout(opts) {
    const spacing = this._num(opts.spacing, 40, 'spacing');
    const shapes = this.elements().filter((e) => e.type !== 'connector');
    if (shapes.length === 0) return;
    const cols = Math.ceil(Math.sqrt(shapes.length));
    const cw = Math.max(...shapes.map((s) => s.width)) + spacing;
    const ch = Math.max(...shapes.map((s) => s.height)) + spacing;
    const ox = Math.min(...shapes.map((s) => s.x)), oy = Math.min(...shapes.map((s) => s.y));
    this.transaction(() => {
      shapes.forEach((s, i) => {
        if (this._layerLocked(s.layer)) return;
        this._opUpdate(s.id, { x: ox + (i % cols) * cw, y: oy + Math.floor(i / cols) * ch });
      });
    });
  }

  // ---------- serialization ----------
  toJSON() {
    return {
      id: this.id,
      layers: this._layers().sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)),
      elements: this.elements(),
    };
  }

  toSVG({ padding = 10 } = {}) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const num = (v) => (Number.isFinite(v) ? String(v) : '0');
    const items = this.elements().filter((e) => this._layerVisible(e.layer));
    const pts = [];
    for (const e of items) {
      if (e.type === 'connector') pts.push(...this.route(e.id));
      else { const b = aabb(e); pts.push([b.x, b.y], [b.x + b.width, b.y + b.height]); }
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = pts.length ? Math.min(...xs) - padding : 0;
    const y0 = pts.length ? Math.min(...ys) - padding : 0;
    const w = pts.length ? Math.max(...xs) - x0 + padding : 0;
    const h = pts.length ? Math.max(...ys) - y0 + padding : 0;
    const body = [];
    for (const e of items) {
      const st = e.style || {};
      const attrs = [];
      if (st.fill != null) attrs.push(`fill="${esc(st.fill)}"`); else if (e.type !== 'text') attrs.push('fill="#ffffff"');
      if (e.type === 'text') attrs.push('fill="none"');
      attrs.push(`stroke="${esc(st.stroke ?? '#000000')}"`);
      attrs.push(`stroke-width="${num(st.strokeWidth ?? 1)}"`);
      if (st.opacity != null) attrs.push(`opacity="${num(st.opacity)}"`);
      const b = e.type === 'connector' ? null : aabb(e);
      const [cx, cy] = b ? [b.x + b.width / 2, b.y + b.height / 2] : [0, 0];
      let inner = '';
      let extraAttr = '';
      if (e.type === 'connector') {
        const r = this.route(e.id);
        const d = r.map((p, i) => `${i ? 'L' : 'M'}${num(p[0])} ${num(p[1])}`).join(' ');
        inner += `<path d="${d}" fill="none" stroke="${esc(st.stroke ?? '#000000')}" stroke-width="${num(st.strokeWidth ?? 1.5)}" marker-end="url(#arrow)"/>`;
        if (e.label) {
          const m = r[Math.floor(r.length / 2)] || [0, 0];
          inner += `<text x="${num(m[0])}" y="${num(m[1])}" text-anchor="middle" font-size="${num(st.fontSize ?? 12)}">${esc(e.label)}</text>`;
        }
      } else {
        const rot = e.rotation ? ` transform="rotate(${num(e.rotation)} ${num(cx)} ${num(cy)})"` : '';
        const shapeAttrs = attrs.join(' ');
        if (e.type === 'rect') inner += `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.width)}" height="${num(e.height)}" ${shapeAttrs}${rot}/>`;
        else if (e.type === 'ellipse') inner += `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(e.width / 2)}" ry="${num(e.height / 2)}" ${shapeAttrs}${rot}/>`;
        else if (e.type === 'diamond') {
          const p = [[cx, e.y], [e.x + e.width, cy], [cx, e.y + e.height], [e.x, cy]].map((q) => `${num(q[0])},${num(q[1])}`).join(' ');
          inner += `<polygon points="${p}" ${shapeAttrs}${rot}/>`;
        } else if (e.type === 'line') {
          inner += `<line x1="${num(e.x)}" y1="${num(e.y)}" x2="${num(e.x + e.width)}" y2="${num(e.y + e.height)}" stroke="${esc(st.stroke ?? '#000000')}" stroke-width="${num(st.strokeWidth ?? 1)}"${rot}/>`;
        } else if (e.type === 'image') {
          const href = e.text || st.src || '';
          inner += `<image href="${esc(href)}" x="${num(e.x)}" y="${num(e.y)}" width="${num(e.width)}" height="${num(e.height)}"${rot}/>`;
        } else if (e.type === 'text') {
          extraAttr = '';
        }
        if (e.text && e.type !== 'line') {
          const lines = String(e.text).split('\n');
          const fs = num(st.fontSize ?? 14);
          const tspans = lines.map((ln, i) => `<tspan x="${num(cx)}" dy="${i ? fs : 0}">${esc(ln)}</tspan>`).join('');
          const fill = st.fontColor != null ? esc(st.fontColor) : '#000000';
          const family = st.fontFamily != null ? ` font-family="${esc(st.fontFamily)}"` : '';
          inner += `<text x="${num(cx)}" y="${num(cy)}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" fill="${fill}"${family}${rot}>${tspans}</text>`;
        }
      }
      body.push(`<g data-id="${esc(e.id)}"${extraAttr}>${inner}</g>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x0)} ${num(y0)} ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">`
      + `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#000000"/></marker></defs>`
      + body.join('') + '</svg>';
  }

  // Loads a serialized snapshot at the origin stamp (used by fromJSON).
  _load(json) {
    const origin = [0, ''];
    this._ents.clear();
    const setEnt = (id, kind, fields) => {
      this._ents.set(id, { kind, created: origin, removed: null, f: new Map() });
      for (const [p, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        this._ents.get(id).f.set(p, { v: clone(v), t: origin });
      }
    };
    const layers = json.layers ?? [{ id: DEFAULT_LAYER, name: 'Layer 1', visible: true, locked: false, order: 0 }];
    for (const l of layers) {
      setEnt(String(l.id), 'layer', { name: l.name, visible: l.visible, locked: l.locked, order: l.order });
    }
    for (const e of json.elements ?? []) {
      const { id, style = {}, ...rest } = e;
      const fields = { ...rest };
      for (const [k, v] of Object.entries(style)) fields[`style.${k}`] = v;
      setEnt(String(id), 'element', fields);
    }
  }
}
