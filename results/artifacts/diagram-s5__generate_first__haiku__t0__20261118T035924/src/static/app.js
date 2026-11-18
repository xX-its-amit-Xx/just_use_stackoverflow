// Browser editor. Uses the same core library as the server (served from /static/core/).
import { fromJSON, createDocument, importDrawio, snap, DiagramError } from '/static/core/index.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  token: localStorage.getItem('token'),
  username: localStorage.getItem('username'),
  actor: sessionStorage.getItem('actor') ?? (sessionStorage.setItem('actor', `web-${Math.random().toString(36).slice(2, 10)}`), sessionStorage.getItem('actor')),
  docId: null,
  doc: null,
  role: null,
  seq: 0,
  tool: 'select',
  selection: new Set(),
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
  connectFrom: null,
  clipboard: [],
  queue: [],
  flushing: false,
  ws: null,
  polling: false,
  presence: new Map(),
  lastCursorSent: 0,
  spaceDown: false,
};

// ---------- HTTP helpers ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

const status = (msg) => {
  $('#status').textContent = msg;
};

// ---------- auth & document list ----------
async function authenticate(kind) {
  const username = $('#username').value.trim();
  const password = $('#password').value;
  try {
    if (kind === 'register') await api('/api/auth/register', { method: 'POST', body: { username, password } });
    const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    state.token = r.token;
    state.username = r.user.username;
    localStorage.setItem('token', r.token);
    localStorage.setItem('username', r.user.username);
    showSignedIn();
    await refreshDocs();
  } catch (err) {
    alert(`Sign-in failed: ${err.message}`);
  }
}

function showSignedIn() {
  const ok = !!state.token;
  $('#auth').classList.toggle('hidden', false);
  $('#who').textContent = ok ? `Signed in as ${state.username}` : '';
  $('#docbar').classList.toggle('hidden', !ok);
  $('#tools').classList.toggle('hidden', !ok);
  $('#workspace').classList.toggle('hidden', !ok);
  $('#login-screen').classList.toggle('hidden', ok);
}

async function refreshDocs(selectId) {
  const { docs } = await api('/api/docs');
  const sel = $('#docs');
  sel.innerHTML = docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (${esc(d.role)})</option>`).join('');
  if (docs.length === 0) {
    const created = await api('/api/docs', { method: 'POST', body: { title: 'Untitled diagram' } });
    return refreshDocs(created.id);
  }
  const want = selectId ?? state.docId ?? docs[0].id;
  sel.value = docs.some((d) => d.id === want) ? want : docs[0].id;
  await openDoc(sel.value);
}

async function openDoc(id) {
  closeSocket();
  const json = await api(`/api/docs/${id}`);
  state.docId = id;
  state.role = json.role;
  state.seq = json.seq;
  state.doc = fromJSON(json, { actor: state.actor });
  state.doc.on('op', (op) => {
    state.queue.push(op);
    scheduleFlush();
  });
  state.queue = loadQueue(id);
  if (state.queue.length) state.doc.receive(state.queue);
  state.selection.clear();
  readOnlyUi();
  connectSocket();
  await loadPanels();
  render();
}

function readOnlyUi() {
  const ro = state.role === 'viewer';
  document.querySelectorAll('#tools button[data-tool], #undo, #redo, #alignGo, #distH, #distV, #layoutGo, #addLayer, #saveVersion, #importFile').forEach((b) => {
    if (b.id !== 'importFile') b.disabled = ro;
  });
  $('#importFile').disabled = ro;
  $('#status').textContent = ro ? 'read-only (viewer)' : '';
}

function loadQueue(id) {
  try {
    return JSON.parse(localStorage.getItem(`queue:${id}`) ?? '[]');
  } catch {
    return [];
  }
}

function saveQueue() {
  if (state.docId) localStorage.setItem(`queue:${state.docId}`, JSON.stringify(state.queue));
}

// ---------- sync ----------
let flushTimer = null;
function scheduleFlush() {
  saveQueue();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 0);
}

async function flush() {
  if (state.flushing || state.queue.length === 0 || !state.docId) return;
  const docId = state.docId;
  const batch = state.queue.slice(0, 200);
  state.flushing = true;
  try {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ops', ops: batch }));
    } else {
      await api(`/api/docs/${docId}/ops`, { method: 'POST', body: { ops: batch } });
    }
    if (state.docId === docId) state.queue.splice(0, batch.length);
  } catch (err) {
    // Network failure keeps the batch queued. Rejected ops (4xx) are dropped so the queue cannot jam.
    if (err.status && err.status >= 400 && err.status < 500) state.queue.splice(0, batch.length);
    else status('offline: edits queued');
  } finally {
    state.flushing = false;
    saveQueue();
    if (state.queue.length) setTimeout(flush, 500);
  }
}

window.addEventListener('online', () => {
  flush();
  connectSocket();
});

function connectSocket() {
  if (!state.docId || !state.token) return;
  const docId = state.docId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/docs/${docId}?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.onopen = () => {
    state.polling = false;
    flush();
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') state.seq = m.seq;
    else if (m.type === 'ops' && state.docId === docId) {
      state.seq = m.seq;
      state.doc.receive(m.ops);
      render();
    } else if (m.type === 'presence') {
      state.presence.set(m.actor, { cursor: m.cursor, selection: m.selection, user: m.user, at: Date.now() });
      renderPresence();
    } else if (m.type === 'error') status(`server: ${m.message ?? m.error}`);
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (state.docId === docId) {
      startPolling(docId);
      setTimeout(() => {
        if (state.docId === docId && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) connectSocket();
      }, 3000);
    }
  };
}

function closeSocket() {
  if (state.ws) {
    const ws = state.ws;
    state.ws = null;
    ws.close();
  }
}

// Long-poll fallback used while the WebSocket is down.
async function startPolling(docId) {
  if (state.polling) return;
  state.polling = true;
  while (state.polling && state.docId === docId && !(state.ws && state.ws.readyState === WebSocket.OPEN)) {
    try {
      const r = await api(`/api/docs/${docId}/ops?since=${state.seq}&wait=1`);
      if (state.docId !== docId) break;
      if (r.ops.length) {
        state.doc.receive(r.ops);
        render();
      }
      state.seq = r.seq;
    } catch {
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  state.polling = false;
}

// ---------- panels ----------
async function loadPanels() {
  await Promise.all([loadComments(), loadVersions()]);
  renderLayers();
}

function renderLayers() {
  const ul = $('#layers');
  const layers = state.doc.layers();
  ul.innerHTML = layers
    .map(
      (l) => `<li data-layer="${esc(l.id)}">
        <button data-act="vis">${l.visible ? 'Hide' : 'Show'}</button>
        <button data-act="lock">${l.locked ? 'Unlock' : 'Lock'}</button>
        ${esc(l.name)}</li>`,
    )
    .join('');
  const pl = $('#pLayer');
  pl.innerHTML = layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
}

async function loadComments() {
  if (!state.docId) return;
  const { comments } = await api(`/api/docs/${state.docId}/comments`);
  $('#comments').innerHTML = comments
    .map(
      (c) => `<li class="${c.resolved ? 'resolved' : ''}" data-cid="${esc(c.id)}">
        <b>${esc(c.author)}</b>${c.elementId ? ` on ${esc(c.elementId)}` : ''}: ${esc(c.text)}
        <div>${c.replies.map((r) => `<div>&nbsp;&nbsp;${esc(r.author)}: ${esc(r.text)}</div>`).join('')}</div>
        <button data-act="reply">Reply</button>
        <button data-act="resolve">${c.resolved ? 'Reopen' : 'Resolve'}</button>
      </li>`,
    )
    .join('');
}

async function loadVersions() {
  if (!state.docId) return;
  const { versions } = await api(`/api/docs/${state.docId}/versions`);
  $('#versions').innerHTML = versions
    .map((v) => `<li data-vid="${esc(v.id)}">${esc(v.label)} <button data-act="restore">Restore</button></li>`)
    .join('');
}

// ---------- rendering ----------
function shapeBox(e, preview) {
  const d = preview?.get(e.id);
  if (d?.box) return d.box;
  const off = d ?? { dx: 0, dy: 0 };
  return { x: e.x + off.dx, y: e.y + off.dy, width: e.width, height: e.height };
}

function renderElement(e, parent, preview) {
  const st = e.style ?? {};
  const common = { 'data-id': e.id, fill: st.fill ?? '#ffffff', stroke: st.stroke ?? '#000000', 'stroke-width': st.strokeWidth ?? 1 };
  if (st.opacity !== undefined) common.opacity = st.opacity;
  if (e.type === 'connector') {
    const pts = state.doc.route(e.id).map((p) => `${p[0]},${p[1]}`).join(' ');
    el('polyline', { 'data-id': e.id, 'data-conn': '1', points: pts, fill: 'none', stroke: st.stroke ?? '#000', 'stroke-width': st.strokeWidth ?? 1 }, parent);
    if (e.label) {
      const mid = state.doc.route(e.id)[0];
      const t = el('text', { x: mid[0], y: mid[1] - 4, 'text-anchor': 'middle', 'font-size': st.fontSize ?? 12 }, parent);
      t.textContent = e.label;
    }
    return;
  }
  const b = shapeBox(e, preview);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const attrs = { ...common };
  if (e.rotation) attrs.transform = `rotate(${e.rotation} ${cx} ${cy})`;
  let node;
  switch (e.type) {
    case 'ellipse':
      node = el('ellipse', { ...attrs, cx, cy, rx: b.width / 2, ry: b.height / 2 }, parent);
      break;
    case 'diamond':
      node = el('polygon', { ...attrs, points: `${cx},${b.y} ${b.x + b.width},${cy} ${cx},${b.y + b.height} ${b.x},${cy}` }, parent);
      break;
    case 'text':
      node = el('text', { ...attrs, x: b.x, y: b.y + (st.fontSize ?? 14), 'font-size': st.fontSize ?? 14, fill: st.color ?? '#000' }, parent);
      node.textContent = e.text;
      return;
    case 'image':
      node = el('image', { ...attrs, href: st.src ?? e.text ?? '', x: b.x, y: b.y, width: b.width, height: b.height }, parent);
      break;
    case 'line':
      node = el('line', { ...attrs, x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height }, parent);
      break;
    default:
      node = el('rect', { ...attrs, x: b.x, y: b.y, width: b.width, height: b.height }, parent);
  }
  if (e.text) {
    const t = el('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': st.fontSize ?? 14, 'pointer-events': 'none', transform: attrs.transform }, parent);
    t.textContent = e.text;
  }
  return node;
}

function selectionBox() {
  const shapes = [...state.selection].map((id) => state.doc.get(id)).filter((e) => e && e.type !== 'connector');
  if (shapes.length === 0) return null;
  return state.doc.bounds(shapes.map((s) => s.id));
}

function renderOverlay() {
  const ov = $('#overlay');
  ov.innerHTML = '';
  for (const id of state.selection) {
    const e = state.doc.get(id);
    if (!e) continue;
    if (e.type === 'connector') {
      for (const p of state.doc.route(id)) el('circle', { cx: p[0], cy: p[1], r: 3 / state.view.scale, class: 'handle' }, ov);
      continue;
    }
    el('rect', { x: e.x, y: e.y, width: e.width, height: e.height, class: 'sel', transform: e.rotation ? `rotate(${e.rotation} ${e.x + e.width / 2} ${e.y + e.height / 2})` : undefined }, ov);
  }
  const b = selectionBox();
  if (b && state.selection.size && state.role !== 'viewer') {
    const hs = 6 / state.view.scale;
    const corners = { nw: [b.x, b.y], ne: [b.x + b.width, b.y], sw: [b.x, b.y + b.height], se: [b.x + b.width, b.y + b.height] };
    for (const [k, [x, y]] of Object.entries(corners)) el('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, class: 'handle', 'data-handle': k }, ov);
    const rotY = b.y - 24 / state.view.scale;
    el('line', { x1: b.x + b.width / 2, y1: b.y, x2: b.x + b.width / 2, y2: rotY, stroke: '#2a6fdb' }, ov);
    el('circle', { cx: b.x + b.width / 2, cy: rotY, r: 4 / state.view.scale, class: 'rot', 'data-handle': 'rotate' }, ov);
  }
  if (state.drag?.type === 'marquee') {
    const r = normRect(state.drag.start, state.drag.cur);
    el('rect', { ...r, class: 'marquee' }, ov);
  }
}

function renderPresence() {
  const pg = $('#presence');
  pg.innerHTML = '';
  const now = Date.now();
  for (const [actor, p] of state.presence) {
    if (now - p.at > 15000) {
      state.presence.delete(actor);
      continue;
    }
    if (p.cursor) {
      el('circle', { cx: p.cursor.x, cy: p.cursor.y, r: 4 / state.view.scale, fill: '#c2185b' }, pg);
      const t = el('text', { x: p.cursor.x + 6 / state.view.scale, y: p.cursor.y, class: 'cursor' }, pg);
      t.textContent = p.user ?? actor;
    }
    for (const id of p.selection ?? []) {
      const e = state.doc.get(id);
      if (e && e.type !== 'connector') el('rect', { x: e.x - 2, y: e.y - 2, width: e.width + 4, height: e.height + 4, fill: 'none', stroke: '#c2185b', 'stroke-dasharray': '2 2' }, pg);
    }
  }
}

function renderMinimap() {
  const mm = $('#minimap');
  mm.innerHTML = '';
  const b = state.doc.bounds();
  const pad = 20;
  const vb = { x: b.x - pad, y: b.y - pad, width: Math.max(b.width, 100) + 2 * pad, height: Math.max(b.height, 100) + 2 * pad };
  mm.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
  for (const e of state.doc.elements().filter((x) => x.type !== 'connector')) {
    el('rect', { x: e.x, y: e.y, width: e.width, height: e.height, fill: '#ddd', stroke: '#999' }, mm);
  }
  const c = $('#canvas');
  const vw = c.clientWidth / state.view.scale;
  const vh = c.clientHeight / state.view.scale;
  el('rect', { x: state.view.x, y: state.view.y, width: vw, height: vh, fill: 'rgba(42,111,219,0.1)', stroke: '#2a6fdb' }, mm);
  mm.onclick = (ev) => {
    const r = mm.getBoundingClientRect();
    const x = vb.x + ((ev.clientX - r.left) / r.width) * vb.width;
    const y = vb.y + ((ev.clientY - r.top) / r.height) * vb.height;
    state.view.x = x - vw / 2;
    state.view.y = y - vh / 2;
    applyView();
  };
}

function applyView() {
  const c = $('#canvas');
  const w = c.clientWidth / state.view.scale;
  const h = c.clientHeight / state.view.scale;
  c.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${w} ${h}`);
  renderOverlay();
  renderMinimap();
}

function render() {
  if (!state.doc) return;
  const content = $('#content');
  content.innerHTML = '';
  const hidden = new Set(state.doc.layers().filter((l) => !l.visible).map((l) => l.id));
  const preview = ['move', 'resize'].includes(state.drag?.type) ? state.drag.preview : null;
  for (const e of state.doc.elements()) {
    if (hidden.has(e.layer)) continue;
    renderElement(e, content, preview);
  }
  for (const id of state.selection) if (!state.doc.get(id)) state.selection.delete(id);
  renderLayers();
  applyView();
  renderProps();
  renderPresence();
}

function renderProps() {
  const ids = [...state.selection];
  const shapes = ids.map((id) => state.doc.get(id)).filter(Boolean);
  $('#props').classList.toggle('hidden', shapes.length === 0);
  $('#noSel').classList.toggle('hidden', shapes.length > 0);
  if (shapes.length === 0) return;
  const first = shapes[0];
  const st = first.style ?? {};
  $('#pFill').value = toHex(st.fill ?? '#ffffff');
  $('#pStroke').value = toHex(st.stroke ?? '#000000');
  $('#pStrokeWidth').value = st.strokeWidth ?? 1;
  $('#pOpacity').value = st.opacity ?? 1;
  $('#pFontSize').value = st.fontSize ?? 14;
  $('#pText').value = first.text ?? '';
  $('#pLayer').value = first.layer;
  for (const id of ['#pFill', '#pStroke', '#pStrokeWidth', '#pOpacity', '#pFontSize', '#pText', '#pLayer', '#duplicate', '#deleteSel']) {
    const n = $(id);
    if (n) n.disabled = state.role === 'viewer';
  }
}

const toHex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#ffffff');

// ---------- geometry helpers ----------
function toDoc(ev) {
  const r = $('#canvas').getBoundingClientRect();
  return {
    x: state.view.x + ((ev.clientX - r.left) / r.width) * ($('#canvas').clientWidth / state.view.scale),
    y: state.view.y + ((ev.clientY - r.top) / r.height) * ($('#canvas').clientHeight / state.view.scale),
  };
}

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function nextId(prefix) {
  return `${prefix}-${state.actor}-${Math.random().toString(36).slice(2, 8)}`;
}

function mutate(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof DiagramError || err.name === 'DiagramError') status(err.message);
    else throw err;
  }
  render();
}

// ---------- pointer interaction ----------
const canvas = $('#canvas');

canvas.addEventListener('pointerdown', (ev) => {
  const p = toDoc(ev);
  if (ev.button === 1 || state.spaceDown) {
    state.drag = { type: 'pan', sx: ev.clientX, sy: ev.clientY, vx: state.view.x, vy: state.view.y };
    canvas.setPointerCapture(ev.pointerId);
    return;
  }
  if (state.role === 'viewer') return;
  const target = ev.target;
  if (target.dataset.handle === 'rotate') {
    const shapes = [...state.selection].map((id) => state.doc.get(id)).filter((e) => e && e.type !== 'connector');
    const b = selectionBox();
    if (b && shapes.length) state.drag = { type: 'rotate', cx: b.x + b.width / 2, cy: b.y + b.height / 2, ids: shapes.map((s) => s.id) };
  } else if (target.dataset.handle) {
    if (state.selection.size !== 1) return status('Resize works on a single shape');
    const id = [...state.selection][0];
    const e = state.doc.get(id);
    if (!e || e.type === 'connector') return;
    state.drag = { type: 'resize', handle: target.dataset.handle, start: p, box: { x: e.x, y: e.y, width: e.width, height: e.height }, ids: [id] };
  } else if (state.tool === 'connector') {
    const hit = state.doc.hitTest(p.x, p.y);
    if (!hit) return;
    if (!state.connectFrom) {
      state.connectFrom = hit.id;
      status('Click the target shape');
    } else {
      mutate(() => state.doc.apply({ type: 'add', element: { id: nextId('conn'), type: 'connector', source: { elementId: state.connectFrom }, target: { elementId: hit.id }, routing: 'orthogonal' } }));
      state.connectFrom = null;
      status('');
    }
  } else if (['rect', 'ellipse', 'diamond', 'text', 'image', 'line'].includes(state.tool)) {
    const size = state.tool === 'text' ? { width: 120, height: 32 } : { width: 120, height: 80 };
    const element = { id: nextId('el'), type: state.tool, x: snap(p, { grid: 10 }).x, y: snap(p, { grid: 10 }).y, ...size, text: '' };
    if (state.tool === 'text') element.text = prompt('Text', 'Text') ?? 'Text';
    if (state.tool === 'image') element.style = { src: prompt('Image URL', 'https://') ?? '' };
    mutate(() => state.doc.apply({ type: 'add', element }));
    state.selection = new Set([element.id]);
    setTool('select');
  } else {
    // select tool
    const conn = target.dataset?.conn ? target.dataset.id : null;
    const hit = conn ? null : state.doc.hitTest(p.x, p.y);
    if (conn) {
      if (!ev.shiftKey) state.selection.clear();
      state.selection.add(conn);
    } else if (hit) {
      if (ev.shiftKey) {
        if (state.selection.has(hit.id)) state.selection.delete(hit.id);
        else state.selection.add(hit.id);
      } else if (!state.selection.has(hit.id)) {
        state.selection = new Set([hit.id]);
      }
      state.drag = { type: 'move', start: p, ids: [...state.selection], preview: new Map(), dx: 0, dy: 0 };
    } else {
      if (!ev.shiftKey) state.selection.clear();
      state.drag = { type: 'marquee', start: p, cur: p, base: new Set(state.selection) };
    }
    render();
  }
  canvas.setPointerCapture(ev.pointerId);
  render();
});

canvas.addEventListener('pointermove', (ev) => {
  const p = toDoc(ev);
  const now = Date.now();
  if (state.ws?.readyState === WebSocket.OPEN && now - state.lastCursorSent > 100) {
    state.lastCursorSent = now;
    state.ws.send(JSON.stringify({ type: 'presence', actor: state.actor, cursor: p, selection: [...state.selection] }));
  }
  const d = state.drag;
  if (!d) return;
  if (d.type === 'pan') {
    state.view.x = d.vx - (ev.clientX - d.sx) / state.view.scale;
    state.view.y = d.vy - (ev.clientY - d.sy) / state.view.scale;
    applyView();
  } else if (d.type === 'move') {
    const first = state.doc.get(d.ids[0]);
    let dx = p.x - d.start.x;
    let dy = p.y - d.start.y;
    if (first && !ev.altKey) {
      const sn = snap({ x: first.x + dx, y: first.y + dy }, { grid: 10 });
      dx = sn.x - first.x;
      dy = sn.y - first.y;
    }
    d.dx = dx;
    d.dy = dy;
    d.preview = new Map(d.ids.map((id) => [id, { dx, dy }]));
    render();
  } else if (d.type === 'marquee') {
    d.cur = p;
    renderOverlay();
  } else if (d.type === 'resize') {
    d.next = resizeBox(d, p, ev.shiftKey);
    previewResize(d);
  } else if (d.type === 'rotate') {
    const deg = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
    d.deg = ((Math.round(deg) % 360) + 360) % 360;
    status(`rotation ${d.deg}°`);
  }
});

canvas.addEventListener('pointerup', (ev) => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.type === 'pan') return;
  if (d.type === 'move' && (d.dx || d.dy)) {
    mutate(() => state.doc.apply({ type: 'move', ids: d.ids, dx: d.dx, dy: d.dy }));
  } else if (d.type === 'marquee') {
    const r = normRect(d.start, d.cur);
    const ids = r.width + r.height > 2 ? state.doc.select(r) : [];
    state.selection = new Set([...d.base, ...ids]);
    render();
  } else if (d.type === 'resize' && d.next) {
    mutate(() => state.doc.apply({ type: 'resize', id: d.ids[0], box: d.next, keepAspect: ev.shiftKey }));
  } else if (d.type === 'rotate') {
    if (d.deg !== undefined) mutate(() => d.ids.forEach((id) => state.doc.apply({ type: 'rotate', id, deg: d.deg })));
    else render();
  } else {
    render();
  }
});

canvas.addEventListener('pointercancel', () => {
  state.drag = null;
  render();
});

canvas.addEventListener('dblclick', (ev) => {
  const p = toDoc(ev);
  const hit = state.doc.hitTest(p.x, p.y);
  if (hit && state.role !== 'viewer') {
    const t = prompt('Text', hit.text ?? '');
    if (t !== null) mutate(() => state.doc.apply({ type: 'update', id: hit.id, patch: { text: t } }));
  }
});

canvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const px = state.view.x + ((ev.clientX - r.left) / r.width) * (canvas.clientWidth / state.view.scale);
    const py = state.view.y + ((ev.clientY - r.top) / r.height) * (canvas.clientHeight / state.view.scale);
    state.view.scale = Math.min(8, Math.max(0.1, state.view.scale * factor));
    const w = canvas.clientWidth / state.view.scale;
    const h = canvas.clientHeight / state.view.scale;
    state.view.x = px - ((ev.clientX - r.left) / r.width) * w;
    state.view.y = py - ((ev.clientY - r.top) / r.height) * h;
    applyView();
  },
  { passive: false },
);

// Resize previews the new box without touching the document until release.
function previewResize(d) {
  if (!d.next) return;
  d.preview = new Map([[d.ids[0], { box: d.next }]]);
  render();
}

function resizeBox(d, p, keepAspect) {
  const b = d.box;
  let x1 = b.x;
  let y1 = b.y;
  let x2 = b.x + b.width;
  let y2 = b.y + b.height;
  if (d.handle.includes('w')) x1 = Math.min(p.x, x2 - 1);
  if (d.handle.includes('e')) x2 = Math.max(p.x, x1 + 1);
  if (d.handle.includes('n')) y1 = Math.min(p.y, y2 - 1);
  if (d.handle.includes('s')) y2 = Math.max(p.y, y1 + 1);
  let box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  if (keepAspect && b.width && b.height) {
    const k = Math.max(box.width / b.width, box.height / b.height);
    box = { x: box.x, y: box.y, width: b.width * k, height: b.height * k };
  }
  return box;
}

// ---------- keyboard ----------
const TOOL_KEYS = { v: 'select', r: 'rect', e: 'ellipse', d: 'diamond', t: 'text', c: 'connector' };
window.addEventListener('keydown', (ev) => {
  if (!state.doc || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (ev.code === 'Space') {
    state.spaceDown = true;
    ev.preventDefault();
    return;
  }
  const mod = ev.ctrlKey || ev.metaKey;
  const k = ev.key.toLowerCase();
  if (mod && k === 'z' && !ev.shiftKey) return withEdit(() => state.doc.undo());
  if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) return withEdit(() => state.doc.redo());
  if (mod && k === 'c') {
    state.clipboard = [...state.selection].map((id) => state.doc.get(id)).filter((e) => e && e.type !== 'connector');
    return;
  }
  if (mod && k === 'v') return paste(state.clipboard, 20);
  if (mod && k === 'd') return duplicate();
  if (state.role === 'viewer') return;
  if (k === 'delete' || k === 'backspace') {
    ev.preventDefault();
    return removeSelection();
  }
  if (!mod && TOOL_KEYS[k]) return setTool(TOOL_KEYS[k]);
  if (ev.key.startsWith('Arrow') && state.selection.size) {
    ev.preventDefault();
    const step = ev.shiftKey ? 10 : 1;
    const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
    const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
    mutate(() => state.doc.apply({ type: 'move', ids: [...state.selection], dx, dy }));
  }
});

window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') state.spaceDown = false;
});

function withEdit(fn) {
  mutate(() => {
    fn();
  });
}

function setTool(tool) {
  state.tool = tool;
  state.connectFrom = null;
  document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

function removeSelection() {
  const ids = [...state.selection];
  if (ids.length === 0) return;
  mutate(() => state.doc.transaction(() => ids.forEach((id) => state.doc.apply({ type: 'remove', id }))));
  state.selection.clear();
  render();
}

function paste(items, offset) {
  if (!items.length) return;
  const ids = [];
  mutate(() =>
    state.doc.transaction(() => {
      for (const e of items) {
        const id = nextId('el');
        ids.push(id);
        const { id: _i, z: _z, ...rest } = e;
        state.doc.apply({ type: 'add', element: { ...rest, id, x: e.x + offset, y: e.y + offset, style: e.style } });
      }
    }),
  );
  state.selection = new Set(ids);
  render();
}

function duplicate() {
  const items = [...state.selection].map((id) => state.doc.get(id)).filter((e) => e && e.type !== 'connector');
  paste(items, 20);
}

// ---------- toolbar & panels wiring ----------
document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#login').onclick = () => authenticate('login');
$('#register').onclick = () => authenticate('register');
$('#undo').onclick = () => withEdit(() => state.doc.undo());
$('#redo').onclick = () => withEdit(() => state.doc.redo());
$('#alignGo').onclick = () => mutate(() => state.doc.align([...state.selection], $('#alignMode').value));
$('#distH').onclick = () => mutate(() => state.doc.distribute([...state.selection], 'horizontal'));
$('#distV').onclick = () => mutate(() => state.doc.distribute([...state.selection], 'vertical'));
$('#layoutGo').onclick = () => {
  const [name, dir] = $('#layoutName').value.split('-');
  mutate(() => state.doc.layout(name, name === 'layered' ? { direction: dir } : {}));
};
$('#zoomFit').onclick = () => {
  const b = state.doc.bounds();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const s = Math.min(w / Math.max(b.width + 80, 1), h / Math.max(b.height + 80, 1), 4);
  state.view.scale = s;
  state.view.x = b.x - 40;
  state.view.y = b.y - 40;
  applyView();
};
$('#duplicate').onclick = duplicate;
$('#deleteSel').onclick = removeSelection;
$('#pFill').oninput = (ev) => setStyle({ fill: ev.target.value });
$('#pStroke').oninput = (ev) => setStyle({ stroke: ev.target.value });
$('#pStrokeWidth').onchange = (ev) => setStyle({ strokeWidth: Number(ev.target.value) });
$('#pOpacity').onchange = (ev) => setStyle({ opacity: Number(ev.target.value) });
$('#pFontSize').onchange = (ev) => setStyle({ fontSize: Number(ev.target.value) });
$('#pText').onchange = (ev) => mutate(() => state.doc.transaction(() => [...state.selection].forEach((id) => state.doc.apply({ type: 'update', id, patch: { text: ev.target.value } }))));
$('#pLayer').onchange = (ev) => mutate(() => state.doc.transaction(() => [...state.selection].forEach((id) => state.doc.apply({ type: 'update', id, patch: { layer: ev.target.value } }))));

function setStyle(style) {
  mutate(() => state.doc.apply({ type: 'setStyle', ids: [...state.selection], style }));
}

$('#layers').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const id = btn.closest('li').dataset.layer;
  const layer = state.doc.layers().find((l) => l.id === id);
  const patch = btn.dataset.act === 'vis' ? { visible: !layer.visible } : { locked: !layer.locked };
  mutate(() => state.doc.apply({ type: 'updateLayer', id, patch }));
});

$('#addLayer').onclick = () => {
  const name = prompt('Layer name', 'Layer');
  if (name) mutate(() => state.doc.apply({ type: 'addLayer', layer: { id: nextId('layer'), name } }));
};

$('#importFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const imported = importDrawio(await file.text(), { id: 'import', actor: 'import' });
  mutate(() =>
    state.doc.transaction(() => {
      for (const s of imported.elements().filter((e) => e.type !== 'connector')) {
        const { z, layer, ...rest } = s;
        state.doc.apply({ type: 'add', element: { ...rest, id: s.id, style: s.style } });
      }
      for (const c of imported.elements().filter((e) => e.type === 'connector')) {
        const { z, layer, ...rest } = c;
        state.doc.apply({ type: 'add', element: { ...rest, id: c.id } });
      }
    }),
  );
};

$('#exportSvg').onclick = () => download(`${state.docId}.svg`, 'image/svg+xml', `/api/docs/${state.docId}/export.svg`);
$('#exportJson').onclick = () => download(`${state.docId}.json`, 'application/json', `/api/docs/${state.docId}/export.json`);

async function download(name, type, path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  const blob = new Blob([await res.blob()], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#saveVersion').onclick = async () => {
  const label = prompt('Version label', `v${new Date().toLocaleTimeString()}`);
  if (!label) return;
  await api(`/api/docs/${state.docId}/versions`, { method: 'POST', body: { label } });
  await loadVersions();
};

$('#versions').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const vid = btn.closest('li').dataset.vid;
  if (!confirm('Restore this version? Current content will be replaced by undoable operations.')) return;
  await api(`/api/docs/${state.docId}/versions/${vid}/restore`, { method: 'POST' });
});

$('#addComment').onclick = async () => {
  const text = $('#commentText').value.trim();
  if (!text) return;
  const elementId = [...state.selection][0] ?? null;
  await api(`/api/docs/${state.docId}/comments`, { method: 'POST', body: { text, elementId } });
  $('#commentText').value = '';
  await loadComments();
};

$('#comments').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const cid = btn.closest('li').dataset.cid;
  if (btn.dataset.act === 'reply') {
    const text = prompt('Reply');
    if (text) await api(`/api/docs/${state.docId}/comments/${cid}/replies`, { method: 'POST', body: { text } });
  } else {
    const current = btn.textContent === 'Reopen';
    await api(`/api/docs/${state.docId}/comments/${cid}/resolve`, { method: 'POST', body: { resolved: !current } });
  }
  await loadComments();
});

$('#docs').onchange = (ev) => openDoc(ev.target.value).catch((err) => alert(err.message));
$('#newDoc').onclick = async () => {
  const title = prompt('Title', 'Untitled diagram');
  if (!title) return;
  const d = await api('/api/docs', { method: 'POST', body: { title } });
  await refreshDocs(d.id);
};
$('#share').onclick = async () => {
  const username = $('#shareUser').value.trim();
  try {
    await api(`/api/docs/${state.docId}/share`, { method: 'POST', body: { username, role: $('#shareRole').value } });
    status(`shared with ${username}`);
  } catch (err) {
    alert(err.message);
  }
};

// Boot: restore session if a token exists.
showSignedIn();
if (state.token) {
  refreshDocs().catch(() => {
    localStorage.removeItem('token');
    state.token = null;
    showSignedIn();
  });
}
