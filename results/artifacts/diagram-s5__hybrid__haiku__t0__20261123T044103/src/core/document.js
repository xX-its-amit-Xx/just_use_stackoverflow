// Diagram document: operation log replayed in Lamport order (CRDT), undo/redo, queries, layout.
import { DiagramError, newId } from './errors.js';
import { aabb, containsPoint, corners } from './geometry.js';
import { routeConnector } from './routing.js';
import { layoutLayered, layoutGrid } from './layout.js';
import { renderSVG } from './svg.js';

export const DEFAULT_LAYER = 'default';
const SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);
const ROUTINGS = new Set(['straight', 'orthogonal']);
const OP_TYPES = new Set(['add', 'update', 'remove', 'move', 'addLayer', 'updateLayer', 'removeLayer']);
const HISTORY_LIMIT = 500;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

function num(v, name, dflt) {
  if (v === undefined) {
    if (dflt === undefined) throw new DiagramError(`${name} is required`);
    return dflt;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DiagramError(`${name} must be a finite number`);
  return v;
}

function cmpEnv(a, b) {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

const zCmp = (a, b) => (a.z - b.z) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function defaultLayer() {
  return { id: DEFAULT_LAYER, name: 'Layer 1', visible: true, locked: false, order: 0 };
}

function emptyState() {
  return { items: new Map(), layers: new Map([[DEFAULT_LAYER, defaultLayer()]]), tomb: new Map() };
}

function cloneState(s) {
  return {
    items: new Map([...s.items].map(([k, v]) => [k, clone(v)])),
    layers: new Map([...s.layers].map(([k, v]) => [k, clone(v)])),
    tomb: new Map([...s.tomb].map(([k, v]) => [k, { ...v }])),
  };
}

function applyPatch(target, patch) {
  for (const key of Object.keys(patch)) {
    if (key === 'id' || key === 'type') continue;
    const v = patch[key];
    if (v === undefined) continue;
    if (key === 'style' && isObj(v)) {
      if (!isObj(target.style)) target.style = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) delete target.style[sk];
        else target.style[sk] = clone(sv);
      }
    } else {
      target[key] = clone(v);
    }
  }
}

// Deterministic replay of one operation envelope into state. Never throws:
// operations that do not apply (unknown ids, tombstoned targets) are ignored.
function applyEnv(st, env) {
  const op = env.op;
  switch (op.type) {
    case 'add': {
      const el = op.element;
      if (st.items.has(el.id)) return;
      const t = st.tomb.get(el.id);
      if (t) {
        if (cmpEnv(env, t) < 0) return;
        st.tomb.delete(el.id);
      }
      if (el.type === 'connector') {
        if (!st.items.has(el.source.elementId) || !st.items.has(el.target.elementId)) return;
      }
      st.items.set(el.id, clone(el));
      return;
    }
    case 'update': {
      const it = st.items.get(op.id);
      if (it) applyPatch(it, op.patch);
      return;
    }
    case 'remove': {
      const rm = (id) => {
        const cur = st.tomb.get(id);
        if (!cur || cmpEnv(env, cur) > 0) st.tomb.set(id, { clock: env.clock, actor: env.actor, id: env.id });
        st.items.delete(id);
      };
      if (!st.items.has(op.id)) { rm(op.id); return; }
      const attached = [];
      for (const [cid, c] of st.items) {
        if (c.type === 'connector' && (c.source.elementId === op.id || c.target.elementId === op.id)) attached.push(cid);
      }
      rm(op.id);
      for (const cid of attached) rm(cid);
      return;
    }
    case 'move': {
      for (const id of op.ids) {
        const it = st.items.get(id);
        if (!it) continue;
        if (it.type === 'connector') {
          for (const p of it.waypoints ?? []) { p[0] += op.dx; p[1] += op.dy; }
        } else {
          it.x += op.dx;
          it.y += op.dy;
        }
      }
      return;
    }
    case 'addLayer': {
      const l = op.layer;
      if (!st.layers.has(l.id)) st.layers.set(l.id, clone(l));
      return;
    }
    case 'updateLayer': {
      const l = st.layers.get(op.id);
      if (l) applyPatch(l, op.patch);
      return;
    }
    case 'removeLayer': {
      if (op.id === DEFAULT_LAYER || !st.layers.has(op.id)) return;
      st.layers.delete(op.id);
      for (const it of st.items.values()) if (it.layer === op.id) it.layer = DEFAULT_LAYER;
      return;
    }
    default:
      return;
  }
}

function flatRev(groups) {
  return groups.slice().reverse().flat();
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export class Doc {
  constructor({ id, actor, base }) {
    this.id = id;
    this.actor = actor;
    this._base = base ?? emptyState();
    this._state = cloneState(this._base);
    this._log = [];
    this._ids = new Set();
    this._clock = 0;
    this._pending = [];
    this._undo = [];
    this._redo = [];
    this._tx = null;
    this._listeners = new Map();
  }

  // ---- events -------------------------------------------------------------
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
    return () => {
      const l = this._listeners.get(event);
      const i = l ? l.indexOf(cb) : -1;
      if (i >= 0) l.splice(i, 1);
    };
  }

  _emit(event, arg) {
    for (const cb of this._listeners.get(event) ?? []) cb(arg);
  }

  // ---- replication core ---------------------------------------------------
  _rebuild() {
    const st = cloneState(this._base);
    for (const env of this._log) applyEnv(st, env);
    return st;
  }

  // Insert envelopes (already de-duplicated) keeping the log sorted by (clock, actor, id).
  _integrate(envs) {
    if (!envs.length) return;
    envs.sort(cmpEnv);
    const last = this._log.length ? this._log[this._log.length - 1] : null;
    if (!last || cmpEnv(envs[0], last) > 0) {
      for (const e of envs) {
        this._log.push(e);
        applyEnv(this._state, e);
      }
    } else {
      this._log = this._log.concat(envs).sort(cmpEnv);
      this._state = this._rebuild();
    }
  }

  pendingOps() {
    const out = this._pending;
    this._pending = [];
    return out;
  }

  receive(remote) {
    const list = Array.isArray(remote) ? remote : [remote];
    const fresh = [];
    const seen = new Set();
    for (const raw of list) {
      if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.actor !== 'string'
        || !Number.isFinite(raw.clock) || !isObj(raw.op) || typeof raw.op.type !== 'string') {
        throw new DiagramError('malformed operation envelope');
      }
      if (!OP_TYPES.has(raw.op.type)) throw new DiagramError(`unknown operation type ${raw.op.type}`);
      if (this._ids.has(raw.id) || seen.has(raw.id)) continue;
      seen.add(raw.id);
      fresh.push(clone(raw));
    }
    if (!fresh.length) return 0;
    for (const e of fresh) {
      this._ids.add(e.id);
      this._clock = Math.max(this._clock, e.clock);
    }
    this._integrate(fresh);
    this._emit('change');
    return fresh.length;
  }

  // ---- transactions / history ----------------------------------------------
  _run(fn, onCommit) {
    if (this._tx) return fn(this._tx);
    const tx = { logLen: this._log.length, pendLen: this._pending.length, envs: [], groups: [] };
    this._tx = tx;
    let result;
    try {
      result = fn(tx);
    } catch (e) {
      this._tx = null;
      for (const env of tx.envs) this._ids.delete(env.id);
      this._log.length = tx.logLen;
      this._pending.length = tx.pendLen;
      this._state = this._rebuild();
      throw e;
    }
    this._tx = null;
    if (onCommit) onCommit(tx);
    for (const env of tx.envs) this._emit('op', clone(env));
    if (tx.envs.length) this._emit('change');
    return result;
  }

  _record(tx) {
    if (!tx.groups.length) return;
    this._undo.push({ ops: flatRev(tx.groups) });
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this._redo = [];
  }

  transaction(fn) {
    return this._run(() => fn(this), (tx) => this._record(tx));
  }

  undo() {
    if (this._tx) throw new DiagramError('undo is not allowed inside a transaction');
    const entry = this._undo.pop();
    if (!entry) return false;
    try {
      this._run((tx) => { tx.groups.push(...this._exec(entry.ops)); }, (tx) => {
        if (tx.groups.length) {
          this._redo.push({ ops: flatRev(tx.groups) });
          if (this._redo.length > HISTORY_LIMIT) this._redo.shift();
        }
      });
      return true;
    } catch (e) {
      if (e instanceof DiagramError) return false;
      throw e;
    }
  }

  redo() {
    if (this._tx) throw new DiagramError('redo is not allowed inside a transaction');
    const entry = this._redo.pop();
    if (!entry) return false;
    try {
      this._run((tx) => { tx.groups.push(...this._exec(entry.ops)); }, (tx) => {
        if (tx.groups.length) {
          this._undo.push({ ops: flatRev(tx.groups) });
          if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
        }
      });
      return true;
    } catch (e) {
      if (e instanceof DiagramError) return false;
      throw e;
    }
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  // Execute canonical ops as new local operations; returns inverse groups (one per op).
  _exec(canons) {
    const tx = this._tx;
    const groups = [];
    for (const c of canons) {
      this._check(c);
      groups.push(this._invert(c));
      const clock = this._clock + 1;
      const env = { id: `${this.actor}:${clock}`, actor: this.actor, clock, op: c };
      this._clock = clock;
      this._ids.add(env.id);
      this._integrate([env]);
      this._pending.push(clone(env));
      tx.envs.push(env);
    }
    return groups;
  }

  _commit(canons) {
    if (!canons.length) return;
    this._run((tx) => { tx.groups.push(...this._exec(canons)); }, (tx) => this._record(tx));
  }

  // ---- validation / compile -------------------------------------------------
  _need(id) {
    const it = this._state.items.get(id);
    if (!it) throw new DiagramError(`unknown element ${String(id)}`);
    return it;
  }

  _needLayer(id) {
    const l = this._state.layers.get(id);
    if (!l) throw new DiagramError(`unknown layer ${String(id)}`);
    return l;
  }

  _assertWritable(layerId) {
    if (this._needLayer(layerId).locked) throw new DiagramError(`layer ${layerId} is locked`);
  }

  _ids_(list) {
    if (!Array.isArray(list)) throw new DiagramError('ids must be an array');
    return list.map((id) => this._need(id).id);
  }

  _nextZ() {
    let max = null;
    for (const it of this._state.items.values()) if (max === null || it.z > max) max = it.z;
    return max === null ? 0 : max + 1;
  }

  _normalize(raw) {
    if (!isObj(raw)) throw new DiagramError('element must be an object');
    const type = raw.type;
    const id = raw.id ?? newId(type === 'connector' ? 'c' : 'e');
    if (typeof id !== 'string' && typeof id !== 'number') throw new DiagramError('invalid id');
    if (this._state.items.has(id)) throw new DiagramError(`duplicate id ${String(id)}`);
    const layer = raw.layer ?? DEFAULT_LAYER;
    this._assertWritable(layer);
    const z = num(raw.z, 'z', this._nextZ());
    const common = { ...clone(raw), id, layer, groupId: raw.groupId ?? null, z };
    if (type === 'connector') {
      const s = raw.source;
      const t = raw.target;
      if (!isObj(s) || !isObj(t) || typeof s.elementId !== 'string' || typeof t.elementId !== 'string') {
        throw new DiagramError('connector requires source.elementId and target.elementId');
      }
      for (const end of [s, t]) {
        const ref = this._state.items.get(end.elementId);
        if (!ref || ref.type === 'connector') throw new DiagramError(`unknown element ${end.elementId}`);
      }
      const routing = raw.routing ?? 'straight';
      if (!ROUTINGS.has(routing)) throw new DiagramError(`unknown routing ${routing}`);
      return {
        ...common,
        type,
        source: clone(s),
        target: clone(t),
        routing,
        waypoints: (raw.waypoints ?? []).map((p) => [num(p[0], 'waypoint x'), num(p[1], 'waypoint y')]),
        label: raw.label ?? '',
        style: clone(raw.style ?? {}),
      };
    }
    if (!SHAPE_TYPES.has(type)) throw new DiagramError(`unknown element type ${String(type)}`);
    return {
      ...common,
      type,
      x: num(raw.x, 'x', 0),
      y: num(raw.y, 'y', 0),
      width: num(raw.width, 'width', 0),
      height: num(raw.height, 'height', 0),
      rotation: num(raw.rotation, 'rotation', 0),
      style: clone(raw.style ?? {}),
      text: raw.text ?? '',
    };
  }

  _compile(op) {
    if (!isObj(op)) throw new DiagramError('operation must be an object');
    switch (op.type) {
      case 'add':
        return [{ type: 'add', element: this._normalize(op.element) }];
      case 'update': {
        this._need(op.id);
        if (!isObj(op.patch)) throw new DiagramError('patch must be an object');
        const patch = clone(op.patch);
        delete patch.id;
        delete patch.type;
        if (patch.layer !== undefined) this._needLayer(patch.layer);
        return [{ type: 'update', id: op.id, patch }];
      }
      case 'remove':
        this._need(op.id);
        return [{ type: 'remove', id: op.id }];
      case 'move': {
        const ids = this._ids_(op.ids);
        return [{ type: 'move', ids, dx: num(op.dx, 'dx', 0), dy: num(op.dy, 'dy', 0) }];
      }
      case 'resize': {
        const it = this._need(op.id);
        if (it.type === 'connector') throw new DiagramError('cannot resize a connector');
        const b = op.box;
        if (!isObj(b)) throw new DiagramError('box required');
        let w = num(b.width, 'width');
        let h = num(b.height, 'height');
        if (op.keepAspect && it.width > 0 && it.height > 0) {
          const s = Math.min(w / it.width, h / it.height);
          w = it.width * s;
          h = it.height * s;
        }
        return [{ type: 'update', id: op.id, patch: { x: num(b.x, 'x'), y: num(b.y, 'y'), width: w, height: h } }];
      }
      case 'rotate': {
        const it = this._need(op.id);
        if (it.type === 'connector') throw new DiagramError('cannot rotate a connector');
        return [{ type: 'update', id: op.id, patch: { rotation: num(op.deg, 'deg') } }];
      }
      case 'group': {
        const ids = this._ids_(op.ids);
        const groupId = op.groupId ?? newId('g');
        return ids.map((id) => ({ type: 'update', id, patch: { groupId } }));
      }
      case 'ungroup': {
        const members = [...this._state.items.values()].filter((it) => it.groupId === op.groupId);
        if (!members.length) throw new DiagramError(`unknown group ${String(op.groupId)}`);
        return members.map((it) => ({ type: 'update', id: it.id, patch: { groupId: null } }));
      }
      case 'reorder': {
        this._need(op.id);
        const list = [...this._state.items.values()].sort(zCmp);
        const idx = list.findIndex((it) => it.id === op.id);
        let z;
        switch (op.to) {
          case 'front':
            if (idx === list.length - 1) return [];
            z = list[list.length - 1].z + 1;
            break;
          case 'back':
            if (idx === 0) return [];
            z = list[0].z - 1;
            break;
          case 'forward': {
            if (idx >= list.length - 1) return [];
            const a = list[idx + 1];
            const b = list[idx + 2];
            z = b ? (a.z + b.z) / 2 : a.z + 1;
            break;
          }
          case 'backward': {
            if (idx <= 0) return [];
            const a = list[idx - 1];
            const b = list[idx - 2];
            z = b ? (b.z + a.z) / 2 : a.z - 1;
            break;
          }
          default:
            throw new DiagramError(`unknown reorder target ${String(op.to)}`);
        }
        return [{ type: 'update', id: op.id, patch: { z } }];
      }
      case 'addLayer': {
        const l = isObj(op.layer) ? op.layer : null;
        if (!l) throw new DiagramError('layer required');
        const id = l.id ?? newId('layer');
        if (this._state.layers.has(id)) throw new DiagramError(`duplicate layer ${id}`);
        const layer = {
          id,
          name: l.name ?? id,
          visible: l.visible ?? true,
          locked: l.locked ?? false,
          order: l.order ?? this._state.layers.size,
        };
        return [{ type: 'addLayer', layer }];
      }
      case 'updateLayer': {
        this._needLayer(op.id);
        const patch = {};
        for (const k of ['name', 'visible', 'locked', 'order']) if (op.patch?.[k] !== undefined) patch[k] = op.patch[k];
        return [{ type: 'updateLayer', id: op.id, patch }];
      }
      case 'removeLayer':
        this._needLayer(op.id);
        if (op.id === DEFAULT_LAYER) throw new DiagramError('the default layer cannot be removed');
        return [{ type: 'removeLayer', id: op.id }];
      case 'setStyle': {
        const ids = this._ids_(op.ids);
        if (!isObj(op.style)) throw new DiagramError('style must be an object');
        return ids.map((id) => ({ type: 'update', id, patch: { style: clone(op.style) } }));
      }
      default:
        throw new DiagramError(`unknown operation type ${String(op.type)}`);
    }
  }

  // Validation of a canonical op against current state (locks, existence).
  _check(c) {
    switch (c.type) {
      case 'add': {
        const el = c.element;
        if (this._state.items.has(el.id)) throw new DiagramError(`duplicate id ${el.id}`);
        this._assertWritable(el.layer);
        return;
      }
      case 'update': {
        const it = this._need(c.id);
        this._assertWritable(it.layer);
        if (c.patch.layer !== undefined) this._assertWritable(c.patch.layer);
        return;
      }
      case 'remove': {
        const it = this._need(c.id);
        this._assertWritable(it.layer);
        for (const o of this._state.items.values()) {
          if (o.type === 'connector' && (o.source.elementId === c.id || o.target.elementId === c.id)) {
            this._assertWritable(o.layer);
          }
        }
        return;
      }
      case 'move':
        for (const id of c.ids) this._assertWritable(this._need(id).layer);
        return;
      case 'addLayer':
        if (this._state.layers.has(c.layer.id)) throw new DiagramError(`duplicate layer ${c.layer.id}`);
        return;
      case 'updateLayer':
        this._needLayer(c.id);
        return;
      case 'removeLayer':
        this._needLayer(c.id);
        if (c.id === DEFAULT_LAYER) throw new DiagramError('the default layer cannot be removed');
        return;
      default:
        return;
    }
  }

  // Inverse of a canonical op, computed against the current (pre-op) state.
  _invert(c) {
    const st = this._state;
    switch (c.type) {
      case 'add':
        return [{ type: 'remove', id: c.element.id }];
      case 'remove': {
        const it = st.items.get(c.id);
        const group = [{ type: 'add', element: clone(it) }];
        if (it.type !== 'connector') {
          for (const o of st.items.values()) {
            if (o.type === 'connector' && (o.source.elementId === c.id || o.target.elementId === c.id)) {
              group.push({ type: 'add', element: clone(o) });
            }
          }
        }
        return group;
      }
      case 'update': {
        const it = st.items.get(c.id);
        const old = {};
        for (const key of Object.keys(c.patch)) {
          if (key === 'style') {
            old.style = {};
            for (const sk of Object.keys(c.patch.style)) old.style[sk] = it.style?.[sk] ?? null;
          } else {
            old[key] = it[key] === undefined ? null : clone(it[key]);
          }
        }
        return [{ type: 'update', id: c.id, patch: old }];
      }
      case 'move':
        return [{ type: 'move', ids: c.ids, dx: -c.dx, dy: -c.dy }];
      case 'addLayer':
        return [{ type: 'removeLayer', id: c.layer.id }];
      case 'updateLayer': {
        const l = st.layers.get(c.id);
        const old = {};
        for (const k of Object.keys(c.patch)) old[k] = l[k];
        return [{ type: 'updateLayer', id: c.id, patch: old }];
      }
      case 'removeLayer': {
        const l = st.layers.get(c.id);
        const group = [{ type: 'addLayer', layer: clone(l) }];
        for (const it of st.items.values()) {
          if (it.layer === c.id) group.push({ type: 'update', id: it.id, patch: { layer: c.id } });
        }
        return group;
      }
      default:
        return [];
    }
  }

  // ---- public operations ----------------------------------------------------
  apply(op) {
    this._commit(this._compile(op));
  }

  _shapesOf(ids) {
    if (!Array.isArray(ids)) throw new DiagramError('ids must be an array');
    return ids.map((id) => this._need(id)).filter((it) => it.type !== 'connector');
  }

  align(ids, mode) {
    const shapes = this._shapesOf(ids);
    if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) {
      throw new DiagramError(`unknown alignment ${String(mode)}`);
    }
    if (!shapes.length) return;
    const boxes = shapes.map((s) => ({ id: s.id, b: aabb(s) }));
    const minX = Math.min(...boxes.map(({ b }) => b.x));
    const maxX = Math.max(...boxes.map(({ b }) => b.x + b.width));
    const minY = Math.min(...boxes.map(({ b }) => b.y));
    const maxY = Math.max(...boxes.map(({ b }) => b.y + b.height));
    const ops = [];
    for (const { id, b } of boxes) {
      let dx = 0;
      let dy = 0;
      switch (mode) {
        case 'left': dx = minX - b.x; break;
        case 'right': dx = maxX - (b.x + b.width); break;
        case 'center': dx = (minX + maxX) / 2 - (b.x + b.width / 2); break;
        case 'top': dy = minY - b.y; break;
        case 'bottom': dy = maxY - (b.y + b.height); break;
        case 'middle': dy = (minY + maxY) / 2 - (b.y + b.height / 2); break;
        default: break;
      }
      if (dx || dy) ops.push({ type: 'move', ids: [id], dx, dy });
    }
    this._commit(ops);
  }

  distribute(ids, direction) {
    const shapes = this._shapesOf(ids);
    if (direction !== 'horizontal' && direction !== 'vertical') {
      throw new DiagramError(`unknown direction ${String(direction)}`);
    }
    if (shapes.length < 3) return;
    const horiz = direction === 'horizontal';
    const boxes = shapes.map((s) => {
      const b = aabb(s);
      return horiz
        ? { id: s.id, lo: b.x, size: b.width }
        : { id: s.id, lo: b.y, size: b.height };
    });
    boxes.sort((a, b) => a.lo - b.lo || (a.id < b.id ? -1 : 1));
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const mids = boxes.slice(1, -1);
    const sumSizes = mids.reduce((s, b) => s + b.size, 0);
    const gap = (last.lo - (first.lo + first.size) - sumSizes) / (boxes.length - 1);
    let cursor = first.lo + first.size;
    const ops = [];
    for (const m of mids) {
      const target = cursor + gap;
      const d = target - m.lo;
      if (d) ops.push({ type: 'move', ids: [m.id], dx: horiz ? d : 0, dy: horiz ? 0 : d });
      cursor = target + m.size;
    }
    this._commit(ops);
  }

  layout(kind, opts = {}) {
    const shapes = [...this._state.items.values()].filter((it) => it.type !== 'connector').sort(zCmp);
    const ids = new Set(shapes.map((s) => s.id));
    const conns = [...this._state.items.values()].filter((it) => it.type === 'connector'
      && ids.has(it.source.elementId) && ids.has(it.target.elementId));
    let positions;
    if (kind === 'layered') positions = layoutLayered(shapes, conns, opts);
    else if (kind === 'grid') positions = layoutGrid(shapes, opts);
    else throw new DiagramError(`unknown layout ${String(kind)}`);
    const ops = [];
    for (const s of shapes) {
      const p = positions.get(s.id);
      if (p && (p.x !== s.x || p.y !== s.y)) ops.push({ type: 'update', id: s.id, patch: { x: p.x, y: p.y } });
    }
    this._commit(ops);
  }

  // ---- queries --------------------------------------------------------------
  get(id) {
    const it = this._state.items.get(id);
    return it ? clone(it) : undefined;
  }

  elements(filter = {}) {
    let list = [...this._state.items.values()];
    if (filter.layer !== undefined) list = list.filter((e) => e.layer === filter.layer);
    if (filter.type !== undefined) list = list.filter((e) => e.type === filter.type);
    return list.sort(zCmp).map(clone);
  }

  layers() {
    return [...this._state.layers.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)).map(clone);
  }

  _visible(e) {
    return this._state.layers.get(e.layer)?.visible !== false;
  }

  hitTest(x, y) {
    const list = [...this._state.items.values()]
      .filter((e) => e.type !== 'connector' && this._visible(e))
      .sort(zCmp)
      .reverse();
    for (const e of list) if (containsPoint(e, x, y)) return clone(e);
    return null;
  }

  select(rect) {
    const out = [];
    for (const e of this._state.items.values()) {
      if (e.type === 'connector') continue;
      const b = aabb(e);
      if (b.x >= rect.x && b.y >= rect.y
        && b.x + b.width <= rect.x + rect.width && b.y + b.height <= rect.y + rect.height) {
        out.push(clone(e));
      }
    }
    return out.sort(zCmp);
  }

  bounds(ids) {
    const list = ids ? ids.map((id) => this._need(id)) : [...this._state.items.values()];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (p) => {
      minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
    };
    for (const e of list) {
      if (e.type === 'connector') this.route(e.id).forEach(add);
      else corners(e).forEach(add);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  route(connectorId) {
    const c = this._state.items.get(connectorId);
    if (!c || c.type !== 'connector') throw new DiagramError(`unknown connector ${String(connectorId)}`);
    return routeConnector(this._state.items, c);
  }

  toJSON() {
    const st = this._state;
    const layers = this.layers();
    const elements = [...st.items.values()].sort(zCmp).map((e) => sortKeys(e));
    return { id: this.id, layers: layers.map(sortKeys), elements };
  }

  toSVG(opts = {}) {
    return renderSVG(this.toJSON(), (c) => this.route(c.id), opts);
  }
}

export function createDocument({ id, actor } = {}) {
  return new Doc({
    id: id ?? newId('doc'),
    actor: actor ?? newId('actor'),
  });
}

export function fromJSON(json, opts = {}) {
  if (!isObj(json)) throw new DiagramError('JSON object required');
  const base = emptyState();
  base.layers = new Map();
  for (const l of json.layers ?? []) {
    if (!isObj(l) || typeof l.id !== 'string') throw new DiagramError('invalid layer');
    base.layers.set(l.id, clone(l));
  }
  if (!base.layers.has(DEFAULT_LAYER)) base.layers.set(DEFAULT_LAYER, defaultLayer());
  for (const el of json.elements ?? []) {
    if (!isObj(el) || typeof el.id !== 'string' || typeof el.type !== 'string') throw new DiagramError('invalid element');
    base.items.set(el.id, clone(el));
  }
  return new Doc({
    id: json.id ?? newId('doc'),
    actor: opts.actor ?? newId('actor'),
    base,
  });
}

export { DiagramError };
