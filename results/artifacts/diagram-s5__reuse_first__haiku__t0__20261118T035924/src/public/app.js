// Browser editor: SVG canvas, tools, selection, property/layer panels, version
// history, comments, live presence and offline-tolerant sync over WebSocket.
import { createDocument, importDrawio, snap, DiagramError } from '/static/core/index.js';
import { aabb, centerOf } from '/static/core/geometry.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const uid = () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 10);
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

const S = {
  session: JSON.parse(localStorage.getItem('diagram-s5-session') || 'null'),
  docId: null, meta: null, doc: null, role: null, readOnly: false,
  seq: 0, ws: null, wsOpen: false, retry: 0, outbox: [], inflight: new Map(), ackN: 0,
  tool: 'select', activeLayer: 'default', selection: new Set(),
  view: { zoom: 1, x: 0, y: 0 }, drag: null, preview: null, guides: { x: [], y: [] },
  marquee: null, connectPreview: null, presence: new Map(), spaceDown: false,
  clipboard: null, renderQueued: false, lastPresenceSent: 0,
};

// ---------- helpers ----------
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  return n;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (S.session) headers.Authorization = `Bearer ${S.session.token}`;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function colorFor(actor) {
  let h = 0;
  for (const ch of actor) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ---------- auth ----------
function showLogin(message = '') {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#loginError').textContent = message;
}

async function authenticate(kind) {
  const username = $('#lUser').value.trim();
  const password = $('#lPass').value;
  try {
    if (kind === 'register') await api('POST', '/api/auth/register', { username, password });
    const r = await api('POST', '/api/auth/login', { username, password });
    S.session = { token: r.token, user: r.user };
    localStorage.setItem('diagram-s5-session', JSON.stringify(S.session));
    $('#loginError').textContent = '';
    await startApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
}

// ---------- document lifecycle ----------
async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#user').textContent = S.session.user.username;
  await refreshDocList();
  const first = $('#docSelect').value;
  if (first) await openDoc(first);
  else await createNewDoc();
}

async function refreshDocList(selectId) {
  const docs = await api('GET', '/api/docs');
  const sel = $('#docSelect');
  sel.innerHTML = '';
  for (const d of docs) sel.append(new Option(`${d.title} (${d.role ?? d.owner})`, d.id));
  if (selectId) sel.value = selectId;
  return docs;
}

async function createNewDoc() {
  const title = prompt('Document title', 'Untitled diagram') || 'Untitled diagram';
  const meta = await api('POST', '/api/docs', { title });
  await refreshDocList(meta.id);
  await openDoc(meta.id);
}

function closeSocket() {
  S.docId = null;
  if (S.ws) { const w = S.ws; S.ws = null; w.onclose = null; w.close(); }
  S.wsOpen = false;
}

async function openDoc(id) {
  closeSocket();
  S.docId = id;
  S.selection = new Set();
  S.outbox = []; S.inflight = new Map(); S.presence = new Map();
  S.doc = createDocument({ id, actor: `${S.session.user.username}-${uid()}` });
  S.doc.on('op', () => flush());
  S.doc.on('change', () => scheduleRender());
  const meta = await api('GET', `/api/docs/${id}`);
  S.meta = meta;
  S.role = meta.role;
  S.readOnly = meta.role === 'viewer';
  const log = await api('GET', `/api/docs/${id}/ops?since=0`);
  S.doc.receive(log.ops);
  S.seq = log.seq;
  S.doc.pendingOps();
  $('#title').value = meta.title;
  $('#title').disabled = S.readOnly;
  $('#members').textContent = Object.keys(meta.members).length
    ? 'Shared with: ' + Object.entries(meta.members).map(([u, r]) => `${u} (${r})`).join(', ')
    : 'Private';
  connectSocket();
  renderAll();
  fitView();
  refreshVersions();
  refreshComments();
}

// ---------- sync ----------
function applyRemoteOps(ops, seq) {
  if (!ops?.length) return;
  S.doc.receive(ops);
  for (const op of ops) if (op.seq > S.seq) S.seq = op.seq;
  if (seq > S.seq) S.seq = seq;
}

function connectSocket() {
  const id = S.docId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/docs/${id}?token=${encodeURIComponent(S.session.token)}`);
  S.ws = ws;
  ws.onopen = async () => {
    if (S.ws !== ws) return;
    S.wsOpen = true;
    S.retry = 0;
    try {
      const r = await api('GET', `/api/docs/${id}/ops?since=${S.seq}`);
      applyRemoteOps(r.ops, r.seq);
    } catch { /* retried on next reconnect */ }
    // Resend anything not yet acknowledged; the server ignores duplicate batches.
    const pending = [...S.inflight.values()].flat().concat(S.outbox);
    S.inflight = new Map(); S.outbox = [];
    S.outbox.push(...pending);
    flush();
    updateStatus();
  };
  ws.onmessage = (ev) => {
    if (S.ws !== ws) return;
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'hello': S.role = m.role; S.readOnly = m.role === 'viewer'; break;
      case 'ops': applyRemoteOps(m.ops, m.seq); break;
      case 'ack': S.inflight.delete(m.ackId); updateStatus(); break;
      case 'error':
        if (m.ackId != null) S.inflight.delete(m.ackId);
        toast(m.message);
        updateStatus();
        break;
      case 'presence':
        S.presence.set(m.actor, { cursor: m.cursor, selection: m.selection || [], at: Date.now() });
        renderOverlay();
        break;
      case 'left': S.presence.delete(m.actor); renderOverlay(); break;
      default: break;
    }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.wsOpen = false;
    updateStatus();
    const delay = Math.min(1000 * 2 ** S.retry, 10000);
    S.retry += 1;
    setTimeout(() => { if (S.ws === ws && S.docId === id) connectSocket(); }, delay);
  };
}

function wsSend(obj) {
  if (S.wsOpen && S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

// Sends local batches; they stay in flight until acknowledged.
function flush() {
  if (!S.doc) return;
  const fresh = S.doc.pendingOps();
  if (fresh.length) S.outbox.push(...fresh);
  if (S.wsOpen && S.outbox.length) {
    const ackId = ++S.ackN;
    const ops = S.outbox.splice(0);
    S.inflight.set(ackId, ops);
    wsSend({ type: 'ops', ops, ackId });
  }
  updateStatus();
}

function updateStatus() {
  const el = $('#status');
  const pending = S.outbox.length + [...S.inflight.values()].reduce((n, a) => n + a.length, 0);
  el.className = `status ${S.wsOpen ? 'online' : 'offline'}`;
  el.textContent = `${S.wsOpen ? 'Online' : 'Offline'}${pending ? ` · ${pending} pending` : ''}${S.readOnly ? ' · read-only' : ''}`;
}

// ---------- actions ----------
function act(op) {
  if (S.readOnly) { toast('This document is read-only for you'); return false; }
  try {
    S.doc.apply(op);
    return true;
  } catch (err) {
    if (err instanceof DiagramError) toast(err.message);
    else { console.error(err); toast('Operation failed'); }
    return false;
  }
}

function actMany(fn) {
  if (S.readOnly) { toast('This document is read-only for you'); return; }
  try {
    S.doc.transaction(fn);
  } catch (err) {
    toast(err.message);
  }
}

// doc.get() returns connectors as well as shapes.
function selectedIds() { return [...S.selection].filter((id) => S.doc.get(id)); }
function selectedItems() { return selectedIds().map((id) => S.doc.get(id)); }

function deleteSelection() {
  const ids = selectedIds();
  if (!ids.length) return;
  actMany(() => { for (const id of ids) S.doc.apply({ type: 'remove', id }); });
  S.selection.clear();
}

// Copies selected shapes plus connectors whose both ends are copied.
function clipboardCopy() {
  const items = S.doc.elements().filter((e) => S.selection.has(e.id));
  const shapeIds = new Set(items.filter((e) => e.type !== 'connector').map((e) => e.id));
  const conns = S.doc.elements({ type: 'connector' })
    .filter((c) => S.selection.has(c.id) || (shapeIds.has(c.source.elementId) && shapeIds.has(c.target.elementId)))
    .filter((c) => shapeIds.has(c.source.elementId) && shapeIds.has(c.target.elementId));
  S.clipboard = [...items.filter((e) => e.type !== 'connector'), ...conns].map((e) => structuredClone(e));
}

function clipboardPaste(offset = 20) {
  if (!S.clipboard?.length) return;
  const map = new Map();
  const newIds = [];
  actMany(() => {
    for (const e of S.clipboard) if (e.type !== 'connector') {
      const id = `e${uid()}`;
      map.set(e.id, id);
      const { id: _i, z: _z, groupId: _g, source: _s, target: _t, ...rest } = e;
      const layer = S.doc.toJSON().layers.some((l) => l.id === e.layer) ? e.layer : S.activeLayer;
      S.doc.apply({ type: 'add', element: { ...rest, id, x: e.x + offset, y: e.y + offset, layer } });
      newIds.push(id);
    }
    for (const e of S.clipboard) if (e.type === 'connector') {
      const a = map.get(e.source.elementId), b = map.get(e.target.elementId);
      if (!a || !b) continue;
      const id = `c${uid()}`;
      map.set(e.id, id);
      S.doc.apply({
        type: 'add',
        element: {
          id, type: 'connector', source: { ...e.source, elementId: a }, target: { ...e.target, elementId: b },
          routing: e.routing, waypoints: (e.waypoints || []).map(([x, y]) => [x + offset, y + offset]),
          label: e.label, layer: S.doc.toJSON().layers.some((l) => l.id === e.layer) ? e.layer : S.activeLayer, style: e.style,
        },
      });
      newIds.push(id);
    }
  });
  S.selection = new Set(newIds.filter((id) => S.doc.get(id)));
  renderAll();
}

function nudge(dx, dy) {
  const ids = selectedIds();
  if (!ids.length) return;
  act({ type: 'move', ids, dx, dy });
}

// ---------- viewport ----------
function toWorld(evt) {
  const r = $('#canvas').getBoundingClientRect();
  return [(evt.clientX - r.left - S.view.x) / S.view.zoom, (evt.clientY - r.top - S.view.y) / S.view.zoom];
}

function fitView() {
  const r = $('#canvas').getBoundingClientRect();
  const b = S.doc.bounds();
  const pad = 40;
  const zw = (r.width - pad * 2) / Math.max(b.width, 1), zh = (r.height - pad * 2) / Math.max(b.height, 1);
  S.view.zoom = Math.max(0.1, Math.min(2, zw, zh));
  S.view.x = pad - b.x * S.view.zoom + (r.width - pad * 2 - b.width * S.view.zoom) / 2;
  S.view.y = pad - b.y * S.view.zoom + (r.height - pad * 2 - b.height * S.view.zoom) / 2;
  scheduleRender();
}

// ---------- rendering ----------
function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; renderAll(); });
}

function renderAll() {
  if (!S.doc) return;
  renderCanvas();
  renderOverlay();
  renderMinimap();
  renderProps();
  renderLayers();
  $('#zoomInfo').textContent = `${Math.round(S.view.zoom * 100)}% · ${S.doc.elements().length} items`;
  $$('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === S.tool));
  updateStatus();
}

function applyPreview(e) {
  const p = S.preview?.get(e.id);
  if (!p) return e;
  const out = { ...e };
  if (p.box) Object.assign(out, p.box);
  if (p.rotation !== undefined) out.rotation = p.rotation;
  if (p.dx || p.dy) { out.x = e.x + (p.dx || 0); out.y = e.y + (p.dy || 0); }
  return out;
}

function renderCanvas() {
  const content = $('#content');
  content.replaceChildren();
  const layers = new Map(S.doc.toJSON().layers.map((l) => [l.id, l]));
  for (const raw of S.doc.elements()) {
    const layer = layers.get(raw.layer);
    if (layer && layer.visible === false) continue;
    const e = applyPreview(raw);
    content.append(e.type === 'connector' ? connectorNode(e) : shapeNode(e));
  }
  $('#viewport').setAttribute('transform', `translate(${S.view.x} ${S.view.y}) scale(${S.view.zoom})`);
}

function shapeNode(e) {
  const st = e.style || {};
  const g = svgEl('g', { 'data-id': e.id });
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
  const rot = e.rotation ? `rotate(${e.rotation} ${cx} ${cy})` : null;
  const common = {
    fill: st.fill ?? (e.type === 'text' ? 'none' : '#ffffff'),
    stroke: st.stroke ?? '#333333', 'stroke-width': st.strokeWidth ?? 1.5,
    opacity: st.opacity ?? 1, transform: rot,
  };
  let shape;
  switch (e.type) {
    case 'ellipse': shape = svgEl('ellipse', { cx, cy, rx: e.width / 2, ry: e.height / 2, ...common }); break;
    case 'diamond': shape = svgEl('polygon', { points: `${cx},${e.y} ${e.x + e.width},${cy} ${cx},${e.y + e.height} ${e.x},${cy}`, ...common }); break;
    case 'line': shape = svgEl('line', { x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height, ...common, fill: 'none' }); break;
    case 'image': shape = svgEl('image', { href: e.text || st.src || '', x: e.x, y: e.y, width: e.width, height: e.height, transform: rot }); break;
    case 'text': shape = svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, ...common, stroke: 'none', fill: 'transparent' }); break;
    default: shape = svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, rx: st.rounded === '1' ? 8 : 0, ...common });
  }
  g.append(shape);
  if (e.text && e.type !== 'line' && e.type !== 'image') {
    const t = svgEl('text', {
      x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': st.fontSize ?? 14, fill: st.fontColor ?? '#111111', transform: rot,
      'font-family': st.fontFamily,
    });
    e.text.split('\n').forEach((line, i) => {
      const ts = svgEl('tspan', { x: cx, dy: i ? (st.fontSize ?? 14) : 0 });
      ts.textContent = line;
      t.append(ts);
    });
    g.append(t);
  }
  return g;
}

function connectorNode(e) {
  const pts = S.doc.route(e.id);
  const st = e.style || {};
  const g = svgEl('g', { 'data-id': e.id });
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  g.append(svgEl('path', {
    d, fill: 'none', stroke: st.stroke ?? '#333333', 'stroke-width': st.strokeWidth ?? 1.5,
    'marker-end': 'url(#arrowhead)',
  }));
  if (e.label && pts.length) {
    const m = pts[Math.floor(pts.length / 2)];
    const t = svgEl('text', { x: m[0], y: m[1] - 6, 'text-anchor': 'middle', 'font-size': 12 });
    t.textContent = e.label;
    g.append(t);
  }
  return g;
}

function renderOverlay() {
  if (!S.doc) return;
  const ov = $('#overlay');
  ov.replaceChildren();
  const sel = selectedShapesOrConnectors();
  if (sel.length) {
    const boxes = sel.map((e) => aabb(applyPreview(e)));
    const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
    const z = S.view.zoom;
    const hs = 6 / z;
    ov.append(svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none', stroke: '#4f46e5', 'stroke-dasharray': `${4 / z} ${3 / z}`, 'stroke-width': 1 / z }));
    if (sel.length === 1 && sel[0].type !== 'connector') {
      const e = applyPreview(sel[0]);
      for (const [name, hx, hy] of handlePoints(e)) {
        ov.append(svgEl('rect', { class: 'handle', 'data-handle': name, x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#4f46e5', 'stroke-width': 1 / z }));
      }
      const [cx] = centerOf(e);
      ov.append(svgEl('line', { x1: cx, y1: e.y, x2: cx, y2: e.y - 24 / z, stroke: '#4f46e5', 'stroke-width': 1 / z }));
      ov.append(svgEl('circle', { class: 'handle', 'data-handle': 'rotate', cx, cy: e.y - 24 / z, r: 4 / z, fill: '#fff', stroke: '#4f46e5', 'stroke-width': 1 / z }));
    }
  }
  for (const g of S.guides.x) ov.append(svgEl('line', { x1: g, y1: -1e6, x2: g, y2: 1e6, stroke: '#f43f5e', 'stroke-width': 1 / S.view.zoom }));
  for (const g of S.guides.y) ov.append(svgEl('line', { x1: -1e6, y1: g, x2: 1e6, y2: g, stroke: '#f43f5e', 'stroke-width': 1 / S.view.zoom }));
  if (S.marquee) {
    const m = S.marquee;
    ov.append(svgEl('rect', { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0), fill: 'rgba(79,70,229,.08)', stroke: '#4f46e5', 'stroke-width': 1 / S.view.zoom }));
  }
  if (S.drag?.type === 'create' && S.drag.cur) {
    const d = S.drag;
    ov.append(svgEl('rect', { x: Math.min(d.start[0], d.cur[0]), y: Math.min(d.start[1], d.cur[1]), width: Math.abs(d.cur[0] - d.start[0]), height: Math.abs(d.cur[1] - d.start[1]), fill: 'none', stroke: '#4f46e5', 'stroke-dasharray': '4 3', 'stroke-width': 1 / S.view.zoom }));
  }
  if (S.connectPreview) {
    const from = S.doc.get(S.connectPreview.from);
    if (from) {
      const [fx, fy] = centerOf(from);
      ov.append(svgEl('line', { x1: fx, y1: fy, x2: S.connectPreview.cur[0], y2: S.connectPreview.cur[1], stroke: '#4f46e5', 'stroke-dasharray': '4 3', 'stroke-width': 1.5 / S.view.zoom }));
    }
  }
  for (const [actor, p] of S.presence) {
    const color = colorFor(actor);
    for (const id of p.selection || []) {
      const e = S.doc.get(id);
      if (!e) continue;
      const b = aabb(e);
      ov.append(svgEl('rect', { x: b.x - 2 / S.view.zoom, y: b.y - 2 / S.view.zoom, width: b.width + 4 / S.view.zoom, height: b.height + 4 / S.view.zoom, fill: 'none', stroke: color, 'stroke-width': 2 / S.view.zoom, 'data-presence': actor }));
    }
    if (p.cursor) {
      ov.append(svgEl('circle', { cx: p.cursor[0], cy: p.cursor[1], r: 5 / S.view.zoom, fill: color, 'data-presence': actor }));
      const t = svgEl('text', { x: p.cursor[0] + 8 / S.view.zoom, y: p.cursor[1] + 4 / S.view.zoom, 'font-size': 12 / S.view.zoom, fill: color });
      t.textContent = actor.split('-')[0];
      ov.append(t);
    }
  }
  $('#viewport').setAttribute('transform', `translate(${S.view.x} ${S.view.y}) scale(${S.view.zoom})`);
}

function handlePoints(e) {
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
  return [
    ['nw', e.x, e.y], ['n', cx, e.y], ['ne', e.x + e.width, e.y], ['e', e.x + e.width, cy],
    ['se', e.x + e.width, e.y + e.height], ['s', cx, e.y + e.height], ['sw', e.x, e.y + e.height], ['w', e.x, cy],
  ];
}

function selectedShapesOrConnectors() { return selectedItems(); }

function renderMinimap() {
  const mm = $('#minimap');
  mm.replaceChildren();
  const items = S.doc.elements().filter((e) => e.type !== 'connector');
  const r = $('#canvas').getBoundingClientRect();
  const view = { x: -S.view.x / S.view.zoom, y: -S.view.y / S.view.zoom, width: r.width / S.view.zoom, height: r.height / S.view.zoom };
  const b0 = S.doc.bounds();
  const bx = Math.min(b0.x, view.x), by = Math.min(b0.y, view.y);
  const bw = Math.max(b0.x + b0.width, view.x + view.width) - bx || 1;
  const bh = Math.max(b0.y + b0.height, view.y + view.height) - by || 1;
  const k = Math.min(200 / bw, 130 / bh);
  for (const e of items) {
    const b = aabb(e);
    mm.append(svgEl('rect', { x: (b.x - bx) * k, y: (b.y - by) * k, width: Math.max(1, b.width * k), height: Math.max(1, b.height * k), fill: '#c7d2fe' }));
  }
  mm.append(svgEl('rect', { x: (view.x - bx) * k, y: (view.y - by) * k, width: view.width * k, height: view.height * k, fill: 'none', stroke: '#4f46e5' }));
  mm.onclick = (evt) => {
    const rect = mm.getBoundingClientRect();
    const wx = bx + (evt.clientX - rect.left) / k, wy = by + (evt.clientY - rect.top) / k;
    S.view.x = r.width / 2 - wx * S.view.zoom;
    S.view.y = r.height / 2 - wy * S.view.zoom;
    scheduleRender();
  };
}

function field(label, type, value, attrs = '') {
  return `<label>${label} <input type="${type}" value="${value ?? ''}" ${attrs}></label>`;
}

function renderProps() {
  const box = $('#props');
  const ids = selectedIds();
  if (ids.length === 0) {
    box.innerHTML = '<h3>Properties</h3><p class="muted">Select an element to edit it.</p>';
    return;
  }
  const first = S.doc.get(ids[0]);
  const st = first.style || {};
  const isConn = first.type === 'connector';
  const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback);
  let html = `<h3>Properties (${ids.length})</h3>`;
  html += `<label>Fill <input type="color" data-style="fill" value="${color(st.fill, '#ffffff')}"></label>`;
  html += `<label>Stroke <input type="color" data-style="stroke" value="${color(st.stroke, '#333333')}"></label>`;
  html += field('Stroke width', 'number', st.strokeWidth ?? 1.5, 'data-style="strokeWidth" min="0" step="0.5"');
  html += field('Opacity', 'number', st.opacity ?? 1, 'data-style="opacity" min="0" max="1" step="0.1"');
  html += field('Font size', 'number', st.fontSize ?? 14, 'data-style="fontSize" min="6" step="1"');
  html += `<label>Font colour <input type="color" data-style="fontColor" value="${color(st.fontColor, '#111111')}"></label>`;
  if (ids.length === 1 && !isConn) {
    html += `<label>Text <textarea rows="2" data-prop="text">${escapeHtml(first.text || '')}</textarea></label>`;
    html += field('X', 'number', Math.round(first.x), 'data-prop="x"');
    html += field('Y', 'number', Math.round(first.y), 'data-prop="y"');
    html += field('Width', 'number', Math.round(first.width), 'data-prop="width" min="0"');
    html += field('Height', 'number', Math.round(first.height), 'data-prop="height" min="0"');
    html += field('Rotation', 'number', Math.round(first.rotation), 'data-prop="rotation" step="1"');
  }
  if (ids.length === 1 && isConn) {
    html += `<label>Label <input data-prop="label" value="${escapeHtml(first.label || '')}"></label>`;
    html += `<label>Routing <select data-prop="routing"><option value="straight"${first.routing === 'straight' ? ' selected' : ''}>straight</option><option value="orthogonal"${first.routing === 'orthogonal' ? ' selected' : ''}>orthogonal</option></select></label>`;
  }
  html += `<div class="row wrap">
    <button data-z="front">Front</button><button data-z="forward">Forward</button>
    <button data-z="backward">Backward</button><button data-z="back">Back</button></div>
    <div class="row"><button data-act="group">Group</button><button data-act="ungroup">Ungroup</button><button data-act="delete">Delete</button></div>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-style]').forEach((inp) => inp.addEventListener('change', () => {
    const v = inp.type === 'number' ? Number(inp.value) : inp.value;
    act({ type: 'setStyle', ids, style: { [inp.dataset.style]: v } });
  }));
  box.querySelectorAll('[data-prop]').forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.prop;
    const v = inp.type === 'number' ? Number(inp.value) : inp.value;
    act({ type: 'update', id: ids[0], patch: { [k]: v } });
  }));
  box.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => {
    actMany(() => { for (const id of ids) S.doc.apply({ type: 'reorder', id, to: b.dataset.z }); });
  }));
  box.querySelector('[data-act="group"]').addEventListener('click', () => { if (ids.length > 1) act({ type: 'group', ids }); });
  box.querySelector('[data-act="ungroup"]').addEventListener('click', () => {
    const gid = first.groupId;
    if (gid) act({ type: 'ungroup', groupId: gid });
  });
  box.querySelector('[data-act="delete"]').addEventListener('click', deleteSelection);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderLayers() {
  const box = $('#layers');
  const layers = S.doc.toJSON().layers;
  if (!layers.some((l) => l.id === S.activeLayer)) S.activeLayer = layers[0]?.id ?? 'default';
  let html = '<h3>Layers</h3>';
  layers.forEach((l, i) => {
    html += `<div class="layer" data-layer="${escapeHtml(l.id)}">
      <input type="radio" name="activeLayer" ${l.id === S.activeLayer ? 'checked' : ''} title="Active layer">
      <input type="checkbox" data-k="visible" ${l.visible ? 'checked' : ''} title="Visible">
      <input type="checkbox" data-k="locked" ${l.locked ? 'checked' : ''} title="Locked">
      <input type="text" data-k="name" value="${escapeHtml(l.name)}">
      <button data-move="-1" ${i === 0 ? 'disabled' : ''} title="Move down">↓</button>
      <button data-move="1" ${i === layers.length - 1 ? 'disabled' : ''} title="Move up">↑</button>
      <button data-k="delete" title="Delete layer">✕</button></div>`;
  });
  html += '<div class="row"><button id="addLayer">Add layer</button></div>';
  box.innerHTML = html;
  box.querySelectorAll('.layer').forEach((row) => {
    const id = row.dataset.layer;
    row.querySelector('input[name=activeLayer]').addEventListener('change', () => { S.activeLayer = id; });
    row.querySelector('[data-k=visible]').addEventListener('change', (e) => act({ type: 'updateLayer', id, patch: { visible: e.target.checked } }));
    row.querySelector('[data-k=locked]').addEventListener('change', (e) => act({ type: 'updateLayer', id, patch: { locked: e.target.checked } }));
    row.querySelector('[data-k=name]').addEventListener('change', (e) => act({ type: 'updateLayer', id, patch: { name: e.target.value } }));
    row.querySelector('[data-k=delete]').addEventListener('click', () => {
      if (layers.length < 2) return toast('Keep at least one layer');
      if (confirm('Delete this layer and everything on it?')) act({ type: 'removeLayer', id });
    });
    row.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const idx = layers.findIndex((l) => l.id === id);
      const other = layers[idx + Number(b.dataset.move)];
      if (!other) return;
      actMany(() => {
        S.doc.apply({ type: 'updateLayer', id, patch: { order: other.order } });
        S.doc.apply({ type: 'updateLayer', id: other.id, patch: { order: layers[idx].order } });
      });
    }));
  });
  $('#addLayer').addEventListener('click', () => {
    const id = `layer-${uid()}`;
    if (act({ type: 'addLayer', layer: { id, name: `Layer ${layers.length + 1}` } })) S.activeLayer = id;
  });
}

// ---------- versions & comments ----------
async function refreshVersions() {
  if (!S.docId) return;
  const list = await api('GET', `/api/docs/${S.docId}/versions`).catch(() => []);
  const ul = $('#versionList');
  ul.innerHTML = '';
  for (const v of list.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<div><strong>${escapeHtml(v.label)}</strong> <span class="muted">${new Date(v.createdAt).toLocaleString()}</span></div>`;
    const b = document.createElement('button');
    b.textContent = 'Restore';
    b.disabled = S.readOnly;
    b.addEventListener('click', async () => {
      if (!confirm(`Restore "${v.label}"? This is undoable by editing back.`)) return;
      try { await api('POST', `/api/docs/${S.docId}/versions/${v.id}/restore`); toast('Version restored'); }
      catch (err) { toast(err.message); }
    });
    li.append(b);
    ul.append(li);
  }
}

async function refreshComments() {
  if (!S.docId) return;
  const all = $('#allComments').checked;
  const list = await api('GET', `/api/docs/${S.docId}/comments`).catch(() => []);
  const sel = selectedIds();
  const ul = $('#commentList');
  ul.innerHTML = '';
  for (const c of list.filter((x) => all || sel.includes(x.elementId))) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="${c.resolved ? 'muted' : ''}"><strong>${escapeHtml(c.author)}</strong> on <code>${escapeHtml(c.elementId)}</code>${c.resolved ? ' (resolved)' : ''}</div>
      <div>${escapeHtml(c.body)}</div>
      ${c.replies.map((r) => `<div class="muted">↳ ${escapeHtml(r.author)}: ${escapeHtml(r.body)}</div>`).join('')}`;
    const row = document.createElement('div');
    row.className = 'row';
    const reply = document.createElement('button');
    reply.textContent = 'Reply';
    reply.addEventListener('click', async () => {
      const body = prompt('Reply');
      if (!body) return;
      await api('POST', `/api/docs/${S.docId}/comments/${c.id}/replies`, { body }).catch((e) => toast(e.message));
      refreshComments();
    });
    const resolve = document.createElement('button');
    resolve.textContent = c.resolved ? 'Reopen' : 'Resolve';
    resolve.addEventListener('click', async () => {
      await api('POST', `/api/docs/${S.docId}/comments/${c.id}/resolve`, { resolved: !c.resolved }).catch((e) => toast(e.message));
      refreshComments();
    });
    row.append(reply, resolve);
    li.append(row);
    ul.append(li);
  }
}

// ---------- import / export ----------
function importJSONInto(json) {
  const ids = new Map();
  const fresh = (p) => `${p}${uid()}`;
  for (const l of json.layers || []) ids.set(l.id, fresh('layer-'));
  for (const e of json.elements || []) ids.set(e.id, fresh(e.type === 'connector' ? 'c' : 'e'));
  const layerFor = (id) => ids.get(id) || S.activeLayer;
  actMany(() => {
    for (const l of json.layers || []) S.doc.apply({ type: 'addLayer', layer: { id: ids.get(l.id), name: l.name, visible: l.visible, locked: l.locked } });
    for (const e of json.elements || []) {
      if (e.type === 'connector') continue;
      const { id, layer, z, groupId, ...rest } = e;
      S.doc.apply({ type: 'add', element: { ...rest, id: ids.get(id), layer: layerFor(layer) } });
    }
    for (const e of json.elements || []) {
      if (e.type !== 'connector') continue;
      const { id, layer, z, groupId, source, target, ...rest } = e;
      if (!ids.get(source.elementId) || !ids.get(target.elementId)) continue;
      S.doc.apply({
        type: 'add',
        element: { ...rest, id: ids.get(id), layer: layerFor(layer), source: { elementId: ids.get(source.elementId) }, target: { elementId: ids.get(target.elementId) } },
      });
    }
  });
}

// ---------- pointer interaction ----------
const HANDLE_ORDER = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function hitHandle(world) {
  const ids = selectedShapesOrConnectors();
  if (ids.length !== 1 || ids[0].type === 'connector') return null;
  const e = ids[0];
  const z = S.view.zoom, tol = 8 / z;
  const cx = e.x + e.width / 2;
  if (Math.hypot(world[0] - cx, world[1] - (e.y - 24 / z)) <= tol) return { handle: 'rotate', e };
  for (const [name, hx, hy] of handlePoints(e)) {
    if (Math.abs(world[0] - hx) <= tol && Math.abs(world[1] - hy) <= tol) return { handle: name, e };
  }
  return null;
}

function hitConnector(world) {
  const tol = 6 / S.view.zoom;
  let best = null, bestD = tol;
  for (const c of S.doc.elements({ type: 'connector' })) {
    const pts = S.doc.route(c.id);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((world[0] - ax) * dx + (world[1] - ay) * dy) / len2));
      const d = Math.hypot(ax + t * dx - world[0], ay + t * dy - world[1]);
      if (d <= bestD) { bestD = d; best = c; }
    }
  }
  return best;
}

function movingBox(ids) {
  const boxes = ids.map((id) => S.doc.get(id))
    .filter((e) => e && e.type !== 'connector').map((e) => aabb(e));
  if (!boxes.length) return null;
  return {
    x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)),
    width: Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x)),
    height: Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y)),
  };
}

function snapMove(ids, dx, dy) {
  const box = movingBox(ids);
  if (!box) return { dx, dy };
  const others = S.doc.elements().filter((e) => e.type !== 'connector' && !ids.includes(e.id)).map((e) => aabb(e));
  const th = 6 / S.view.zoom;
  const xs = [], ys = [];
  for (const o of others) { xs.push(o.x, o.x + o.width / 2, o.x + o.width); ys.push(o.y, o.y + o.height / 2, o.y + o.height); }
  let best = null;
  for (const cand of [box.x, box.x + box.width / 2, box.x + box.width]) {
    for (const g of xs) { const d = g - (cand + dx); if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { axis: 'x', d, g }; }
  }
  let bestX = best && best.axis === 'x' ? best : null;
  best = null;
  for (const cand of [box.y, box.y + box.height / 2, box.y + box.height]) {
    for (const g of ys) { const d = g - (cand + dy); if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { axis: 'y', d, g }; }
  }
  let bestY = best;
  S.guides = { x: [], y: [] };
  if (bestX) { dx += bestX.d; S.guides.x.push(bestX.g); }
  if (bestY) { dy += bestY.d; S.guides.y.push(bestY.g); }
  return { dx, dy };
}

function onPointerDown(evt) {
  if (!S.doc) return;
  const canvas = $('#canvas');
  if (evt.button === 1 || S.spaceDown || S.tool === 'pan') {
    S.drag = { type: 'pan', x: evt.clientX, y: evt.clientY, vx: S.view.x, vy: S.view.y };
    canvas.setPointerCapture(evt.pointerId);
    canvas.classList.add('pan');
    return;
  }
  const world = toWorld(evt);
  const [wx, wy] = world;
  if (S.tool === 'select') {
    const h = hitHandle(world);
    if (h && h.handle === 'rotate') {
      const c = centerOf(h.e);
      S.drag = { type: 'rotate', id: h.e.id, c, origRot: h.e.rotation || 0, startAng: Math.atan2(wy - c[1], wx - c[0]) };
    } else if (h) {
      S.drag = { type: 'resize', id: h.e.id, handle: h.handle, start: world, orig: { x: h.e.x, y: h.e.y, width: h.e.width, height: h.e.height } };
    } else {
      const hit = S.doc.hitTest(wx, wy) || hitConnector(world);
      if (hit) {
        if (evt.shiftKey) {
          if (S.selection.has(hit.id)) S.selection.delete(hit.id); else S.selection.add(hit.id);
        } else if (!S.selection.has(hit.id)) {
          S.selection = new Set([hit.id]);
        }
        S.drag = { type: 'move', ids: selectedIds(), start: world, dx: 0, dy: 0, moved: false };
      } else {
        if (!evt.shiftKey) S.selection = new Set();
        S.drag = { type: 'marquee', additive: evt.shiftKey, base: new Set(S.selection) };
        S.marquee = { x0: wx, y0: wy, x1: wx, y1: wy };
      }
    }
  } else if (S.tool === 'connector' || S.tool === 'orthogonal') {
    const hit = S.doc.hitTest(wx, wy);
    if (hit) S.connectPreview = { from: hit.id, cur: world, routing: S.tool === 'orthogonal' ? 'orthogonal' : 'straight' };
    S.drag = { type: 'connect' };
  } else if (S.tool === 'text' || S.tool === 'rect' || S.tool === 'ellipse' || S.tool === 'diamond' || S.tool === 'line' || S.tool === 'image') {
    S.drag = { type: 'create', tool: S.tool, start: world, cur: world };
  }
  canvas.setPointerCapture(evt.pointerId);
  scheduleRender();
}

function onPointerMove(evt) {
  if (!S.doc) return;
  const world = toWorld(evt);
  const now = Date.now();
  if (S.ws && now - S.lastPresenceSent > 100) {
    S.lastPresenceSent = now;
    wsSend({ type: 'presence', cursor: world, selection: [...S.selection] });
  }
  const d = S.drag;
  if (!d) return;
  if (d.type === 'pan') {
    S.view.x = d.vx + (evt.clientX - d.x);
    S.view.y = d.vy + (evt.clientY - d.y);
    scheduleRender();
    return;
  }
  if (d.type === 'move') {
    let dx = world[0] - d.start[0] || 0, dy = world[1] - d.start[1] || 0;
    if (Math.abs(dx) + Math.abs(dy) < 2) return;
    d.moved = true;
    if (evt.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    ({ dx, dy } = snapMove(d.ids, dx, dy));
    d.dx = dx; d.dy = dy;
    S.preview = new Map(d.ids.map((id) => [id, { dx, dy }]));
  } else if (d.type === 'resize') {
    const o = d.orig;
    let x0 = o.x, y0 = o.y, x1 = o.x + o.width, y1 = o.y + o.height;
    const h = d.handle;
    if (h.includes('w')) x0 = Math.min(world[0], x1);
    if (h.includes('e')) x1 = Math.max(world[0], x0);
    if (h.includes('n')) y0 = Math.min(world[1], y1);
    if (h.includes('s')) y1 = Math.max(world[1], y0);
    let box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    if (evt.shiftKey && o.width && o.height) {
      const r = o.width / o.height;
      if (box.width / r > box.height) box.height = box.width / r; else box.width = box.height * r;
      if (h.includes('w')) box.x = o.x + o.width - box.width;
      if (h.includes('n')) box.y = o.y + o.height - box.height;
    }
    d.box = box;
    S.preview = new Map([[d.id, { box }]]);
  } else if (d.type === 'rotate') {
    let ang = (Math.atan2(world[1] - d.c[1], world[0] - d.c[0]) - d.startAng) * 180 / Math.PI;
    let rot = d.origRot + ang;
    if (evt.shiftKey) rot = Math.round(rot / 15) * 15;
    d.rot = rot;
    S.preview = new Map([[d.id, { rotation: rot }]]);
  } else if (d.type === 'marquee') {
    S.marquee.x1 = world[0]; S.marquee.y1 = world[1];
  } else if (d.type === 'create') {
    d.cur = world;
  } else if (d.type === 'connect') {
    if (S.connectPreview) S.connectPreview.cur = world;
  }
  scheduleRender();
}

function onPointerUp(evt) {
  const d = S.drag;
  S.drag = null;
  $('#canvas').classList.remove('pan');
  S.guides = { x: [], y: [] };
  if (!d) return;
  if (d.type === 'move') {
    S.preview = null;
    if (d.moved) act({ type: 'move', ids: d.ids, dx: d.dx, dy: d.dy });
  } else if (d.type === 'resize') {
    S.preview = null;
    const b = d.box;
    if (b && (b.width !== d.orig.width || b.height !== d.orig.height || b.x !== d.orig.x || b.y !== d.orig.y)) {
      act({ type: 'resize', id: d.id, box: { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height) } });
    }
  } else if (d.type === 'rotate') {
    S.preview = null;
    if (d.rot !== undefined) act({ type: 'rotate', id: d.id, deg: Math.round(d.rot * 10) / 10 });
  } else if (d.type === 'marquee') {
    const m = S.marquee;
    S.marquee = null;
    const rect = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0) };
    const found = rect.width + rect.height > 2 ? S.doc.select(rect).map((e) => e.id) : [];
    S.selection = d.additive ? new Set([...d.base, ...found]) : new Set(found);
  } else if (d.type === 'create') {
    S.drag = null;
    const [sx, sy] = d.start, [ex, ey] = d.cur || d.start;
    let x = Math.min(sx, ex), y = Math.min(sy, ey), w = Math.abs(ex - sx), h = Math.abs(ey - sy);
    if (w < 4 && h < 4) {
      const dw = d.tool === 'text' ? 120 : 100, dh = d.tool === 'text' ? 30 : 60;
      x = sx - dw / 2; y = sy - dh / 2; w = dw; h = dh;
    }
    const type = d.tool;
    const style = type === 'text' ? { stroke: 'none', fill: 'none' } : {};
    const el = { type, x, y, width: w, height: h, layer: S.activeLayer, text: type === 'text' ? 'Text' : '', style };
    const id = `e${uid()}`;
    if (act({ type: 'add', element: { ...el, id } })) {
      S.selection = new Set([id]);
    }
    S.tool = 'select';
  } else if (d.type === 'connect') {
    const cp = S.connectPreview;
    S.connectPreview = null;
    const target = S.doc.hitTest(...toWorld(evt));
    if (cp && target && target.id !== cp.from) {
      const id = `c${uid()}`;
      if (act({ type: 'add', element: { id, type: 'connector', source: { elementId: cp.from }, target: { elementId: target.id }, routing: cp.routing, layer: S.activeLayer } })) {
        S.selection = new Set([id]);
      }
    }
  }
  scheduleRender();
}

function onDblClick(evt) {
  const hit = S.doc.hitTest(...toWorld(evt));
  if (!hit) return;
  const text = prompt('Text', hit.text || '');
  if (text !== null) act({ type: 'update', id: hit.id, patch: { text } });
}

// ---------- keyboard ----------
const TOOL_KEYS = { v: 'select', r: 'rect', e: 'ellipse', d: 'diamond', t: 'text', l: 'line', i: 'image', c: 'connector', o: 'orthogonal' };

function onKeyDown(evt) {
  if (!S.doc || $('#app').hidden) return;
  const tag = (evt.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  const mod = evt.ctrlKey || evt.metaKey;
  const k = evt.key.toLowerCase();
  if (evt.key === ' ') { S.spaceDown = true; evt.preventDefault(); return; }
  if (mod && k === 'z' && !evt.shiftKey) { evt.preventDefault(); S.doc.undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && evt.shiftKey))) { evt.preventDefault(); S.doc.redo(); return; }
  if (mod && k === 'c') { evt.preventDefault(); clipboardCopy(); return; }
  if (mod && k === 'v') { evt.preventDefault(); clipboardPaste(20); return; }
  if (mod && k === 'd') { evt.preventDefault(); clipboardCopy(); clipboardPaste(20); return; }
  if (mod) return;
  if (evt.key === 'Delete' || evt.key === 'Backspace') { evt.preventDefault(); deleteSelection(); return; }
  if (evt.key === 'Escape') { S.selection = new Set(); S.tool = 'select'; renderAll(); return; }
  if (evt.key.startsWith('Arrow')) {
    evt.preventDefault();
    const s = evt.shiftKey ? 10 : 1;
    const [dx, dy] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[evt.key];
    nudge(dx, dy);
    return;
  }
  if (TOOL_KEYS[k]) { S.tool = TOOL_KEYS[k]; renderAll(); }
}

// ---------- wiring ----------
function wire() {
  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); authenticate('login'); });
  $('#registerBtn').addEventListener('click', () => authenticate('register'));
  $('#logout').addEventListener('click', async () => {
    S.session = null;
    localStorage.removeItem('diagram-s5-session');
    closeSocket();
    location.reload();
  });
  $('#docSelect').addEventListener('change', (e) => openDoc(e.target.value).catch((err) => toast(err.message)));
  $('#newDoc').addEventListener('click', () => createNewDoc().catch((err) => toast(err.message)));
  $('#title').addEventListener('change', async (e) => {
    const title = e.target.value.trim();
    if (!title || !S.docId) return;
    try {
      S.meta = await api('PATCH', `/api/docs/${S.docId}`, { title });
      await refreshDocList(S.docId);
      toast('Title saved');
    } catch (err) { toast(err.message); }
  });
  $('#undo').addEventListener('click', () => S.doc?.undo());
  $('#redo').addEventListener('click', () => S.doc?.redo());
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const imported = importDrawio(await file.text());
      importJSONInto(imported.toJSON());
      toast(`Imported ${imported.elements().length} items`);
      fitView();
    } catch (err) { toast(err.message); }
    e.target.value = '';
  });
  $('#exportSvg').addEventListener('click', () => download(`${S.meta?.title || 'diagram'}.svg`, 'image/svg+xml', S.doc.toSVG()));
  $('#exportJson').addEventListener('click', () => download(`${S.meta?.title || 'diagram'}.json`, 'application/json', JSON.stringify(S.doc.toJSON(), null, 2)));
  $('#shareBtn').addEventListener('click', async () => {
    try {
      const r = await api('POST', `/api/docs/${S.docId}/share`, { username: $('#shareUser').value.trim(), role: $('#shareRole').value });
      $('#members').textContent = 'Shared with: ' + Object.entries(r.members).map(([u, role]) => `${u} (${role})`).join(', ');
      toast('Shared');
    } catch (err) { toast(err.message); }
  });
  $('#layoutBtn').addEventListener('click', () => {
    const [kind, dir] = $('#layoutKind').value.split('-');
    const spacing = Number($('#layoutSpacing').value) || 50;
    actMany(() => S.doc.layout(kind, kind === 'layered' ? { direction: dir, spacing } : { spacing }));
    fitView();
  });
  $$('[data-align]').forEach((b) => b.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length > 1) actMany(() => S.doc.align(ids, b.dataset.align));
  }));
  $$('[data-dist]').forEach((b) => b.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length > 2) actMany(() => S.doc.distribute(ids, b.dataset.dist));
  }));
  $('#saveVersion').addEventListener('click', async () => {
    const label = prompt('Version label', new Date().toLocaleString());
    if (!label) return;
    try { await api('POST', `/api/docs/${S.docId}/versions`, { label }); refreshVersions(); }
    catch (err) { toast(err.message); }
  });
  $('#refreshVersions').addEventListener('click', refreshVersions);
  $('#allComments').addEventListener('change', refreshComments);
  $('#commentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = selectedIds();
    const body = $('#commentBody').value.trim();
    if (!body) return;
    if (ids.length !== 1) return toast('Select exactly one element to comment on');
    try {
      await api('POST', `/api/docs/${S.docId}/comments`, { elementId: ids[0], body });
      $('#commentBody').value = '';
      refreshComments();
    } catch (err) { toast(err.message); }
  });
  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tool]');
    if (b) { S.tool = b.dataset.tool; renderAll(); }
  });

  const canvas = $('#canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', (evt) => {
    evt.preventDefault();
    if (evt.ctrlKey) {
      const r = canvas.getBoundingClientRect();
      const sx = evt.clientX - r.left, sy = evt.clientY - r.top;
      const wx = (sx - S.view.x) / S.view.zoom, wy = (sy - S.view.y) / S.view.zoom;
      S.view.zoom = Math.max(0.1, Math.min(8, S.view.zoom * Math.exp(-evt.deltaY * 0.01)));
      S.view.x = sx - wx * S.view.zoom;
      S.view.y = sy - wy * S.view.zoom;
    } else {
      S.view.x -= evt.deltaX;
      S.view.y -= evt.deltaY;
    }
    scheduleRender();
  }, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', (e) => { if (e.key === ' ') S.spaceDown = false; });
  window.addEventListener('resize', () => scheduleRender());
  $('#title').addEventListener('keydown', (e) => e.stopPropagation());
}

wire();
renderAll();
if (S.session) {
  startApp().catch((err) => { if (err.status === 401) { S.session = null; localStorage.removeItem('diagram-s5-session'); showLogin(); } else toast(err.message); });
} else {
  showLogin();
}
