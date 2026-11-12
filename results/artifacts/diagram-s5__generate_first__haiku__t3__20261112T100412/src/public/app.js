import { fromJSON, importDrawio } from '/static/core/index.js';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const GRID = 10;
const TOOLS = { v: 'select', r: 'rect', e: 'ellipse', d: 'diamond', t: 'text', l: 'line', i: 'image', c: 'connector' };

let token = localStorage.getItem('token');
let me = localStorage.getItem('user');

const S = {
  doc: null,
  id: null,
  title: '',
  role: 'viewer',
  actor: '',
  lastSeq: 0,
  ws: null,
  wsTimer: null,
  online: false,
  queue: [],
  sending: false,
  tool: 'select',
  sel: new Set(),
  zoom: 1,
  panX: 0,
  panY: 0,
  drag: null,
  connStart: null,
  spaceDown: false,
  presence: new Map(),
  activeLayer: 'default',
  clipboard: null,
  lastPresence: 0,
  rendering: false,
};

// ------------------------------------------------------------------ http

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const err = new Error(data.message || r.statusText);
    err.status = r.status;
    throw err;
  }
  return data;
}

function status(msg) {
  $('#status').textContent = msg ?? '';
}

function show(name) {
  for (const id of ['login', 'dash', 'editor']) $('#' + id).classList.toggle('hidden', id !== name);
}

// ------------------------------------------------------------------ auth

async function login(username, password) {
  const r = await api('/auth/login', { method: 'POST', body: { username, password } });
  token = r.token;
  me = r.user.username;
  localStorage.setItem('token', token);
  localStorage.setItem('user', me);
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await login(f.username.value, f.password.value);
    route();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#registerBtn').addEventListener('click', async () => {
  const f = $('#loginForm');
  try {
    await api('/auth/register', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
    await login(f.username.value, f.password.value);
    route();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', () => {
  token = null;
  me = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.hash = '';
  route();
});

// ------------------------------------------------------------- dashboard

async function showDash() {
  show('dash');
  $('#whoami').textContent = me ?? '';
  const docs = await api('/docs');
  const ul = $('#docList');
  ul.innerHTML = '';
  for (const d of docs) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#/doc/' + d.id;
    a.textContent = d.title;
    const role = document.createElement('span');
    role.textContent = d.role;
    role.className = 'pill';
    li.append(a, role);
    if (d.role === 'owner') {
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete "${d.title}"?`)) return;
        await api('/docs/' + d.id, { method: 'DELETE' });
        showDash();
      });
      li.append(del);
    }
    ul.append(li);
  }
}

$('#newDocForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = e.target.title.value.trim() || 'Untitled';
  const d = await api('/docs', { method: 'POST', body: { title } });
  location.hash = '#/doc/' + d.id;
});

// ---------------------------------------------------------------- router

async function route() {
  if (!token) {
    closeDoc();
    show('login');
    return;
  }
  const m = /^#\/doc\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  try {
    if (m) await openDoc(m[1]);
    else {
      closeDoc();
      await showDash();
    }
  } catch (err) {
    if (err.status === 401) {
      token = null;
      localStorage.removeItem('token');
      show('login');
      return;
    }
    alert(err.message);
    location.hash = '';
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- document

async function openDoc(id) {
  if (S.id === id && S.doc) return;
  closeDoc();
  const snap = await api(`/docs/${id}`);
  S.id = id;
  S.title = snap.title;
  S.role = snap.role;
  S.lastSeq = snap.seq;
  S.actor = `${me}-${Math.random().toString(36).slice(2, 8)}`;
  S.doc = fromJSON(snap, { actor: S.actor });
  S.sel = new Set();
  show('editor');
  $('#docTitle').textContent = S.title;
  const readOnly = S.role === 'viewer';
  document.querySelectorAll('[data-tool]').forEach((b) => (b.disabled = readOnly && b.dataset.tool !== 'select'));
  await loadVersions();
  await loadComments();
  connectWs();
  render();
  flush();
}

function closeDoc() {
  clearTimeout(S.wsTimer);
  if (S.ws) {
    const ws = S.ws;
    S.ws = null;
    ws.onclose = null;
    ws.close();
  }
  S.doc = null;
  S.id = null;
  S.queue = [];
}

function connectWs() {
  if (!S.id) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/docs/${S.id}?token=${encodeURIComponent(token)}`);
  S.ws = ws;
  ws.onopen = () => setOnline(true);
  ws.onmessage = (ev) => onWsMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setOnline(false);
    S.wsTimer = setTimeout(() => {
      if (S.id) connectWs();
    }, 2000);
  };
}

function setOnline(on) {
  S.online = on;
  const pill = $('#conn');
  pill.textContent = on ? 'online' : 'offline';
  pill.className = 'pill ' + (on ? 'on' : 'off');
  if (on) catchUp().then(flush);
}

async function catchUp() {
  if (!S.id || !S.doc) return;
  try {
    const r = await api(`/docs/${S.id}/ops?since=${S.lastSeq}`);
    S.doc.receive(r.ops);
    S.lastSeq = r.seq;
    render();
  } catch {
    /* offline: retried on reconnect */
  }
}

function onWsMessage(msg) {
  if (!S.doc) return;
  if (msg.type === 'ops') {
    S.doc.receive(msg.ops);
    S.lastSeq = Math.max(S.lastSeq, msg.seq ?? S.lastSeq);
    render();
  } else if (msg.type === 'presence') {
    S.presence.set(msg.actor, { cursor: msg.cursor, selection: msg.selection ?? [], t: Date.now() });
    render();
  } else if (msg.type === 'error') {
    status(msg.message);
  } else if (msg.type === 'hello') {
    S.lastSeq = Math.max(S.lastSeq, msg.seq);
  }
}

async function flush() {
  if (!S.doc) return;
  S.queue.push(...S.doc.pendingOps());
  if (!S.queue.length || S.sending || !S.online || S.role === 'viewer') return;
  S.sending = true;
  const batch = S.queue.slice(0, 200);
  try {
    const r = await api(`/docs/${S.id}/ops`, { method: 'POST', body: { ops: batch } });
    S.queue.splice(0, batch.length);
    S.lastSeq = Math.max(S.lastSeq, r.seq);
  } catch (err) {
    if (err.status === 400 || err.status === 403) {
      S.queue.splice(0, batch.length);
      status(err.message);
    } else {
      setOnline(false);
    }
  } finally {
    S.sending = false;
  }
  if (S.queue.length && S.online) flush();
}

window.addEventListener('online', () => connectWs());

// ------------------------------------------------------------------ act

function act(fn) {
  try {
    fn();
    status('');
  } catch (err) {
    status(err.message);
  }
  pruneSelection();
  render();
  flush();
}

function pruneSelection() {
  if (!S.doc) return;
  for (const id of [...S.sel]) if (!S.doc.get(id)) S.sel.delete(id);
}

let idCounter = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function setTool(t) {
  S.tool = t;
  S.connStart = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

// --------------------------------------------------------------- render

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}

function previewOf(v) {
  const d = S.drag;
  if (!d) return v;
  if (d.type === 'move' && d.ids.includes(v.id)) return { ...v, x: v.x + d.dx, y: v.y + d.dy };
  if (d.type === 'resize' && d.id === v.id) return { ...v, ...d.box };
  if (d.type === 'rotate' && d.id === v.id) return { ...v, rotation: d.rotation };
  return v;
}

function shapeNode(v, parent) {
  const st = v.style ?? {};
  const common = {
    'data-id': v.id,
    fill: st.fill ?? '#ffffff',
    stroke: st.stroke ?? '#333333',
    'stroke-width': st.strokeWidth ?? 1.5,
    opacity: st.opacity,
  };
  const cx = v.x + v.width / 2;
  const cy = v.y + v.height / 2;
  const tr = v.rotation ? `rotate(${v.rotation} ${cx} ${cy})` : null;
  const g = el('g', { transform: tr }, parent);
  switch (v.type) {
    case 'ellipse':
      el('ellipse', { ...common, cx, cy, rx: v.width / 2, ry: v.height / 2 }, g);
      break;
    case 'diamond':
      el('polygon', { ...common, points: `${cx},${v.y} ${v.x + v.width},${cy} ${cx},${v.y + v.height} ${v.x},${cy}` }, g);
      break;
    case 'line':
      el('line', { 'data-id': v.id, x1: v.x, y1: v.y, x2: v.x + v.width, y2: v.y + v.height, stroke: common.stroke, 'stroke-width': common['stroke-width'] }, g);
      break;
    case 'text':
      el('rect', { 'data-id': v.id, x: v.x, y: v.y, width: Math.max(v.width, 20), height: Math.max(v.height, 20), fill: 'transparent' }, g);
      break;
    case 'image':
      el('rect', { ...common, x: v.x, y: v.y, width: v.width, height: v.height, 'stroke-dasharray': '4 3' }, g);
      el('text', { x: cx, y: cy, 'text-anchor': 'middle', 'pointer-events': 'none', fill: '#666' }, g).textContent = '🖼';
      break;
    default:
      el('rect', { ...common, x: v.x, y: v.y, width: v.width, height: v.height }, g);
  }
  if (v.type !== 'text' && v.text) {
    const t = el('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'pointer-events': 'none', 'font-size': st.fontSize ?? 14, fill: st.fontColor ?? '#111' }, g);
    t.textContent = v.text;
  }
  if (v.type === 'text') {
    const t = el('text', { x: v.x, y: v.y + (st.fontSize ?? 14), 'pointer-events': 'none', 'font-size': st.fontSize ?? 14, fill: st.fontColor ?? '#111' }, g);
    t.textContent = v.text;
  }
  return g;
}

function render() {
  if (!S.doc) return;
  const svg = $('#canvas');
  svg.replaceChildren();
  defs();
  const vp = el('g', { transform: `translate(${S.panX} ${S.panY}) scale(${S.zoom})` }, svg);
  const views = S.doc.visibleElements();
  const shapesById = new Map();
  for (const v0 of views) {
    const v = previewOf(v0);
    if (v.type === 'connector') {
      const pts = S.doc.route(v.id).map((p) => p.join(',')).join(' ');
      el('polyline', { 'data-id': v.id, points: pts, fill: 'none', stroke: v.style?.stroke ?? '#333', 'stroke-width': v.style?.strokeWidth ?? 1.5, 'marker-end': 'url(#arrow)' }, vp);
      if (v.label) {
        const pts2 = S.doc.route(v.id);
        const mid = pts2[Math.floor(pts2.length / 2)];
        const t = el('text', { x: mid[0], y: mid[1] - 4, 'text-anchor': 'middle', 'pointer-events': 'none' }, vp);
        t.textContent = v.label;
      }
    } else {
      shapesById.set(v.id, v);
      shapeNode(v, vp);
    }
  }
  // selection outlines and handles
  for (const id of S.sel) {
    const v = previewOf(S.doc.get(id) ?? {});
    if (!v.type || v.type === 'connector') continue;
    const g = el('g', { transform: v.rotation ? `rotate(${v.rotation} ${v.x + v.width / 2} ${v.y + v.height / 2})` : null }, vp);
    el('rect', { x: v.x - 2, y: v.y - 2, width: v.width + 4, height: v.height + 4, fill: 'none', stroke: '#2b6cb0', 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, g);
    el('rect', { 'data-handle': 'resize', x: v.x + v.width - 4, y: v.y + v.height - 4, width: 8, height: 8, fill: '#2b6cb0', cursor: 'nwse-resize' }, g);
    el('line', { x1: v.x + v.width / 2, y1: v.y - 2, x2: v.x + v.width / 2, y2: v.y - 20, stroke: '#2b6cb0', 'pointer-events': 'none' }, g);
    el('circle', { 'data-handle': 'rotate', cx: v.x + v.width / 2, cy: v.y - 22, r: 5, fill: '#fff', stroke: '#2b6cb0', cursor: 'grab' }, g);
  }
  // connector in progress
  if (S.connStart && S.lastPointer) {
    const s = S.doc.get(S.connStart);
    if (s) el('line', { x1: s.x + s.width / 2, y1: s.y + s.height / 2, x2: S.lastPointer.x, y2: S.lastPointer.y, stroke: '#2b6cb0', 'stroke-dasharray': '4 3' }, vp);
  }
  // marquee
  if (S.drag?.type === 'marquee') {
    const { start, cur } = S.drag;
    el('rect', { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), width: Math.abs(cur.x - start.x), height: Math.abs(cur.y - start.y), fill: 'rgba(43,108,176,0.1)', stroke: '#2b6cb0' }, vp);
  }
  // remote presence
  const now = Date.now();
  for (const [actor, p] of S.presence) {
    if (now - p.t > 30000) {
      S.presence.delete(actor);
      continue;
    }
    const color = colorFor(actor);
    for (const id of p.selection ?? []) {
      const v = S.doc.get(id);
      if (v && v.type !== 'connector') el('rect', { x: v.x - 4, y: v.y - 4, width: v.width + 8, height: v.height + 8, fill: 'none', stroke: color, 'stroke-width': 2, 'pointer-events': 'none' }, vp);
    }
    if (p.cursor) {
      el('circle', { cx: p.cursor.x, cy: p.cursor.y, r: 4, fill: color, 'pointer-events': 'none' }, vp);
      const t = el('text', { x: p.cursor.x + 6, y: p.cursor.y + 12, fill: color, 'font-size': 11, 'pointer-events': 'none' }, vp);
      t.textContent = actor;
    }
  }
  renderPanels();
  renderMinimap(views);
}

function colorFor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 40%)`;
}

const defs = () => {
  const svg = $('#canvas');
  const d = el('defs', {}, svg);
  const m = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, d);
  el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#333' }, m);
};

function renderMinimap(views) {
  const mm = $('#minimap');
  mm.replaceChildren();
  const b = S.doc.bounds();
  if (!b || views.length === 0) return;
  const pad = 10;
  const W = 180;
  const H = 120;
  const sc = Math.min((W - 2 * pad) / Math.max(b.width, 1), (H - 2 * pad) / Math.max(b.height, 1));
  const tx = (x) => pad + (x - b.x) * sc;
  const ty = (y) => pad + (y - b.y) * sc;
  for (const v of views) {
    if (v.type === 'connector') continue;
    el('rect', { x: tx(v.x), y: ty(v.y), width: Math.max(2, v.width * sc), height: Math.max(2, v.height * sc), fill: '#999' }, mm);
  }
  const stage = $('#stage').getBoundingClientRect();
  const vx = -S.panX / S.zoom;
  const vy = -S.panY / S.zoom;
  el('rect', { x: tx(vx), y: ty(vy), width: (stage.width / S.zoom) * sc, height: (stage.height / S.zoom) * sc, fill: 'none', stroke: '#2b6cb0' }, mm);
}

function renderPanels() {
  const sel = [...S.sel].map((id) => S.doc.get(id)).filter(Boolean);
  const first = sel.find((v) => v.type !== 'connector');
  const ro = S.role === 'viewer';
  for (const k of ['#pFill', '#pStroke', '#pFont', '#pOpacity', '#pText']) $(k).disabled = ro || !first;
  if (first) {
    $('#pFill').value = toHex(first.style?.fill ?? '#ffffff');
    $('#pStroke').value = toHex(first.style?.stroke ?? '#333333');
    $('#pFont').value = first.style?.fontSize ?? 14;
    $('#pOpacity').value = first.style?.opacity ?? 1;
    $('#pText').value = first.text ?? '';
  }
  renderLayers();
  renderComments();
}

function toHex(c) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ffffff';
}

function renderLayers() {
  const ul = $('#layers');
  ul.replaceChildren();
  for (const l of S.doc.layers()) {
    const li = document.createElement('li');
    const name = document.createElement('a');
    name.textContent = (l.id === S.activeLayer ? '▶ ' : '') + l.name;
    name.href = '#';
    name.addEventListener('click', (e) => {
      e.preventDefault();
      S.activeLayer = l.id;
      render();
    });
    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = l.visible;
    vis.title = 'visible';
    vis.addEventListener('change', () => act(() => S.doc.apply({ type: 'updateLayer', id: l.id, patch: { visible: vis.checked } })));
    const lock = document.createElement('input');
    lock.type = 'checkbox';
    lock.checked = l.locked;
    lock.title = 'locked';
    lock.addEventListener('change', () => act(() => S.doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: lock.checked } })));
    li.append(name, vis, lock);
    if (l.id !== 'default') {
      const del = document.createElement('button');
      del.textContent = '×';
      del.addEventListener('click', () => {
        if (confirm(`Delete layer "${l.name}" and its contents?`)) act(() => S.doc.apply({ type: 'removeLayer', id: l.id }));
      });
      li.append(del);
    }
    ul.append(li);
  }
}

let commentsCache = [];

async function loadComments() {
  if (!S.id) return;
  try {
    commentsCache = await api(`/docs/${S.id}/comments`);
  } catch {
    commentsCache = [];
  }
  renderComments();
}

function renderComments() {
  const ul = $('#comments');
  ul.replaceChildren();
  const selected = new Set([...S.sel]);
  const list = commentsCache.filter((c) => c.parentId === null);
  for (const root of list) {
    const li = document.createElement('li');
    if (root.resolved) li.classList.add('resolved');
    const head = document.createElement('div');
    head.textContent = `${root.author} on ${root.elementId}${selected.has(root.elementId) ? ' (selected)' : ''}: ${root.text}`;
    li.append(head);
    for (const r of commentsCache.filter((c) => c.parentId === root.id)) {
      const reply = document.createElement('div');
      reply.textContent = `↳ ${r.author}: ${r.text}`;
      li.append(reply);
    }
    const actions = document.createElement('div');
    const reply = document.createElement('button');
    reply.textContent = 'Reply';
    reply.addEventListener('click', async () => {
      const text = prompt('Reply');
      if (!text) return;
      await api(`/docs/${S.id}/comments`, { method: 'POST', body: { elementId: root.elementId, text, parentId: root.id } });
      loadComments();
    });
    const resolve = document.createElement('button');
    resolve.textContent = root.resolved ? 'Reopen' : 'Resolve';
    resolve.addEventListener('click', async () => {
      await api(`/docs/${S.id}/comments/${root.id}/resolve`, { method: 'POST', body: { resolved: !root.resolved } });
      loadComments();
    });
    actions.append(reply, resolve);
    li.append(actions);
    ul.append(li);
  }
}

$('#commentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
  const elementId = [...S.sel][0];
  if (!text) return;
  if (!elementId) return status('select an element to comment on');
  await api(`/docs/${S.id}/comments`, { method: 'POST', body: { elementId, text } });
  e.target.text.value = '';
  loadComments();
});

// ------------------------------------------------------------- pointer

function toDoc(e) {
  const r = $('#canvas').getBoundingClientRect();
  return { x: (e.clientX - r.left - S.panX) / S.zoom, y: (e.clientY - r.top - S.panY) / S.zoom };
}

const snapV = (v) => ($('#snapChk').checked ? Math.round(v / GRID) * GRID : v);

function onDown(e) {
  if (!S.doc) return;
  const p = toDoc(e);
  S.lastPointer = p;
  if (e.button === 1 || S.spaceDown) {
    S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY };
    return;
  }
  if (S.tool !== 'select' && S.tool !== 'connector') {
    if (S.role === 'viewer') return status('read-only');
    const type = S.tool;
    const v = {
      id: newId('el-'),
      type,
      x: snapV(p.x),
      y: snapV(p.y),
      width: type === 'line' ? 120 : 120,
      height: type === 'line' ? 0 : 70,
      text: type === 'text' ? 'Text' : type === 'rect' || type === 'ellipse' || type === 'diamond' ? 'Label' : '',
      layer: S.activeLayer,
      style: { fill: '#ffffff', stroke: '#333333' },
    };
    act(() => S.doc.apply({ type: 'add', element: v }));
    S.sel = new Set([v.id]);
    setTool('select');
    render();
    return;
  }
  if (S.tool === 'connector') {
    const hit = S.doc.hitTest(p.x, p.y);
    if (!hit) {
      S.connStart = null;
    } else if (!S.connStart) {
      S.connStart = hit.id;
    } else {
      const id = newId('c-');
      act(() =>
        S.doc.apply({
          type: 'add',
          element: { id, type: 'connector', source: { elementId: S.connStart }, target: { elementId: hit.id }, routing: 'orthogonal', layer: hit.layer, style: { stroke: '#333333' } },
        }),
      );
      S.connStart = null;
      setTool('select');
    }
    render();
    return;
  }
  // select tool
  const handle = e.target.dataset?.handle;
  const selId = [...S.sel][0];
  if (handle && selId && S.sel.size === 1) {
    const v = S.doc.get(selId);
    if (handle === 'resize') S.drag = { type: 'resize', id: v.id, start: p, orig: v, box: { x: v.x, y: v.y, width: v.width, height: v.height } };
    if (handle === 'rotate') {
      const cx = v.x + v.width / 2;
      const cy = v.y + v.height / 2;
      S.drag = { type: 'rotate', id: v.id, cx, cy, base: v.rotation, a0: Math.atan2(p.y - cy, p.x - cx), rotation: v.rotation };
    }
    render();
    return;
  }
  const domId = e.target.closest?.('[data-id]')?.dataset.id;
  const hit = S.doc.hitTest(p.x, p.y);
  const id = hit?.id ?? (domId && S.doc.get(domId)?.type === 'connector' ? domId : null);
  if (id) {
    if (!S.sel.has(id)) {
      if (!e.shiftKey) S.sel.clear();
      S.sel.add(id);
    } else if (e.shiftKey) {
      S.sel.delete(id);
    }
    const ids = [...S.sel].filter((x) => S.doc.get(x)?.type !== 'connector');
    S.drag = { type: 'move', start: p, ids, dx: 0, dy: 0, moved: false };
  } else {
    if (!e.shiftKey) S.sel.clear();
    S.drag = { type: 'marquee', start: p, cur: p };
  }
  render();
  sendPresence();
}

function onMove(e) {
  if (!S.doc) return;
  const p = toDoc(e);
  S.lastPointer = p;
  const d = S.drag;
  if (d?.type === 'pan') {
    S.panX = d.px + (e.clientX - d.sx);
    S.panY = d.py + (e.clientY - d.sy);
  } else if (d?.type === 'move') {
    let dx = p.x - d.start.x;
    let dy = p.y - d.start.y;
    if ($('#snapChk').checked) {
      dx = Math.round(dx / GRID) * GRID;
      dy = Math.round(dy / GRID) * GRID;
    }
    d.dx = dx;
    d.dy = dy;
  } else if (d?.type === 'resize') {
    const w = Math.max(4, d.orig.width + (p.x - d.start.x));
    const h = Math.max(4, d.orig.height + (p.y - d.start.y));
    d.box = { x: d.orig.x, y: d.orig.y, width: w, height: e.shiftKey ? (w * d.orig.height) / Math.max(d.orig.width, 1) : h };
  } else if (d?.type === 'rotate') {
    const a = Math.atan2(p.y - d.cy, p.x - d.cx);
    let deg = d.base + ((a - d.a0) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    d.rotation = deg;
  } else if (d?.type === 'marquee') {
    d.cur = p;
  }
  if (S.connStart || d) render();
  sendPresenceThrottled();
}

function onUp() {
  const d = S.drag;
  S.drag = null;
  if (d?.type === 'move' && (d.dx || d.dy) && d.ids.length) {
    act(() => S.doc.transaction(() => S.doc.apply({ type: 'move', ids: d.ids, dx: d.dx, dy: d.dy })));
  } else if (d?.type === 'resize') {
    act(() => S.doc.apply({ type: 'resize', id: d.id, box: d.box, keepAspect: false }));
  } else if (d?.type === 'rotate') {
    act(() => S.doc.apply({ type: 'rotate', id: d.id, deg: d.rotation }));
  } else if (d?.type === 'marquee') {
    const r = {
      x: Math.min(d.start.x, d.cur.x),
      y: Math.min(d.start.y, d.cur.y),
      width: Math.abs(d.cur.x - d.start.x),
      height: Math.abs(d.cur.y - d.start.y),
    };
    for (const v of S.doc.select(r)) S.sel.add(v.id);
  }
  render();
  sendPresence();
}

function sendPresence() {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.lastPresence = Date.now();
  S.ws.send(JSON.stringify({ type: 'presence', actor: S.actor, cursor: S.lastPointer ?? null, selection: [...S.sel] }));
}

function sendPresenceThrottled() {
  if (Date.now() - S.lastPresence > 100) sendPresence();
}

const canvas = $('#canvas');
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  onDown(e);
});
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const nz = Math.min(8, Math.max(0.1, S.zoom * Math.exp(-e.deltaY * 0.01)));
    S.panX = sx - ((sx - S.panX) * nz) / S.zoom;
    S.panY = sy - ((sy - S.panY) * nz) / S.zoom;
    S.zoom = nz;
  } else {
    S.panX -= e.deltaX;
    S.panY -= e.deltaY;
  }
  render();
}, { passive: false });

// ------------------------------------------------------------- keyboard

function selectedIds() {
  return [...S.sel].filter((id) => S.doc.get(id));
}

function deleteSelection() {
  const ids = selectedIds();
  if (!ids.length) return;
  act(() =>
    S.doc.transaction(() => {
      for (const id of ids) if (S.doc.get(id)) S.doc.apply({ type: 'remove', id });
    }),
  );
  S.sel.clear();
  render();
}

function copySelection() {
  const views = selectedIds().map((id) => S.doc.get(id));
  S.clipboard = JSON.parse(JSON.stringify(views));
}

function pasteClipboard(offset = 20) {
  if (!S.clipboard?.length) return;
  const map = new Map();
  const newSel = [];
  act(() =>
    S.doc.transaction(() => {
      for (const v of S.clipboard.filter((x) => x.type !== 'connector')) {
        const id = newId('el-');
        map.set(v.id, id);
        const { id: _i, type, ...rest } = v;
        S.doc.apply({ type: 'add', element: { ...rest, id, type, x: v.x + offset, y: v.y + offset, layer: S.activeLayer } });
        newSel.push(id);
      }
      for (const v of S.clipboard.filter((x) => x.type === 'connector')) {
        const s = map.get(v.source.elementId);
        const t = map.get(v.target.elementId);
        if (!s || !t) continue;
        const id = newId('c-');
        S.doc.apply({ type: 'add', element: { ...v, id, source: { elementId: s }, target: { elementId: t } } });
        newSel.push(id);
      }
    }),
  );
  S.sel = new Set(newSel.filter((id) => S.doc.get(id)));
  S.clipboard = S.clipboard.map((v) => ({ ...v, x: v.x + offset, y: v.y + offset }));
  render();
}

document.addEventListener('keydown', (e) => {
  if (!S.doc || $('#editor').classList.contains('hidden')) return;
  if (e.target.matches('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') {
    S.spaceDown = true;
    e.preventDefault();
    return;
  }
  if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    e.preventDefault();
    act(() => S.doc.undo());
  } else if (mod && (e.key === 'y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
    e.preventDefault();
    act(() => S.doc.redo());
  } else if (mod && e.key.toLowerCase() === 'c') {
    copySelection();
  } else if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    pasteClipboard();
  } else if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    copySelection();
    pasteClipboard();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelection();
  } else if (e.key.startsWith('Arrow')) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const ids = selectedIds().filter((id) => S.doc.get(id).type !== 'connector');
    if (ids.length) {
      e.preventDefault();
      act(() => S.doc.apply({ type: 'move', ids, dx, dy }));
    }
  } else if (!mod && TOOLS[e.key.toLowerCase()]) {
    setTool(TOOLS[e.key.toLowerCase()]);
  } else if (e.key === 'Escape') {
    S.sel.clear();
    setTool('select');
    render();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') S.spaceDown = false;
});

// ------------------------------------------------------------- toolbar

$('#undoBtn').addEventListener('click', () => act(() => S.doc.undo()));
$('#redoBtn').addEventListener('click', () => act(() => S.doc.redo()));
$('#deleteBtn').addEventListener('click', deleteSelection);
$('#dupBtn').addEventListener('click', () => {
  copySelection();
  pasteClipboard();
});
$('#alignSel').addEventListener('change', (e) => {
  const mode = e.target.value;
  e.target.value = '';
  if (mode) act(() => S.doc.align(selectedIds(), mode));
});
$('#distSel').addEventListener('change', (e) => {
  const dir = e.target.value;
  e.target.value = '';
  if (dir) act(() => S.doc.distribute(selectedIds(), dir));
});
$('#layoutSel').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (!v) return;
  if (v.startsWith('layered:')) act(() => S.doc.layout('layered', { direction: v.split(':')[1] }));
  else act(() => S.doc.layout(v));
});
$('#zoomIn').addEventListener('click', () => {
  S.zoom = Math.min(8, S.zoom * 1.25);
  render();
});
$('#zoomOut').addEventListener('click', () => {
  S.zoom = Math.max(0.1, S.zoom / 1.25);
  render();
});
$('#zoomFit').addEventListener('click', () => {
  const b = S.doc.bounds();
  if (!b) return;
  const r = $('#stage').getBoundingClientRect();
  S.zoom = Math.min(r.width / (b.width + 80), r.height / (b.height + 80), 4);
  S.panX = r.width / 2 - (b.x + b.width / 2) * S.zoom;
  S.panY = r.height / 2 - (b.y + b.height / 2) * S.zoom;
  render();
});

// property panel
function styleChange(style) {
  const ids = selectedIds().filter((id) => S.doc.get(id));
  if (!ids.length) return;
  act(() => S.doc.apply({ type: 'setStyle', ids, style }));
}
$('#pFill').addEventListener('change', (e) => styleChange({ fill: e.target.value }));
$('#pStroke').addEventListener('change', (e) => styleChange({ stroke: e.target.value }));
$('#pFont').addEventListener('change', (e) => styleChange({ fontSize: Number(e.target.value) }));
$('#pOpacity').addEventListener('change', (e) => styleChange({ opacity: Number(e.target.value) }));
$('#pText').addEventListener('change', (e) => {
  const ids = selectedIds().filter((id) => S.doc.get(id).type !== 'connector');
  if (ids.length === 1) act(() => S.doc.apply({ type: 'update', id: ids[0], patch: { text: e.target.value } }));
});

// layers
$('#addLayerBtn').addEventListener('click', () => {
  const name = prompt('Layer name');
  if (!name) return;
  act(() => S.doc.apply({ type: 'addLayer', layer: { id: newId('layer-'), name } }));
});

// io
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const imported = importDrawio(await file.text(), { id: 'import', actor: 'import' });
    const r = await api('/docs', { method: 'POST', body: { title: file.name.replace(/\.(xml|drawio)$/i, '') } });
    const ops = imported.pendingOps();
    if (ops.length) await api(`/docs/${r.id}/ops`, { method: 'POST', body: { ops } });
    location.hash = '#/doc/' + r.id;
  } catch (err) {
    status(err.message);
  }
});

async function download(url, name, type) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const blob = new Blob([await r.text()], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#svgBtn').addEventListener('click', () => download(`/api/docs/${S.id}/export.svg`, `${S.title}.svg`, 'image/svg+xml'));
$('#jsonBtn').addEventListener('click', () => download(`/api/docs/${S.id}/export.json`, `${S.title}.json`, 'application/json'));

// versions
async function loadVersions() {
  if (!S.id) return;
  const list = await api(`/docs/${S.id}/versions`);
  const ul = $('#versions');
  ul.replaceChildren();
  for (const v of list) {
    const li = document.createElement('li');
    li.textContent = `${v.label} · ${new Date(v.createdAt).toLocaleTimeString()}`;
    const btn = document.createElement('button');
    btn.textContent = 'Restore';
    btn.disabled = S.role === 'viewer';
    btn.addEventListener('click', async () => {
      if (!confirm(`Restore "${v.label}"?`)) return;
      try {
        await api(`/docs/${S.id}/versions/${v.id}/restore`, { method: 'POST' });
        await catchUp();
        status('restored');
      } catch (err) {
        status(err.message);
      }
    });
    li.append(btn);
    ul.append(li);
  }
}

$('#saveVersionBtn').addEventListener('click', async () => {
  const label = prompt('Version label', new Date().toLocaleString());
  if (!label) return;
  await flush();
  await api(`/docs/${S.id}/versions`, { method: 'POST', body: { label } });
  loadVersions();
});

$('#backBtn').addEventListener('click', (e) => {
  e.preventDefault();
  location.hash = '';
});

route();
