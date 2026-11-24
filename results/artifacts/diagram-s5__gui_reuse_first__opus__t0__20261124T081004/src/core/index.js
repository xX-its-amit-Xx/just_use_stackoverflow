// Diagram core library: document model, operations, undo/redo, CRDT sync,
// geometry queries, routing, layout and (de)serialization.
// Isomorphic ES module (no DOM, no Node-specific APIs).

import { generateKeyBetween } from './fractional-indexing.js';
import {
  SHAPE_TYPES, aabb, unionBoxes, containsPoint, boundaryToward, portPoint, portSide,
  snap, orthogonalRoute, simplify, center,
} from './geometry.js';
import { layeredLayout, gridLayout } from './layout.js';
import { parseXml, walk, escapeXml } from './xml.js';

export { snap };

export class DiagramError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'DiagramError';
    this.code = code;
  }
}

const DEFAULT_LAYER_ID = 'default';
const HISTORY_LIMIT = 500;
const SHAPE_FIELDS = ['id', 'type', 'x', 'y', 'width', 'height', 'rotation', 'style', 'text', 'layer', 'groupId', 'z'];
const CONN_FIELDS = ['id', 'type', 'source', 'target', 'routing', 'waypoints', 'label', 'style', 'layer', 'z'];
const LAYER_FIELDS = ['id', 'name', 'visible', 'locked', 'order'];
const NUMERIC = ['x', 'y', 'width', 'height', 'rotation'];

const clone = v => (v === undefined ? undefined : v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
// timestamp ordering (clock, actor)
const tsLess = (c1, a1, c2, a2) => (c1 !== c2 ? c1 < c2 : a1 < a2);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function normEndpoint(ep, which) {
  if (typeof ep === 'string') return { elementId: ep };
  if (!isObj(ep) || typeof (ep.elementId ?? ep.id) !== 'string') throw new DiagramError(`connector ${which} must reference an element`);
  const out = { elementId: ep.elementId ?? ep.id };
  if (ep.port !== undefined && ep.port !== null) out.port = clone(ep.port);
  return out;
}

let actorCounter = 0;
function randomActor() {
  return 'actor-' + Math.random().toString(36).slice(2, 10) + (actorCounter++).toString(36);
}

class Doc {
  constructor({ id, actor } = {}) {
    this._id = id ?? 'doc';
    this._actor = actor != null ? String(actor) : randomActor();
    this._els = new Map();     // id -> {alive:{v,c,a}, f:{field:{v,c,a}}}
    this._layers = new Map();
    this._clock = 0;
    this._seen = new Set();
    this._pending = [];
    this._listeners = new Map();
    this._undo = [];
    this._redo = [];
    this._tx = null;
    this._txDepth = 0;
    // implicit default layer (identical on every replica)
    this._layers.set(DEFAULT_LAYER_ID, {
      alive: { v: true, c: 0, a: '' },
      f: {
        name: { v: 'Layer 1', c: 0, a: '' }, visible: { v: true, c: 0, a: '' },
        locked: { v: false, c: 0, a: '' }, order: { v: 0, c: 0, a: '' },
      },
    });
  }

  get id() { return this._id; }
  get actor() { return this._actor; }

  // ------------------------------------------------------------------ events
  on(evt, cb) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(cb);
    return () => this.off(evt, cb);
  }
  off(evt, cb) { this._listeners.get(evt)?.delete(cb); }
  _emit(evt, ...args) {
    for (const cb of [...(this._listeners.get(evt) || [])]) {
      try { cb(...args); } catch (e) { /* listener errors must not corrupt state */ void e; }
    }
  }

  // ------------------------------------------------------------ CRDT layer
  _applyChange(ch, c, a) {
    const map = ch.k === 'l' ? this._layers : this._els;
    let rec = map.get(ch.id);
    if (!rec) { rec = { alive: { v: false, c: 0, a: '' }, f: {} }; map.set(ch.id, rec); }
    const inv = { k: ch.k, id: ch.id };
    if (ch.alive !== undefined) {
      inv.alive = rec.alive.v;
      if (!tsLess(c, a, rec.alive.c, rec.alive.a)) rec.alive = { v: !!ch.alive, c, a };
    }
    if (ch.set) {
      inv.set = {};
      for (const key of Object.keys(ch.set)) {
        const r = rec.f[key];
        inv.set[key] = r ? clone(r.v) : null;
        if (!r || !tsLess(c, a, r.c, r.a)) rec.f[key] = { v: clone(ch.set[key]), c, a };
      }
    }
    return inv;
  }

  _commit(changes, { history = true } = {}) {
    if (!changes.length) return [];
    const clock = ++this._clock;
    const op = { id: `${this._actor}@${clock}`, actor: this._actor, clock, changes: clone(changes) };
    const inv = [];
    for (const ch of changes) inv.push(this._applyChange(ch, clock, this._actor));
    inv.reverse();
    this._seen.add(op.id);
    this._pending.push(op);
    if (history) this._record(inv);
    this._emit('op', clone(op));
    this._emit('change', { local: true, op });
    return inv;
  }

  _record(inv) {
    if (this._tx) { this._tx.unshift(...inv); return; }
    this._undo.push(inv);
    if (this._undo.length > HISTORY_LIMIT) this._undo.splice(0, this._undo.length - HISTORY_LIMIT);
    this._redo.length = 0;
  }

  pendingOps() {
    const out = this._pending;
    this._pending = [];
    return clone(out);
  }

  receive(remoteOps) {
    const list = Array.isArray(remoteOps) ? remoteOps : [remoteOps];
    let applied = 0;
    for (const op of list) {
      if (!isObj(op) || typeof op.id !== 'string' || !Array.isArray(op.changes)) throw new DiagramError('malformed remote op');
      if (this._seen.has(op.id)) continue;
      const c = num(op.clock), a = String(op.actor ?? '');
      for (const ch of op.changes) {
        if (!isObj(ch) || typeof ch.id !== 'string' || (ch.k !== 'e' && ch.k !== 'l')) continue;
        this._applyChange(ch, c, a);
      }
      this._seen.add(op.id);
      if (c > this._clock) this._clock = c;
      applied++;
    }
    if (applied) this._emit('change', { local: false, ops: list });
    return applied;
  }

  hasOp(id) { return this._seen.has(id); }

  // ------------------------------------------------------------ materialise
  _layerLive(id) {
    const r = this._layers.get(id);
    return !!(r && r.alive.v);
  }
  _rawLive(id) {
    const r = this._els.get(id);
    return !!(r && r.alive.v && r.f.type);
  }
  _live(id, depth = 0) {
    const r = this._els.get(id);
    if (!r || !r.alive.v || !r.f.type) return false;
    if (!this._layerLive(r.f.layer?.v ?? DEFAULT_LAYER_ID)) return false;
    if (r.f.type.v === 'connector') {
      if (depth > 2) return false;
      const s = r.f.source?.v?.elementId, t = r.f.target?.v?.elementId;
      if (!s || !t) return false;
      if (s === id || t === id) return false;
      return this._live(s, depth + 1) && this._live(t, depth + 1);
    }
    return true;
  }
  _mat(id) {
    const r = this._els.get(id);
    const isConn = r.f.type.v === 'connector';
    const fields = isConn ? CONN_FIELDS : SHAPE_FIELDS;
    const o = {};
    const style = {};
    const extras = {};
    for (const [k, reg] of Object.entries(r.f)) {
      if (k.startsWith('style.')) { if (reg.v !== null && reg.v !== undefined) style[k.slice(6)] = clone(reg.v); }
      else if (!fields.includes(k) && reg.v !== null && reg.v !== undefined) extras[k] = clone(reg.v);
    }
    const g = (k, d) => { const reg = r.f[k]; return reg && reg.v !== null && reg.v !== undefined ? clone(reg.v) : d; };
    for (const k of fields) {
      switch (k) {
        case 'id': o.id = id; break;
        case 'type': o.type = r.f.type.v; break;
        case 'style': o.style = Object.fromEntries(Object.keys(style).sort().map(s => [s, style[s]])); break;
        case 'text': case 'label': o[k] = g(k, ''); break;
        case 'layer': o.layer = g('layer', DEFAULT_LAYER_ID); break;
        case 'groupId': o.groupId = g('groupId', null); break;
        case 'z': o.z = g('z', 'a0'); break;
        case 'routing': o.routing = g('routing', 'straight'); break;
        case 'waypoints': o.waypoints = g('waypoints', []); break;
        case 'source': case 'target': o[k] = g(k, null); break;
        default: o[k] = num(g(k, 0));
      }
    }
    for (const k of Object.keys(extras).sort()) o[k] = extras[k];
    return o;
  }
  _matLayer(id) {
    const r = this._layers.get(id);
    const g = (k, d) => { const reg = r.f[k]; return reg && reg.v !== null && reg.v !== undefined ? clone(reg.v) : d; };
    return { id, name: g('name', id), visible: g('visible', true) !== false, locked: g('locked', false) === true, order: num(g('order', 0)) };
  }

  layers() {
    const out = [];
    for (const id of this._layers.keys()) if (this._layerLive(id)) out.push(this._matLayer(id));
    out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
  getLayer(id) { return this._layerLive(id) ? this._matLayer(id) : undefined; }
  _defaultLayer() {
    if (this._layerLive(DEFAULT_LAYER_ID)) return DEFAULT_LAYER_ID;
    const ls = this.layers();
    if (!ls.length) throw new DiagramError('document has no layers');
    return ls[0].id;
  }

  get(id) {
    if (typeof id !== 'string' || !this._live(id)) return undefined;
    return this._mat(id);
  }

  elements(filter = {}) {
    const lorder = new Map(this.layers().map((l, i) => [l.id, i]));
    const out = [];
    for (const id of this._els.keys()) {
      if (!this._live(id)) continue;
      const e = this._mat(id);
      if (filter.layer !== undefined && e.layer !== filter.layer) continue;
      if (filter.type !== undefined) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        if (!types.includes(e.type)) continue;
      }
      out.push(e);
    }
    out.sort((a, b) => (lorder.get(a.layer) - lorder.get(b.layer)) || (a.z < b.z ? -1 : a.z > b.z ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  shapes() { return this.elements().filter(e => e.type !== 'connector'); }
  connectors() { return this.elements().filter(e => e.type === 'connector'); }

  groups() {
    const m = new Map();
    for (const e of this.elements()) {
      if (e.groupId == null) continue;
      if (!m.has(e.groupId)) m.set(e.groupId, []);
      m.get(e.groupId).push(e.id);
    }
    return [...m.keys()].sort().map(id => ({ id, children: m.get(id) }));
  }

  // ------------------------------------------------------------ validation
  _need(id) {
    if (typeof id !== 'string' || !this._live(id)) throw new DiagramError(`unknown element: ${id}`, 'not_found');
    return this._mat(id);
  }
  _assertUnlocked(layerId) {
    const l = this.getLayer(layerId);
    if (!l) throw new DiagramError(`unknown layer: ${layerId}`, 'not_found');
    if (l.locked) throw new DiagramError(`layer ${layerId} is locked`, 'locked');
  }
  _maxZ() {
    let m = null;
    for (const [id, r] of this._els) if (r.alive.v && r.f.z && this._live(id)) { const z = r.f.z.v; if (typeof z === 'string' && (m === null || z > m)) m = z; }
    return m;
  }
  _minZ() {
    let m = null;
    for (const [id, r] of this._els) if (r.alive.v && r.f.z && this._live(id)) { const z = r.f.z.v; if (typeof z === 'string' && (m === null || z < m)) m = z; }
    return m;
  }

  _styleSet(style, set) {
    if (!isObj(style)) return;
    for (const [k, v] of Object.entries(style)) set['style.' + k] = v === undefined ? null : clone(v);
  }

  // ------------------------------------------------------------ operations
  apply(op) {
    if (!isObj(op) || typeof op.type !== 'string') throw new DiagramError('operation must be an object with a type');
    const fn = this['_op_' + op.type];
    if (typeof fn !== 'function') throw new DiagramError(`unknown operation type: ${op.type}`, 'unknown_op');
    let result;
    const changes = fn.call(this, op, r => { result = r; });
    this._commit(changes);
    return result;
  }

  _op_add(op) {
    const el = op.element;
    if (!isObj(el)) throw new DiagramError('add requires an element');
    if (typeof el.id !== 'string' || !el.id) throw new DiagramError('element id must be a non-empty string');
    if (this._live(el.id) || this._rawLive(el.id)) throw new DiagramError(`element already exists: ${el.id}`, 'conflict');
    const isConn = el.type === 'connector';
    if (!isConn && !SHAPE_TYPES.has(el.type)) throw new DiagramError(`unknown element type: ${el.type}`);
    const layer = el.layer ?? this._defaultLayer();
    this._assertUnlocked(layer);
    const set = {};
    if (isConn) {
      const source = normEndpoint(el.source, 'source'), target = normEndpoint(el.target, 'target');
      for (const ep of [source, target]) {
        const t = this.get(ep.elementId);
        if (!t || t.type === 'connector') throw new DiagramError(`connector endpoint not found: ${ep.elementId}`, 'not_found');
      }
      const routing = el.routing ?? 'straight';
      if (routing !== 'straight' && routing !== 'orthogonal') throw new DiagramError(`unknown routing: ${routing}`);
      Object.assign(set, {
        type: 'connector', source, target, routing,
        waypoints: Array.isArray(el.waypoints) ? clone(el.waypoints) : [],
        label: el.label ?? '', layer,
      });
    } else {
      Object.assign(set, { type: el.type, text: el.text ?? '', layer, groupId: el.groupId ?? null });
      for (const k of NUMERIC) set[k] = num(el[k]);
    }
    for (const [k, v] of Object.entries(el)) {
      if (k === 'style' || k === 'z' || k === 'id' || k in set) continue;
      if (v !== undefined) set[k] = clone(v);
    }
    const maxZ = this._maxZ();
    set.z = generateKeyBetween(maxZ, null);
    this._styleSet(el.style, set);
    // clear stale registers from a previous incarnation of this id
    const old = this._els.get(el.id);
    if (old) for (const k of Object.keys(old.f)) if (!(k in set)) set[k] = null;
    return [{ k: 'e', id: el.id, alive: true, set }];
  }

  _patchSet(cur, patch) {
    const set = {};
    if (!isObj(patch)) throw new DiagramError('patch must be an object');
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      if (k === 'style') { if (v === null) { for (const s of Object.keys(cur.style)) set['style.' + s] = null; } else this._styleSet(v, set); continue; }
      if (k === 'type') {
        if (cur.type === 'connector' ? v !== 'connector' : !SHAPE_TYPES.has(v)) throw new DiagramError(`invalid type change: ${v}`);
      }
      if (k === 'layer') { this._assertUnlocked(v); }
      if (k === 'source' || k === 'target') {
        if (cur.type !== 'connector') throw new DiagramError('only connectors have endpoints');
        const ep = normEndpoint(v, k);
        const t = this.get(ep.elementId);
        if (!t || t.type === 'connector') throw new DiagramError(`connector endpoint not found: ${ep.elementId}`, 'not_found');
        set[k] = ep; continue;
      }
      if (k === 'routing' && v !== 'straight' && v !== 'orthogonal') throw new DiagramError(`unknown routing: ${v}`);
      if (NUMERIC.includes(k)) { set[k] = num(v); continue; }
      set[k] = v === undefined ? null : clone(v);
    }
    return set;
  }

  _op_update(op) {
    const cur = this._need(op.id);
    this._assertUnlocked(cur.layer);
    return [{ k: 'e', id: op.id, set: this._patchSet(cur, op.patch) }];
  }

  _op_setStyle(op) {
    const ids = this._ids(op.ids ?? op.id);
    const changes = [];
    for (const id of ids) {
      const cur = this._need(id);
      this._assertUnlocked(cur.layer);
      const set = {};
      this._styleSet(op.style, set);
      changes.push({ k: 'e', id, set });
    }
    return changes;
  }

  _ids(ids) {
    if (typeof ids === 'string') return [ids];
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    return [...new Set(ids)];
  }

  _attachedConnectors(ids) {
    const set = new Set(ids);
    const out = [];
    for (const [id, r] of this._els) {
      if (!r.alive.v || r.f.type?.v !== 'connector' || set.has(id)) continue;
      if (set.has(r.f.source?.v?.elementId) || set.has(r.f.target?.v?.elementId)) out.push(id);
    }
    return out;
  }

  _op_remove(op) {
    const ids = op.ids ? this._ids(op.ids) : [op.id];
    const changes = [];
    for (const id of ids) {
      const cur = this._need(id);
      this._assertUnlocked(cur.layer);
      changes.push({ k: 'e', id, alive: false });
    }
    for (const cid of this._attachedConnectors(ids)) {
      if (this._rawLive(cid)) changes.push({ k: 'e', id: cid, alive: false });
    }
    return changes;
  }

  _expandGroups(ids) {
    const groups = new Set();
    for (const id of ids) { const e = this.get(id); if (e && e.groupId != null) groups.add(e.groupId); }
    if (!groups.size) return ids;
    const out = [...ids];
    for (const e of this.elements()) if (e.groupId != null && groups.has(e.groupId) && !out.includes(e.id)) out.push(e.id);
    return out;
  }

  _op_move(op) {
    const dx = num(op.dx), dy = num(op.dy);
    const ids = this._expandGroups(this._ids(op.ids ?? op.id));
    const changes = [];
    for (const id of ids) {
      const cur = this._need(id);
      this._assertUnlocked(cur.layer);
      if (cur.type === 'connector') {
        changes.push({ k: 'e', id, set: { waypoints: cur.waypoints.map(p => Array.isArray(p) ? [p[0] + dx, p[1] + dy] : { ...p, x: num(p.x) + dx, y: num(p.y) + dy }) } });
      } else {
        changes.push({ k: 'e', id, set: { x: cur.x + dx, y: cur.y + dy } });
      }
    }
    return changes;
  }

  _op_resize(op) {
    const cur = this._need(op.id);
    if (cur.type === 'connector') throw new DiagramError('cannot resize a connector');
    this._assertUnlocked(cur.layer);
    const box = op.box;
    if (!isObj(box)) throw new DiagramError('resize requires a box');
    let x = num(box.x, cur.x), y = num(box.y, cur.y), w = num(box.width, cur.width), h = num(box.height, cur.height);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    if (op.keepAspect && cur.width > 0 && cur.height > 0) {
      const ratio = cur.width / cur.height;
      const sw = w / cur.width, sh = h / cur.height;
      // follow the dimension that changed the most
      if (Math.abs(sw - 1) >= Math.abs(sh - 1)) h = w / ratio; else w = h * ratio;
    }
    return [{ k: 'e', id: op.id, set: { x, y, width: w, height: h } }];
  }

  _op_rotate(op) {
    const cur = this._need(op.id);
    if (cur.type === 'connector') throw new DiagramError('cannot rotate a connector');
    this._assertUnlocked(cur.layer);
    const deg = Number(op.deg ?? op.rotation ?? op.angle);
    if (!Number.isFinite(deg)) throw new DiagramError('rotate requires numeric deg');
    return [{ k: 'e', id: op.id, set: { rotation: deg } }];
  }

  _op_group(op, ret) {
    const ids = this._ids(op.ids);
    if (!ids.length) throw new DiagramError('group requires ids');
    const groupId = op.groupId ?? `g-${this._actor}-${this._clock + 1}`;
    const changes = [];
    for (const id of ids) {
      const cur = this._need(id);
      this._assertUnlocked(cur.layer);
      changes.push({ k: 'e', id, set: { groupId } });
    }
    ret(groupId);
    return changes;
  }

  _op_ungroup(op) {
    const members = this.elements().filter(e => e.groupId != null && e.groupId === op.groupId);
    if (!members.length) throw new DiagramError(`unknown group: ${op.groupId}`, 'not_found');
    for (const e of members) this._assertUnlocked(e.layer);
    return members.map(e => ({ k: 'e', id: e.id, set: { groupId: null } }));
  }

  _op_reorder(op) {
    const cur = this._need(op.id);
    this._assertUnlocked(cur.layer);
    const all = this.elements().filter(e => e.layer === cur.layer);
    const others = all.filter(e => e.id !== cur.id);
    const idx = all.findIndex(e => e.id === cur.id);
    const distinctAfter = (z) => { const n = others.find(e => e.z > z); return n ? n.z : null; };
    const distinctBefore = (z) => { const p = [...others].reverse().find(e => e.z < z); return p ? p.z : null; };
    let z;
    switch (op.to) {
      case 'front': {
        const m = this._maxZ();
        if (idx === all.length - 1 && (m === null || cur.z >= m) && !others.some(e => e.z === cur.z)) return [];
        z = generateKeyBetween(m, null); break;
      }
      case 'back': {
        const m = this._minZ();
        if (idx === 0 && !others.some(e => e.z === cur.z)) return [];
        z = generateKeyBetween(null, m); break;
      }
      case 'forward': {
        if (idx === all.length - 1) return [];
        const next = all[idx + 1];
        const a = next.z, b = distinctAfter(a);
        z = generateKeyBetween(a, b); break;
      }
      case 'backward': {
        if (idx === 0) return [];
        const prev = all[idx - 1];
        const b = prev.z, a = distinctBefore(b);
        z = generateKeyBetween(a, b); break;
      }
      default: throw new DiagramError(`unknown reorder target: ${op.to}`);
    }
    return [{ k: 'e', id: cur.id, set: { z } }];
  }

  _op_addLayer(op) {
    const l = op.layer;
    if (!isObj(l) || typeof l.id !== 'string' || !l.id) throw new DiagramError('addLayer requires layer.id');
    if (this._layerLive(l.id)) throw new DiagramError(`layer already exists: ${l.id}`, 'conflict');
    const maxOrder = Math.max(-1, ...this.layers().map(x => x.order));
    return [{ k: 'l', id: l.id, alive: true, set: {
      name: l.name ?? l.id, visible: l.visible !== false, locked: l.locked === true,
      order: Number.isFinite(l.order) ? l.order : maxOrder + 1,
    } }];
  }

  _op_updateLayer(op) {
    if (!this._layerLive(op.id)) throw new DiagramError(`unknown layer: ${op.id}`, 'not_found');
    if (!isObj(op.patch)) throw new DiagramError('patch must be an object');
    const set = {};
    for (const [k, v] of Object.entries(op.patch)) {
      if (k === 'id') continue;
      if (k === 'visible' || k === 'locked') set[k] = !!v;
      else if (k === 'order') set[k] = num(v);
      else set[k] = clone(v);
    }
    return [{ k: 'l', id: op.id, set }];
  }

  _op_removeLayer(op) {
    const l = this.getLayer(op.id);
    if (!l) throw new DiagramError(`unknown layer: ${op.id}`, 'not_found');
    if (this.layers().length <= 1) throw new DiagramError('cannot remove the last layer');
    const members = this.elements({ layer: op.id });
    if (l.locked && members.length) throw new DiagramError(`layer ${op.id} is locked`, 'locked');
    const changes = [{ k: 'l', id: op.id, alive: false }];
    const ids = members.map(e => e.id);
    for (const id of ids) changes.push({ k: 'e', id, alive: false });
    for (const cid of this._attachedConnectors(ids)) changes.push({ k: 'e', id: cid, alive: false });
    return changes;
  }

  // ------------------------------------------------------------ history
  transaction(fn) {
    const outer = this._txDepth === 0;
    if (outer) this._tx = [];
    this._txDepth++;
    let res;
    try {
      res = fn(this);
    } catch (e) {
      this._txDepth--;
      if (outer) {
        const inv = this._tx; this._tx = null;
        if (inv.length) this._commit(inv, { history: false });
      }
      throw e;
    }
    this._txDepth--;
    if (outer) {
      const inv = this._tx; this._tx = null;
      if (inv.length) {
        this._undo.push(inv);
        if (this._undo.length > HISTORY_LIMIT) this._undo.splice(0, this._undo.length - HISTORY_LIMIT);
        this._redo.length = 0;
      }
    }
    return res;
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  undo() {
    if (this._tx) throw new DiagramError('cannot undo inside a transaction');
    const entry = this._undo.pop();
    if (!entry) return false;
    const inv = this._commit(entry, { history: false });
    this._redo.push(inv);
    return true;
  }

  redo() {
    if (this._tx) throw new DiagramError('cannot redo inside a transaction');
    const entry = this._redo.pop();
    if (!entry) return false;
    const inv = this._commit(entry, { history: false });
    this._undo.push(inv);
    if (this._undo.length > HISTORY_LIMIT) this._undo.splice(0, this._undo.length - HISTORY_LIMIT);
    return true;
  }

  // ------------------------------------------------------------ queries
  _visibleShapes() {
    const vis = new Set(this.layers().filter(l => l.visible).map(l => l.id));
    return this.elements().filter(e => e.type !== 'connector' && vis.has(e.layer));
  }

  hitTest(x, y) {
    const shapes = this._visibleShapes();
    for (let i = shapes.length - 1; i >= 0; i--) if (containsPoint(shapes[i], x, y)) return shapes[i];
    return null;
  }

  select(rect) {
    if (!isObj(rect)) throw new DiagramError('select requires a rect');
    let { x, y } = rect;
    let w = rect.width ?? (rect.x2 !== undefined ? rect.x2 - rect.x : 0);
    let h = rect.height ?? (rect.y2 !== undefined ? rect.y2 - rect.y : 0);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const eps = 1e-9;
    return this._visibleShapes().filter(e => {
      const b = aabb(e);
      return b.x >= x - eps && b.y >= y - eps && b.x + b.width <= x + w + eps && b.y + b.height <= y + h + eps;
    });
  }

  bounds(ids) {
    let els;
    if (ids === undefined || ids === null) els = this.elements();
    else els = this._ids(ids).map(id => this._need(id));
    const boxes = [];
    for (const e of els) {
      if (e.type === 'connector') {
        try { const pts = this.route(e.id); for (const [px, py] of pts) boxes.push({ x: px, y: py, width: 0, height: 0 }); } catch { /* ignore */ }
      } else boxes.push(aabb(e));
    }
    return unionBoxes(boxes) ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  align(ids, mode) {
    const els = this._ids(ids).map(id => this._need(id)).filter(e => e.type !== 'connector');
    if (!['left', 'center', 'centre', 'right', 'top', 'middle', 'bottom'].includes(mode)) throw new DiagramError(`unknown align mode: ${mode}`);
    if (!els.length) return;
    const b = unionBoxes(els.map(e => ({ x: e.x, y: e.y, width: e.width, height: e.height })));
    this.transaction(() => {
      for (const e of els) {
        const patch = {};
        switch (mode) {
          case 'left': patch.x = b.x; break;
          case 'right': patch.x = b.x + b.width - e.width; break;
          case 'center': case 'centre': patch.x = b.x + b.width / 2 - e.width / 2; break;
          case 'top': patch.y = b.y; break;
          case 'bottom': patch.y = b.y + b.height - e.height; break;
          case 'middle': patch.y = b.y + b.height / 2 - e.height / 2; break;
        }
        const k = Object.keys(patch)[0];
        if (patch[k] !== e[k]) this.apply({ type: 'update', id: e.id, patch });
      }
    });
  }

  distribute(ids, dir) {
    if (dir !== 'horizontal' && dir !== 'vertical') throw new DiagramError(`unknown distribute direction: ${dir}`);
    const els = this._ids(ids).map(id => this._need(id)).filter(e => e.type !== 'connector');
    if (els.length < 3) return;
    const [P, S] = dir === 'horizontal' ? ['x', 'width'] : ['y', 'height'];
    els.sort((a, b) => a[P] - b[P] || (a[P] + a[S] / 2) - (b[P] + b[S] / 2) || (a.id < b.id ? -1 : 1));
    const first = els[0], last = els[els.length - 1];
    const span = last[P] + last[S] - first[P];
    const total = els.reduce((a, e) => a + e[S], 0);
    const gap = (span - total) / (els.length - 1);
    this.transaction(() => {
      let pos = first[P] + first[S] + gap;
      for (let i = 1; i < els.length - 1; i++) {
        const e = els[i];
        if (Math.abs(e[P] - pos) > 1e-12) this.apply({ type: 'update', id: e.id, patch: { [P]: pos } });
        pos += e[S] + gap;
      }
    });
  }

  // ------------------------------------------------------------ routing
  _wp(p) { return Array.isArray(p) ? [num(p[0]), num(p[1])] : [num(p.x), num(p.y)]; }

  route(connectorId) {
    const c = this._need(connectorId);
    if (c.type !== 'connector') throw new DiagramError(`not a connector: ${connectorId}`);
    const s = this._need(c.source.elementId), t = this._need(c.target.elementId);
    const wps = (c.waypoints || []).map(p => this._wp(p));
    if (c.routing === 'orthogonal') return this._routeOrthogonal(c, s, t, wps);
    const sc = center(s), tc = center(t);
    const sp = portPoint(s, c.source.port) ?? boundaryToward(s, ...(wps[0] ?? tc));
    const tp = portPoint(t, c.target.port) ?? boundaryToward(t, ...(wps[wps.length - 1] ?? sc));
    return [[sp[0] + 0, sp[1] + 0], ...wps, [tp[0] + 0, tp[1] + 0]];
  }

  _routeOrthogonal(c, s, t, wps) {
    const sb = aabb(s), tb = aabb(t);
    const others = this._visibleShapes().filter(e => e.id !== s.id && e.id !== t.id && e.type !== 'line');
    const obstacles = [sb, tb, ...others.map(aabb)];
    const all = unionBoxes(this._visibleShapes().map(aabb).concat([sb, tb]));
    const area = { x: all.x - 100, y: all.y - 100, width: all.width + 200, height: all.height + 200 };
    const sSide = portSide(c.source.port), tSide = portSide(c.target.port);
    const ss = sSide && sSide !== 'center' ? sSide : null, ts = tSide && tSide !== 'center' ? tSide : null;
    if (wps.length) {
      // route through waypoints as tiny pseudo-boxes
      const boxes = [sb, ...wps.map(p => ({ x: p[0], y: p[1], width: 0, height: 0 })), tb];
      let pts = [];
      for (let i = 0; i + 1 < boxes.length; i++) {
        const seg = orthogonalRoute(boxes[i], boxes[i + 1], obstacles, area, i === 0 ? ss : null, i + 2 === boxes.length ? ts : null);
        if (!seg) { pts = null; break; }
        pts.push(...seg);
      }
      if (pts) return simplify(pts);
    }
    const r = orthogonalRoute(sb, tb, obstacles, area, ss, ts);
    if (r) return r;
    // fallback: simple elbow between facing sides
    const [scx, scy] = center(s), [tcx, tcy] = center(t);
    const horizontal = Math.abs(tcx - scx) >= Math.abs(tcy - scy);
    if (horizontal) {
      const sx = tcx >= scx ? sb.x + sb.width : sb.x, tx = tcx >= scx ? tb.x : tb.x + tb.width;
      const mx = (sx + tx) / 2;
      return simplify([[sx, scy], [mx, scy], [mx, tcy], [tx, tcy]]);
    }
    const sy = tcy >= scy ? sb.y + sb.height : sb.y, ty = tcy >= scy ? tb.y : tb.y + tb.height;
    const my = (sy + ty) / 2;
    return simplify([[scx, sy], [scx, my], [tcx, my], [tcx, ty]]);
  }

  // ------------------------------------------------------------ layout
  layout(kind = 'layered', opts = {}) {
    const lockedLayers = new Set(this.layers().filter(l => l.locked).map(l => l.id));
    const nodes = this.elements().filter(e => e.type !== 'connector' && !lockedLayers.has(e.layer));
    if (!nodes.length) return;
    const b = unionBoxes(nodes.map(e => ({ x: e.x, y: e.y, width: e.width, height: e.height })));
    const origin = opts.origin ?? { x: b.x, y: b.y };
    let pos;
    if (kind === 'layered' || kind === 'hierarchical' || kind === 'sugiyama') {
      const ids = new Set(nodes.map(n => n.id));
      const edges = this.elements({ type: 'connector' })
        .filter(c => ids.has(c.source.elementId) && ids.has(c.target.elementId))
        .map(c => [c.source.elementId, c.target.elementId]);
      pos = layeredLayout(nodes, edges, { ...opts, origin });
    } else if (kind === 'grid') {
      pos = gridLayout(nodes, { ...opts, origin });
    } else {
      throw new DiagramError(`unknown layout: ${kind}`);
    }
    this.transaction(() => {
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (p && (p.x !== n.x || p.y !== n.y)) this.apply({ type: 'update', id: n.id, patch: { x: p.x, y: p.y } });
      }
    });
  }

  // ------------------------------------------------------------ serialization
  toJSON() {
    return {
      id: this._id,
      layers: this.layers(),
      elements: this.elements(),
      groups: this.groups(),
    };
  }

  /** Replace the whole content with the given snapshot as one undoable local step. */
  loadSnapshot(json) {
    const snap = typeof json === 'string' ? JSON.parse(json) : json;
    const changes = [];
    const wantLayers = new Map((snap.layers || []).map(l => [l.id, l]));
    const wantEls = new Map((snap.elements || []).map(e => [e.id, e]));
    for (const [id, r] of this._els) if (r.alive.v && !wantEls.has(id)) changes.push({ k: 'e', id, alive: false });
    for (const [id, r] of this._layers) if (r.alive.v && !wantLayers.has(id)) changes.push({ k: 'l', id, alive: false });
    for (const l of wantLayers.values()) {
      const set = {};
      for (const k of LAYER_FIELDS) if (k !== 'id' && l[k] !== undefined) set[k] = clone(l[k]);
      changes.push({ k: 'l', id: l.id, alive: true, set });
    }
    for (const e of wantEls.values()) changes.push({ k: 'e', id: e.id, alive: true, set: elementSet(e, this._els.get(e.id)) });
    this._commit(changes);
  }

  toSVG(opts = {}) {
    const padding = Number.isFinite(+opts.padding) ? +opts.padding : 10;
    const vis = new Set(this.layers().filter(l => l.visible).map(l => l.id));
    const els = this.elements().filter(e => vis.has(e.layer));
    const boxes = [];
    const routes = new Map();
    for (const e of els) {
      if (e.type === 'connector') {
        let pts = [];
        try { pts = this.route(e.id); } catch { pts = []; }
        routes.set(e.id, pts);
        for (const [x, y] of pts) boxes.push({ x, y, width: 0, height: 0 });
      } else boxes.push(aabb(e));
    }
    const b = unionBoxes(boxes) ?? { x: 0, y: 0, width: 0, height: 0 };
    const vx = b.x - padding, vy = b.y - padding, vw = b.width + 2 * padding, vh = b.height + 2 * padding;
    const f = n => String(Math.round(n * 1000) / 1000);
    const a = (k, v) => (v === undefined || v === null || v === '' ? '' : ` ${k}="${escapeXml(v)}"`);
    const out = [];
    out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${f(vw)}" height="${f(vh)}" viewBox="${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}">`);
    out.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>`);
    const textEl = (x, y, txt, st) => {
      const lines = String(txt).split('\n');
      const fs = num(st.fontSize, 14);
      const start = y - ((lines.length - 1) * fs * 1.2) / 2;
      const spans = lines.map((ln, i) => `<tspan x="${f(x)}" y="${f(start + i * fs * 1.2)}">${escapeXml(ln)}</tspan>`).join('');
      return `<text text-anchor="middle" dominant-baseline="middle" font-size="${f(fs)}"${a('font-family', st.fontFamily ?? 'sans-serif')}${a('fill', st.fontColor ?? st.color ?? '#000000')}${a('font-weight', st.fontWeight)}>${spans}</text>`;
    };
    for (const e of els) {
      const st = e.style || {};
      const common = `${a('fill', st.fill ?? (e.type === 'text' ? 'none' : '#ffffff'))}${a('stroke', st.stroke ?? (e.type === 'text' ? 'none' : '#000000'))}${a('stroke-width', st.strokeWidth ?? 1)}`;
      const op = st.opacity !== undefined ? a('opacity', st.opacity) : '';
      if (e.type === 'connector') {
        const pts = routes.get(e.id) || [];
        let inner = `<polyline fill="none"${a('stroke', st.stroke ?? '#000000')}${a('stroke-width', st.strokeWidth ?? 1)}${st.dashed ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#arrow)" points="${pts.map(p => f(p[0]) + ',' + f(p[1])).join(' ')}"/>`;
        if (e.label && pts.length) {
          const mid = pts[Math.floor((pts.length - 1) / 2)], mid2 = pts[Math.min(pts.length - 1, Math.floor((pts.length - 1) / 2) + 1)];
          inner += textEl((mid[0] + mid2[0]) / 2, (mid[1] + mid2[1]) / 2, e.label, st);
        }
        out.push(`<g data-id="${escapeXml(e.id)}" data-type="connector"${op}>${inner}</g>`);
        continue;
      }
      const [cx, cy] = center(e);
      const tr = e.rotation ? ` transform="rotate(${f(e.rotation)} ${f(cx)} ${f(cy)})"` : '';
      let shape = '';
      switch (e.type) {
        case 'rect': shape = `<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(Math.abs(e.width))}" height="${f(Math.abs(e.height))}"${st.rounded ? ' rx="8" ry="8"' : ''}${common}/>`; break;
        case 'ellipse': shape = `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(Math.abs(e.width) / 2)}" ry="${f(Math.abs(e.height) / 2)}"${common}/>`; break;
        case 'diamond': shape = `<polygon points="${f(cx)},${f(e.y)} ${f(e.x + e.width)},${f(cy)} ${f(cx)},${f(e.y + e.height)} ${f(e.x)},${f(cy)}"${common}/>`; break;
        case 'line': shape = `<line x1="${f(e.x)}" y1="${f(e.y)}" x2="${f(e.x + e.width)}" y2="${f(e.y + e.height)}"${a('stroke', st.stroke ?? '#000000')}${a('stroke-width', st.strokeWidth ?? 1)}/>`; break;
        case 'image': shape = `<image x="${f(e.x)}" y="${f(e.y)}" width="${f(Math.abs(e.width))}" height="${f(Math.abs(e.height))}"${a('href', e.src ?? st.image ?? '')}/>`; break;
        case 'text': shape = `<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(Math.abs(e.width))}" height="${f(Math.abs(e.height))}"${common}/>`; break;
      }
      const txt = e.text ? textEl(cx, cy, e.text, st) : '';
      out.push(`<g data-id="${escapeXml(e.id)}" data-type="${e.type}"${tr}${op}>${shape}${txt}</g>`);
    }
    out.push('</svg>');
    return out.join('\n');
  }
}

function elementSet(e, old) {
  const set = {};
  if (old) for (const k of Object.keys(old.f)) set[k] = null;
  for (const [k, v] of Object.entries(e)) {
    if (k === 'id') continue;
    if (k === 'style') { if (isObj(v)) for (const [sk, sv] of Object.entries(v)) set['style.' + sk] = clone(sv); continue; }
    set[k] = clone(v);
  }
  return set;
}

export function createDocument(opts = {}) {
  return new Doc(opts || {});
}

export function fromJSON(json, opts = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!isObj(data)) throw new DiagramError('invalid document JSON');
  const doc = new Doc({ id: opts.id ?? data.id, actor: opts.actor });
  if (Array.isArray(data.layers) && data.layers.length) {
    doc._layers.clear();
    for (const l of data.layers) {
      if (!isObj(l) || typeof l.id !== 'string') throw new DiagramError('invalid layer in JSON');
      const f = {};
      for (const k of LAYER_FIELDS) if (k !== 'id' && l[k] !== undefined) f[k] = { v: clone(l[k]), c: 0, a: '' };
      doc._layers.set(l.id, { alive: { v: true, c: 0, a: '' }, f });
    }
  }
  let z = null;
  for (const e of data.elements || []) {
    if (!isObj(e) || typeof e.id !== 'string') throw new DiagramError('invalid element in JSON');
    if (e.type !== 'connector' && !SHAPE_TYPES.has(e.type)) throw new DiagramError(`unknown element type: ${e.type}`);
    const set = elementSet(e, null);
    if (typeof set.z !== 'string') { z = generateKeyBetween(z, null); set.z = z; } else if (z === null || set.z > z) z = set.z;
    const f = {};
    for (const [k, v] of Object.entries(set)) f[k] = { v, c: 0, a: '' };
    doc._els.set(e.id, { alive: { v: true, c: 0, a: '' }, f });
  }
  return doc;
}

// ---------------------------------------------------------------- draw.io

function parseDrawioStyle(s) {
  const out = { _tokens: [] };
  for (const part of String(s || '').split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out._tokens.push(part.trim());
    else out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function htmlToText(v) {
  if (!/[<&]/.test(v)) return v;
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>\s*<(div|p)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string') throw new DiagramError('importDrawio expects an XML string');
  let tree;
  try { tree = parseXml(xml); } catch (e) { throw new DiagramError('invalid XML: ' + e.message); }
  const all = [...walk(tree)];
  let scope = tree;
  const diagram = all.find(n => n.name === 'diagram');
  if (diagram) {
    const hasModel = [...walk(diagram)].some(n => n.name === 'mxGraphModel');
    if (!hasModel) {
      if (diagram.text.trim()) throw new DiagramError('compressed draw.io diagrams are not supported');
      throw new DiagramError('draw.io diagram has no mxGraphModel');
    }
    scope = diagram;
  }
  const model = [...walk(scope)].find(n => n.name === 'mxGraphModel');
  if (!model && !all.some(n => n.name === 'mxCell')) throw new DiagramError('not a draw.io document');
  // collect cells (supporting UserObject/object wrappers)
  const cells = [];
  for (const n of walk(model || scope)) {
    if (n.name !== 'mxCell') continue;
    const wrap = n.parent && (n.parent.name === 'UserObject' || n.parent.name === 'object') ? n.parent : null;
    const id = n.attrs.id ?? wrap?.attrs.id;
    if (id === undefined) continue;
    const geo = n.children.find(c => c.name === 'mxGeometry');
    cells.push({
      id, parent: n.attrs.parent, vertex: n.attrs.vertex === '1', edge: n.attrs.edge === '1',
      value: wrap ? (wrap.attrs.label ?? '') : (n.attrs.value ?? ''), style: n.attrs.style ?? '',
      source: n.attrs.source, target: n.attrs.target, geo,
    });
  }
  const byId = new Map(cells.map(c => [c.id, c]));
  const doc = createDocument({ id: opts.id ?? 'imported', actor: opts.actor });
  const rootIds = new Set(cells.filter(c => c.parent === undefined && !c.vertex && !c.edge).map(c => c.id));
  const layerCells = cells.filter(c => !c.vertex && !c.edge && c.parent !== undefined && (rootIds.has(c.parent) || !byId.has(c.parent)));
  const layerIds = new Set(layerCells.map(c => c.id));
  const g = (geo, k) => num(geo?.attrs[k], 0);
  const abs = new Map();
  const absPos = (c, depth = 0) => {
    if (abs.has(c.id)) return abs.get(c.id);
    let p = [g(c.geo, 'x'), g(c.geo, 'y')];
    const parent = byId.get(c.parent);
    if (parent && parent.vertex && depth < 50) {
      const pp = absPos(parent, depth + 1);
      p = [p[0] + pp[0], p[1] + pp[1]];
    }
    abs.set(c.id, p);
    return p;
  };
  const layerOf = (c, depth = 0) => {
    if (layerIds.has(c.parent)) return c.parent;
    const parent = byId.get(c.parent);
    if (parent && depth < 50) return layerOf(parent, depth + 1);
    return null;
  };
  const mapStyle = (st) => {
    const s = {};
    if (st.fillColor && st.fillColor !== 'default') s.fill = st.fillColor === 'none' ? 'none' : st.fillColor;
    if (st.strokeColor && st.strokeColor !== 'default') s.stroke = st.strokeColor;
    if (st.strokeWidth !== undefined) s.strokeWidth = num(st.strokeWidth, 1);
    if (st.fontSize !== undefined) s.fontSize = num(st.fontSize, 12);
    if (st.fontColor) s.fontColor = st.fontColor;
    if (st.fontFamily) s.fontFamily = st.fontFamily;
    if (st.opacity !== undefined) s.opacity = num(st.opacity, 100) / 100;
    if (st.rounded === '1') s.rounded = true;
    if (st.dashed === '1') s.dashed = true;
    return s;
  };
  const changes = [];
  const layerIdMap = new Map();
  if (layerCells.length) {
    layerCells.forEach((c, i) => {
      layerIdMap.set(c.id, c.id);
      changes.push({ k: 'l', id: c.id, alive: true, set: {
        name: htmlToText(c.value) || (i === 0 ? 'Layer 1' : `Layer ${i + 1}`),
        visible: !/visible=0/.test(c.style), locked: /locked=1/.test(c.style), order: i,
      } });
    });
    if (!layerIdMap.has(DEFAULT_LAYER_ID)) changes.unshift({ k: 'l', id: DEFAULT_LAYER_ID, alive: false });
  }
  const defaultLayer = layerCells.length ? layerCells[0].id : DEFAULT_LAYER_ID;
  let z = null;
  const vertexIds = new Set();
  const edgeLabels = new Map();
  for (const c of cells) {
    if (!c.vertex) continue;
    const parent = byId.get(c.parent);
    const st = parseDrawioStyle(c.style);
    if (parent && parent.edge) { // edge label child
      if (c.value) edgeLabels.set(parent.id, htmlToText(c.value));
      continue;
    }
    const shapeName = st.shape ?? st._tokens[0] ?? '';
    let type = 'rect';
    if (shapeName === 'ellipse' || st._tokens.includes('ellipse') || shapeName === 'doubleEllipse') type = 'ellipse';
    else if (shapeName === 'rhombus' || st._tokens.includes('rhombus')) type = 'diamond';
    else if (shapeName === 'text' || st._tokens.includes('text')) type = 'text';
    else if (shapeName === 'image' || st._tokens.includes('image') || st.image) type = 'image';
    else if (shapeName === 'line') type = 'line';
    const [x, y] = absPos(c);
    z = generateKeyBetween(z, null);
    const set = {
      type, x, y, width: g(c.geo, 'width'), height: g(c.geo, 'height'),
      rotation: num(st.rotation, 0), text: htmlToText(c.value), layer: layerOf(c) ?? defaultLayer,
      groupId: parent && parent.vertex ? parent.id : null, z,
    };
    if (type === 'image' && st.image) set.src = st.image;
    for (const [k, v] of Object.entries(mapStyle(st))) set['style.' + k] = v;
    changes.push({ k: 'e', id: c.id, alive: true, set });
    vertexIds.add(c.id);
  }
  for (const c of cells) {
    if (!c.edge) continue;
    if (!vertexIds.has(c.source) || !vertexIds.has(c.target)) continue;
    const st = parseDrawioStyle(c.style);
    const pts = [];
    const arr = c.geo?.children.find(n => n.name === 'Array' && (n.attrs.as === 'points' || !n.attrs.as));
    if (arr) for (const p of arr.children) if (p.name === 'mxPoint') pts.push([num(p.attrs.x), num(p.attrs.y)]);
    z = generateKeyBetween(z, null);
    const set = {
      type: 'connector', source: { elementId: c.source }, target: { elementId: c.target },
      routing: /orthogonal|elbow/i.test(st.edgeStyle ?? '') ? 'orthogonal' : 'straight',
      waypoints: pts, label: htmlToText(c.value) || edgeLabels.get(c.id) || '',
      layer: layerOf(c) ?? defaultLayer, z,
    };
    for (const [k, v] of Object.entries(mapStyle(st))) set['style.' + k] = v;
    changes.push({ k: 'e', id: c.id, alive: true, set });
  }
  doc._commit(changes, { history: false });
  return doc;
}

export { aabb, containsPoint };
