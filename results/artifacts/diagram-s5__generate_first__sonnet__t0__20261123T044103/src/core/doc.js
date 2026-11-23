import { DiagramError } from './errors.js';
import { aabb, unionBox, containsPoint } from './geom.js';
import { routeConnector } from './route.js';
import { layoutLayered, layoutGrid } from './layout.js';
import { toSVG } from './svg.js';

export const DEFAULT_LAYER = 'default';
const SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);
const NUM_FIELDS = ['x', 'y', 'width', 'height', 'rotation'];
const HISTORY_LIMIT = 500;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const gt = (c1, a1, c2, a2) => c1 > c2 || (c1 === c2 && a1 > a2);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const EL_ORDER = ['id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'style', 'text', 'layer', 'groupId', 'z'];
const CN_ORDER = ['id', 'type', 'source', 'target', 'routing', 'waypoints', 'label', 'style', 'layer', 'z'];

export class Document {
  constructor({ id = 'doc', actor = 'local' } = {}) {
    this.id = id;
    this.actor = actor;
    this._ents = new Map();
    this._clock = 0;
    this._pending = [];
    this._listeners = {};
    this._undo = [];
    this._redo = [];
    this._txn = null;
    this._cache = null;
    this._seq = 0;
    this._seedDefaultLayer();
  }

  _seedDefaultLayer() {
    const r = this._rec('l', DEFAULT_LAYER);
    const P = { name: 'Layer 1', visible: true, locked: false, order: 0 };
    for (const k of Object.keys(P)) r.props[k] = [P[k], 0, ''];
  }

  _rec(ent, id) {
    const key = ent + ':' + id;
    let r = this._ents.get(key);
    if (!r) { r = { ent, id, props: {}, del: null, rev: null }; this._ents.set(key, r); }
    return r;
  }
  _find(ent, id) { return this._ents.get(ent + ':' + id); }
  _visible(r) {
    if (!r || !Object.keys(r.props).length) return false;
    if (!r.del) return true;
    return !!r.rev && gt(r.rev[0], r.rev[1], r.del[0], r.del[1]);
  }

  // ---- events
  on(ev, cb) {
    (this._listeners[ev] ||= []).push(cb);
    return () => { this._listeners[ev] = this._listeners[ev].filter((f) => f !== cb); };
  }
  _emit(ev, ...a) { for (const f of this._listeners[ev] || []) f(...a); }

  // ---- CRDT core
  _integrate(op) {
    const r = this._rec(op.ent, op.id);
    if (op.clk > this._clock) this._clock = op.clk;
    if (op.kind === 'put') {
      for (const k of Object.keys(op.props)) {
        const cur = r.props[k];
        if (!cur || gt(op.clk, op.actor, cur[1], cur[2])) r.props[k] = [clone(op.props[k]), op.clk, op.actor];
      }
      if (op.revive && (!r.rev || gt(op.clk, op.actor, r.rev[0], r.rev[1]))) r.rev = [op.clk, op.actor];
    } else if (op.kind === 'del') {
      if (!r.del || gt(op.clk, op.actor, r.del[0], r.del[1])) r.del = [op.clk, op.actor];
    }
    this._cache = null;
  }

  _snapshotProps(r) {
    const p = {};
    for (const k of Object.keys(r.props)) p[k] = clone(r.props[k][0]);
    return p;
  }

  // Apply specs as local ops. Returns inverse specs (already in undo order).
  _commit(specs) {
    const inv = [];
    for (const s of specs) {
      const r = this._find(s.ent, s.id);
      const vis = this._visible(r);
      if (s.kind === 'put') {
        if (!vis) inv.push({ kind: 'del', ent: s.ent, id: s.id });
        else {
          const props = {};
          for (const k of Object.keys(s.props)) props[k] = r.props[k] ? clone(r.props[k][0]) : null;
          inv.push({ kind: 'put', ent: s.ent, id: s.id, props });
        }
      } else if (vis) inv.push({ kind: 'put', ent: s.ent, id: s.id, props: this._snapshotProps(r), revive: true });
      const op = { opid: `${this.actor}:${this._clock + 1}`, actor: this.actor, clk: this._clock + 1, kind: s.kind, ent: s.ent, id: s.id };
      if (s.kind === 'put') { op.props = clone(s.props); if (s.revive) op.revive = true; }
      this._integrate(op);
      this._pending.push(op);
      this._emit('op', clone(op));
    }
    inv.reverse();
    if (specs.length) this._emit('change', 'local');
    return inv;
  }

  _record(inv) {
    if (!inv.length) return;
    if (this._txn) { this._txn.unshift(...inv); return; }
    this._undo.push(inv);
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this._redo = [];
  }

  transaction(fn) {
    if (this._txn) return fn(this);
    this._txn = [];
    let res;
    try { res = fn(this); } catch (e) {
      const inv = this._txn; this._txn = null;
      if (inv.length) this._commit(inv);
      throw e;
    }
    const inv = this._txn; this._txn = null;
    this._record(inv);
    return res;
  }

  undo() {
    const inv = this._undo.pop();
    if (!inv) return false;
    const redo = this._commit(inv);
    this._redo.push(redo);
    return true;
  }
  redo() {
    const inv = this._redo.pop();
    if (!inv) return false;
    const undo = this._commit(inv);
    this._undo.push(undo);
    return true;
  }
  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  pendingOps() { const p = this._pending; this._pending = []; return p; }

  receive(ops) {
    if (!Array.isArray(ops)) ops = ops ? [ops] : [];
    for (const op of ops) {
      if (!isObj(op) || (op.kind !== 'put' && op.kind !== 'del') || (op.ent !== 'e' && op.ent !== 'l') ||
        typeof op.id !== 'string' || typeof op.clk !== 'number' || typeof op.actor !== 'string' ||
        (op.kind === 'put' && !isObj(op.props))) throw new DiagramError('malformed op');
    }
    let changed = false;
    for (const op of ops) { this._integrate(op); changed = true; }
    if (changed) this._emit('change', 'remote');
  }

  // ---- materialisation
  _materialize(r) {
    const o = {};
    const style = {};
    for (const k of Object.keys(r.props)) {
      const v = r.props[k][0];
      if (k.startsWith('style.')) { if (v !== null) style[k.slice(6)] = clone(v); } else o[k] = clone(v);
    }
    o.id = r.id;
    o.style = Object.fromEntries(Object.keys(style).sort().map((k) => [k, style[k]]));
    const order = o.type === 'connector' ? CN_ORDER : EL_ORDER;
    const out = {};
    for (const k of order) if (k in o) out[k] = o[k];
    for (const k of Object.keys(o).sort()) if (!(k in out)) out[k] = o[k];
    return out;
  }

  _all() {
    if (this._cache) return this._cache;
    const items = [];
    const layers = new Map();
    for (const r of this._ents.values()) {
      if (!this._visible(r)) continue;
      if (r.ent === 'l') {
        const P = (k, d) => (r.props[k] ? r.props[k][0] : d);
        layers.set(r.id, { id: r.id, name: P('name', r.id), visible: P('visible', true), locked: P('locked', false), order: P('order', 0) });
      }
    }
    const shapes = new Map();
    for (const r of this._ents.values()) {
      if (r.ent !== 'e' || !this._visible(r)) continue;
      const o = this._materialize(r);
      if (!o.type) continue;
      items.push(o);
      if (o.type !== 'connector') shapes.set(o.id, o);
    }
    const live = items.filter((o) => o.type !== 'connector' ||
      ((!o.source?.elementId || shapes.has(o.source.elementId)) && (!o.target?.elementId || shapes.has(o.target.elementId))));
    const lo = (o) => layers.get(o.layer)?.order ?? 0;
    live.sort((a, b) => lo(a) - lo(b) || (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const layerList = [...layers.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
    this._cache = { items: live, byId: new Map(live.map((o) => [o.id, o])), layers: layerList, layerById: layers };
    return this._cache;
  }

  get(id) { const o = this._all().byId.get(id); return o ? clone(o) : undefined; }
  layers() { return clone(this._all().layers); }
  getLayer(id) { const l = this._all().layerById.get(id); return l ? clone(l) : undefined; }
  groups() {
    const m = new Map();
    for (const o of this._all().items) if (o.groupId) { if (!m.has(o.groupId)) m.set(o.groupId, []); m.get(o.groupId).push(o.id); }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, ids]) => ({ id, ids: ids.sort() }));
  }

  elements(filter = {}) {
    let list = this._all().items;
    if (filter?.layer !== undefined) list = list.filter((o) => o.layer === filter.layer);
    if (filter?.type !== undefined) list = list.filter((o) => o.type === filter.type);
    return clone(list);
  }
  _shapes() { return this._all().items.filter((o) => o.type !== 'connector'); }
  _layerVisible(o) { return this._all().layerById.get(o.layer)?.visible !== false; }

  hitTest(x, y) {
    const list = this._shapes();
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      if (!this._layerVisible(o)) continue;
      if (containsPoint(o, x, y)) return clone(o);
    }
    return null;
  }
  select(rect) {
    const x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.width, y2 = rect.y + rect.height;
    const out = [];
    for (const o of this._shapes()) {
      if (!this._layerVisible(o)) continue;
      const b = aabb(o);
      if (b.x >= x1 && b.y >= y1 && b.x + b.width <= x2 && b.y + b.height <= y2) out.push(clone(o));
    }
    return out;
  }
  bounds(ids) {
    const list = ids ? ids.map((i) => this._all().byId.get(i)).filter((o) => o && o.type !== 'connector') : this._shapes();
    return unionBox(list.map(aabb));
  }

  // ---- validation helpers
  _layerOf(o) { return this._all().layerById.get(o.layer); }
  _assertUnlocked(o) {
    const l = this._layerOf(o);
    if (l && l.locked) throw new DiagramError(`layer ${l.id} is locked`);
  }
  _need(id) {
    const o = this._all().byId.get(id);
    if (!o) throw new DiagramError(`unknown id: ${id}`);
    return o;
  }
  _checkNums(o) {
    for (const k of NUM_FIELDS) if (k in o && (typeof o[k] !== 'number' || !Number.isFinite(o[k]))) throw new DiagramError(`${k} must be a number`);
  }
  _maxZ(layer) {
    let m = 0;
    for (const o of this._all().items) if (typeof o.z === 'number' && o.z > m && (layer === undefined || o.layer === layer)) m = o.z;
    return m;
  }

  _putSpec(id, props, extra) { return { kind: 'put', ent: 'e', id, props, ...extra }; }
  _styleProps(style) {
    const p = {};
    for (const k of Object.keys(style || {})) p['style.' + k] = style[k] === undefined ? null : style[k];
    return p;
  }

  // ---- operations
  apply(op) {
    if (!isObj(op) || typeof op.type !== 'string') throw new DiagramError('invalid operation');
    const specs = this._plan(op);
    const inv = this._commit(specs);
    this._record(inv);
    return this;
  }

  _plan(op) {
    const specs = [];
    switch (op.type) {
      case 'add': {
        const el = op.element;
        if (!isObj(el) || typeof el.id !== 'string' || !el.id) throw new DiagramError('add requires element with id');
        if (this._all().byId.has(el.id)) throw new DiagramError(`duplicate id: ${el.id}`);
        const props = {};
        if (el.type === 'connector') {
          if (!isObj(el.source) || !isObj(el.target)) {
            if (el.source === undefined || el.target === undefined) throw new DiagramError('connector needs source and target');
          }
          const routing = el.routing ?? 'straight';
          if (routing !== 'straight' && routing !== 'orthogonal') throw new DiagramError('bad routing');
          Object.assign(props, {
            type: 'connector', source: clone(el.source), target: clone(el.target), routing,
            waypoints: clone(el.waypoints ?? []), label: el.label ?? '', z: typeof el.z === 'number' ? el.z : this._maxZ() + 1,
          });
          if (el.layer !== undefined) {
            if (!this._all().layerById.has(el.layer)) throw new DiagramError('unknown layer');
            props.layer = el.layer; this._assertUnlocked(el);
          }
        } else {
          if (!SHAPE_TYPES.has(el.type)) throw new DiagramError(`unknown element type: ${el.type}`);
          this._checkNums(el);
          const layer = el.layer ?? DEFAULT_LAYER;
          if (!this._all().layerById.has(layer)) throw new DiagramError(`unknown layer: ${layer}`);
          this._assertUnlocked({ layer });
          Object.assign(props, {
            type: el.type, x: el.x ?? 0, y: el.y ?? 0, width: el.width ?? 0, height: el.height ?? 0, rotation: el.rotation ?? 0,
            text: el.text ?? '', layer, groupId: el.groupId ?? null, z: typeof el.z === 'number' ? el.z : this._maxZ() + 1,
          });
        }
        for (const k of Object.keys(el)) {
          if (k in props || k === 'id' || k === 'style' || k === 'type') continue;
          props[k] = clone(el[k]);
        }
        Object.assign(props, this._styleProps(el.style));
        specs.push(this._putSpec(el.id, props, { revive: true }));
        break;
      }
      case 'update': {
        const o = this._need(op.id);
        if (!isObj(op.patch)) throw new DiagramError('patch required');
        this._assertUnlocked(o);
        const props = {};
        for (const k of Object.keys(op.patch)) {
          const v = op.patch[k];
          if (k === 'id') { if (v !== o.id) throw new DiagramError('cannot change id'); continue; }
          if (k === 'type') { if (v !== o.type) throw new DiagramError('cannot change type'); continue; }
          if (k === 'style') { if (!isObj(v)) throw new DiagramError('style must be an object'); Object.assign(props, this._styleProps(v)); continue; }
          if (NUM_FIELDS.includes(k) && (typeof v !== 'number' || !Number.isFinite(v))) throw new DiagramError(`${k} must be a number`);
          if (k === 'layer') {
            if (!this._all().layerById.has(v)) throw new DiagramError('unknown layer');
            this._assertUnlocked({ layer: v });
          }
          if (k === 'routing' && v !== 'straight' && v !== 'orthogonal') throw new DiagramError('bad routing');
          props[k] = clone(v);
        }
        if (Object.keys(props).length) specs.push(this._putSpec(o.id, props));
        break;
      }
      case 'remove': {
        const o = this._need(op.id);
        this._assertUnlocked(o);
        specs.push({ kind: 'del', ent: 'e', id: o.id });
        if (o.type !== 'connector') {
          for (const c of this._all().items) {
            if (c.type === 'connector' && (c.source?.elementId === o.id || c.target?.elementId === o.id)) specs.push({ kind: 'del', ent: 'e', id: c.id });
          }
        }
        break;
      }
      case 'move': {
        if (!Array.isArray(op.ids)) throw new DiagramError('ids required');
        const dx = op.dx ?? 0, dy = op.dy ?? 0;
        if (typeof dx !== 'number' || typeof dy !== 'number') throw new DiagramError('dx/dy must be numbers');
        const objs = op.ids.map((i) => this._need(i));
        objs.forEach((o) => this._assertUnlocked(o));
        const set = new Set(op.ids);
        for (const o of objs) {
          if (o.type === 'connector') {
            if (o.waypoints?.length) specs.push(this._putSpec(o.id, { waypoints: o.waypoints.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
          } else specs.push(this._putSpec(o.id, { x: o.x + dx, y: o.y + dy }));
        }
        for (const c of this._all().items) {
          if (c.type !== 'connector' || set.has(c.id) || !c.waypoints?.length) continue;
          if (set.has(c.source?.elementId) && set.has(c.target?.elementId)) {
            specs.push(this._putSpec(c.id, { waypoints: c.waypoints.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
          }
        }
        break;
      }
      case 'resize': {
        const o = this._need(op.id);
        if (o.type === 'connector') throw new DiagramError('cannot resize connector');
        this._assertUnlocked(o);
        const b = op.box;
        if (!isObj(b)) throw new DiagramError('box required');
        let { x = o.x, y = o.y, width = o.width, height = o.height } = b;
        for (const v of [x, y, width, height]) if (typeof v !== 'number' || !Number.isFinite(v)) throw new DiagramError('bad box');
        if (op.keepAspect && o.width > 0 && o.height > 0) {
          const ratio = o.width / o.height;
          if (width === o.width && height !== o.height) width = height * ratio;
          else height = width / ratio;
        }
        specs.push(this._putSpec(o.id, { x, y, width, height }));
        break;
      }
      case 'rotate': {
        const o = this._need(op.id);
        if (o.type === 'connector') throw new DiagramError('cannot rotate connector');
        this._assertUnlocked(o);
        if (typeof op.deg !== 'number' || !Number.isFinite(op.deg)) throw new DiagramError('deg must be a number');
        specs.push(this._putSpec(o.id, { rotation: op.deg }));
        break;
      }
      case 'group': {
        if (!Array.isArray(op.ids) || !op.ids.length) throw new DiagramError('ids required');
        const objs = op.ids.map((i) => this._need(i));
        objs.forEach((o) => { if (o.type === 'connector') throw new DiagramError('cannot group connectors'); this._assertUnlocked(o); });
        const gid = op.groupId ?? `grp-${this.actor}-${this._clock + 1}`;
        for (const o of objs) specs.push(this._putSpec(o.id, { groupId: gid }));
        break;
      }
      case 'ungroup': {
        const members = this._shapes().filter((o) => o.groupId === op.groupId);
        if (!members.length) throw new DiagramError(`unknown group: ${op.groupId}`);
        members.forEach((o) => this._assertUnlocked(o));
        for (const o of members) specs.push(this._putSpec(o.id, { groupId: null }));
        break;
      }
      case 'reorder': {
        const o = this._need(op.id);
        this._assertUnlocked(o);
        const list = this._all().items.filter((i) => i.layer === o.layer);
        const idx = list.findIndex((i) => i.id === o.id);
        let z;
        if (op.to === 'front') { if (idx === list.length - 1) break; z = this._maxZ(o.layer) + 1; }
        else if (op.to === 'back') { if (idx === 0) break; z = Math.min(...list.map((i) => i.z ?? 0)) - 1; }
        else if (op.to === 'forward') {
          if (idx === list.length - 1) break;
          const a = list[idx + 1].z ?? 0, b = list[idx + 2]?.z;
          z = b === undefined ? a + 1 : (a + b) / 2;
          if (b !== undefined && b === a) z = a + 1e-9;
        } else if (op.to === 'backward') {
          if (idx === 0) break;
          const a = list[idx - 1].z ?? 0, b = list[idx - 2]?.z;
          z = b === undefined ? a - 1 : (a + b) / 2;
        } else throw new DiagramError('bad reorder target');
        specs.push(this._putSpec(o.id, { z }));
        break;
      }
      case 'addLayer': {
        const l = op.layer;
        if (!isObj(l) || typeof l.id !== 'string' || !l.id) throw new DiagramError('layer id required');
        if (this._all().layerById.has(l.id)) throw new DiagramError('duplicate layer');
        const maxOrder = Math.max(...this._all().layers.map((x) => x.order), -1);
        specs.push({ kind: 'put', ent: 'l', id: l.id, revive: true, props: {
          name: l.name ?? l.id, visible: l.visible ?? true, locked: l.locked ?? false, order: typeof l.order === 'number' ? l.order : maxOrder + 1,
        } });
        break;
      }
      case 'updateLayer': {
        if (!this._all().layerById.has(op.id)) throw new DiagramError('unknown layer');
        if (!isObj(op.patch)) throw new DiagramError('patch required');
        const props = {};
        for (const k of ['name', 'visible', 'locked', 'order']) if (k in op.patch) props[k] = op.patch[k];
        if (Object.keys(props).length) specs.push({ kind: 'put', ent: 'l', id: op.id, props });
        break;
      }
      case 'removeLayer': {
        const l = this._all().layerById.get(op.id);
        if (!l) throw new DiagramError('unknown layer');
        if (op.id === DEFAULT_LAYER) throw new DiagramError('cannot remove the default layer');
        if (l.locked) throw new DiagramError('layer is locked');
        const gone = new Set();
        for (const o of this._all().items) if (o.layer === op.id) gone.add(o.id);
        for (const o of this._all().items) {
          if (gone.has(o.id) || (o.type === 'connector' && (gone.has(o.source?.elementId) || gone.has(o.target?.elementId)))) {
            specs.push({ kind: 'del', ent: 'e', id: o.id });
          }
        }
        specs.push({ kind: 'del', ent: 'l', id: op.id });
        break;
      }
      case 'setStyle': {
        if (!Array.isArray(op.ids) || !isObj(op.style)) throw new DiagramError('ids and style required');
        const objs = op.ids.map((i) => this._need(i));
        objs.forEach((o) => this._assertUnlocked(o));
        for (const o of objs) specs.push(this._putSpec(o.id, this._styleProps(op.style)));
        break;
      }
      default: throw new DiagramError(`unknown operation type: ${op.type}`);
    }
    return specs;
  }

  // ---- geometry
  align(ids, mode) {
    const objs = ids.map((i) => this._need(i)).filter((o) => o.type !== 'connector');
    if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) throw new DiagramError('bad align mode');
    if (!objs.length) return this;
    const b = unionBox(objs.map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height })));
    this.transaction(() => {
      for (const o of objs) {
        const patch = {};
        if (mode === 'left') patch.x = b.x;
        else if (mode === 'right') patch.x = b.x + b.width - o.width;
        else if (mode === 'center') patch.x = b.x + b.width / 2 - o.width / 2;
        else if (mode === 'top') patch.y = b.y;
        else if (mode === 'bottom') patch.y = b.y + b.height - o.height;
        else patch.y = b.y + b.height / 2 - o.height / 2;
        this.apply({ type: 'update', id: o.id, patch });
      }
    });
    return this;
  }

  distribute(ids, mode) {
    const objs = ids.map((i) => this._need(i)).filter((o) => o.type !== 'connector');
    if (mode !== 'horizontal' && mode !== 'vertical') throw new DiagramError('bad distribute mode');
    if (objs.length < 3) return this;
    const h = mode === 'horizontal';
    const pos = (o) => (h ? o.x : o.y), size = (o) => (h ? o.width : o.height);
    const sorted = [...objs].sort((a, b) => pos(a) - pos(b) || (a.id < b.id ? -1 : 1));
    const first = sorted[0];
    const last = sorted.reduce((m, o) => (pos(o) + size(o) > pos(m) + size(m) ? o : m), sorted[sorted.length - 1]);
    const middle = sorted.filter((o) => o !== first && o !== last);
    const span = pos(last) + size(last) - pos(first);
    const total = sorted.reduce((s, o) => s + size(o), 0);
    const gap = (span - total) / (sorted.length - 1);
    this.transaction(() => {
      let cur = pos(first) + size(first) + gap;
      for (const o of middle) {
        this.apply({ type: 'update', id: o.id, patch: h ? { x: cur } : { y: cur } });
        cur += size(o) + gap;
      }
    });
    return this;
  }

  route(connectorId) {
    const c = this._need(connectorId);
    if (c.type !== 'connector') throw new DiagramError('not a connector');
    return routeConnector(c, this._all().byId, this._shapes());
  }

  layout(kind, opts = {}) {
    const shapes = this._shapes().filter((o) => !this._layerOf(o)?.locked);
    const conns = this._all().items.filter((o) => o.type === 'connector');
    let pos;
    if (kind === 'layered') pos = layoutLayered(shapes, conns, opts);
    else if (kind === 'grid') pos = layoutGrid(shapes, opts);
    else throw new DiagramError(`unknown layout: ${kind}`);
    this.transaction(() => {
      for (const [id, p] of pos) {
        const o = this._all().byId.get(id);
        if (o.x !== p.x || o.y !== p.y) this.apply({ type: 'update', id, patch: { x: p.x, y: p.y } });
      }
    });
    return this;
  }

  // Replace the current visible state with a snapshot (as new local ops).
  restore(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const tmp = Document.fromJSON(data);
    const target = tmp._all();
    const specs = [];
    for (const l of target.layers) {
      const { id, ...props } = l;
      specs.push({ kind: 'put', ent: 'l', id, props, revive: true });
    }
    for (const l of this._all().layers) if (!target.layerById.has(l.id)) specs.push({ kind: 'del', ent: 'l', id: l.id });
    for (const o of target.items) {
      const props = {};
      for (const k of Object.keys(o)) {
        if (k === 'id') continue;
        if (k === 'style') Object.assign(props, this._styleProps(o.style)); else props[k] = clone(o[k]);
      }
      const cur = this._all().byId.get(o.id);
      if (cur) for (const k of Object.keys(cur.style || {})) if (!(k in (o.style || {}))) props['style.' + k] = null;
      specs.push({ kind: 'put', ent: 'e', id: o.id, props, revive: true });
    }
    for (const o of this._all().items) if (!target.byId.has(o.id)) specs.push({ kind: 'del', ent: 'e', id: o.id });
    this._record(this._commit(specs));
    return this;
  }

  toSVG(opts = {}) {
    const a = this._all();
    return toSVG(a.items, a.layerById, opts);
  }

  toJSON() {
    const a = this._all();
    const ents = {};
    for (const key of [...this._ents.keys()].sort()) {
      const r = this._ents.get(key);
      const props = {};
      for (const k of Object.keys(r.props).sort()) props[k] = r.props[k];
      ents[key] = { props, del: r.del, rev: r.rev };
    }
    return { id: this.id, version: 1, layers: clone(a.layers), elements: clone(a.items), groups: this.groups(), crdt: { ents } };
  }

  static fromJSON(json, opts = {}) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!isObj(data)) throw new DiagramError('invalid document JSON');
    const doc = new Document({ id: data.id ?? 'doc', actor: opts.actor ?? data.actor ?? 'local' });
    if (data.crdt?.ents) {
      doc._ents = new Map();
      for (const [key, v] of Object.entries(data.crdt.ents)) {
        const i = key.indexOf(':');
        doc._ents.set(key, { ent: key.slice(0, i), id: key.slice(i + 1), props: clone(v.props), del: clone(v.del), rev: clone(v.rev) });
        for (const s of [...Object.values(v.props), v.del, v.rev]) if (s && s[1] > doc._clock) doc._clock = s[1];
      }
      if (!doc._find('l', DEFAULT_LAYER)) doc._seedDefaultLayer();
    } else {
      for (const l of data.layers || []) {
        if (l.id === DEFAULT_LAYER) { const r = doc._rec('l', l.id); for (const k of ['name', 'visible', 'locked', 'order']) if (k in l) r.props[k] = [l[k], 0, '']; continue; }
        doc.apply({ type: 'addLayer', layer: l });
      }
      for (const e of data.elements || []) doc.apply({ type: 'add', element: e });
      doc._pending = []; doc._undo = []; doc._redo = [];
    }
    return doc;
  }
}
