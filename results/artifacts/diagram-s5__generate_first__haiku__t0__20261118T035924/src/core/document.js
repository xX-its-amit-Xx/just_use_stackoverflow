// Diagram document: a replicated state built from timestamped primitive writes.
//
// State is a set of records keyed by id. Each record has a lifecycle (created /
// removed timestamps; an element is alive when its latest create is newer than its
// latest delete) and LWW fields ({v, t} per field). A timestamp is [lamport, actor]
// and is totally ordered, so replicas that have seen the same set of primitives reach
// the same state regardless of delivery order. Connectors are hidden while an endpoint
// is not alive, which gives "removing an element removes its connectors" for free.
//
// High-level operations (add, move, ...) are translated into primitives. Each local
// step records inverse entries (guarded: they only apply if nobody else has written
// the same field/lifecycle since) so undo reverts only the local actor's changes.

import { DiagramError } from './errors.js';
import { keyBetween } from './fractional.js';
import { aabb, boundaryPoint, containsPoint, normDeg, portPoint, sideToward, unionRect, centerOf } from './geometry.js';
import { orthoRoute, simplifyPoints } from './routing.js';
import { layeredLayout, gridLayout } from './layout.js';

export const SHAPE_TYPES = ['rect', 'ellipse', 'diamond', 'text', 'image', 'line'];
const SHAPE_SET = new Set(SHAPE_TYPES);
const ROUTINGS = new Set(['straight', 'orthogonal']);
const NUMERIC = new Set(['x', 'y', 'width', 'height', 'rotation']);
const DEFAULT_FIELDS = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  text: '',
  label: '',
  layer: 'default',
  groupId: null,
  routing: 'straight',
  waypoints: [],
  z: '',
};
const LAYER_FIELDS = new Set(['name', 'visible', 'locked', 'order']);
const HISTORY_LIMIT = 500;
const ROUTE_MARGIN = 100;

const zeroTs = () => [0, ''];
const clone = (v) => (v === undefined ? null : v === null || typeof v !== 'object' ? v : structuredClone(v));
const randomId = (prefix) => {
  const u = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${prefix}_${u.replace(/-/g, '').slice(0, 12)}`;
};

function cmpTs(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

function normPoint(p) {
  if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
  if (p && typeof p === 'object') return [Number(p.x), Number(p.y)];
  throw new DiagramError('invalid waypoint');
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function newTx() {
  return { forward: [], ops: [], oids: [], snap: new Map(), inverse: [], setIdx: new Map(), lifeIdx: new Map() };
}

export class Document {
  constructor({ id, actor } = {}) {
    this._id = id ?? randomId('doc');
    this._actor = String(actor ?? randomId('actor'));
    this._clock = 0;
    this._records = new Map();
    this._applied = new Set();
    this._outbox = [];
    this._undo = [];
    this._redo = [];
    this._listeners = new Set();
    this._tx = null;
    this._depth = 0;
    // Default layer exists on every replica with the same lowest timestamp.
    this._records.set('default', {
      kind: 'layer',
      created: zeroTs(),
      removed: null,
      fields: {
        name: { v: 'Layer 1', t: zeroTs() },
        visible: { v: true, t: zeroTs() },
        locked: { v: false, t: zeroTs() },
        order: { v: 0, t: zeroTs() },
      },
    });
  }

  get id() {
    return this._id;
  }

  get actor() {
    return this._actor;
  }

  on(event, cb) {
    if (event !== 'op') throw new DiagramError(`unknown event: ${event}`);
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  // ---------- record level ----------

  _alive(id) {
    const r = this._records.get(id);
    if (!r || !r.created) return false;
    return !r.removed || cmpTs(r.created, r.removed) > 0;
  }

  _fieldValue(id, field) {
    const c = this._records.get(id)?.fields[field];
    return c ? c.v : undefined;
  }

  _applyPrim(p) {
    const id = String(p.id);
    let r = this._records.get(id);
    if (!r) {
      r = { kind: null, created: null, removed: null, fields: {} };
      this._records.set(id, r);
    }
    switch (p.op) {
      case 'set': {
        const cur = r.fields[p.field];
        if (!cur || cmpTs(p.ts, cur.t) > 0) r.fields[p.field] = { v: clone(p.value), t: p.ts };
        break;
      }
      case 'create': {
        if (!r.kind && p.kind) r.kind = p.kind;
        if (!r.created || cmpTs(p.ts, r.created) > 0) r.created = p.ts;
        for (const [k, v] of Object.entries(p.fields ?? {})) {
          const cur = r.fields[k];
          if (!cur || cmpTs(p.ts, cur.t) > 0) r.fields[k] = { v: clone(v), t: p.ts };
        }
        break;
      }
      case 'delete': {
        if (!r.removed || cmpTs(p.ts, r.removed) > 0) r.removed = p.ts;
        break;
      }
      default:
        throw new DiagramError(`unknown primitive: ${p.op}`);
    }
  }

  _lifeTs(r) {
    if (!r || !r.created) return null;
    return r.removed && cmpTs(r.removed, r.created) > 0 ? r.removed : r.created;
  }

  // Records the inverse for a primitive that is about to be applied locally.
  _track(full) {
    const tx = this._tx;
    const id = String(full.id);
    const r = this._records.get(id);
    if (full.op === 'set') {
      const key = `${id}\u0000${full.field}`;
      let e = tx.setIdx.get(key);
      if (!e) {
        const cur = r?.fields[full.field];
        e = { act: 'set', id, field: full.field, value: cur ? clone(cur.v) : null, guard: full.ts };
        tx.setIdx.set(key, e);
        tx.inverse.push(e);
      }
      e.guard = full.ts;
    } else {
      let e = tx.lifeIdx.get(id);
      if (!e) {
        e = { act: 'life', id, wasAlive: this._alive(id), guard: full.ts };
        tx.lifeIdx.set(id, e);
        tx.inverse.push(e);
      }
      e.guard = full.ts;
    }
  }

  _guardOk(e) {
    const r = this._records.get(e.id);
    if (!r) return false;
    if (e.act === 'set') {
      const c = r.fields[e.field];
      return !!c && cmpTs(c.t, e.guard) === 0;
    }
    const life = this._lifeTs(r);
    return !!life && cmpTs(life, e.guard) === 0;
  }

  _runInverse(e) {
    if (e.act === 'set') {
      this._write({ op: 'set', id: e.id, field: e.field, value: clone(e.value) });
      return;
    }
    const alive = this._alive(e.id);
    if (alive === e.wasAlive) return;
    if (e.wasAlive) this._write({ op: 'create', id: e.id, fields: {} });
    else this._write({ op: 'delete', id: e.id });
  }

  _write(prim) {
    const tx = this._tx;
    const ts = [++this._clock, this._actor];
    const full = { ...prim, id: String(prim.id), ts, oid: `${this._actor}@${this._clock}` };
    if (!tx.snap.has(full.id)) tx.snap.set(full.id, structuredClone(this._records.get(full.id)) ?? null);
    this._track(full);
    tx.forward.push(structuredClone(prim));
    this._applyPrim(full);
    this._applied.add(full.oid);
    tx.oids.push(full.oid);
    tx.ops.push(full);
  }

  _rollback(tx) {
    for (const [id, snap] of tx.snap) {
      if (snap === null) this._records.delete(id);
      else this._records.set(id, snap);
    }
    for (const oid of tx.oids) this._applied.delete(oid);
  }

  _commit(tx, mode) {
    if (tx.ops.length === 0) return;
    if (mode === 'user' || mode === 'redo') {
      this._undo.push({ forward: tx.forward, inverse: tx.inverse });
      if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
      if (mode === 'user') this._redo = [];
    }
    for (const op of tx.ops) {
      this._outbox.push(op);
      for (const cb of this._listeners) cb(op);
    }
  }

  _run(fn, mode) {
    if (this._depth > 0) return fn(this);
    this._tx = newTx();
    this._depth = 1;
    let result;
    try {
      result = fn(this);
    } catch (err) {
      const tx = this._tx;
      this._tx = null;
      this._depth = 0;
      this._rollback(tx);
      throw err;
    }
    const tx = this._tx;
    this._tx = null;
    this._depth = 0;
    this._commit(tx, mode);
    return result;
  }

  /** Runs fn(doc) as a single undo step; throws roll back all of its changes. */
  transaction(fn) {
    return this._run(fn, 'user');
  }

  // ---------- queries ----------

  _isShape(id) {
    if (id === undefined || id === null) return false;
    const sid = String(id);
    const r = this._records.get(sid);
    return !!r && r.kind === 'element' && this._alive(sid) && this._fieldValue(sid, 'type') !== 'connector';
  }

  _materialize(id) {
    const sid = String(id);
    const r = this._records.get(sid);
    if (!r || r.kind !== 'element' || !this._alive(sid)) return undefined;
    const flat = {};
    const style = {};
    for (const k of Object.keys(r.fields)) {
      const v = r.fields[k].v;
      if (k.startsWith('style.')) {
        if (v !== null && v !== undefined) style[k.slice(6)] = clone(v);
      } else {
        flat[k] = v === null || v === undefined ? clone(DEFAULT_FIELDS[k] ?? null) : clone(v);
      }
    }
    if (flat.type === 'connector') {
      if (!this._isShape(flat.source?.elementId) || !this._isShape(flat.target?.elementId)) return undefined;
    }
    return sortedObject({ ...flat, id: sid, style: sortedObject(style) });
  }

  _all() {
    const out = [];
    for (const [id, r] of this._records) {
      if (r.kind !== 'element') continue;
      const e = this._materialize(id);
      if (e) out.push(e);
    }
    return out.sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  _materializeLayer(id) {
    const sid = String(id);
    const r = this._records.get(sid);
    if (!r || r.kind !== 'layer' || !this._alive(sid)) return undefined;
    const f = (k) => this._fieldValue(sid, k);
    return {
      id: sid,
      name: f('name') ?? sid,
      visible: f('visible') !== false,
      locked: f('locked') === true,
      order: f('order') ?? 0,
    };
  }

  _layerOrThrow(id) {
    const l = this._materializeLayer(id);
    if (!l) throw new DiagramError(`unknown layer: ${id}`, 'not_found');
    return l;
  }

  _assertUnlocked(layerId) {
    if (this._layerOrThrow(layerId).locked) throw new DiagramError(`layer is locked: ${layerId}`, 'locked');
  }

  _req(id) {
    const e = this._materialize(id);
    if (!e) throw new DiagramError(`unknown element: ${id}`, 'not_found');
    return e;
  }

  _reqShape(id) {
    const e = this._req(id);
    if (e.type === 'connector') throw new DiagramError(`not a shape: ${id}`);
    return e;
  }

  get(id) {
    return this._materialize(id);
  }

  elements({ layer, type } = {}) {
    return this._all().filter((e) => (layer === undefined || e.layer === layer) && (type === undefined || e.type === type));
  }

  layers() {
    const out = [];
    for (const [id, r] of this._records) {
      if (r.kind !== 'layer') continue;
      const l = this._materializeLayer(id);
      if (l) out.push(l);
    }
    return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  groups() {
    const map = new Map();
    for (const e of this._all()) {
      if (e.groupId === null || e.groupId === undefined) continue;
      if (!map.has(e.groupId)) map.set(e.groupId, []);
      map.get(e.groupId).push(e.id);
    }
    return [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, ids]) => ({ id, ids }));
  }

  hitTest(x, y) {
    const hidden = new Set(this.layers().filter((l) => !l.visible).map((l) => l.id));
    const all = this._all();
    for (let k = all.length - 1; k >= 0; k--) {
      const e = all[k];
      if (e.type === 'connector' || hidden.has(e.layer)) continue;
      if (containsPoint(e, x, y)) return e;
    }
    return null;
  }

  select(rect) {
    const r = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const ids = [];
    for (const e of this._all()) {
      if (e.type === 'connector') continue;
      const b = aabb(e);
      if (b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height) ids.push(e.id);
    }
    return ids;
  }

  bounds(ids) {
    if (ids === undefined) return unionRect(this._all().filter((e) => e.type !== 'connector').map(aabb));
    const boxes = [];
    for (const id of ids) {
      const e = this._req(id);
      if (e.type === 'connector') for (const p of this.route(id)) boxes.push({ x: p[0], y: p[1], width: 0, height: 0 });
      else boxes.push(aabb(e));
    }
    return unionRect(boxes);
  }

  // ---------- routing ----------

  route(connectorId) {
    const c = this._materialize(connectorId);
    if (!c || c.type !== 'connector') throw new DiagramError(`unknown connector: ${connectorId}`, 'not_found');
    const src = this._req(c.source.elementId);
    const tgt = this._req(c.target.elementId);
    const wps = (c.waypoints ?? []).map((p) => ({ x: p[0], y: p[1] }));
    const sc = centerOf(src);
    const tc = centerOf(tgt);
    let pts;
    if (c.routing === 'orthogonal') {
      const start = (c.source.port && portPoint(src, c.source.port)) || sideToward(src, wps[0] ?? tc);
      const end = (c.target.port && portPoint(tgt, c.target.port)) || sideToward(tgt, wps[wps.length - 1] ?? sc);
      const stops = [start, ...wps, end];
      const obstacles = this._all().filter((e) => e.type !== 'connector').map(aabb);
      const all = [...obstacles, ...stops.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 }))];
      const b = unionRect(all);
      const region = {
        minX: b.x - ROUTE_MARGIN,
        minY: b.y - ROUTE_MARGIN,
        maxX: b.x + b.width + ROUTE_MARGIN,
        maxY: b.y + b.height + ROUTE_MARGIN,
      };
      pts = [];
      for (let i = 0; i + 1 < stops.length; i++) {
        const seg = orthoRoute(stops[i], stops[i + 1], obstacles, region) ?? [
          stops[i],
          { x: stops[i + 1].x, y: stops[i].y },
          stops[i + 1],
        ];
        for (const p of seg) if (!pts.length || pts[pts.length - 1].x !== p.x || pts[pts.length - 1].y !== p.y) pts.push(p);
      }
      pts = simplifyPoints(pts.length ? pts : [start]);
    } else {
      const first = wps[0] ?? tc;
      const last = wps[wps.length - 1] ?? sc;
      const start = (c.source.port && portPoint(src, c.source.port)) || boundaryPoint(src, first);
      const end = (c.target.port && portPoint(tgt, c.target.port)) || boundaryPoint(tgt, last);
      pts = [start, ...wps, end];
    }
    return pts.map((p) => [p.x, p.y]);
  }

  // ---------- operations ----------

  apply(op) {
    if (this._depth > 0) return this._applyOp(op);
    return this._run(() => this._applyOp(op), 'user');
  }

  _applyOp(op) {
    if (!op || typeof op !== 'object' || typeof op.type !== 'string') throw new DiagramError('invalid operation');
    switch (op.type) {
      case 'add':
        return this._opAdd(op.element);
      case 'update':
        return this._opUpdate(op.id, op.patch ?? {});
      case 'remove':
        return this._opRemove(op.id);
      case 'move':
        return this._opMove(op.ids, op.dx, op.dy);
      case 'resize':
        return this._opResize(op.id, op.box, op.keepAspect);
      case 'rotate':
        return this._opRotate(op.id, op.deg);
      case 'group':
        return this._opGroup(op.ids, op.groupId);
      case 'ungroup':
        return this._opUngroup(op.groupId);
      case 'reorder':
        return this._opReorder(op.id, op.to);
      case 'addLayer':
        return this._opAddLayer(op.layer);
      case 'updateLayer':
        return this._opUpdateLayer(op.id, op.patch ?? {});
      case 'removeLayer':
        return this._opRemoveLayer(op.id);
      case 'setStyle':
        return this._opSetStyle(op.ids, op.style ?? {});
      default:
        throw new DiagramError(`unknown operation type: ${op.type}`);
    }
  }

  _topZ() {
    const all = this._all();
    return all.length ? all[all.length - 1].z : null;
  }

  _opAdd(e) {
    if (!e || typeof e !== 'object') throw new DiagramError('element required');
    const type = e.type;
    if (type !== 'connector' && !SHAPE_SET.has(type)) throw new DiagramError(`unknown element type: ${type}`);
    const id = String(e.id ?? randomId(type === 'connector' ? 'conn' : 'el'));
    const r = this._records.get(id);
    if (r && this._alive(id)) throw new DiagramError(`duplicate id: ${id}`, 'conflict');
    const layer = String(e.layer ?? 'default');
    this._assertUnlocked(layer);
    const fields = { type, layer, groupId: e.groupId ?? null };
    if (type === 'connector') {
      for (const side of ['source', 'target']) {
        const ref = e[side];
        if (!ref || !this._isShape(ref.elementId)) throw new DiagramError(`unknown ${side} element`, 'not_found');
        fields[side] = { elementId: String(ref.elementId), ...(ref.port !== undefined ? { port: ref.port } : {}) };
      }
      const routing = e.routing ?? 'straight';
      if (!ROUTINGS.has(routing)) throw new DiagramError(`unknown routing: ${routing}`);
      fields.routing = routing;
      fields.waypoints = (e.waypoints ?? []).map(normPoint);
      fields.label = e.label ?? '';
    } else {
      for (const k of ['x', 'y', 'width', 'height', 'rotation']) {
        const v = e[k] ?? 0;
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new DiagramError(`invalid ${k}`);
        fields[k] = v;
      }
      fields.text = e.text ?? '';
    }
    for (const [k, v] of Object.entries(e.style ?? {})) {
      if (v !== undefined && v !== null) fields[`style.${k}`] = v;
    }
    fields.z = e.z !== undefined ? String(e.z) : keyBetween(this._topZ(), null);
    this._write({ op: 'create', id, kind: 'element', fields });
    return this._materialize(id);
  }

  _opUpdate(id, patch) {
    const el = this._req(id);
    this._assertUnlocked(el.layer);
    for (const [k, value] of Object.entries(patch)) {
      if (k === 'id') {
        if (String(value) !== String(id)) throw new DiagramError('cannot change id');
        continue;
      }
      if (k === 'type') throw new DiagramError('cannot change type');
      if (k === 'style') {
        for (const [sk, sv] of Object.entries(value ?? {})) this._write({ op: 'set', id, field: `style.${sk}`, value: sv ?? null });
        continue;
      }
      let v = value;
      if (NUMERIC.has(k) && (typeof v !== 'number' || !Number.isFinite(v))) throw new DiagramError(`invalid ${k}`);
      if (k === 'layer') {
        v = String(v);
        this._assertUnlocked(v);
      }
      if (k === 'source' || k === 'target') {
        if (!this._isShape(v?.elementId)) throw new DiagramError(`unknown ${k} element`, 'not_found');
        v = { ...v, elementId: String(v.elementId) };
      }
      if (k === 'routing' && !ROUTINGS.has(v)) throw new DiagramError(`unknown routing: ${v}`);
      if (k === 'waypoints') v = (v ?? []).map(normPoint);
      this._write({ op: 'set', id, field: k, value: clone(v) });
    }
    return this._materialize(id);
  }

  _opRemove(id) {
    const sid = String(id);
    if (!this._records.get(sid) || this._records.get(sid).kind !== 'element' || !this._alive(sid)) {
      throw new DiagramError(`unknown element: ${id}`, 'not_found');
    }
    this._write({ op: 'delete', id: sid });
  }

  _opMove(ids, dx, dy) {
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    if (typeof dx !== 'number' || typeof dy !== 'number') throw new DiagramError('dx and dy must be numbers');
    for (const id of ids) {
      const e = this._req(id);
      if (e.type === 'connector') continue;
      this._assertUnlocked(e.layer);
      this._write({ op: 'set', id: e.id, field: 'x', value: e.x + dx });
      this._write({ op: 'set', id: e.id, field: 'y', value: e.y + dy });
    }
  }

  _opResize(id, box, keepAspect) {
    const e = this._reqShape(id);
    this._assertUnlocked(e.layer);
    if (!box || [box.x, box.y, box.width, box.height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new DiagramError('invalid box');
    }
    if (box.width < 0 || box.height < 0) throw new DiagramError('negative size');
    let { width, height } = box;
    if (keepAspect && e.width > 0 && e.height > 0) {
      const s = Math.min(box.width / e.width, box.height / e.height);
      width = e.width * s;
      height = e.height * s;
    }
    this._write({ op: 'set', id: e.id, field: 'x', value: box.x });
    this._write({ op: 'set', id: e.id, field: 'y', value: box.y });
    this._write({ op: 'set', id: e.id, field: 'width', value: width });
    this._write({ op: 'set', id: e.id, field: 'height', value: height });
  }

  _opRotate(id, deg) {
    const e = this._reqShape(id);
    this._assertUnlocked(e.layer);
    if (typeof deg !== 'number' || !Number.isFinite(deg)) throw new DiagramError('invalid angle');
    this._write({ op: 'set', id: e.id, field: 'rotation', value: deg });
  }

  _opGroup(ids, groupId) {
    if (!Array.isArray(ids) || ids.length === 0) throw new DiagramError('ids must be a non-empty array');
    const gid = String(groupId ?? randomId('grp'));
    for (const id of ids) {
      const e = this._req(id);
      this._assertUnlocked(e.layer);
      this._write({ op: 'set', id: e.id, field: 'groupId', value: gid });
    }
    return gid;
  }

  _opUngroup(groupId) {
    const members = this._all().filter((e) => e.groupId === groupId);
    if (members.length === 0) throw new DiagramError(`unknown group: ${groupId}`, 'not_found');
    for (const e of members) {
      this._assertUnlocked(e.layer);
      this._write({ op: 'set', id: e.id, field: 'groupId', value: null });
    }
  }

  _opReorder(id, to) {
    const e = this._req(id);
    this._assertUnlocked(e.layer);
    const list = this._all();
    const idx = list.findIndex((x) => x.id === e.id);
    const others = list.filter((x) => x.id !== e.id);
    let z;
    switch (to) {
      case 'front':
        z = keyBetween(others.length ? others[others.length - 1].z : null, null);
        break;
      case 'back':
        z = keyBetween(null, others.length ? others[0].z : null);
        break;
      case 'forward': {
        // Move just above the next element: between it and the one after it.
        const next = list[idx + 1];
        const after = list[idx + 2];
        if (!next) z = keyBetween(e.z, null);
        else z = after && after.z > next.z ? keyBetween(next.z, after.z) : keyBetween(next.z, null);
        break;
      }
      case 'backward': {
        // Move just below the previous element: between the one before it and it.
        const prev = list[idx - 1];
        const before = list[idx - 2];
        if (!prev) z = keyBetween(null, e.z);
        else z = before && before.z < prev.z ? keyBetween(before.z, prev.z) : keyBetween(null, prev.z);
        break;
      }
      default:
        throw new DiagramError(`unknown reorder target: ${to}`);
    }
    this._write({ op: 'set', id: e.id, field: 'z', value: z });
  }

  _opAddLayer(layer) {
    if (!layer || typeof layer !== 'object') throw new DiagramError('layer required');
    const id = String(layer.id ?? randomId('layer'));
    if (this._materializeLayer(id)) throw new DiagramError(`duplicate layer: ${id}`, 'conflict');
    const order = this.layers().reduce((m, l) => Math.max(m, l.order), 0) + 1;
    this._write({
      op: 'create',
      id,
      kind: 'layer',
      fields: {
        name: layer.name ?? id,
        visible: layer.visible ?? true,
        locked: layer.locked ?? false,
        order: layer.order ?? order,
      },
    });
    return this._materializeLayer(id);
  }

  _opUpdateLayer(id, patch) {
    this._layerOrThrow(id);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      if (!LAYER_FIELDS.has(k)) throw new DiagramError(`unknown layer property: ${k}`);
      this._write({ op: 'set', id: String(id), field: k, value: clone(v) });
    }
    return this._materializeLayer(id);
  }

  _opRemoveLayer(id) {
    const sid = String(id);
    if (sid === 'default') throw new DiagramError('cannot remove the default layer');
    this._layerOrThrow(sid);
    for (const e of this._all()) {
      if (e.layer !== sid) continue;
      this._assertUnlocked(sid);
      this._write({ op: 'set', id: e.id, field: 'layer', value: 'default' });
    }
    this._write({ op: 'delete', id: sid });
  }

  _opSetStyle(ids, style) {
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    for (const id of ids) {
      const e = this._req(id);
      this._assertUnlocked(e.layer);
      for (const [k, v] of Object.entries(style)) this._write({ op: 'set', id: e.id, field: `style.${k}`, value: v ?? null });
    }
  }

  // ---------- history ----------

  undo() {
    if (this._depth > 0) throw new DiagramError('cannot undo inside a transaction');
    const step = this._undo.pop();
    if (!step) return false;
    this._run(() => {
      for (const e of step.inverse) if (this._guardOk(e)) this._runInverse(e);
    }, 'undo');
    this._redo.push(step);
    return true;
  }

  redo() {
    if (this._depth > 0) throw new DiagramError('cannot redo inside a transaction');
    const step = this._redo.pop();
    if (!step) return false;
    this._run(() => {
      for (const p of step.forward) this._write(p);
    }, 'redo');
    return true;
  }

  canUndo() {
    return this._undo.length > 0;
  }

  canRedo() {
    return this._redo.length > 0;
  }

  // ---------- geometry operations ----------

  _shapesOf(ids) {
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    return ids.map((id) => this._req(id)).filter((e) => e.type !== 'connector');
  }

  align(ids, mode) {
    const valid = ['left', 'center', 'right', 'top', 'middle', 'bottom'];
    if (!valid.includes(mode)) throw new DiagramError(`unknown align mode: ${mode}`);
    const shapes = this._shapesOf(ids);
    if (shapes.length === 0) return;
    const boxes = shapes.map(aabb);
    const minL = Math.min(...boxes.map((b) => b.x));
    const maxR = Math.max(...boxes.map((b) => b.x + b.width));
    const minT = Math.min(...boxes.map((b) => b.y));
    const maxB = Math.max(...boxes.map((b) => b.y + b.height));
    this.transaction(() => {
      shapes.forEach((s, i) => {
        const b = boxes[i];
        let dx = 0;
        let dy = 0;
        if (mode === 'left') dx = minL - b.x;
        else if (mode === 'right') dx = maxR - (b.x + b.width);
        else if (mode === 'center') dx = (minL + maxR) / 2 - (b.x + b.width / 2);
        else if (mode === 'top') dy = minT - b.y;
        else if (mode === 'bottom') dy = maxB - (b.y + b.height);
        else dy = (minT + maxB) / 2 - (b.y + b.height / 2);
        if (dx || dy) this._opMove([s.id], dx, dy);
      });
    });
  }

  distribute(ids, direction) {
    if (direction !== 'horizontal' && direction !== 'vertical') throw new DiagramError(`unknown direction: ${direction}`);
    const shapes = this._shapesOf(ids);
    if (shapes.length < 3) return;
    const h = direction === 'horizontal';
    const items = shapes.map((s) => ({ s, b: aabb(s) })).sort((p, q) => (h ? p.b.x - q.b.x : p.b.y - q.b.y));
    const first = items[0].b;
    const last = items[items.length - 1].b;
    const middle = items.slice(1, -1);
    const sizeSum = middle.reduce((sum, it) => sum + (h ? it.b.width : it.b.height), 0);
    const startEdge = h ? first.x + first.width : first.y + first.height;
    const endEdge = h ? last.x : last.y;
    const gap = (endEdge - startEdge - sizeSum) / (items.length - 1);
    this.transaction(() => {
      let cursor = startEdge;
      for (const it of middle) {
        const target = cursor + gap;
        const dx = h ? target - it.b.x : 0;
        const dy = h ? 0 : target - it.b.y;
        if (dx || dy) this._opMove([it.s.id], dx, dy);
        cursor = target + (h ? it.b.width : it.b.height);
      }
    });
  }

  layout(name, opts = {}) {
    const shapes = this.elements().filter((e) => e.type !== 'connector');
    const bounds = unionRect(shapes.map(aabb));
    const origin = { x: bounds.x, y: bounds.y };
    const nodes = shapes.map((s) => ({ id: s.id, width: s.width, height: s.height }));
    let positions;
    if (name === 'layered') {
      const ids = new Set(shapes.map((s) => s.id));
      const edges = this.elements()
        .filter((e) => e.type === 'connector' && ids.has(e.source.elementId) && ids.has(e.target.elementId))
        .map((e) => ({ from: e.source.elementId, to: e.target.elementId }));
      positions = layeredLayout({
        nodes,
        edges,
        direction: opts.direction === 'LR' ? 'LR' : 'TB',
        spacing: opts.spacing ?? 40,
        origin,
      });
    } else if (name === 'grid') {
      positions = gridLayout({ nodes, spacing: opts.spacing ?? 40, origin });
    } else {
      throw new DiagramError(`unknown layout: ${name}`);
    }
    this.transaction(() => {
      for (const s of shapes) {
        const p = positions.get(s.id);
        if (!p) continue;
        if (p.x !== s.x) this._write({ op: 'set', id: s.id, field: 'x', value: p.x });
        if (p.y !== s.y) this._write({ op: 'set', id: s.id, field: 'y', value: p.y });
      }
    });
  }

  // ---------- replication ----------

  pendingOps() {
    const out = this._outbox;
    this._outbox = [];
    return out;
  }

  receive(remoteOps) {
    const list = Array.isArray(remoteOps) ? remoteOps : [remoteOps];
    for (const op of list) {
      if (!op || typeof op !== 'object' || !Array.isArray(op.ts) || typeof op.op !== 'string') {
        throw new DiagramError('invalid remote op');
      }
      const oid = op.oid ?? JSON.stringify(op);
      if (this._applied.has(oid)) continue;
      this._applied.add(oid);
      this._clock = Math.max(this._clock, op.ts[0]);
      this._applyPrim({ ...structuredClone(op), oid });
    }
  }

  // ---------- serialization ----------

  toJSON() {
    const records = [];
    for (const id of [...this._records.keys()].sort()) {
      const r = this._records.get(id);
      const fields = {};
      for (const k of Object.keys(r.fields).sort()) fields[k] = { v: clone(r.fields[k].v), t: r.fields[k].t };
      records.push({ id, kind: r.kind, created: r.created, removed: r.removed, fields });
    }
    return {
      id: this._id,
      layers: this.layers(),
      elements: this._all(),
      groups: this.groups(),
      records,
    };
  }
}

export function createDocument({ id, actor } = {}) {
  return new Document({ id, actor });
}

export function fromJSON(json, { actor } = {}) {
  if (!json || typeof json !== 'object') throw new DiagramError('invalid document JSON');
  const doc = new Document({ id: json.id, actor });
  doc._records = new Map();
  let maxClock = 0;
  const bump = (ts) => {
    if (Array.isArray(ts)) maxClock = Math.max(maxClock, Number(ts[0]) || 0);
  };
  if (Array.isArray(json.records)) {
    for (const r of json.records) {
      const fields = {};
      for (const [k, c] of Object.entries(r.fields ?? {})) {
        fields[k] = { v: clone(c.v), t: c.t };
        bump(c.t);
      }
      bump(r.created);
      bump(r.removed);
      doc._records.set(String(r.id), {
        kind: r.kind ?? null,
        created: r.created ?? null,
        removed: r.removed ?? null,
        fields,
      });
    }
  } else {
    // Legacy/plain JSON: rebuild records from the visible state.
    for (const l of json.layers ?? []) {
      doc._applyPrim({ op: 'create', id: l.id, kind: 'layer', ts: zeroTs(), fields: { name: l.name, visible: l.visible, locked: l.locked, order: l.order } });
    }
    for (const e of json.elements ?? []) {
      const fields = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === 'id') continue;
        if (k === 'style') for (const [sk, sv] of Object.entries(v ?? {})) fields[`style.${sk}`] = sv;
        else fields[k] = v;
      }
      doc._applyPrim({ op: 'create', id: e.id, kind: 'element', ts: zeroTs(), fields });
    }
  }
  doc._clock = maxClock;
  return doc;
}

export { normDeg };
