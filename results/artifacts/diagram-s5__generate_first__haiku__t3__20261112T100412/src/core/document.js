import { DiagramError } from './errors.js';
import { SHAPE_TYPES, containsPoint, cornersOf, centerOf, clipToBoundary, portPoint } from './geometry.js';
import { straightRoute, orthogonalRoute, fallbackRoute, toPt } from './routing.js';
import { layeredPositions, gridPositions } from './layout.js';
import { renderSVG } from './svg.js';

export const DEFAULT_LAYER = 'default';
const CONNECTOR = 'connector';
const MAX_HISTORY = 500;
const ROUTINGS = new Set(['straight', 'orthogonal']);
const NUMERIC = ['x', 'y', 'width', 'height', 'rotation'];
const ADD_RESERVED = new Set(['id', 'type', 'style', 'layer', 'groupId', 'z']);
const ZERO_STAMP = [0, ''];

/*
 * Replication model
 * -----------------
 * State is a map of last-writer-wins registers, one per (entity, field).
 * A register holds {v, s} where s = [lamport, actorId] is the stamp of the
 * write that produced it. Every local operation is lowered into a list of
 * register writes ("writes") which are shipped inside the op, so remote
 * replicas never re-interpret the operation. Joining two sets of writes is
 * a per-register max over stamps, which is commutative, associative and
 * idempotent: replicas that have seen the same ops converge regardless of
 * delivery order. Removal is a register `__exists` on the element.
 */

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const write = (e, i, f, v) => ({ e, i, f, v: clone(v) });

function cmpStamp(a, b) {
  if (!b) return 1;
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

const sameStamp = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

function uid(prefix) {
  const c = globalThis.crypto;
  const r = c && c.randomUUID ? c.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return prefix + r;
}

const num = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DiagramError(`${name} must be a finite number`);
  return v;
};

class Entity {
  constructor(kind, id) {
    this.kind = kind; // 'el' | 'ly'
    this.id = id;
    this.regs = new Map(); // field -> {v, s}
  }
}

export class DiagramDocument {
  constructor({ id, actor } = {}) {
    this.id = id !== undefined ? String(id) : uid('doc-');
    this.actor = actor !== undefined ? String(actor) : uid('actor-');
    this._ents = new Map();
    this._clock = 0;
    this._applied = new Set();
    this._pending = [];
    this._listeners = new Map();
    this._undo = [];
    this._redo = [];
    this._txn = null;
    this._applyRegWrite(
      'ly',
      DEFAULT_LAYER,
      { name: 'Default', visible: true, locked: false, order: 0, __exists: true },
      ZERO_STAMP,
    );
  }

  // ---------------------------------------------------------------- events

  on(name, cb) {
    let set = this._listeners.get(name);
    if (!set) this._listeners.set(name, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  off(name, cb) {
    this._listeners.get(name)?.delete(cb);
  }

  _emit(name, arg) {
    const set = this._listeners.get(name);
    if (set) for (const cb of [...set]) cb(arg);
  }

  // ----------------------------------------------------------- state access

  _ent(kind, id, create = false) {
    const key = kind + ':' + id;
    let e = this._ents.get(key);
    if (!e && create) {
      e = new Entity(kind, id);
      this._ents.set(key, e);
    }
    return e;
  }

  _applyRegWrite(kind, id, fields, stamp) {
    for (const [f, v] of Object.entries(fields)) this._applyWrite({ e: kind, i: id, f, v, s: stamp });
  }

  _applyWrite(w) {
    if (!w || (w.e !== 'el' && w.e !== 'ly') || typeof w.i !== 'string' || typeof w.f !== 'string' || !Array.isArray(w.s)) {
      throw new DiagramError('malformed write');
    }
    const ent = this._ent(w.e, w.i, true);
    const cur = ent.regs.get(w.f);
    if (!cur || cmpStamp(w.s, cur.s) > 0) ent.regs.set(w.f, { v: clone(w.v), s: [w.s[0], w.s[1]] });
  }

  _field(ent, f) {
    return ent.regs.get(f)?.v;
  }

  _liveEnt(kind, id) {
    const e = this._ents.get(kind + ':' + id);
    return e && e.regs.get('__exists')?.v === true ? e : undefined;
  }

  _elEnt(id) {
    return this._liveEnt('el', id);
  }

  _layerEnt(id) {
    return this._liveEnt('ly', id);
  }

  _requireEl(id) {
    const e = this._elEnt(id);
    if (!e) throw new DiagramError(`unknown element id: ${id}`, 'UNKNOWN_ID');
    return e;
  }

  _requireLayer(id) {
    const e = this._layerEnt(id);
    if (!e) throw new DiagramError(`unknown layer id: ${id}`, 'UNKNOWN_ID');
    return e;
  }

  _isConnectorEnt(e) {
    return this._field(e, 'type') === CONNECTOR;
  }

  _isLive(e) {
    if (e.regs.get('__exists')?.v !== true) return false;
    if (this._isConnectorEnt(e)) {
      const s = this._field(e, 'source');
      const t = this._field(e, 'target');
      return !!(s && t && this._elEnt(s.elementId) && this._elEnt(t.elementId));
    }
    return true;
  }

  _assertLayerWritable(layerId) {
    const layer = this._requireLayer(layerId);
    if (this._field(layer, 'locked')) throw new DiagramError(`layer "${layerId}" is locked`, 'LOCKED');
  }

  _assertWritable(ent) {
    const layerId = this._field(ent, 'layer') ?? DEFAULT_LAYER;
    const layer = this._layerEnt(layerId);
    if (layer && this._field(layer, 'locked')) throw new DiagramError(`layer "${layerId}" is locked`, 'LOCKED');
  }

  _layerOrders() {
    const m = new Map();
    for (const e of this._ents.values()) {
      if (e.kind === 'ly' && e.regs.get('__exists')?.v === true) m.set(e.id, this._field(e, 'order') ?? 0);
    }
    return m;
  }

  _layerVisible(layerId) {
    const l = this._layerEnt(layerId);
    return !l || this._field(l, 'visible') !== false;
  }

  _view(e) {
    const out = {};
    for (const [f, r] of e.regs) {
      if (f === '__exists' || r.v === undefined) continue;
      if (f.startsWith('style.')) {
        out.style ??= {};
        out.style[f.slice(6)] = clone(r.v);
      } else {
        out[f] = clone(r.v);
      }
    }
    out.id = e.id;
    out.style ??= {};
    out.groupId ??= null;
    out.layer ??= DEFAULT_LAYER;
    out.z ??= 0;
    if (out.type === CONNECTOR) {
      out.routing ??= 'straight';
      out.waypoints ??= [];
      out.label ??= '';
    } else {
      for (const k of NUMERIC) out[k] ??= 0;
      out.text ??= '';
    }
    // canonical key order so equal states serialise identically
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  _allElementEnts() {
    const list = [];
    for (const e of this._ents.values()) if (e.kind === 'el' && this._elEnt(e.id)) list.push(e);
    return list;
  }

  _topZ() {
    let m = null;
    for (const e of this._allElementEnts()) {
      const z = this._field(e, 'z') ?? 0;
      if (m === null || z > m) m = z;
    }
    return m === null ? 1 : m + 1;
  }

  // ------------------------------------------------------- commit / history

  _commit(type, writes, mode = 'do') {
    const l = ++this._clock;
    const stamp = [l, this.actor];
    const records = [];
    for (const w of writes) {
      w.s = stamp;
      const ent = this._ent(w.e, w.i, true);
      const prev = ent.regs.get(w.f);
      ent.regs.set(w.f, { v: w.v, s: stamp });
      records.push({
        e: w.e,
        i: w.i,
        f: w.f,
        prev: prev ? { v: prev.v, s: prev.s } : null,
        next: { v: w.v, s: stamp },
      });
    }
    const opId = `${this.actor}:${l}`;
    const op = JSON.parse(
      JSON.stringify({
        id: opId,
        actor: this.actor,
        clock: l,
        type,
        writes: writes.map((w) => ({ e: w.e, i: w.i, f: w.f, v: w.v, s: w.s })),
      }),
    );
    this._applied.add(opId);
    this._pending.push(op);
    this._emit('op', op);

    if (mode === 'do') {
      if (this._txn) this._txn.push(...records);
      else this._pushHistory(records);
    } else if (mode === 'undo') {
      this._redo.push(records);
    } else if (mode === 'redo') {
      this._undo.push(records);
    }
    return op;
  }

  _pushHistory(records) {
    this._undo.push(records);
    if (this._undo.length > MAX_HISTORY) this._undo.shift();
    this._redo = [];
  }

  /** Writes that restore the state before a recorded group (only registers still holding our last write). */
  _revertWrites(records) {
    const byKey = new Map();
    for (const r of records) {
      const key = r.e + '\u0000' + r.i + '\u0000' + r.f;
      let en = byKey.get(key);
      if (!en) {
        en = { e: r.e, i: r.i, f: r.f, first: r.prev, expect: r.next.s };
        byKey.set(key, en);
      }
      en.expect = r.next.s;
    }
    const writes = [];
    for (const en of byKey.values()) {
      const ent = this._ents.get(en.e + ':' + en.i);
      const cur = ent?.regs.get(en.f);
      if (!cur || !sameStamp(cur.s, en.expect)) continue;
      writes.push(write(en.e, en.i, en.f, en.first ? en.first.v : undefined));
    }
    return writes;
  }

  // ----------------------------------------------------------- operations

  /** Applies a local operation. Returns the emitted op, or null when it changed nothing. */
  apply(op) {
    if (!op || typeof op !== 'object') throw new DiagramError('operation must be an object');
    let writes;
    switch (op.type) {
      case 'add':
        writes = this._wAdd(op);
        break;
      case 'update':
        writes = this._wUpdate(op);
        break;
      case 'remove':
        writes = this._removeWrites([this._requireEl(op.id).id]);
        break;
      case 'move':
        writes = this._wMove(op);
        break;
      case 'resize':
        writes = this._wResize(op);
        break;
      case 'rotate':
        writes = this._wRotate(op);
        break;
      case 'group':
        writes = this._wGroup(op);
        break;
      case 'ungroup':
        writes = this._wUngroup(op);
        break;
      case 'reorder':
        writes = this._wReorder(op);
        break;
      case 'addLayer':
        writes = this._wAddLayer(op);
        break;
      case 'updateLayer':
        writes = this._wUpdateLayer(op);
        break;
      case 'removeLayer':
        writes = this._wRemoveLayer(op);
        break;
      case 'setStyle':
        writes = this._wSetStyle(op);
        break;
      default:
        throw new DiagramError(`unknown operation type: ${op.type}`, 'UNKNOWN_OP');
    }
    if (!writes || writes.length === 0) return null;
    return this._commit(op.type, writes, 'do');
  }

  _uniqueIds(ids) {
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    return [...new Set(ids.map((x) => String(x)))];
  }

  _checkEndpoint(ep) {
    if (!ep || typeof ep !== 'object' || typeof ep.elementId !== 'string') {
      throw new DiagramError('connector endpoint requires elementId');
    }
    const target = this._elEnt(ep.elementId);
    if (!target) throw new DiagramError(`unknown element id: ${ep.elementId}`, 'UNKNOWN_ID');
    if (this._isConnectorEnt(target)) throw new DiagramError('connectors cannot attach to connectors');
    const out = { elementId: ep.elementId };
    if (ep.port !== undefined) out.port = ep.port;
    return out;
  }

  _wAdd(op) {
    const el = op.element;
    if (!el || typeof el !== 'object') throw new DiagramError('add requires an element');
    const type = el.type;
    if (type !== CONNECTOR && !SHAPE_TYPES.has(type)) throw new DiagramError(`unknown element type: ${type}`);
    const id = el.id === undefined ? uid('el-') : String(el.id);
    if (this._elEnt(id)) throw new DiagramError(`duplicate element id: ${id}`);
    const layer = el.layer ?? DEFAULT_LAYER;
    this._assertLayerWritable(layer);

    const data =
      type === CONNECTOR
        ? { routing: 'straight', waypoints: [], label: '' }
        : { x: 0, y: 0, width: 0, height: 0, rotation: 0, text: '' };
    for (const [k, v] of Object.entries(el)) {
      if (!ADD_RESERVED.has(k) && v !== undefined) data[k] = v;
    }
    const w = [];
    const put = (f, v) => w.push(write('el', id, f, v));
    put('__exists', true);
    put('type', type);
    put('layer', layer);
    put('groupId', el.groupId ?? null);
    put('z', el.z !== undefined ? num(el.z, 'z') : this._topZ());
    if (type === CONNECTOR) {
      if (!ROUTINGS.has(data.routing)) throw new DiagramError(`unknown routing: ${data.routing}`);
      data.source = this._checkEndpoint(data.source);
      data.target = this._checkEndpoint(data.target);
    } else {
      for (const k of NUMERIC) data[k] = num(data[k], k);
      if (data.width < 0 || data.height < 0) throw new DiagramError('width and height must be non-negative');
    }
    for (const [k, v] of Object.entries(data)) put(k, v);
    for (const [k, v] of Object.entries(el.style ?? {})) put('style.' + k, v ?? undefined);
    return w;
  }

  _wUpdate(op) {
    const ent = this._requireEl(op.id);
    this._assertWritable(ent);
    const patch = op.patch ?? {};
    if (typeof patch !== 'object') throw new DiagramError('patch must be an object');
    const w = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === 'type') continue;
      if (k === 'style') {
        for (const [sk, sv] of Object.entries(v ?? {})) w.push(write('el', ent.id, 'style.' + sk, sv ?? undefined));
        continue;
      }
      if (k === 'layer') this._assertLayerWritable(v);
      if (NUMERIC.includes(k) && v !== undefined) num(v, k);
      if (k === 'source' || k === 'target') {
        w.push(write('el', ent.id, k, this._checkEndpoint(v)));
        continue;
      }
      w.push(write('el', ent.id, k, v));
    }
    return w;
  }

  _removeWrites(ids) {
    const all = new Set(ids);
    for (const e of this._allElementEnts()) {
      if (!this._isConnectorEnt(e)) continue;
      const s = this._field(e, 'source');
      const t = this._field(e, 'target');
      if (s && t && (all.has(s.elementId) || all.has(t.elementId))) all.add(e.id);
    }
    const w = [];
    for (const id of all) {
      this._assertWritable(this._requireEl(id));
      w.push(write('el', id, '__exists', false));
    }
    return w;
  }

  _wMove(op) {
    const dx = num(op.dx, 'dx');
    const dy = num(op.dy, 'dy');
    const w = [];
    for (const id of this._uniqueIds(op.ids)) {
      const ent = this._requireEl(id);
      if (this._isConnectorEnt(ent)) continue;
      this._assertWritable(ent);
      w.push(write('el', id, 'x', this._field(ent, 'x') + dx));
      w.push(write('el', id, 'y', this._field(ent, 'y') + dy));
    }
    return w;
  }

  _wResize(op) {
    const ent = this._requireEl(op.id);
    this._assertWritable(ent);
    const box = op.box ?? {};
    let x = num(box.x, 'box.x');
    let y = num(box.y, 'box.y');
    let width = Math.max(0, num(box.width, 'box.width'));
    let height = Math.max(0, num(box.height, 'box.height'));
    if (op.keepAspect) {
      const w0 = this._field(ent, 'width') ?? 0;
      const h0 = this._field(ent, 'height') ?? 0;
      if (w0 > 0 && h0 > 0) {
        const s = Math.min(width / w0, height / h0);
        width = w0 * s;
        height = h0 * s;
      }
    }
    return [
      write('el', ent.id, 'x', x),
      write('el', ent.id, 'y', y),
      write('el', ent.id, 'width', width),
      write('el', ent.id, 'height', height),
    ];
  }

  _wRotate(op) {
    const ent = this._requireEl(op.id);
    this._assertWritable(ent);
    return [write('el', ent.id, 'rotation', num(op.deg, 'deg'))];
  }

  _wGroup(op) {
    const gid = op.groupId === undefined ? uid('group-') : String(op.groupId);
    const w = [];
    for (const id of this._uniqueIds(op.ids)) {
      const ent = this._requireEl(id);
      this._assertWritable(ent);
      w.push(write('el', id, 'groupId', gid));
    }
    return w;
  }

  _wUngroup(op) {
    const members = this._allElementEnts().filter((e) => this._field(e, 'groupId') === op.groupId);
    if (members.length === 0) throw new DiagramError(`unknown group: ${op.groupId}`);
    return members.map((e) => {
      this._assertWritable(e);
      return write('el', e.id, 'groupId', null);
    });
  }

  _wReorder(op) {
    const ent = this._requireEl(op.id);
    const list = this._allElementEnts()
      .map((e) => ({ id: e.id, z: this._field(e, 'z') ?? 0 }))
      .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const i = list.findIndex((e) => e.id === ent.id);
    let nz;
    switch (op.to) {
      case 'front':
        nz = list[list.length - 1].z + 1;
        break;
      case 'back':
        nz = list[0].z - 1;
        break;
      case 'forward': {
        if (i === list.length - 1) return [];
        const n1 = list[i + 1];
        const n2 = list[i + 2];
        nz = n2 ? (n1.z + n2.z) / 2 : n1.z + 1;
        break;
      }
      case 'backward': {
        if (i === 0) return [];
        const p1 = list[i - 1];
        const p2 = list[i - 2];
        nz = p2 ? (p2.z + p1.z) / 2 : p1.z - 1;
        break;
      }
      default:
        throw new DiagramError(`unknown reorder target: ${op.to}`);
    }
    this._assertWritable(ent);
    return [write('el', ent.id, 'z', nz)];
  }

  _wAddLayer(op) {
    const L = op.layer;
    if (!L || typeof L !== 'object') throw new DiagramError('addLayer requires a layer');
    const id = L.id === undefined ? uid('layer-') : String(L.id);
    if (this._layerEnt(id)) throw new DiagramError(`duplicate layer id: ${id}`);
    let maxOrder = 0;
    for (const [lid, o] of this._layerOrders()) maxOrder = Math.max(maxOrder, o);
    const order = L.order === undefined ? maxOrder + 1 : num(L.order, 'order');
    return [
      write('ly', id, '__exists', true),
      write('ly', id, 'name', L.name ?? id),
      write('ly', id, 'visible', L.visible ?? true),
      write('ly', id, 'locked', L.locked ?? false),
      write('ly', id, 'order', order),
    ];
  }

  _wUpdateLayer(op) {
    const ent = this._requireLayer(op.id);
    const patch = op.patch ?? {};
    const w = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || k === '__exists') continue;
      if (k === 'order') num(v, 'order');
      w.push(write('ly', ent.id, k, v));
    }
    return w;
  }

  _wRemoveLayer(op) {
    if (op.id === DEFAULT_LAYER) throw new DiagramError('the default layer cannot be removed');
    const layer = this._requireLayer(op.id);
    const ids = this._allElementEnts()
      .filter((e) => (this._field(e, 'layer') ?? DEFAULT_LAYER) === layer.id)
      .map((e) => e.id);
    const w = this._removeWrites(ids);
    w.push(write('ly', layer.id, '__exists', false));
    return w;
  }

  _wSetStyle(op) {
    const style = op.style ?? {};
    const w = [];
    for (const id of this._uniqueIds(op.ids)) {
      const ent = this._requireEl(id);
      this._assertWritable(ent);
      for (const [k, v] of Object.entries(style)) w.push(write('el', id, 'style.' + k, v ?? undefined));
    }
    return w;
  }

  // ---------------------------------------------------------- transactions

  /** Runs fn as one undo step. If fn throws, the changes it made are reverted. */
  transaction(fn) {
    if (this._txn) return fn(this);
    this._txn = [];
    let result;
    try {
      result = fn(this);
    } catch (err) {
      const records = this._txn;
      this._txn = null;
      const writes = this._revertWrites(records);
      if (writes.length) this._commit('rollback', writes, 'rollback');
      throw err;
    }
    const records = this._txn;
    this._txn = null;
    if (records.length) this._pushHistory(records);
    return result;
  }

  undo() {
    if (this._txn) throw new DiagramError('cannot undo inside a transaction');
    const group = this._undo.pop();
    if (!group) return false;
    const writes = this._revertWrites(group);
    if (writes.length) this._commit('undo', writes, 'undo');
    return true;
  }

  redo() {
    if (this._txn) throw new DiagramError('cannot redo inside a transaction');
    const group = this._redo.pop();
    if (!group) return false;
    const writes = this._revertWrites(group);
    if (writes.length) this._commit('redo', writes, 'redo');
    return true;
  }

  // ------------------------------------------------------- collaboration

  pendingOps() {
    const out = this._pending;
    this._pending = [];
    return out;
  }

  /** Integrates remote ops. Idempotent. Returns the number of newly applied ops. */
  receive(input) {
    const ops = Array.isArray(input) ? input : [input];
    for (const op of ops) {
      if (!op || typeof op.id !== 'string' || !Array.isArray(op.writes)) throw new DiagramError('invalid remote op');
    }
    let applied = 0;
    for (const op of ops) {
      if (this._applied.has(op.id)) continue;
      this._applied.add(op.id);
      if (Number.isFinite(op.clock) && op.clock > this._clock) this._clock = op.clock;
      for (const w of op.writes) this._applyWrite(w);
      applied++;
    }
    if (applied) this._emit('change', { applied });
    return applied;
  }

  // ------------------------------------------------------------- queries

  get(id) {
    const e = this._elEnt(String(id));
    if (!e || !this._isLive(e)) return undefined;
    return this._view(e);
  }

  elements(filter = {}) {
    const orders = this._layerOrders();
    const views = [];
    for (const e of this._allElementEnts()) {
      if (this._isLive(e)) views.push(this._view(e));
    }
    views.sort(
      (a, b) =>
        (orders.get(a.layer) ?? 0) - (orders.get(b.layer) ?? 0) ||
        a.z - b.z ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return views.filter(
      (v) =>
        (filter.layer === undefined || v.layer === filter.layer) &&
        (filter.type === undefined || v.type === filter.type),
    );
  }

  layers() {
    const out = [];
    for (const e of this._ents.values()) {
      if (e.kind !== 'ly' || e.regs.get('__exists')?.v !== true) continue;
      out.push({
        id: e.id,
        name: this._field(e, 'name') ?? e.id,
        visible: this._field(e, 'visible') !== false,
        locked: this._field(e, 'locked') === true,
        order: this._field(e, 'order') ?? 0,
      });
    }
    return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  }

  /** Elements on visible layers. */
  visibleElements() {
    return this.elements().filter((v) => this._layerVisible(v.layer));
  }

  hitTest(x, y) {
    const list = this.visibleElements().filter((v) => v.type !== CONNECTOR);
    for (let i = list.length - 1; i >= 0; i--) {
      if (containsPoint(list[i], x, y)) return list[i];
    }
    return null;
  }

  select(rect) {
    const r = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    return this.visibleElements().filter((v) => {
      if (v.type === CONNECTOR) return false;
      return cornersOf(v).every(
        (p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height,
      );
    });
  }

  bounds(ids) {
    const list = ids
      ? this._uniqueIds(ids).map((id) => {
          const v = this.get(id);
          if (!v) throw new DiagramError(`unknown element id: ${id}`, 'UNKNOWN_ID');
          return v;
        })
      : this.visibleElements();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const extend = (x, y) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    for (const v of list) {
      if (v.type === CONNECTOR) {
        for (const [x, y] of this.route(v.id)) extend(x, y);
      } else {
        extend(v.x, v.y);
        extend(v.x + v.width, v.y + v.height);
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // ------------------------------------------------------------- routing

  route(connectorId) {
    const c = this.get(connectorId);
    if (!c || c.type !== CONNECTOR) throw new DiagramError(`unknown connector id: ${connectorId}`, 'UNKNOWN_ID');
    const src = this.get(c.source.elementId);
    const tgt = this.get(c.target.elementId);
    if (!src || !tgt) throw new DiagramError('connector endpoint is missing');
    const wps = (c.waypoints ?? []).map(toPt);
    if (c.routing === 'orthogonal') {
      const obstacles = this.elements().filter((v) => v.type !== CONNECTOR);
      const r = orthogonalRoute({
        obstacles,
        src,
        tgt,
        wps,
        srcPort: c.source.port,
        tgtPort: c.target.port,
      });
      return r ?? fallbackRoute(src, tgt, wps, c.source.port, c.target.port);
    }
    return straightRoute(src, tgt, wps, c.source.port, c.target.port);
  }

  // ------------------------------------------------------------ geometry

  _shapesOf(ids) {
    return this._uniqueIds(ids)
      .map((id) => {
        const v = this.get(id);
        if (!v) throw new DiagramError(`unknown element id: ${id}`, 'UNKNOWN_ID');
        return v;
      })
      .filter((v) => v.type !== CONNECTOR);
  }

  align(ids, mode) {
    const list = this._shapesOf(ids);
    if (list.length === 0) return;
    const minX = Math.min(...list.map((v) => v.x));
    const maxX = Math.max(...list.map((v) => v.x + v.width));
    const minY = Math.min(...list.map((v) => v.y));
    const maxY = Math.max(...list.map((v) => v.y + v.height));
    const patchFor = (v) => {
      switch (mode) {
        case 'left':
          return { x: minX };
        case 'right':
          return { x: maxX - v.width };
        case 'center':
          return { x: (minX + maxX) / 2 - v.width / 2 };
        case 'top':
          return { y: minY };
        case 'bottom':
          return { y: maxY - v.height };
        case 'middle':
          return { y: (minY + maxY) / 2 - v.height / 2 };
        default:
          throw new DiagramError(`unknown align mode: ${mode}`);
      }
    };
    this.transaction(() => {
      for (const v of list) {
        const patch = patchFor(v);
        const changed = Object.entries(patch).some(([k, val]) => v[k] !== val);
        if (changed) this.apply({ type: 'update', id: v.id, patch });
      }
    });
  }

  distribute(ids, direction) {
    const horizontal = direction === 'horizontal';
    if (!horizontal && direction !== 'vertical') throw new DiagramError(`unknown distribute direction: ${direction}`);
    const pos = horizontal ? 'x' : 'y';
    const size = horizontal ? 'width' : 'height';
    const list = this._shapesOf(ids).sort((a, b) => a[pos] - b[pos] || (a.id < b.id ? -1 : 1));
    if (list.length < 3) return;
    const first = list[0];
    const last = list[list.length - 1];
    const total = list.reduce((s, v) => s + v[size], 0);
    const span = last[pos] + last[size] - first[pos];
    const gap = (span - total) / (list.length - 1);
    this.transaction(() => {
      let cursor = first[pos];
      for (let i = 1; i < list.length - 1; i++) {
        cursor = cursor + list[i - 1][size] + gap;
        if (list[i][pos] !== cursor) this.apply({ type: 'update', id: list[i].id, patch: { [pos]: cursor } });
      }
    });
  }

  layout(kind, opts = {}) {
    const all = this.elements();
    const nodes = all.filter((v) => v.type !== CONNECTOR);
    const spacing = opts.spacing ?? 40;
    let positions;
    if (kind === 'layered') {
      const direction = opts.direction ?? 'TB';
      if (direction !== 'TB' && direction !== 'LR') throw new DiagramError(`unknown direction: ${direction}`);
      const ids = new Set(nodes.map((n) => n.id));
      const edges = all
        .filter((v) => v.type === CONNECTOR && ids.has(v.source.elementId) && ids.has(v.target.elementId))
        .map((v) => ({ from: v.source.elementId, to: v.target.elementId }));
      positions = layeredPositions(nodes, edges, { direction, spacing });
    } else if (kind === 'grid') {
      positions = gridPositions(nodes, { spacing });
    } else {
      throw new DiagramError(`unknown layout: ${kind}`);
    }
    this.transaction(() => {
      for (const v of nodes) {
        const p = positions.get(v.id);
        if (p && (p.x !== v.x || p.y !== v.y)) this.apply({ type: 'update', id: v.id, patch: { x: p.x, y: p.y } });
      }
    });
  }

  // ------------------------------------------------------- serialization

  toJSON() {
    const regs = [];
    for (const ent of this._ents.values()) {
      for (const [f, r] of ent.regs) {
        const o = { e: ent.kind, i: ent.id, f, s: [r.s[0], r.s[1]] };
        if (r.v !== undefined) o.v = clone(r.v);
        regs.push(o);
      }
    }
    regs.sort((a, b) => {
      const ka = a.e + '\u0000' + a.i + '\u0000' + a.f;
      const kb = b.e + '\u0000' + b.i + '\u0000' + b.f;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return { id: this.id, layers: this.layers(), elements: this.elements(), regs };
  }

  toSVG(opts = {}) {
    return renderSVG(this, opts);
  }
}

export function fromJSON(json, opts = {}) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (!obj || typeof obj !== 'object') throw new DiagramError('invalid document JSON');
  const doc = new DiagramDocument({ id: obj.id, actor: opts.actor });
  if (Array.isArray(obj.regs)) {
    for (const r of obj.regs) doc._applyWrite({ e: r.e, i: r.i, f: r.f, v: r.v, s: r.s });
    for (const e of doc._ents.values()) {
      for (const r of e.regs.values()) if (r.s[0] > doc._clock) doc._clock = r.s[0];
    }
  } else {
    for (const l of obj.layers ?? []) {
      if (l.id === DEFAULT_LAYER) doc.apply({ type: 'updateLayer', id: l.id, patch: l });
      else doc.apply({ type: 'addLayer', layer: l });
    }
    const els = obj.elements ?? [];
    for (const el of els.filter((e) => e.type !== CONNECTOR)) doc.apply({ type: 'add', element: el });
    for (const el of els.filter((e) => e.type === CONNECTOR)) doc.apply({ type: 'add', element: el });
    doc.pendingOps();
    doc._undo = [];
    doc._redo = [];
  }
  return doc;
}

export { centerOf, clipToBoundary, portPoint };
