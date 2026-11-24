// diagram-s5 core library (isomorphic, no DOM). Written from scratch.
export class DiagramError extends Error {
  constructor(message) { super(message); this.name = 'DiagramError'; }
}
const SHAPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);
const DEFAULT_LAYER = 'default';
const NUMERIC = ['x', 'y', 'width', 'height', 'rotation', 'z'];
const MAX_HISTORY = 500;
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const cmpTs = (a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const fail = (m) => { throw new DiagramError(m); };

function exists(ent) {
  return !!ent && !!ent.addTs && (!ent.delTs || cmpTs(ent.addTs, ent.delTs) > 0);
}
function flatten(obj) {
  const props = {};
  for (const k of Object.keys(obj)) {
    if (k === 'id') continue;
    if (k === 'style') {
      for (const sk of Object.keys(obj.style || {})) props['style.' + sk] = clone(obj.style[sk]);
    } else props[k] = clone(obj[k]);
  }
  return props;
}
function materialize(ent) {
  const o = { id: ent.id };
  const style = {};
  for (const k of Object.keys(ent.props).sort()) {
    const v = ent.props[k].v;
    if (k.startsWith('style.')) { if (v !== null) style[k.slice(6)] = clone(v); }
    else if (v !== null || k === 'groupId') o[k] = clone(v);
  }
  if (ent.kind !== 'layer') o.style = style;
  return o;
}

export class Doc {
  constructor(id, actor) {
    this.id = id; this.actor = actor;
    this._ents = new Map(); this._clock = 0; this._seen = new Set(); this._pending = [];
    this._listeners = { op: [], change: [] };
    this._undo = []; this._redo = []; this._rec = null; this._depth = 0;
    this._bootstrap();
  }
  _bootstrap() {
    const ts = [0, ''];
    const ent = { id: DEFAULT_LAYER, kind: 'layer', addTs: ts, delTs: null, props: {} };
    for (const [k, v] of Object.entries({ name: 'Layer 1', visible: true, locked: false, order: 0 })) ent.props[k] = { v, ts };
    this._ents.set(DEFAULT_LAYER, ent);
  }
  on(evt, cb) {
    (this._listeners[evt] ||= []).push(cb);
    return () => { this._listeners[evt] = this._listeners[evt].filter((f) => f !== cb); };
  }
  _fire(evt, arg) { for (const f of [...(this._listeners[evt] || [])]) f(arg); }

  // ---------- CRDT core ----------
  _applyOp(op) {
    const ts = [op.clock, op.actor];
    if (op.clock > this._clock) this._clock = op.clock;
    let ent = this._ents.get(op.eid);
    if (!ent) { ent = { id: op.eid, kind: null, addTs: null, delTs: null, props: {} }; this._ents.set(op.eid, ent); }
    const setProp = (k, v) => {
      const cur = ent.props[k];
      if (!cur || cmpTs(ts, cur.ts) > 0) ent.props[k] = { v: clone(v), ts };
    };
    if (op.k === 'add') {
      ent.kind = op.kind;
      if (!ent.addTs || cmpTs(ts, ent.addTs) > 0) ent.addTs = ts;
      for (const k of Object.keys(op.props)) setProp(k, op.props[k]);
    } else if (op.k === 'set') setProp(op.key, op.value);
    else if (op.k === 'del') { if (!ent.delTs || cmpTs(ts, ent.delTs) > 0) ent.delTs = ts; }
  }
  _emit(op) {
    op.clock = this._clock + 1; op.actor = this.actor; op.id = `${this.actor}:${op.clock}`;
    this._applyOp(op); this._seen.add(op.id);
    this._pending.push(op);
    this._fire('op', clone(op));
  }
  _val(eid, key) { const e = this._ents.get(eid); return e && e.props[key] ? e.props[key].v : null; }
  _ladd(eid, kind, props) {
    if (this._rec) this._rec.push({ k: 'del', eid });
    this._emit({ k: 'add', eid, kind, props: clone(props) });
  }
  _lset(eid, key, value) {
    if (value === undefined) value = null;
    if (this._rec) this._rec.push({ k: 'set', eid, key, value: clone(this._val(eid, key)) });
    this._emit({ k: 'set', eid, key, value: clone(value) });
  }
  _ldel(eid) {
    const ent = this._ents.get(eid);
    if (this._rec) {
      const props = {}; for (const k of Object.keys(ent.props)) props[k] = clone(ent.props[k].v);
      this._rec.push({ k: 'add', eid, kind: ent.kind, props });
    }
    this._emit({ k: 'del', eid });
  }
  _runInverse(items) {
    const newRec = []; const saved = this._rec; this._rec = newRec;
    try {
      for (const it of [...items].reverse()) {
        if (it.k === 'add') this._ladd(it.eid, it.kind, it.props);
        else if (it.k === 'set') this._lset(it.eid, it.key, it.value);
        else this._ldel(it.eid);
      }
    } finally { this._rec = saved; }
    return newRec;
  }
  transaction(fn) {
    if (this._depth > 0) { this._depth++; try { return fn(); } finally { this._depth--; } }
    this._depth = 1; this._rec = [];
    let res;
    try { res = fn(); }
    catch (e) {
      const rec = this._rec; this._rec = null; this._depth = 0;
      if (rec.length) { this._runInverse(rec); this._fire('change'); }
      throw e;
    }
    const rec = this._rec; this._rec = null; this._depth = 0;
    if (rec.length) {
      this._undo.push(rec); if (this._undo.length > MAX_HISTORY) this._undo.shift();
      this._redo = [];
      this._fire('change');
    }
    return res;
  }
  undo() {
    if (!this._undo.length) return false;
    const rec = this._undo.pop(); this._redo.push(this._runInverse(rec)); this._fire('change'); return true;
  }
  redo() {
    if (!this._redo.length) return false;
    const rec = this._redo.pop(); this._undo.push(this._runInverse(rec)); this._fire('change'); return true;
  }
  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }
  pendingOps() { const p = this._pending; this._pending = []; return clone(p); }
  receive(ops) {
    if (!Array.isArray(ops)) ops = [ops];
    let n = 0;
    for (const op of ops) {
      if (!op || typeof op !== 'object' || typeof op.id !== 'string' || typeof op.eid !== 'string' ||
        !isNum(op.clock) || typeof op.actor !== 'string' || !['add', 'set', 'del'].includes(op.k)) fail('malformed op');
      if (op.k === 'add' && (typeof op.props !== 'object' || !op.props)) fail('malformed op');
      if (op.k === 'set' && typeof op.key !== 'string') fail('malformed op');
    }
    for (const op of ops) {
      if (this._seen.has(op.id)) continue;
      this._seen.add(op.id); this._applyOp(op); n++;
    }
    if (n) this._fire('change');
    return n;
  }
  restoreFrom(json) {
    const snap = fromJSON(json, { actor: '_snap' });
    this.transaction(() => {
      for (const [id, ent] of this._ents) if (exists(ent) && !exists(snap._ents.get(id))) this._ldel(id);
      for (const [id, s] of snap._ents) {
        if (!exists(s)) continue;
        const cur = this._ents.get(id);
        const props = {}; for (const k of Object.keys(s.props)) props[k] = s.props[k].v;
        if (!exists(cur)) { this._ladd(id, s.kind, props); continue; }
        for (const k of Object.keys(props)) if (JSON.stringify(this._val(id, k)) !== JSON.stringify(props[k])) this._lset(id, k, props[k]);
        for (const k of Object.keys(cur.props)) if (!(k in props) && cur.props[k].v !== null) this._lset(id, k, null);
      }
    });
  }

  // ---------- helpers ----------
  _ent(id, kinds = ['shape', 'connector']) {
    const e = this._ents.get(id);
    if (!exists(e) || !kinds.includes(e.kind)) fail(`unknown id: ${id}`);
    return e;
  }
  _layerEnt(id) { const e = this._ents.get(id); if (!exists(e) || e.kind !== 'layer') fail(`unknown layer: ${id}`); return e; }
  _checkLayerUnlocked(layerId) { const l = this._layerEnt(layerId); if (this._val(l.id, 'locked')) fail(`layer ${layerId} is locked`); }
  _checkUnlocked(ent) { this._checkLayerUnlocked(this._val(ent.id, 'layer') ?? DEFAULT_LAYER); }
  _all(kinds = ['shape', 'connector']) {
    const out = [];
    for (const e of this._ents.values()) if (exists(e) && kinds.includes(e.kind)) {
      if (e.kind === 'connector') {
        const s = this._ents.get(this._val(e.id, 'source')?.elementId), t = this._ents.get(this._val(e.id, 'target')?.elementId);
        if (!exists(s) || !exists(t)) continue;
      }
      out.push(e);
    }
    out.sort((a, b) => ((this._val(a.id, 'z') ?? 0) - (this._val(b.id, 'z') ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
  _maxZ() { let m = 0; for (const e of this._all()) m = Math.max(m, this._val(e.id, 'z') ?? 0); return m; }
  _minZ() { let m = 0; for (const e of this._all()) m = Math.min(m, this._val(e.id, 'z') ?? 0); return m; }
  _attached(id) {
    return this._all(['connector']).filter((c) => this._val(c.id, 'source')?.elementId === id || this._val(c.id, 'target')?.elementId === id);
  }
  _rawAttached(id) { // include connectors regardless of endpoint visibility
    const out = [];
    for (const e of this._ents.values()) if (exists(e) && e.kind === 'connector' &&
      (this._val(e.id, 'source')?.elementId === id || this._val(e.id, 'target')?.elementId === id)) out.push(e);
    return out;
  }

  // ---------- operations ----------
  apply(op) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string') fail('invalid operation');
    const h = OPS[op.type];
    if (!h) fail(`unknown operation type: ${op.type}`);
    return this.transaction(() => h.call(this, op));
  }

  // ---------- queries ----------
  get(id) {
    const e = this._ents.get(id);
    if (!exists(e) || (e.kind !== 'shape' && e.kind !== 'connector')) return undefined;
    return materialize(e);
  }
  getLayer(id) { const e = this._ents.get(id); return exists(e) && e.kind === 'layer' ? materialize(e) : undefined; }
  layers() {
    return [...this._ents.values()].filter((e) => exists(e) && e.kind === 'layer').map(materialize)
      .sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
  }
  elements(filter = {}) {
    let list = this._all().map(materialize);
    if (filter.layer !== undefined) list = list.filter((e) => e.layer === filter.layer);
    if (filter.type !== undefined) list = list.filter((e) => e.type === filter.type);
    return list;
  }
  _shapes() { return this._all(['shape']).map(materialize); }
  hitTest(x, y) {
    const vis = new Map(this.layers().map((l) => [l.id, l.visible]));
    const list = this._shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (vis.get(s.layer) === false) continue;
      if (containsPoint(s, x, y)) return s;
    }
    return null;
  }
  select(rect) {
    const r = normRect(rect);
    const vis = new Map(this.layers().map((l) => [l.id, l.visible]));
    return this._shapes().filter((s) => vis.get(s.layer) !== false &&
      s.x >= r.x && s.y >= r.y && s.x + s.width <= r.x + r.width && s.y + s.height <= r.y + r.height).map((s) => s.id);
  }
  bounds(ids) {
    const list = ids ? ids.map((id) => this.get(id) || fail(`unknown id: ${id}`)).filter((e) => e.type !== 'connector') : this._shapes();
    if (!list.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of list) { x1 = Math.min(x1, s.x); y1 = Math.min(y1, s.y); x2 = Math.max(x2, s.x + s.width); y2 = Math.max(y2, s.y + s.height); }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  // ---------- geometry ----------
  align(ids, mode) {
    if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) fail('bad align mode');
    const shapes = (ids || []).map((id) => this._ent(id, ['shape']) && this.get(id));
    if (!shapes.length) return;
    shapes.forEach((s) => this._checkUnlocked(this._ents.get(s.id)));
    const b = this.bounds(ids);
    this.transaction(() => {
      for (const s of shapes) {
        let patch;
        if (mode === 'left') patch = { x: b.x };
        else if (mode === 'right') patch = { x: b.x + b.width - s.width };
        else if (mode === 'center') patch = { x: b.x + b.width / 2 - s.width / 2 };
        else if (mode === 'top') patch = { y: b.y };
        else if (mode === 'bottom') patch = { y: b.y + b.height - s.height };
        else patch = { y: b.y + b.height / 2 - s.height / 2 };
        for (const k of Object.keys(patch)) this._lset(s.id, k, patch[k]);
      }
    });
  }
  distribute(ids, dir) {
    if (dir !== 'horizontal' && dir !== 'vertical') fail('bad distribute direction');
    const shapes = (ids || []).map((id) => this._ent(id, ['shape']) && this.get(id));
    shapes.forEach((s) => this._checkUnlocked(this._ents.get(s.id)));
    if (shapes.length < 3) return;
    const h = dir === 'horizontal';
    const pos = h ? 'x' : 'y', size = h ? 'width' : 'height';
    shapes.sort((a, b) => a[pos] - b[pos]);
    const first = shapes[0], last = shapes[shapes.length - 1];
    const end = Math.max(...shapes.map((s) => s[pos] + s[size]));
    const total = shapes.reduce((a, s) => a + s[size], 0);
    const gap = (end - first[pos] - total) / (shapes.length - 1);
    this.transaction(() => {
      let cur = first[pos] + first[size] + gap;
      for (let i = 1; i < shapes.length - 1; i++) { this._lset(shapes[i].id, pos, cur); cur += shapes[i][size] + gap; }
    });
  }

  // ---------- routing ----------
  route(connectorId) {
    const c = this.get(connectorId);
    if (!c || c.type !== 'connector') fail(`unknown connector: ${connectorId}`);
    const s = this.get(c.source.elementId), t = this.get(c.target.elementId);
    const obstacles = this._shapes().filter((e) => e.id !== s.id && e.id !== t.id);
    return routeConnector(c, s, t, obstacles, this.bounds());
  }

  // ---------- layout ----------
  layout(kind, opts = {}) {
    if (kind === 'layered') return layoutLayered(this, opts);
    if (kind === 'grid') return layoutGrid(this, opts);
    fail(`unknown layout: ${kind}`);
  }

  // ---------- serialization ----------
  toJSON() {
    const ents = {};
    for (const id of [...this._ents.keys()].sort()) {
      const e = this._ents.get(id);
      const props = {}; for (const k of Object.keys(e.props).sort()) props[k] = { v: clone(e.props[k].v), ts: e.props[k].ts };
      ents[id] = { kind: e.kind, addTs: e.addTs, delTs: e.delTs, props };
    }
    return {
      id: this.id, version: 1,
      layers: this.layers(),
      elements: this._shapes(),
      connectors: this._all(['connector']).map(materialize),
      crdt: { entities: ents },
    };
  }
  toSVG(opts = {}) { return toSVG(this, opts); }
}

function normRect(r) {
  if (!r) fail('rect required');
  const x = r.x ?? r.left, y = r.y ?? r.top;
  const w = r.width ?? (r.right - x), h = r.height ?? (r.bottom - y);
  return { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, width: Math.abs(w), height: Math.abs(h) };
}
function containsPoint(s, px, py) {
  const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
  let dx = px - cx, dy = py - cy;
  if (s.rotation) {
    const a = -s.rotation * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
  }
  const hw = s.width / 2, hh = s.height / 2;
  if (s.type === 'ellipse') return hw > 0 && hh > 0 ? (dx / hw) ** 2 + (dy / hh) ** 2 <= 1 + 1e-9 : false;
  if (s.type === 'diamond') return hw > 0 && hh > 0 ? Math.abs(dx) / hw + Math.abs(dy) / hh <= 1 + 1e-9 : false;
  if (s.type === 'line') {
    const x1 = -hw, y1 = -hh, x2 = hw, y2 = hh;
    const len2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    let t = len2 ? ((dx - x1) * (x2 - x1) + (dy - y1) * (y2 - y1)) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(dx - (x1 + t * (x2 - x1)), dy - (y1 + t * (y2 - y1))) <= 4;
  }
  return Math.abs(dx) <= hw + 1e-9 && Math.abs(dy) <= hh + 1e-9;
}

// ---------- op handlers ----------
function checkNums(obj) {
  for (const k of NUMERIC) if (obj[k] !== undefined && !isNum(obj[k])) fail(`${k} must be a finite number`);
}
function checkEndpoint(doc, ep, which) {
  if (!ep || typeof ep !== 'object' || typeof ep.elementId !== 'string') fail(`connector ${which} requires elementId`);
  doc._ent(ep.elementId, ['shape']);
}
const OPS = {
  add(op) {
    const el = op.element;
    if (!el || typeof el !== 'object' || typeof el.id !== 'string' || !el.id) fail('element with id required');
    if (exists(this._ents.get(el.id))) fail(`duplicate id: ${el.id}`);
    checkNums(el);
    const layer = el.layer ?? DEFAULT_LAYER;
    this._checkLayerUnlocked(layer);
    let obj, kind;
    if (el.type === 'connector') {
      kind = 'connector';
      checkEndpoint(this, el.source, 'source'); checkEndpoint(this, el.target, 'target');
      if (el.routing !== undefined && el.routing !== 'straight' && el.routing !== 'orthogonal') fail('bad routing');
      obj = { routing: 'straight', waypoints: [], label: '', style: {}, ...el, layer };
    } else if (SHAPES.has(el.type)) {
      kind = 'shape';
      obj = { x: 0, y: 0, width: 0, height: 0, rotation: 0, style: {}, text: '', groupId: null, ...el, layer };
    } else fail(`unknown element type: ${el.type}`);
    if (obj.style === null || typeof obj.style !== 'object') fail('style must be an object');
    if (obj.z === undefined) obj.z = this._maxZ() + 1;
    this._ladd(el.id, kind, flatten(obj));
    return el.id;
  },
  update(op) {
    const ent = this._ent(op.id); this._checkUnlocked(ent);
    const p = op.patch;
    if (!p || typeof p !== 'object') fail('patch required');
    if (p.id !== undefined && p.id !== op.id) fail('cannot change id');
    if (p.type !== undefined && p.type !== this._val(op.id, 'type')) fail('cannot change type');
    checkNums(p);
    if (p.layer !== undefined) this._checkLayerUnlocked(p.layer);
    if (p.style !== undefined && p.style !== null && typeof p.style !== 'object') fail('style must be an object');
    if (ent.kind === 'connector') {
      if (p.source) checkEndpoint(this, p.source, 'source');
      if (p.target) checkEndpoint(this, p.target, 'target');
      if (p.routing !== undefined && p.routing !== 'straight' && p.routing !== 'orthogonal') fail('bad routing');
    }
    for (const k of Object.keys(p)) {
      if (k === 'id' || k === 'type') continue;
      if (k === 'style') { for (const sk of Object.keys(p.style || {})) this._lset(op.id, 'style.' + sk, p.style[sk]); }
      else this._lset(op.id, k, p[k]);
    }
  },
  remove(op) {
    const ent = this._ent(op.id); this._checkUnlocked(ent);
    const att = ent.kind === 'shape' ? this._rawAttached(op.id) : [];
    att.forEach((c) => this._checkUnlocked(c));
    for (const c of att) this._ldel(c.id);
    this._ldel(op.id);
  },
  move(op) {
    if (!Array.isArray(op.ids) || !isNum(op.dx) || !isNum(op.dy)) fail('move requires ids, dx, dy');
    const ents = op.ids.map((id) => this._ent(id));
    ents.forEach((e) => this._checkUnlocked(e));
    for (const e of ents) {
      if (e.kind === 'shape') { this._lset(e.id, 'x', this._val(e.id, 'x') + op.dx); this._lset(e.id, 'y', this._val(e.id, 'y') + op.dy); }
      else {
        const wp = (this._val(e.id, 'waypoints') || []).map((p) => (Array.isArray(p) ? [p[0] + op.dx, p[1] + op.dy] : { ...p, x: p.x + op.dx, y: p.y + op.dy }));
        this._lset(e.id, 'waypoints', wp);
      }
    }
  },
  resize(op) {
    const ent = this._ent(op.id, ['shape']); this._checkUnlocked(ent);
    const b = op.box;
    if (!b || !['x', 'y', 'width', 'height'].every((k) => isNum(b[k])) || b.width < 0 || b.height < 0) fail('invalid box');
    let { x, y, width, height } = b;
    if (op.keepAspect) {
      const w0 = this._val(op.id, 'width'), h0 = this._val(op.id, 'height');
      if (w0 > 0 && h0 > 0) {
        if (width !== w0 || height === h0) height = width * h0 / w0; else width = height * w0 / h0;
      }
    }
    this._lset(op.id, 'x', x); this._lset(op.id, 'y', y); this._lset(op.id, 'width', width); this._lset(op.id, 'height', height);
  },
  rotate(op) {
    const ent = this._ent(op.id, ['shape']); this._checkUnlocked(ent);
    if (!isNum(op.deg)) fail('deg must be a number');
    this._lset(op.id, 'rotation', op.deg);
  },
  group(op) {
    if (!Array.isArray(op.ids) || !op.ids.length) fail('ids required');
    const ents = op.ids.map((id) => this._ent(id, ['shape']));
    ents.forEach((e) => this._checkUnlocked(e));
    const gid = op.groupId ?? `g:${this.actor}:${this._clock + 1}`;
    for (const e of ents) this._lset(e.id, 'groupId', gid);
    return gid;
  },
  ungroup(op) {
    const ents = this._all(['shape']).filter((e) => this._val(e.id, 'groupId') === op.groupId);
    if (!ents.length) fail(`unknown group: ${op.groupId}`);
    ents.forEach((e) => this._checkUnlocked(e));
    for (const e of ents) this._lset(e.id, 'groupId', null);
  },
  reorder(op) {
    const ent = this._ent(op.id); this._checkUnlocked(ent);
    if (!['front', 'back', 'forward', 'backward'].includes(op.to)) fail('bad reorder target');
    const list = this._all(); const i = list.findIndex((e) => e.id === op.id);
    const z = (e) => this._val(e.id, 'z') ?? 0;
    let nz;
    if (op.to === 'front') { if (i === list.length - 1) return; nz = z(list[list.length - 1]) + 1; }
    else if (op.to === 'back') { if (i === 0) return; nz = z(list[0]) - 1; }
    else if (op.to === 'forward') {
      if (i === list.length - 1) return;
      const n = list[i + 1], nn = list[i + 2]; nz = nn && z(nn) !== z(n) ? (z(n) + z(nn)) / 2 : z(n) + 1;
    } else {
      if (i === 0) return;
      const p = list[i - 1], pp = list[i - 2]; nz = pp && z(pp) !== z(p) ? (z(p) + z(pp)) / 2 : z(p) - 1;
    }
    this._lset(op.id, 'z', nz);
  },
  addLayer(op) {
    const l = op.layer;
    if (!l || typeof l.id !== 'string' || !l.id) fail('layer id required');
    if (exists(this._ents.get(l.id))) fail(`duplicate id: ${l.id}`);
    const order = isNum(l.order) ? l.order : Math.max(-1, ...this.layers().map((x) => x.order)) + 1;
    this._ladd(l.id, 'layer', { name: l.name ?? l.id, visible: l.visible ?? true, locked: l.locked ?? false, order });
  },
  updateLayer(op) {
    this._layerEnt(op.id);
    if (!op.patch || typeof op.patch !== 'object') fail('patch required');
    for (const k of Object.keys(op.patch)) if (['name', 'visible', 'locked', 'order'].includes(k)) this._lset(op.id, k, op.patch[k]);
  },
  removeLayer(op) {
    this._layerEnt(op.id);
    if (op.id === DEFAULT_LAYER) fail('cannot remove the default layer');
    this._checkLayerUnlocked(op.id);
    const inside = this._all(['shape']).filter((e) => this._val(e.id, 'layer') === op.id);
    for (const e of inside) for (const c of this._rawAttached(e.id)) this._checkUnlocked(c);
    for (const e of inside) { for (const c of this._rawAttached(e.id)) this._ldel(c.id); this._ldel(e.id); }
    for (const e of this._all(['connector'])) if (this._val(e.id, 'layer') === op.id) this._ldel(e.id);
    this._ldel(op.id);
  },
  setStyle(op) {
    if (!Array.isArray(op.ids) || !op.style || typeof op.style !== 'object') fail('ids and style required');
    const ents = op.ids.map((id) => this._ent(id));
    ents.forEach((e) => this._checkUnlocked(e));
    for (const e of ents) for (const k of Object.keys(op.style)) this._lset(e.id, 'style.' + k, op.style[k]);
  },
};

export function createDocument({ id = 'doc', actor = 'local' } = {}) { return new Doc(id, actor); }

export function fromJSON(json, opts = {}) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (!j || typeof j !== 'object' || !j.crdt) fail('invalid document JSON');
  const doc = new Doc(j.id, opts.actor ?? 'local');
  doc._ents = new Map(); let clock = 0;
  for (const [id, e] of Object.entries(j.crdt.entities)) {
    const ent = { id, kind: e.kind, addTs: e.addTs, delTs: e.delTs, props: {} };
    for (const k of Object.keys(e.props)) { ent.props[k] = { v: clone(e.props[k].v), ts: e.props[k].ts }; clock = Math.max(clock, e.props[k].ts[0]); }
    if (e.addTs) clock = Math.max(clock, e.addTs[0]);
    if (e.delTs) clock = Math.max(clock, e.delTs[0]);
    doc._ents.set(id, ent);
  }
  if (!doc._ents.has(DEFAULT_LAYER)) doc._bootstrap();
  doc._clock = clock;
  return doc;
}

export function snap(point, { grid, guides, threshold = 5 } = {}) {
  let { x, y } = point;
  const pick = (v, axis) => {
    let best = null, bd = threshold + 1e-9;
    const list = [];
    if (Array.isArray(guides)) for (const g of guides) {
      if (isNum(g)) list.push(g);
      else if (g && typeof g === 'object') {
        const gv = g.value ?? g.position ?? g.pos;
        if (g.x !== undefined && axis === 'x') list.push(g.x);
        else if (g.y !== undefined && axis === 'y') list.push(g.y);
        else if ((g.axis === axis || g.orientation === (axis === 'x' ? 'vertical' : 'horizontal')) && isNum(gv)) list.push(gv);
      }
    } else if (guides && typeof guides === 'object') for (const g of guides[axis] || guides[axis + 's'] || []) list.push(g);
    for (const g of list) { const d = Math.abs(g - v); if (d < bd) { bd = d; best = g; } }
    if (best !== null) return best;
    if (isNum(grid) && grid > 0) return Math.round(v / grid) * grid;
    return v;
  };
  return { x: pick(x, 'x'), y: pick(y, 'y') };
}

// ---------- routing implementation ----------
const rectOf = (s) => ({ l: s.x, t: s.y, r: s.x + s.width, b: s.y + s.height });
function boundaryPoint(s, toward) {
  const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
  const dx = toward[0] - cx, dy = toward[1] - cy, hw = s.width / 2, hh = s.height / 2;
  if (!dx && !dy) return [cx + hw, cy];
  let k;
  if (s.type === 'ellipse') k = 1 / Math.sqrt((dx / (hw || 1e-9)) ** 2 + (dy / (hh || 1e-9)) ** 2);
  else if (s.type === 'diamond') k = 1 / (Math.abs(dx) / (hw || 1e-9) + Math.abs(dy) / (hh || 1e-9));
  else k = Math.min(Math.abs(dx) > 1e-12 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-12 ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * k, cy + dy * k];
}
const SIDES = {
  right: { d: 0, pt: (s) => [s.x + s.width, s.y + s.height / 2] },
  bottom: { d: 1, pt: (s) => [s.x + s.width / 2, s.y + s.height] },
  left: { d: 2, pt: (s) => [s.x, s.y + s.height / 2] },
  top: { d: 3, pt: (s) => [s.x + s.width / 2, s.y] },
};
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const dedupe = (pts) => {
  const out = [];
  for (const p of pts) { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
};

function routeConnector(c, s, t, obstacles, docBounds) {
  const sc = [s.x + s.width / 2, s.y + s.height / 2], tc = [t.x + t.width / 2, t.y + t.height / 2];
  const wps = (c.waypoints || []).map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));
  if (c.routing !== 'orthogonal') {
    const sp = c.source.port && SIDES[c.source.port] ? SIDES[c.source.port].pt(s) : boundaryPoint(s, wps[0] || tc);
    const tp = c.target.port && SIDES[c.target.port] ? SIDES[c.target.port].pt(t) : boundaryPoint(t, wps[wps.length - 1] || sc);
    return [sp, ...wps, tp];
  }
  for (const m of [10, 0]) {
    const r = orthoRoute(c, s, t, obstacles, docBounds, m);
    if (r) return r;
  }
  const sp = boundaryPoint(s, tc), tp = boundaryPoint(t, sc), my = (sp[1] + tp[1]) / 2;
  return dedupe([sp, [sp[0], my], [tp[0], my], tp]);
}

function orthoRoute(c, s, t, obstacles, docBounds, m) {
  const srcSides = c.source.port && SIDES[c.source.port] ? [c.source.port] : Object.keys(SIDES);
  const dstSides = c.target.port && SIDES[c.target.port] ? [c.target.port] : Object.keys(SIDES);
  const blockers = obstacles.map((o) => { const r = rectOf(o); return { l: r.l - m, t: r.t - m, r: r.r + m, b: r.b + m }; });
  blockers.push(rectOf(s), rectOf(t));
  const starts = srcSides.map((n) => ({ side: n, p: SIDES[n].pt(s), d: SIDES[n].d }));
  const goals = dstSides.map((n) => ({ side: n, p: SIDES[n].pt(t), d: (SIDES[n].d + 2) % 4 }));
  const xsSet = new Set(), ysSet = new Set();
  const all = [...obstacles, s, t];
  let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
  for (const o of all) { bx1 = Math.min(bx1, o.x); by1 = Math.min(by1, o.y); bx2 = Math.max(bx2, o.x + o.width); by2 = Math.max(by2, o.y + o.height); }
  if (docBounds) { bx1 = Math.min(bx1, docBounds.x); by1 = Math.min(by1, docBounds.y); bx2 = Math.max(bx2, docBounds.x + docBounds.width); by2 = Math.max(by2, docBounds.y + docBounds.height); }
  bx1 -= 100; by1 -= 100; bx2 += 100; by2 += 100;
  xsSet.add(bx1); xsSet.add(bx2); ysSet.add(by1); ysSet.add(by2);
  for (const o of all) {
    for (const x of [o.x - m, o.x, o.x + o.width, o.x + o.width + m, o.x + o.width / 2]) xsSet.add(x);
    for (const y of [o.y - m, o.y, o.y + o.height, o.y + o.height + m, o.y + o.height / 2]) ysSet.add(y);
  }
  for (const g of [...starts, ...goals]) { xsSet.add(g.p[0]); ysSet.add(g.p[1]); }
  if (m === 0) { for (const o of all) { xsSet.add(o.x - 10); xsSet.add(o.x + o.width + 10); ysSet.add(o.y - 10); ysSet.add(o.y + o.height + 10); } }
  const xs = [...xsSet].filter((x) => x >= bx1 && x <= bx2).sort((a, b) => a - b);
  const ys = [...ysSet].filter((y) => y >= by1 && y <= by2).sort((a, b) => a - b);
  const xi = new Map(xs.map((x, i) => [x, i])), yi = new Map(ys.map((y, i) => [y, i]));
  const ny = ys.length;
  const segBlocked = (x1, y1, x2, y2) => {
    for (const r of blockers) {
      if (y1 === y2) { if (y1 > r.t && y1 < r.b && Math.max(x1, x2) > r.l && Math.min(x1, x2) < r.r) return true; }
      else if (x1 > r.l && x1 < r.r && Math.max(y1, y2) > r.t && Math.min(y1, y2) < r.b) return true;
    }
    return false;
  };
  const cache = new Map();
  const edgeOk = (ax, ay, bx, by) => {
    const key = (ax * ny + ay) * 4096 + (bx * ny + by);
    let v = cache.get(key);
    if (v === undefined) { v = !segBlocked(xs[ax], ys[ay], xs[bx], ys[by]); cache.set(key, v); }
    return v;
  };
  const sid = (ix, iy, d) => (ix * ny + iy) * 4 + d;
  const dist = new Map(), parent = new Map();
  const heap = [];
  const push = (cost, st) => { heap.push([cost, st]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m2 = i; if (l < heap.length && heap[l][0] < heap[m2][0]) m2 = l; if (r < heap.length && heap[r][0] < heap[m2][0]) m2 = r; if (m2 === i) break; [heap[m2], heap[i]] = [heap[i], heap[m2]]; i = m2; } } return top; };
  const goalMap = new Map(goals.map((g) => [sid(xi.get(g.p[0]), yi.get(g.p[1]), g.d), g]));
  for (const st of starts) {
    const ix = xi.get(st.p[0]), iy = yi.get(st.p[1]);
    const nx = ix + DX[st.d], ny2 = iy + DY[st.d];
    if (nx < 0 || ny2 < 0 || nx >= xs.length || ny2 >= ny) continue;
    if (!edgeOk(ix, iy, nx, ny2)) continue;
    const id = sid(nx, ny2, st.d);
    const cost = Math.abs(xs[nx] - xs[ix]) + Math.abs(ys[ny2] - ys[iy]);
    if (!dist.has(id) || cost < dist.get(id)) { dist.set(id, cost); parent.set(id, { start: st }); push(cost, id); }
  }
  let found = null;
  while (heap.length) {
    const [cost, id] = pop();
    if (cost > dist.get(id)) continue;
    if (goalMap.has(id)) { found = id; break; }
    const d = id & 3, node = id >> 2, ix = Math.floor(node / ny), iy = node % ny;
    for (const nd of [d, (d + 1) & 3, (d + 3) & 3]) {
      const nx = ix + DX[nd], ny2 = iy + DY[nd];
      if (nx < 0 || ny2 < 0 || nx >= xs.length || ny2 >= ny) continue;
      if (!edgeOk(ix, iy, nx, ny2)) continue;
      const nid = sid(nx, ny2, nd);
      const nc = cost + Math.abs(xs[nx] - xs[ix]) + Math.abs(ys[ny2] - ys[iy]) + (nd !== d ? 25 : 0);
      if (!dist.has(nid) || nc < dist.get(nid)) { dist.set(nid, nc); parent.set(nid, { prev: id }); push(nc, nid); }
    }
  }
  if (found === null) return null;
  const pts = []; let cur = found;
  for (;;) {
    const node = cur >> 2; pts.push([xs[Math.floor(node / ny)], ys[node % ny]]);
    const p = parent.get(cur);
    if (p.start) { pts.push(p.start.p); break; }
    cur = p.prev;
  }
  return dedupe(pts.reverse());
}

// ---------- layout ----------
function layoutGrid(doc, opts) {
  const spacing = opts.spacing ?? 50;
  const shapes = doc._shapes();
  if (!shapes.length) return;
  const b = doc.bounds();
  const cols = opts.columns ?? Math.ceil(Math.sqrt(shapes.length));
  const cw = Math.max(...shapes.map((s) => s.width)), ch = Math.max(...shapes.map((s) => s.height));
  doc.transaction(() => {
    shapes.forEach((s, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      doc.apply({ type: 'update', id: s.id, patch: { x: b.x + col * (cw + spacing) + (cw - s.width) / 2, y: b.y + row * (ch + spacing) + (ch - s.height) / 2 } });
    });
  });
}

function layoutLayered(doc, opts) {
  const dir = opts.direction === 'LR' ? 'LR' : 'TB';
  const spacing = opts.spacing ?? 60;
  const shapes = doc._shapes();
  if (!shapes.length) return;
  const idx = new Map(shapes.map((s, i) => [s.id, i]));
  const n = shapes.length;
  const edges = [];
  for (const c of doc._all(['connector']).map(materialize)) {
    const a = idx.get(c.source.elementId), b = idx.get(c.target.elementId);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  // cycle removal
  const adj = Array.from({ length: n }, () => []);
  edges.forEach(([a, b], i) => adj[a].push([b, i]));
  const state = new Array(n).fill(0), rev = new Set();
  const dfs = (u) => { state[u] = 1; for (const [v, i] of adj[u]) { if (state[v] === 1) rev.add(i); else if (state[v] === 0) dfs(v); } state[u] = 2; };
  for (let i = 0; i < n; i++) if (!state[i]) dfs(i);
  const dag = edges.map(([a, b], i) => (rev.has(i) ? [b, a] : [a, b]));
  // longest path layering
  const indeg = new Array(n).fill(0), out = Array.from({ length: n }, () => []);
  dag.forEach(([a, b]) => { out[a].push(b); indeg[b]++; });
  const layer = new Array(n).fill(0), q = []; const deg = [...indeg];
  for (let i = 0; i < n; i++) if (!deg[i]) q.push(i);
  while (q.length) { const u = q.shift(); for (const v of out[u]) { layer[v] = Math.max(layer[v], layer[u] + 1); if (--deg[v] === 0) q.push(v); } }
  // dummy nodes
  const nodes = shapes.map((s, i) => ({ id: i, layer: layer[i], real: true }));
  const links = [];
  for (const [a, b] of dag) {
    let prev = a;
    for (let l = layer[a] + 1; l < layer[b]; l++) { const d = { id: nodes.length, layer: l, real: false }; nodes.push(d); links.push([prev, d.id]); prev = d.id; }
    links.push([prev, b]);
  }
  const nl = Math.max(...layer) + 1;
  let layers = Array.from({ length: nl }, () => []);
  nodes.forEach((nd) => layers[nd.layer].push(nd.id));
  const up = nodes.map(() => []), down = nodes.map(() => []);
  links.forEach(([a, b]) => { down[a].push(b); up[b].push(a); });
  const crossings = (ls) => {
    let total = 0;
    const pos = new Map(); ls.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
    for (let k = 0; k + 1 < ls.length; k++) {
      const es = []; for (const a of ls[k]) for (const b of down[a]) es.push([pos.get(a), pos.get(b)]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++)
        if ((es[i][0] - es[j][0]) * (es[i][1] - es[j][1]) < 0) total++;
    }
    return total;
  };
  let best = layers.map((l) => [...l]), bestC = crossings(best);
  let work = layers.map((l) => [...l]);
  const sweep = (downward) => {
    const order = downward ? [...work.keys()].slice(1) : [...work.keys()].slice(0, -1).reverse();
    for (const k of order) {
      const ref = work[downward ? k - 1 : k + 1]; const rp = new Map(ref.map((id, i) => [id, i]));
      const cur = new Map(work[k].map((id, i) => [id, i]));
      const bary = (id) => { const nb = (downward ? up : down)[id]; return nb.length ? nb.reduce((a, x) => a + rp.get(x), 0) / nb.length : cur.get(id); };
      work[k] = [...work[k]].sort((a, b) => (bary(a) - bary(b)) || (cur.get(a) - cur.get(b)));
    }
  };
  for (let it = 0; it < 12; it++) {
    sweep(it % 2 === 0);
    const c = crossings(work);
    if (c < bestC) { bestC = c; best = work.map((l) => [...l]); }
  }
  layers = best;
  const flowSize = (id) => (nodes[id].real ? (dir === 'TB' ? shapes[id].height : shapes[id].width) : 0);
  const crossSize = (id) => (nodes[id].real ? (dir === 'TB' ? shapes[id].width : shapes[id].height) : 1);
  const center = new Map();
  layers.forEach((l) => { let p = 0; for (const id of l) { center.set(id, p + crossSize(id) / 2); p += crossSize(id) + spacing; } });
  const widths = layers.map((l) => l.reduce((a, id) => a + crossSize(id) + spacing, -spacing));
  const maxW = Math.max(...widths);
  layers.forEach((l, k) => { const off = (maxW - widths[k]) / 2; l.forEach((id) => center.set(id, center.get(id) + off)); });
  const place = (l, desired) => {
    let edge = -Infinity;
    for (const id of l) { const c = Math.max(desired(id), edge + (edge === -Infinity ? 0 : spacing) + crossSize(id) / 2); center.set(id, c); edge = c + crossSize(id) / 2; }
  };
  for (let it = 0; it < 4; it++) {
    const downward = it % 2 === 0;
    const ks = downward ? [...layers.keys()].slice(1) : [...layers.keys()].slice(0, -1).reverse();
    for (const k of ks) {
      place(layers[k], (id) => { const nb = (downward ? up : down)[id]; return nb.length ? nb.reduce((a, x) => a + center.get(x), 0) / nb.length : center.get(id); });
    }
  }
  const b = doc.bounds();
  let minC = Infinity; for (const l of layers) for (const id of l) minC = Math.min(minC, center.get(id) - crossSize(id) / 2);
  const crossOrigin = dir === 'TB' ? b.x : b.y, flowOrigin = dir === 'TB' ? b.y : b.x;
  const layerSize = layers.map((l) => Math.max(0, ...l.map(flowSize)));
  const layerStart = []; let acc = flowOrigin;
  layerSize.forEach((sz, k) => { layerStart.push(acc); acc += sz + spacing; });
  doc.transaction(() => {
    layers.forEach((l, k) => {
      for (const id of l) {
        if (!nodes[id].real) continue;
        const s = shapes[id];
        const cross = crossOrigin + center.get(id) - minC - crossSize(id) / 2;
        const flow = layerStart[k] + (layerSize[k] - flowSize(id)) / 2;
        const patch = dir === 'TB' ? { x: cross, y: flow } : { x: flow, y: cross };
        doc.apply({ type: 'update', id: s.id, patch });
      }
    });
  });
}

// ---------- SVG ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (n) => Math.round(n * 100) / 100;
function toSVG(doc, { padding = 20 } = {}) {
  const vis = new Map(doc.layers().map((l) => [l.id, l.visible]));
  const list = doc.elements().filter((e) => vis.get(e.layer) !== false);
  const routes = new Map();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of list) {
    if (e.type === 'connector') {
      const r = doc.route(e.id); routes.set(e.id, r);
      for (const [px, py] of r) { x1 = Math.min(x1, px); y1 = Math.min(y1, py); x2 = Math.max(x2, px); y2 = Math.max(y2, py); }
    } else { x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y); x2 = Math.max(x2, e.x + e.width); y2 = Math.max(y2, e.y + e.height); }
  }
  if (!list.length) { x1 = y1 = 0; x2 = y2 = 0; }
  const vx = x1 - padding, vy = y1 - padding, vw = x2 - x1 + 2 * padding, vh = y2 - y1 + 2 * padding;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${num(vw)}" height="${num(vh)}" viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}">`];
  for (const e of list) {
    const st = e.style || {};
    const fill = st.fill ?? '#ffffff', stroke = st.stroke ?? '#000000', sw = st.strokeWidth ?? 1;
    const op = st.opacity !== undefined ? ` opacity="${esc(st.opacity)}"` : '';
    const fs = st.fontSize ?? 14, ff = st.fontFamily ?? 'sans-serif', color = st.color ?? '#000000';
    if (e.type === 'connector') {
      const r = routes.get(e.id);
      const pts = r.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
      let g = `<g data-id="${esc(e.id)}" data-type="connector"${op}><polyline points="${pts}" fill="none" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"/>`;
      if (e.label) { const mid = r[Math.floor((r.length - 1) / 2)], nx = r[Math.ceil((r.length - 1) / 2)]; g += `<text x="${num((mid[0] + nx[0]) / 2)}" y="${num((mid[1] + nx[1]) / 2)}" text-anchor="middle" font-size="${esc(fs)}" font-family="${esc(ff)}" fill="${esc(color)}">${esc(e.label)}</text>`; }
      out.push(g + '</g>');
      continue;
    }
    const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
    const tr = e.rotation ? ` transform="rotate(${num(e.rotation)} ${num(cx)} ${num(cy)})"` : '';
    let body;
    const attrs = `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"`;
    if (e.type === 'rect') body = `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.width)}" height="${num(e.height)}" ${attrs}/>`;
    else if (e.type === 'ellipse') body = `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(e.width / 2)}" ry="${num(e.height / 2)}" ${attrs}/>`;
    else if (e.type === 'diamond') body = `<polygon points="${num(cx)},${num(e.y)} ${num(e.x + e.width)},${num(cy)} ${num(cx)},${num(e.y + e.height)} ${num(e.x)},${num(cy)}" ${attrs}/>`;
    else if (e.type === 'line') body = `<line x1="${num(e.x)}" y1="${num(e.y)}" x2="${num(e.x + e.width)}" y2="${num(e.y + e.height)}" stroke="${esc(stroke)}" stroke-width="${esc(sw)}"/>`;
    else if (e.type === 'image') body = `<image x="${num(e.x)}" y="${num(e.y)}" width="${num(e.width)}" height="${num(e.height)}" href="${esc(st.src ?? '')}"/>`;
    else body = '';
    let txt = '';
    if (e.text) txt = `<text x="${num(cx)}" y="${num(cy)}" text-anchor="middle" dominant-baseline="middle" font-size="${esc(fs)}" font-family="${esc(ff)}" fill="${esc(color)}">${esc(e.text)}</text>`;
    out.push(`<g data-id="${esc(e.id)}" data-type="${e.type}"${tr}${op}>${body}${txt}</g>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

// ---------- draw.io import ----------
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[6] !== undefined) { top.text += decodeEntities(m[6]); continue; }
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[3] === undefined) continue;
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a;
    while ((a = ar.exec(m[4]))) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
    const node = { name: m[3], attrs, children: [], text: '' };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}
function walk(node, fn) { fn(node); for (const c of node.children) walk(c, fn); }
function parseStyle(s) {
  const o = {};
  for (const part of (s || '').split(';')) { if (!part) continue; const i = part.indexOf('='); if (i < 0) o[part] = true; else o[part.slice(0, i)] = part.slice(i + 1); }
  return o;
}
export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string') fail('xml string required');
  const root = parseXml(xml);
  let hasModel = false, compressed = false;
  walk(root, (n) => { if (n.name === 'mxGraphModel') hasModel = true; if (n.name === 'diagram' && n.text.trim() && !n.children.length) compressed = true; });
  if (!hasModel) fail(compressed ? 'compressed draw.io diagrams are not supported' : 'no mxGraphModel found');
  const cells = [];
  const visit = (node, wrapper) => {
    for (const c of node.children) {
      if (c.name === 'mxCell') cells.push({ cell: c, wrap: wrapper });
      else if (c.name === 'UserObject' || c.name === 'object') visit(c, c);
      else visit(c, wrapper && c.name === 'mxCell' ? wrapper : null);
    }
  };
  // visit only inside the first mxGraphModel
  let model; walk(root, (n) => { if (!model && n.name === 'mxGraphModel') model = n; });
  visit(model, null);
  const byId = new Map();
  for (const { cell, wrap } of cells) {
    const id = (wrap?.attrs.id) ?? cell.attrs.id;
    const geo = cell.children.find((c) => c.name === 'mxGeometry');
    byId.set(id, { id, cell, wrap, geo, a: cell.attrs, style: parseStyle(cell.attrs.style), value: wrap ? (wrap.attrs.label ?? cell.attrs.value ?? '') : (cell.attrs.value ?? '') });
  }
  const abs = (c, depth = 0) => {
    const g = c.geo?.attrs || {};
    let x = parseFloat(g.x) || 0, y = parseFloat(g.y) || 0;
    const p = byId.get(c.a.parent);
    if (p && p.a.vertex === '1' && depth < 20) { const pa = abs(p, depth + 1); x += pa.x; y += pa.y; }
    return { x, y };
  };
  const doc = createDocument({ id: opts.id ?? 'imported', actor: opts.actor ?? 'import' });
  const clean = (c) => {
    let v = c.value;
    if (c.style.html === '1' || /<[a-z][\s\S]*>/i.test(v)) v = decodeEntities(v.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n+$/, '');
    return v;
  };
  const styleOf = (c) => {
    const st = {};
    if (c.style.fillColor && c.style.fillColor !== 'none') st.fill = c.style.fillColor; else if (c.style.fillColor === 'none') st.fill = 'none';
    if (c.style.strokeColor) st.stroke = c.style.strokeColor;
    if (c.style.fontColor) st.color = c.style.fontColor;
    if (c.style.fontSize) st.fontSize = Number(c.style.fontSize) || undefined;
    if (c.style.strokeWidth) st.strokeWidth = Number(c.style.strokeWidth) || undefined;
    if (c.style.opacity) st.opacity = Number(c.style.opacity) / 100;
    for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
    return st;
  };
  doc.transaction(() => {
    for (const c of byId.values()) {
      if (c.a.vertex !== '1') continue;
      const g = c.geo?.attrs || {}; const p = abs(c);
      let type = 'rect';
      const shape = c.style.shape;
      if (c.style.ellipse || shape === 'ellipse' || shape === 'doubleEllipse') type = 'ellipse';
      else if (c.style.rhombus || shape === 'rhombus') type = 'diamond';
      else if (c.style.text || shape === 'text') type = 'text';
      else if (shape === 'image') type = 'image';
      const style = styleOf(c); if (type === 'image' && c.style.image) style.src = c.style.image;
      doc.apply({ type: 'add', element: { id: c.id, type, x: p.x, y: p.y, width: parseFloat(g.width) || 0, height: parseFloat(g.height) || 0, rotation: parseFloat(c.style.rotation) || 0, text: clean(c), style } });
    }
    for (const c of byId.values()) {
      if (c.a.edge !== '1') continue;
      if (!doc.get(c.a.source) || !doc.get(c.a.target)) continue;
      const pts = c.geo?.children.find((n) => n.name === 'Array' && n.attrs.as === 'points');
      const waypoints = (pts?.children || []).filter((n) => n.name === 'mxPoint').map((n) => [parseFloat(n.attrs.x) || 0, parseFloat(n.attrs.y) || 0]);
      const es = String(c.style.edgeStyle || '');
      doc.apply({ type: 'add', element: { id: c.id, type: 'connector', source: { elementId: c.a.source }, target: { elementId: c.a.target }, routing: /orthogonal|elbow/i.test(es) ? 'orthogonal' : 'straight', waypoints, label: clean(c), style: styleOf(c) } });
    }
  });
  doc._undo = []; doc._redo = [];
  return doc;
}
