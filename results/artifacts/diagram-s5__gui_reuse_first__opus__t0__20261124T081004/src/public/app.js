// Browser editor for diagram-s5. Uses the isomorphic core from /static/core/.
import { createDocument, importDrawio, fromJSON, snap, DiagramError } from '/static/core/index.js';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const uid = () => Math.random().toString(36).slice(2, 10);
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324'];
const colorFor = (s) => COLORS[[...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];

// ------------------------------------------------------------------ state
const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  docId: null, doc: null, role: null, seq: 0,
  tool: 'select', selection: new Set(), activeLayer: null,
  view: { x: 0, y: 0, zoom: 1 },
  ws: null, online: false, remote: new Map(), clipboard: null, drag: null, comments: [],
};

// ------------------------------------------------------------------ API
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && state.token && !url.includes('/auth/')) logout();
    throw Object.assign(new Error(data?.message || res.statusText), { status: res.status });
  }
  return data;
}

// ------------------------------------------------------------------ auth + doc list
async function doAuth(register) {
  const username = $('#auth-user').value.trim(), password = $('#auth-pass').value;
  $('#auth-msg').textContent = '';
  try {
    if (register) await api('POST', '/api/auth/register', { username, password });
    const r = await api('POST', '/api/auth/login', { username, password });
    state.token = r.token; state.user = r.user;
    localStorage.setItem('token', r.token); localStorage.setItem('user', JSON.stringify(r.user));
    showDocList();
  } catch (e) { $('#auth-msg').textContent = e.message; }
}
$('#auth-form').addEventListener('submit', (e) => { e.preventDefault(); doAuth(false); });
$('#btn-register').addEventListener('click', () => doAuth(true));

function logout() {
  state.token = null; localStorage.removeItem('token'); localStorage.removeItem('user');
  closeDoc();
  $('#doclist').classList.add('hidden'); $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden');
}
$('#btn-logout').addEventListener('click', logout);

async function showDocList() {
  closeDoc();
  $('#auth').classList.add('hidden'); $('#app').classList.add('hidden'); $('#doclist').classList.remove('hidden');
  const list = await api('GET', '/api/docs');
  const ul = $('#docs'); ul.innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><small></small>`;
    li.firstChild.textContent = d.title; li.lastChild.textContent = `${d.role} · ${d.owner}`;
    li.addEventListener('click', () => { location.hash = d.id; });
    ul.appendChild(li);
  }
}
$('#new-doc').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = await api('POST', '/api/docs', { title: $('#new-doc-title').value || 'Untitled' });
  location.hash = d.id;
});
$('#btn-home').addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', route);

async function route() {
  if (!state.token) return logout();
  const id = location.hash.slice(1);
  if (!id) return showDocList();
  try { await openDoc(id); } catch (e) { alert(e.message); location.hash = ''; }
}

// ------------------------------------------------------------------ sync (offline queue + WS + long-poll fallback)
const outboxKey = () => `outbox:${state.docId}`;
const loadOutbox = () => JSON.parse(localStorage.getItem(outboxKey()) || '[]');
const saveOutbox = (ops) => localStorage.setItem(outboxKey(), JSON.stringify(ops));

async function openDoc(id) {
  closeDoc();
  const meta = await api('GET', `/api/docs/${id}`);
  state.docId = id; state.role = meta.role;
  const actor = `${state.user.username}-${uid()}`;
  const doc = createDocument({ id, actor });
  state.doc = doc;
  const { ops, seq } = await api('GET', `/api/docs/${id}/ops?since=0`);
  doc.receive(ops); state.seq = seq;
  // re-apply any queued offline ops from an earlier session
  const queued = loadOutbox();
  if (queued.length) doc.receive(queued);
  doc.on('op', (op) => { saveOutbox([...loadOutbox(), op]); scheduleFlush(); });
  doc.on('change', () => scheduleRender());
  state.selection.clear();
  state.activeLayer = doc.layers()[0]?.id;
  $('#doc-title').textContent = meta.title + (meta.role === 'viewer' ? ' (view only)' : '');
  $('#auth').classList.add('hidden'); $('#doclist').classList.add('hidden'); $('#app').classList.remove('hidden');
  connect();
  scheduleFlush();
  loadVersions(); loadComments();
  zoomFit();
  scheduleRender();
}

function closeDoc() {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  state.doc = null; state.docId = null; state.remote.clear();
  clearTimeout(state.reconnectTimer);
  state.polling = false;
}

function setStatus(online) {
  state.online = online;
  const s = $('#status'); s.textContent = online ? 'online' : `offline (${loadOutbox().length} queued)`;
  s.className = 'status ' + (online ? 'online' : 'offline');
}

function connect() {
  const docId = state.docId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try { ws = new WebSocket(`${proto}://${location.host}/ws/docs/${docId}?token=${encodeURIComponent(state.token)}&actor=${encodeURIComponent(state.doc.actor)}`); }
  catch { return longPoll(); }
  state.ws = ws;
  ws.onopen = async () => {
    setStatus(true);
    await flush();
    ws.send(JSON.stringify({ type: 'sync', since: state.seq }));
    sendPresence();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ops') { state.doc?.receive(msg.ops); state.seq = Math.max(state.seq, msg.seq); }
    else if (msg.type === 'ack') { state.seq = Math.max(state.seq, msg.seq); }
    else if (msg.type === 'presence') { state.remote.set(msg.actor, { ...msg, at: Date.now() }); renderCollaborators(); scheduleRender(); }
    else if (msg.type === 'leave') { state.remote.delete(msg.actor); renderCollaborators(); scheduleRender(); }
    else if (msg.type === 'comments') { state.comments = msg.comments; renderComments(); scheduleRender(); }
  };
  ws.onclose = () => {
    setStatus(false);
    if (state.docId !== docId) return;
    state.reconnectTimer = setTimeout(() => { if (state.docId === docId) connect(); }, 2000);
  };
}

async function longPoll() {
  if (state.polling) return;
  state.polling = true;
  const docId = state.docId;
  while (state.polling && state.docId === docId) {
    try {
      const r = await api('GET', `/api/docs/${docId}/ops?since=${state.seq}&wait=1`);
      state.doc.receive(r.ops); state.seq = r.seq; setStatus(true);
    } catch { setStatus(false); await new Promise(r => setTimeout(r, 3000)); }
  }
}

let flushTimer = null, flushing = false;
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 50); }
async function flush() {
  if (flushing || !state.docId || state.role === 'viewer') return;
  const ops = loadOutbox();
  if (!ops.length) { setStatus(state.online); return; }
  flushing = true;
  try {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'ops', ops }));
    } else {
      await api('POST', `/api/docs/${state.docId}/ops`, { ops });
    }
    const remaining = loadOutbox().filter(o => !ops.some(s => s.id === o.id));
    saveOutbox(remaining);
  } catch { /* stay queued; retried on reconnect */ }
  finally { flushing = false; setStatus(state.online); }
}
window.addEventListener('online', () => { flush(); if (!state.ws || state.ws.readyState > 1) connect(); });

let presenceTimer = null, lastCursor = null;
function sendPresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: 'presence', actor: state.doc.actor, name: state.user.username, cursor: lastCursor, selection: [...state.selection] }));
  }, 50);
}

function renderCollaborators() {
  const box = $('#collaborators'); box.innerHTML = '';
  for (const p of state.remote.values()) {
    const s = document.createElement('span'); s.className = 'collab'; s.style.background = colorFor(p.actor); s.textContent = p.name || p.user;
    box.appendChild(s);
  }
}

// ------------------------------------------------------------------ editing helpers
function apply(op) {
  if (state.role === 'viewer') return;
  try { return state.doc.apply(op); } catch (e) { if (e instanceof DiagramError) flash(e.message); else throw e; }
}
function txn(fn) {
  if (state.role === 'viewer') return;
  try { state.doc.transaction(fn); } catch (e) { if (e instanceof DiagramError) flash(e.message); else throw e; }
}
function flash(msg) { const s = $('#status'); const old = s.textContent; s.textContent = msg; setTimeout(() => { s.textContent = old; }, 2000); }
function setSelection(ids) { state.selection = new Set(ids.filter(id => state.doc.get(id))); renderProps(); sendPresence(); scheduleRender(); }
function expandGroups(ids) {
  const groups = new Set(ids.map(id => state.doc.get(id)?.groupId).filter(Boolean));
  if (!groups.size) return ids;
  return [...new Set([...ids, ...state.doc.elements().filter(e => groups.has(e.groupId)).map(e => e.id)])];
}

// ------------------------------------------------------------------ view transform
const canvas = $('#canvas');
function toWorld(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) / state.view.zoom + state.view.x, y: (clientY - r.top) / state.view.zoom + state.view.y };
}
function applyView() {
  $('#viewport').setAttribute('transform', `scale(${state.view.zoom}) translate(${-state.view.x} ${-state.view.y})`);
  $('#zoom-label').textContent = Math.round(state.view.zoom * 100) + '%';
  renderMinimap();
}
function zoomAt(factor, cx, cy) {
  const before = toWorld(cx, cy);
  state.view.zoom = Math.min(8, Math.max(0.1, state.view.zoom * factor));
  const r = canvas.getBoundingClientRect();
  state.view.x = before.x - (cx - r.left) / state.view.zoom;
  state.view.y = before.y - (cy - r.top) / state.view.zoom;
  applyView();
}
function zoomFit() {
  const b = state.doc.bounds();
  const r = canvas.getBoundingClientRect();
  if (!b.width && !b.height) { state.view = { x: -40, y: -40, zoom: 1 }; return applyView(); }
  const z = Math.min(2, Math.max(0.1, Math.min((r.width - 80) / (b.width || 1), (r.height - 80) / (b.height || 1))));
  state.view = { zoom: z, x: b.x - (r.width / z - b.width) / 2, y: b.y - (r.height / z - b.height) / 2 };
  applyView();
}
$('#btn-zoom-in').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(1.2, r.left + r.width / 2, r.top + r.height / 2); });
$('#btn-zoom-out').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(1 / 1.2, r.left + r.width / 2, r.top + r.height / 2); });
$('#btn-zoom-fit').addEventListener('click', zoomFit);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  else { state.view.x += e.deltaX / state.view.zoom; state.view.y += e.deltaY / state.view.zoom; applyView(); }
}, { passive: false });

// ------------------------------------------------------------------ rendering
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

function render() {
  const doc = state.doc; if (!doc) return;
  const content = $('#content'); content.innerHTML = '';
  const vis = new Set(doc.layers().filter(l => l.visible).map(l => l.id));
  const commented = new Set(state.comments.filter(c => !c.resolved).map(c => c.elementId));
  const preview = state.drag && state.drag.preview;
  for (const el of doc.elements()) {
    if (!vis.has(el.layer)) continue;
    const e = preview && preview[el.id] ? { ...el, ...preview[el.id] } : el;
    const st = e.style || {};
    const g = svgEl('g', { 'data-id': e.id, opacity: st.opacity }, content);
    if (e.type === 'connector') {
      let pts;
      try { pts = doc.route(e.id); } catch { continue; }
      if (preview) {
        const s = preview[e.source.elementId], t = preview[e.target.elementId];
        if (s || t) pts = straightPreview(e, s, t) || pts;
      }
      svgEl('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: st.stroke || '#333', 'stroke-width': st.strokeWidth || 1.5, 'marker-end': 'url(#arrow)', class: commented.has(e.id) ? 'commented' : null }, g);
      svgEl('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': 10 }, g);
      if (e.label) {
        const m = pts[Math.floor(pts.length / 2) - (pts.length % 2 ? 0 : 1)], n = pts[Math.floor(pts.length / 2)];
        const t = svgEl('text', { x: (m[0] + n[0]) / 2, y: (m[1] + n[1]) / 2 - 4, 'text-anchor': 'middle', 'font-size': st.fontSize || 12 }, g);
        t.textContent = e.label;
      }
      continue;
    }
    const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
    if (e.rotation) g.setAttribute('transform', `rotate(${e.rotation} ${cx} ${cy})`);
    const common = { fill: st.fill || (e.type === 'text' ? 'transparent' : '#ffffff'), stroke: st.stroke || (e.type === 'text' ? 'none' : '#333'), 'stroke-width': st.strokeWidth ?? 1.5, class: commented.has(e.id) ? 'commented' : null };
    if (e.type === 'rect' || e.type === 'text') svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, rx: st.rounded ? 8 : 0, ...common }, g);
    else if (e.type === 'ellipse') svgEl('ellipse', { cx, cy, rx: e.width / 2, ry: e.height / 2, ...common }, g);
    else if (e.type === 'diamond') svgEl('polygon', { points: `${cx},${e.y} ${e.x + e.width},${cy} ${cx},${e.y + e.height} ${e.x},${cy}`, ...common }, g);
    else if (e.type === 'line') svgEl('line', { x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height, stroke: st.stroke || '#333', 'stroke-width': st.strokeWidth || 2 }, g);
    else if (e.type === 'image') {
      if (e.src) svgEl('image', { x: e.x, y: e.y, width: e.width, height: e.height, href: e.src, preserveAspectRatio: 'none' }, g);
      svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, fill: 'none', stroke: '#999', 'stroke-dasharray': '4 2' }, g);
    }
    if (e.text) {
      const lines = String(e.text).split('\n'); const fs = st.fontSize || 14;
      const t = svgEl('text', { x: cx, y: cy - (lines.length - 1) * fs * 0.6, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': fs, 'font-family': st.fontFamily || 'sans-serif', fill: st.fontColor || '#222' }, g);
      lines.forEach((ln, i) => { const ts = svgEl('tspan', { x: cx, dy: i ? fs * 1.2 : 0 }, t); ts.textContent = ln; });
    }
  }
  renderOverlay();
  renderRemote();
  renderLayers();
  renderMinimap();
  $('#btn-undo').disabled = !doc.canUndo(); $('#btn-redo').disabled = !doc.canRedo();
}

function straightPreview(c, s, t) {
  const a = { ...state.doc.get(c.source.elementId), ...(s || {}) }, b = { ...state.doc.get(c.target.elementId), ...(t || {}) };
  return [[a.x + a.width / 2, a.y + a.height / 2], [b.x + b.width / 2, b.y + b.height / 2]];
}

function selBox(id) {
  const e = state.doc.get(id); if (!e) return null;
  const p = state.drag?.preview?.[id];
  return p ? { ...e, ...p } : e;
}

function renderOverlay() {
  const ov = $('#overlay'); ov.innerHTML = '';
  const z = state.view.zoom;
  for (const id of state.selection) {
    const e = selBox(id); if (!e) continue;
    if (e.type === 'connector') {
      try { const pts = state.doc.route(id); svgEl('polyline', { points: pts.map(p => p.join(',')).join(' '), class: 'sel-outline', 'stroke-width': 2 / z }, ov); } catch { /* */ }
      continue;
    }
    const g = svgEl('g', e.rotation ? { transform: `rotate(${e.rotation} ${e.x + e.width / 2} ${e.y + e.height / 2})` } : {}, ov);
    svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, class: 'sel-outline', 'stroke-width': 1 / z }, g);
    if (state.selection.size === 1 && state.role !== 'viewer') {
      const hs = 8 / z;
      const handles = { nw: [e.x, e.y], ne: [e.x + e.width, e.y], sw: [e.x, e.y + e.height], se: [e.x + e.width, e.y + e.height],
        n: [e.x + e.width / 2, e.y], s: [e.x + e.width / 2, e.y + e.height], w: [e.x, e.y + e.height / 2], e: [e.x + e.width, e.y + e.height / 2] };
      for (const [k, [hx, hy]] of Object.entries(handles)) svgEl('rect', { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: 'handle', 'data-handle': k, 'stroke-width': 1 / z }, g);
      svgEl('line', { x1: e.x + e.width / 2, y1: e.y, x2: e.x + e.width / 2, y2: e.y - 24 / z, stroke: '#1e78ff', 'stroke-width': 1 / z }, g);
      svgEl('circle', { cx: e.x + e.width / 2, cy: e.y - 24 / z, r: 5 / z, class: 'handle', 'data-handle': 'rotate', 'stroke-width': 1 / z }, g);
    }
  }
  const d = state.drag;
  if (d && d.kind === 'marquee') {
    const r = normRect(d.start, d.cur);
    svgEl('rect', { ...r, class: 'marquee', 'stroke-width': 1 / z }, ov);
  }
  if (d && (d.kind === 'create' || d.kind === 'connect') && d.cur) {
    if (d.kind === 'create') svgEl('rect', { ...normRect(d.start, d.cur), class: 'marquee', 'stroke-width': 1 / z }, ov);
    else svgEl('line', { x1: d.start.x, y1: d.start.y, x2: d.cur.x, y2: d.cur.y, stroke: '#1e78ff', 'stroke-width': 1.5 / z, 'marker-end': 'url(#arrow)' }, ov);
  }
  for (const gd of (d && d.guides) || []) {
    if (gd.x !== undefined) svgEl('line', { x1: gd.x, y1: -1e5, x2: gd.x, y2: 1e5, class: 'guide', 'stroke-width': 1 / z }, ov);
    else svgEl('line', { x1: -1e5, y1: gd.y, x2: 1e5, y2: gd.y, class: 'guide', 'stroke-width': 1 / z }, ov);
  }
}

function renderRemote() {
  const g = $('#remote'); g.innerHTML = '';
  const z = state.view.zoom;
  for (const p of state.remote.values()) {
    const col = colorFor(p.actor);
    for (const id of p.selection || []) {
      const e = state.doc.get(id); if (!e || e.type === 'connector') continue;
      svgEl('rect', { x: e.x - 3 / z, y: e.y - 3 / z, width: e.width + 6 / z, height: e.height + 6 / z, fill: 'none', stroke: col, 'stroke-width': 2 / z }, g);
    }
    if (p.cursor) {
      svgEl('path', { d: `M${p.cursor.x},${p.cursor.y} l${12 / z},${4 / z} l${-5 / z},${3 / z} l${-3 / z},${6 / z} z`, fill: col }, g);
      const t = svgEl('text', { x: p.cursor.x + 12 / z, y: p.cursor.y + 18 / z, fill: col, 'font-size': 12 / z }, g);
      t.textContent = p.name || p.user || p.actor;
    }
  }
}

function renderMinimap() {
  const doc = state.doc; if (!doc) return;
  const mini = $('#minimap'), mc = $('#mini-content'); mc.innerHTML = '';
  const r = canvas.getBoundingClientRect();
  const vw = { x: state.view.x, y: state.view.y, width: r.width / state.view.zoom, height: r.height / state.view.zoom };
  const b = doc.bounds();
  const x1 = Math.min(b.x, vw.x), y1 = Math.min(b.y, vw.y), x2 = Math.max(b.x + b.width, vw.x + vw.width), y2 = Math.max(b.y + b.height, vw.y + vw.height);
  mini.setAttribute('viewBox', `${x1 - 20} ${y1 - 20} ${x2 - x1 + 40} ${y2 - y1 + 40}`);
  for (const e of doc.elements()) if (e.type !== 'connector') svgEl('rect', { x: e.x, y: e.y, width: e.width, height: e.height, fill: '#bbb' }, mc);
  const v = $('#mini-view');
  for (const [k, val] of Object.entries(vw)) v.setAttribute(k, val);
  v.setAttribute('stroke-width', (x2 - x1) / 180);
  mini.dataset.vb = JSON.stringify([x1 - 20, y1 - 20, x2 - x1 + 40, y2 - y1 + 40]);
}
$('#minimap').addEventListener('pointerdown', (e) => {
  const mini = $('#minimap'); const [vx, vy, vw, vh] = JSON.parse(mini.dataset.vb || '[0,0,1,1]');
  const r = mini.getBoundingClientRect();
  const s = Math.max(vw / r.width, vh / r.height);
  const wx = vx + (e.clientX - r.left) * s - (vw - r.width * s) / 2 * 0, wy = vy + (e.clientY - r.top) * s;
  const cr = canvas.getBoundingClientRect();
  state.view.x = wx - cr.width / state.view.zoom / 2; state.view.y = wy - cr.height / state.view.zoom / 2;
  applyView();
});

// ------------------------------------------------------------------ layers panel
function renderLayers() {
  const ul = $('#layers'); ul.innerHTML = '';
  const layers = state.doc.layers();
  if (!layers.some(l => l.id === state.activeLayer)) state.activeLayer = layers[0]?.id;
  for (const l of [...layers].reverse()) {
    const li = document.createElement('li');
    if (l.id === state.activeLayer) li.className = 'active';
    const vis = document.createElement('input'); vis.type = 'checkbox'; vis.checked = l.visible; vis.title = 'Visible';
    vis.onchange = () => apply({ type: 'updateLayer', id: l.id, patch: { visible: vis.checked } });
    const lock = document.createElement('button'); lock.textContent = l.locked ? '🔒' : '🔓'; lock.title = 'Lock';
    lock.onclick = () => apply({ type: 'updateLayer', id: l.id, patch: { locked: !l.locked } });
    const name = document.createElement('span'); name.textContent = l.name;
    name.onclick = () => { state.activeLayer = l.id; renderLayers(); };
    name.ondblclick = () => { const n = prompt('Layer name', l.name); if (n) apply({ type: 'updateLayer', id: l.id, patch: { name: n } }); };
    const del = document.createElement('button'); del.textContent = '✕'; del.title = 'Delete layer';
    del.onclick = () => { if (confirm(`Delete layer ${l.name}?`)) apply({ type: 'removeLayer', id: l.id }); };
    li.append(vis, lock, name, del);
    ul.appendChild(li);
  }
}
$('#btn-add-layer').addEventListener('click', () => {
  const id = 'layer-' + uid();
  apply({ type: 'addLayer', layer: { id, name: `Layer ${state.doc.layers().length + 1}` } });
  state.activeLayer = id; renderLayers();
});

// ------------------------------------------------------------------ properties panel
const PROPS = ['text', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'fontFamily', 'opacity', 'routing', 'x', 'y', 'width', 'height', 'rotation'];
function renderProps() {
  const ids = [...state.selection];
  $('#props-empty').classList.toggle('hidden', ids.length > 0);
  $('#props-form').classList.toggle('hidden', ids.length === 0);
  if (!ids.length) return;
  const e = state.doc.get(ids[0]); if (!e) return;
  const st = e.style || {};
  const val = { text: e.type === 'connector' ? e.label : e.text, fill: st.fill || '#ffffff', stroke: st.stroke || '#333333', strokeWidth: st.strokeWidth ?? 1.5, fontSize: st.fontSize ?? 14, fontFamily: st.fontFamily || 'sans-serif', opacity: st.opacity ?? 1, routing: e.routing || 'straight', x: e.x, y: e.y, width: e.width, height: e.height, rotation: e.rotation };
  for (const k of PROPS) { const inp = $('#p-' + k); if (document.activeElement !== inp && val[k] !== undefined) inp.value = val[k]; }
}
for (const k of PROPS) {
  $('#p-' + k).addEventListener('change', (ev) => {
    const v = ev.target.value;
    const ids = [...state.selection];
    txn(() => {
      for (const id of ids) {
        const e = state.doc.get(id); if (!e) continue;
        if (k === 'text') state.doc.apply({ type: 'update', id, patch: e.type === 'connector' ? { label: v } : { text: v } });
        else if (k === 'routing') { if (e.type === 'connector') state.doc.apply({ type: 'update', id, patch: { routing: v } }); }
        else if (['x', 'y', 'width', 'height'].includes(k)) { if (e.type !== 'connector') state.doc.apply({ type: 'resize', id, box: { x: e.x, y: e.y, width: e.width, height: e.height, [k]: Number(v) } }); }
        else if (k === 'rotation') { if (e.type !== 'connector') state.doc.apply({ type: 'rotate', id, deg: Number(v) }); }
        else state.doc.apply({ type: 'setStyle', ids: [id], style: { [k]: ['strokeWidth', 'fontSize', 'opacity'].includes(k) ? Number(v) : v } });
      }
    });
  });
}

// ------------------------------------------------------------------ pointer interaction
const pointers = new Map();
let pinch = null;
function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }

function snapMove(ids, dx, dy) {
  if (!$('#snap-toggle').checked) return { dx, dy, guides: [] };
  const els = ids.map(id => state.doc.get(id)).filter(e => e && e.type !== 'connector');
  if (!els.length) return { dx, dy, guides: [] };
  const b = els.reduce((a, e) => ({ x1: Math.min(a.x1, e.x), y1: Math.min(a.y1, e.y), x2: Math.max(a.x2, e.x + e.width), y2: Math.max(a.y2, e.y + e.height) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
  const gx = [], gy = [];
  for (const o of state.doc.elements()) {
    if (o.type === 'connector' || ids.includes(o.id)) continue;
    gx.push(o.x, o.x + o.width / 2, o.x + o.width); gy.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  const thr = 6 / state.view.zoom;
  const cand = (vals, guides) => {
    let best = null;
    for (const [i, v] of vals.entries()) {
      const s = snap({ x: v, y: 0 }, { guides: { x: guides }, threshold: thr });
      if (s.x !== v && (best === null || Math.abs(s.x - v) < Math.abs(best.d))) best = { d: s.x - v, g: s.x, i };
    }
    return best;
  };
  const w = b.x2 - b.x1, h = b.y2 - b.y1;
  const sx = cand([b.x1 + dx, b.x1 + dx + w / 2, b.x1 + dx + w], gx);
  const sy = cand([b.y1 + dy, b.y1 + dy + h / 2, b.y1 + dy + h], gy);
  const guides = [];
  if (sx) { dx += sx.d; guides.push({ x: sx.g }); } else dx = snap({ x: b.x1 + dx, y: 0 }, { grid: 10 }).x - b.x1;
  if (sy) { dy += sy.d; guides.push({ y: sy.g }); } else dy = snap({ x: 0, y: b.y1 + dy }, { grid: 10 }).y - b.y1;
  return { dx, dy, guides };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!state.doc) return;
  canvas.focus();
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    state.drag = null; return;
  }
  const p = toWorld(ev.clientX, ev.clientY);
  if (ev.button === 1 || (ev.button === 0 && ev.altKey) || state.spaceDown) { state.drag = { kind: 'pan', last: { x: ev.clientX, y: ev.clientY } }; return; }
  const handle = ev.target.getAttribute && ev.target.getAttribute('data-handle');
  const ro = state.role === 'viewer';
  if (handle && !ro) {
    const id = [...state.selection][0]; const e = state.doc.get(id);
    state.drag = { kind: handle === 'rotate' ? 'rotate' : 'resize', handle, id, orig: e, start: p };
    return;
  }
  if (state.tool === 'select' || ro) {
    const hitConn = ev.target.closest && ev.target.closest('g[data-id]');
    let hit = state.doc.hitTest(p.x, p.y);
    if (!hit && hitConn) { const c = state.doc.get(hitConn.getAttribute('data-id')); if (c && c.type === 'connector') hit = c; }
    if (hit) {
      let ids = expandGroups([hit.id]);
      if (ev.shiftKey) {
        const sel = new Set(state.selection);
        const has = sel.has(hit.id);
        for (const id of ids) has ? sel.delete(id) : sel.add(id);
        setSelection([...sel]);
      } else if (!state.selection.has(hit.id)) setSelection(ids);
      if (!ro) state.drag = { kind: 'move', start: p, ids: [...state.selection], dx: 0, dy: 0 };
    } else {
      if (!ev.shiftKey) setSelection([]);
      state.drag = { kind: 'marquee', start: p, cur: p, additive: ev.shiftKey };
    }
    return;
  }
  if (state.tool === 'connector') {
    const hit = state.doc.hitTest(p.x, p.y);
    if (hit) state.drag = { kind: 'connect', from: hit.id, start: p, cur: p };
    return;
  }
  state.drag = { kind: 'create', start: snap(p, { grid: $('#snap-toggle').checked ? 10 : 0 }), cur: p };
});

canvas.addEventListener('pointermove', (ev) => {
  if (!state.doc) return;
  const p = toWorld(ev.clientX, ev.clientY);
  lastCursor = { x: Math.round(p.x), y: Math.round(p.y) }; sendPresence();
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt(dist / pinch.dist, pinch.mid.x, pinch.mid.y); pinch.dist = dist; return;
  }
  const d = state.drag; if (!d) return;
  if (d.kind === 'pan') {
    state.view.x -= (ev.clientX - d.last.x) / state.view.zoom; state.view.y -= (ev.clientY - d.last.y) / state.view.zoom;
    d.last = { x: ev.clientX, y: ev.clientY }; applyView(); return;
  }
  if (d.kind === 'move') {
    const s = snapMove(d.ids, p.x - d.start.x, p.y - d.start.y);
    d.dx = s.dx; d.dy = s.dy; d.guides = s.guides;
    d.preview = {};
    for (const id of d.ids) { const e = state.doc.get(id); if (e && e.type !== 'connector') d.preview[id] = { x: e.x + d.dx, y: e.y + d.dy }; }
  } else if (d.kind === 'resize') {
    const o = d.orig; let { x, y, width, height } = o;
    let px = p.x, py = p.y;
    if ($('#snap-toggle').checked) ({ x: px, y: py } = snap({ x: px, y: py }, { grid: 10 }));
    if (d.handle.includes('e')) width = px - o.x;
    if (d.handle.includes('s')) height = py - o.y;
    if (d.handle.includes('w')) { width = o.x + o.width - px; x = px; }
    if (d.handle.includes('n')) { height = o.y + o.height - py; y = py; }
    if (ev.shiftKey && o.width && o.height) { const r = o.width / o.height; if (Math.abs(width / o.width) > Math.abs(height / o.height)) height = width / r; else width = height * r; }
    d.box = { x: Math.min(x, x + width), y: Math.min(y, y + height), width: Math.abs(width), height: Math.abs(height) };
    d.preview = { [d.id]: d.box };
  } else if (d.kind === 'rotate') {
    const o = d.orig; const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    let deg = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
    if (ev.shiftKey || $('#snap-toggle').checked) deg = Math.round(deg / 15) * 15;
    d.deg = ((deg % 360) + 360) % 360;
    d.preview = { [d.id]: { rotation: d.deg } };
  } else { d.cur = p; }
  scheduleRender();
});

function endPointer(ev) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  const d = state.drag; state.drag = null;
  if (!d || !state.doc) return scheduleRender();
  if (d.kind === 'move' && (d.dx || d.dy)) apply({ type: 'move', ids: d.ids, dx: d.dx, dy: d.dy });
  else if (d.kind === 'resize' && d.box) apply({ type: 'resize', id: d.id, box: d.box });
  else if (d.kind === 'rotate' && d.deg !== undefined) apply({ type: 'rotate', id: d.id, deg: d.deg });
  else if (d.kind === 'marquee') {
    const r = normRect(d.start, d.cur);
    if (r.width > 2 || r.height > 2) {
      const ids = state.doc.select(r).map(e => e.id);
      setSelection(d.additive ? [...state.selection, ...ids] : ids);
    }
  } else if (d.kind === 'connect') {
    const hit = state.doc.hitTest(d.cur.x, d.cur.y);
    if (hit && hit.id !== d.from) {
      const id = 'c-' + uid();
      apply({ type: 'add', element: { id, type: 'connector', source: { elementId: d.from }, target: { elementId: hit.id }, routing: 'orthogonal', layer: state.activeLayer } });
      setSelection([id]);
    }
  } else if (d.kind === 'create') {
    let r = normRect(d.start, d.cur);
    if (r.width < 5 && r.height < 5) r = { x: d.start.x, y: d.start.y, width: state.tool === 'text' ? 120 : 100, height: state.tool === 'text' ? 30 : 60 };
    const id = state.tool[0] + '-' + uid();
    const el = { id, type: state.tool, ...r, layer: state.activeLayer, text: state.tool === 'text' ? 'Text' : '' };
    if (state.tool === 'line') { el.width = d.cur.x - d.start.x; el.height = d.cur.y - d.start.y; el.x = d.start.x; el.y = d.start.y; }
    if (state.tool === 'image') { const src = prompt('Image URL'); if (!src) return scheduleRender(); el.src = src; }
    apply({ type: 'add', element: el });
    setSelection([id]);
    setTool('select');
  }
  scheduleRender();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// inline text editing
canvas.addEventListener('dblclick', (ev) => {
  if (state.role === 'viewer') return;
  const p = toWorld(ev.clientX, ev.clientY);
  const hit = state.doc.hitTest(p.x, p.y); if (!hit) return;
  const ta = $('#text-editor'); const z = state.view.zoom;
  Object.assign(ta.style, { left: (hit.x - state.view.x) * z + 'px', top: (hit.y - state.view.y) * z + 'px', width: hit.width * z + 'px', height: hit.height * z + 'px' });
  ta.value = hit.text || ''; ta.classList.remove('hidden'); ta.focus();
  const done = () => { ta.classList.add('hidden'); ta.onblur = null; if (ta.value !== (hit.text || '')) apply({ type: 'update', id: hit.id, patch: { text: ta.value } }); };
  ta.onblur = done;
  ta.onkeydown = (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); ta.blur(); } };
});

// ------------------------------------------------------------------ toolbar / commands
function setTool(t) {
  state.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#btn-undo').addEventListener('click', () => state.doc?.undo());
$('#btn-redo').addEventListener('click', () => state.doc?.redo());

$('#align').addEventListener('change', (e) => {
  const v = e.target.value; e.target.value = '';
  const ids = [...state.selection];
  try {
    if (v === 'dist-h') state.doc.distribute(ids, 'horizontal');
    else if (v === 'dist-v') state.doc.distribute(ids, 'vertical');
    else if (v) state.doc.align(ids, v);
  } catch (err) { flash(err.message); }
});
$('#layout').addEventListener('change', (e) => {
  const v = e.target.value; e.target.value = '';
  try {
    if (v.startsWith('layered')) state.doc.layout('layered', { direction: v.split('-')[1], spacing: 40 });
    else if (v === 'grid') state.doc.layout('grid', { spacing: 40 });
  } catch (err) { flash(err.message); }
});
$('#arrange').addEventListener('change', (e) => {
  const v = e.target.value; e.target.value = '';
  const ids = [...state.selection];
  if (v === 'group') apply({ type: 'group', ids });
  else if (v === 'ungroup') { const gs = new Set(ids.map(id => state.doc.get(id)?.groupId).filter(Boolean)); txn(() => gs.forEach(g => state.doc.apply({ type: 'ungroup', groupId: g }))); }
  else if (v) txn(() => ids.forEach(id => state.doc.apply({ type: 'reorder', id, to: v })));
});

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btn-export-svg').addEventListener('click', () => download(`${state.docId}.svg`, state.doc.toSVG({ padding: 20 }), 'image/svg+xml'));
$('#btn-export-json').addEventListener('click', () => download(`${state.docId}.json`, JSON.stringify(state.doc.toJSON(), null, 2), 'application/json'));
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const text = await f.text();
  try {
    const src = text.trim().startsWith('{') ? fromJSON(text) : importDrawio(text);
    // re-create imported content with fresh ids as one undoable step
    const map = new Map();
    const layer = state.activeLayer;
    txn(() => {
      for (const el of src.elements()) {
        const id = (el.type === 'connector' ? 'c-' : 's-') + uid(); map.set(el.id, id);
        const { z, ...rest } = el; void z;
        const copy = { ...rest, id, layer, groupId: el.groupId ? 'g-' + el.groupId : null };
        if (el.type === 'connector') { copy.source = { ...el.source, elementId: map.get(el.source.elementId) }; copy.target = { ...el.target, elementId: map.get(el.target.elementId) }; }
        state.doc.apply({ type: 'add', element: copy });
      }
    });
    zoomFit();
  } catch (err) { flash('Import failed: ' + err.message); }
});

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (!state.doc || $('#app').classList.contains('hidden')) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const mod = e.ctrlKey || e.metaKey;
  const ids = [...state.selection];
  if (e.key === ' ') { state.spaceDown = true; return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? state.doc.redo() : state.doc.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); state.doc.redo(); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(state.doc.elements().map(x => x.id)); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); state.clipboard = ids.map(id => state.doc.get(id)).filter(Boolean); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(state.clipboard); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); paste(ids.map(id => state.doc.get(id)).filter(Boolean)); return; }
  if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) $('#arrange').value = 'ungroup'; else $('#arrange').value = 'group'; $('#arrange').dispatchEvent(new Event('change')); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    txn(() => { for (const id of ids) if (state.doc.get(id)) state.doc.apply({ type: 'remove', id }); });
    setSelection([]); return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key] && ids.length) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    apply({ type: 'move', ids, dx: arrows[e.key][0] * step, dy: arrows[e.key][1] * step }); return;
  }
  if (e.key === 'Escape') { setSelection([]); setTool('select'); return; }
  if (!mod) {
    const t = { v: 'select', r: 'rect', o: 'ellipse', d: 'diamond', t: 'text', l: 'line', c: 'connector' }[e.key.toLowerCase()];
    if (t) setTool(t);
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') state.spaceDown = false; });

function paste(items) {
  if (!items || !items.length) return;
  const map = new Map(); const newIds = [];
  txn(() => {
    const ordered = [...items.filter(e => e.type !== 'connector'), ...items.filter(e => e.type === 'connector')];
    for (const el of ordered) {
      const id = el.type[0] + '-' + uid(); map.set(el.id, id);
      const { z, ...rest } = el; void z;
      const copy = { ...rest, id, layer: state.doc.getLayer(el.layer) && !state.doc.getLayer(el.layer).locked ? el.layer : state.activeLayer };
      if (el.type === 'connector') {
        const s = map.get(el.source.elementId) ?? el.source.elementId, t = map.get(el.target.elementId) ?? el.target.elementId;
        if (!state.doc.get(s) || !state.doc.get(t)) continue;
        copy.source = { ...el.source, elementId: s }; copy.target = { ...el.target, elementId: t };
        copy.waypoints = (el.waypoints || []).map(p => [p[0] + 20, p[1] + 20]);
      } else { copy.x += 20; copy.y += 20; copy.groupId = el.groupId ? el.groupId + '-copy' : null; }
      state.doc.apply({ type: 'add', element: copy }); newIds.push(id);
    }
  });
  state.clipboard = items.map(e => ({ ...e, x: (e.x || 0) + 20, y: (e.y || 0) + 20 }));
  setSelection(newIds);
}

// ------------------------------------------------------------------ versions
async function loadVersions() {
  const ul = $('#versions'); ul.innerHTML = '';
  let list = [];
  try { list = await api('GET', `/api/docs/${state.docId}/versions`); } catch { return; }
  for (const v of [...list].reverse()) {
    const li = document.createElement('li');
    const s = document.createElement('span'); s.textContent = `${v.label}`; s.title = `${v.createdAt} by ${v.createdBy}`;
    const b = document.createElement('button'); b.textContent = 'Restore';
    b.disabled = state.role === 'viewer';
    b.onclick = async () => { if (confirm(`Restore "${v.label}"?`)) { await api('POST', `/api/docs/${state.docId}/versions/${v.id}/restore`); } };
    li.append(s, b); ul.appendChild(li);
  }
}
$('#btn-save-version').addEventListener('click', async () => {
  const label = prompt('Version label', new Date().toLocaleString()); if (label === null) return;
  await flush();
  await api('POST', `/api/docs/${state.docId}/versions`, { label });
  loadVersions();
});

// ------------------------------------------------------------------ comments
async function loadComments() {
  try { state.comments = await api('GET', `/api/docs/${state.docId}/comments`); } catch { state.comments = []; }
  renderComments();
}
function renderComments() {
  const ul = $('#comments'); ul.innerHTML = '';
  const showResolved = $('#show-resolved').checked;
  for (const c of state.comments) {
    if (c.resolved && !showResolved) continue;
    const li = document.createElement('li'); if (c.resolved) li.className = 'resolved';
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${c.author} on ${c.elementId}`;
    meta.style.cursor = 'pointer'; meta.onclick = () => setSelection([c.elementId]);
    const body = document.createElement('div'); body.textContent = c.text;
    li.append(meta, body);
    for (const r of c.replies || []) { const d = document.createElement('div'); d.className = 'reply'; d.textContent = `${r.author}: ${r.text}`; li.appendChild(d); }
    const reply = document.createElement('button'); reply.textContent = 'Reply';
    reply.onclick = async () => { const t = prompt('Reply'); if (t) { await api('POST', `/api/docs/${state.docId}/comments/${c.id}/replies`, { text: t }); loadComments(); } };
    const res = document.createElement('button'); res.textContent = c.resolved ? 'Reopen' : 'Resolve';
    res.onclick = async () => { await api('POST', `/api/docs/${state.docId}/comments/${c.id}/${c.resolved ? 'reopen' : 'resolve'}`, {}); loadComments(); };
    li.append(reply, res); ul.appendChild(li);
  }
}
$('#show-resolved').addEventListener('change', renderComments);
$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#comment-text').value.trim(); const id = [...state.selection][0];
  if (!text || !id) return flash('Select an element and type a comment');
  await api('POST', `/api/docs/${state.docId}/comments`, { elementId: id, text });
  $('#comment-text').value = ''; loadComments();
});

window.addEventListener('resize', () => applyView());
setStatus(false);
if (state.token) route(); else logout();
