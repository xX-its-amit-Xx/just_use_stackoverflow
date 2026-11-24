import { createDocument, importDrawio, snap } from '/static/lib/core/index.js';

// ---------- small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const NS = 'http://www.w3.org/2000/svg';
const rid = (p = 'e') => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// ---------- state ----------
const S = {
  token: localStorage.getItem('diagram-s5.token'),
  username: localStorage.getItem('diagram-s5.user'),
  docId: null,
  doc: null,
  actor: '',
  role: 'viewer',
  seq: 0,
  ws: null,
  wsRetry: 0,
  queue: [],
  inflight: 0,
  selection: new Set(),
  tool: 'select',
  activeLayer: 'default',
  view: { x: 40, y: 40, k: 1 },
  drag: null,
  spaceDown: false,
  remote: new Map(),
  clipboard: null,
  connFrom: null,
  snapGrid: false,
  presenceTimer: null,
  lastCursor: null,
};

const GRID = 10;
const storageKey = () => `diagram-s5.queue.${S.docId}`;

// ---------- API ----------
async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && S.token && path !== '/auth/login') {
    logout();
    throw new Error('Session expired, please log in again');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.message) || res.statusText);
  return data;
}

// ---------- screens ----------
function show(name) {
  for (const id of ['auth', 'home', 'editor']) $(`#${id}`).classList.toggle('hidden', id !== name);
}

function setAuthMsg(msg) { $('#auth-msg').textContent = msg; }

async function login(username, password) {
  const r = await api('POST', '/auth/login', { username, password });
  S.token = r.token;
  S.username = r.user.username;
  localStorage.setItem('diagram-s5.token', S.token);
  localStorage.setItem('diagram-s5.user', S.username);
}

function logout() {
  S.token = null;
  S.username = null;
  localStorage.removeItem('diagram-s5.token');
  localStorage.removeItem('diagram-s5.user');
  disconnect();
  location.hash = '';
  showAuth();
}

function showAuth() { show('auth'); }

async function showHome() {
  disconnect();
  show('home');
  $('#whoami').textContent = `Signed in as ${S.username}`;
  const list = await api('GET', '/docs');
  const ul = $('#doc-list');
  ul.innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li');
    li.innerHTML = `<a href="#doc/${esc(d.id)}">${esc(d.title)}</a><span class="status">${esc(d.role)}</span>`;
    ul.appendChild(li);
  }
  if (!list.length) ul.innerHTML = '<li>No diagrams yet.</li>';
}

// ---------- routing ----------
async function route() {
  if (!S.token) return showAuth();
  const m = location.hash.match(/^#doc\/([A-Za-z0-9_-]+)$/);
  if (m) {
    if (S.docId !== m[1]) await openDoc(m[1]);
    else show('editor');
  } else {
    await showHome();
  }
}

// ---------- document sync ----------
async function openDoc(id) {
  disconnect();
  S.docId = id;
  S.actor = `${S.username}-${rid('s')}`;
  S.doc = createDocument({ id, actor: S.actor });
  S.selection = new Set();
  S.remote.clear();
  S.queue = JSON.parse(localStorage.getItem(storageKey()) || '[]');
  S.seq = 0;
  try {
    const meta = await api('GET', `/docs/${id}`);
    S.role = meta.role;
    $('#doc-title').textContent = meta.title;
    await pullOps();
  } catch (err) {
    setFooter(err.message);
    location.hash = '';
    return showHome();
  }
  show('editor');
  connect();
  refreshAll();
  $('#editor').classList.toggle('readonly', S.role === 'viewer');
}

async function pullOps() {
  const r = await api('GET', `/docs/${S.docId}/ops?since=${S.seq}`);
  if (r.ops.length) S.doc.receive(r.ops);
  S.seq = r.seq;
}

function connect() {
  if (!S.docId) return;
  S.wantWS = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/docs/${S.docId}?token=${encodeURIComponent(S.token)}`);
  S.ws = ws;
  ws.onopen = async () => {
    S.wsRetry = 0;
    setConn(true);
    try { await pullOps(); } catch { /* retried on next message */ }
    flush();
    refreshAll();
  };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    if (S.ws === ws) S.ws = null;
    if (!S.wantWS) return;
    setConn(false);
    S.inflight = 0;
    const delay = Math.min(10000, 500 * 2 ** S.wsRetry++);
    setTimeout(() => { if (S.wantWS && !S.ws) connect(); }, delay);
  };
}

function disconnect() {
  S.wantWS = false;
  const ws = S.ws;
  S.ws = null;
  if (ws) try { ws.close(); } catch { /* ignore */ }
  setConn(false);
}

function setConn(online) {
  const el = $('#conn-status');
  el.textContent = online ? 'online' : 'offline';
  el.className = `status ${online ? 'online' : 'offline'}`;
  updateFooter();
}

async function onMessage(msg) {
  if (msg.type === 'ops') {
    try {
      S.doc.receive(msg.ops);
      if (msg.seq - msg.ops.length === S.seq) S.seq = msg.seq;
      else await pullOps();
    } catch (err) {
      setFooter(`sync error: ${err.message}`);
    }
    refreshAll();
  } else if (msg.type === 'ack') {
    S.queue.splice(0, S.inflight);
    S.inflight = 0;
    saveQueue();
    S.seq = Math.max(S.seq, msg.seq);
    updateFooter();
  } else if (msg.type === 'error') {
    S.queue.splice(0, S.inflight);
    S.inflight = 0;
    saveQueue();
    setFooter(`server rejected changes: ${msg.message}`);
    updateFooter();
  } else if (msg.type === 'presence') {
    S.remote.set(msg.actor, { cursor: msg.cursor, selection: msg.selection || [], at: Date.now() });
    renderOverlay();
  }
}

function saveQueue() {
  localStorage.setItem(storageKey(), JSON.stringify(S.queue));
}

// Collect local ops produced since the last flush and send them (or keep them queued offline).
function flush() {
  if (!S.doc) return;
  const ops = S.doc.pendingOps();
  if (ops.length) S.queue.push(...ops);
  saveQueue();
  sendQueue();
  updateFooter();
}

function sendQueue() {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN || S.inflight > 0 || !S.queue.length) return;
  S.inflight = S.queue.length;
  S.ws.send(JSON.stringify({ type: 'ops', ops: S.queue.slice() }));
}

// ---------- rendering ----------
const content = () => $('#content');
const overlay = () => $('#overlay');

function refreshAll() {
  if (!S.doc) return;
  renderLayers();
  renderContent();
  renderOverlay();
  renderProps();
  if (!$('#tab-comments').classList.contains('hidden')) renderComments();
  if (!$('#tab-versions').classList.contains('hidden')) renderVersions();
  renderMinimap();
  updateFooter();
}

function visibleLayerIds() {
  return new Set(S.doc.layers().filter(l => l.visible).map(l => l.id));
}

function displayOf(el) {
  const p = S.drag;
  if (!p || !S.selection.has(el.id)) return el;
  if (p.mode === 'move') return { ...el, x: el.x + p.dx, y: el.y + p.dy };
  if (p.mode === 'resize' && p.id === el.id) return { ...el, ...p.box };
  if (p.mode === 'rotate' && p.id === el.id) return { ...el, rotation: p.deg };
  return el;
}

function shapeNode(el) {
  const st = el.style || {};
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const common = {
    'data-id': el.id,
    fill: st.fill ?? (el.type === 'text' ? 'none' : '#ffffff'),
    stroke: st.stroke ?? (el.type === 'text' ? 'none' : '#333333'),
    'stroke-width': st.strokeWidth ?? 1.5,
  };
  if (st.opacity !== undefined) common.opacity = st.opacity;
  const tr = el.rotation ? `rotate(${el.rotation} ${cx} ${cy})` : null;
  let node;
  switch (el.type) {
    case 'ellipse': node = svg('ellipse', { ...common, cx, cy, rx: el.width / 2, ry: el.height / 2 }); break;
    case 'diamond': node = svg('polygon', { ...common, points: `${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}` }); break;
    case 'line': node = svg('line', { ...common, x1: el.x, y1: el.y, x2: el.x + el.width, y2: el.y + el.height }); break;
    case 'text': node = svg('rect', { ...common, x: el.x, y: el.y, width: el.width, height: el.height, fill: 'transparent', stroke: 'transparent' }); break;
    default: node = svg('rect', { ...common, x: el.x, y: el.y, width: el.width, height: el.height });
  }
  if (tr) node.setAttribute('transform', tr);
  const g = svg('g', { 'data-id': el.id, class: 'shape' });
  g.appendChild(node);
  if (el.text) g.appendChild(textNode(el.text, cx, cy, st, tr));
  return g;
}

function textNode(text, cx, cy, st, transform) {
  const size = st.fontSize ?? 14;
  const t = svg('text', {
    x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'font-size': size, fill: st.fontColor ?? '#111', 'pointer-events': 'none',
  });
  if (transform) t.setAttribute('transform', transform);
  String(text).split('\n').forEach((line, i) => {
    const ts = svg('tspan', { x: cx, dy: i === 0 ? 0 : size * 1.2 });
    ts.textContent = line;
    t.appendChild(ts);
  });
  return t;
}

function connectorNode(c) {
  const pts = S.doc.route(c.id);
  const st = c.style || {};
  const g = svg('g', { 'data-id': c.id, class: 'connector' });
  g.appendChild(svg('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': 10 }));
  g.appendChild(svg('polyline', {
    points: pts.map(p => p.join(',')).join(' '), fill: 'none',
    stroke: st.stroke ?? '#333', 'stroke-width': st.strokeWidth ?? 1.5, 'marker-end': 'url(#arrow)',
  }));
  if (c.label) {
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    g.appendChild(textNode(c.label, mid[0], mid[1] - 8, st, null));
  }
  return g;
}

function renderContent() {
  const vis = visibleLayerIds();
  const els = S.doc.elements().filter(e => vis.has(e.layer));
  const frag = document.createDocumentFragment();
  for (const el of els) {
    const d = displayOf(el);
    frag.appendChild(d.type === 'connector' ? connectorNode(el) : shapeNode(d));
  }
  const c = content();
  c.replaceChildren(frag);
  c.setAttribute('transform', `translate(${S.view.x} ${S.view.y}) scale(${S.view.k})`);
  $('#zoom-label').textContent = `${Math.round(S.view.k * 100)}%`;
  for (const g of $$('#content [data-id]')) {
    if (S.selection.has(g.dataset.id)) g.classList.add('selected');
  }
}

function selectionBox() {
  const ids = [...S.selection].filter(id => S.doc.get(id));
  if (!ids.length) return null;
  const b = S.doc.bounds(ids);
  if (!b) return null;
  const p = S.drag;
  if (p && p.mode === 'move') return { ...b, x: b.x + p.dx, y: b.y + p.dy };
  if (p && p.mode === 'resize') return p.box;
  return b;
}

function renderOverlay() {
  const o = overlay();
  o.replaceChildren();
  if (!S.doc) return;
  const k = S.view.k;
  const t = `translate(${S.view.x} ${S.view.y}) scale(${k})`;
  // World-coordinate overlay items live in a group carrying the view transform.
  const g = svg('g', { transform: t });
  o.appendChild(g);
  const box = selectionBox();
  if (box) {
    g.appendChild(svg('rect', { class: 'sel-box', x: box.x, y: box.y, width: box.width, height: box.height, 'pointer-events': 'none' }));
    const s = 8 / k;
    const handles = { nw: [box.x, box.y], n: [box.x + box.width / 2, box.y], ne: [box.x + box.width, box.y], e: [box.x + box.width, box.y + box.height / 2], se: [box.x + box.width, box.y + box.height], s: [box.x + box.width / 2, box.y + box.height], sw: [box.x, box.y + box.height], w: [box.x, box.y + box.height / 2] };
    const single = S.selection.size === 1 && !S.doc.get([...S.selection][0])?.type?.includes('connector');
    if (single) {
      for (const [name, [hx, hy]] of Object.entries(handles)) {
        g.appendChild(svg('rect', { class: 'handle', 'data-handle': name, x: hx - s / 2, y: hy - s / 2, width: s, height: s, 'stroke-width': 1 / k, style: `cursor:${name}-resize` }));
      }
      const rotY = box.y - 24 / k;
      g.appendChild(svg('line', { x1: box.x + box.width / 2, y1: box.y, x2: box.x + box.width / 2, y2: rotY, stroke: '#3b6fd8', 'stroke-width': 1 / k }));
      g.appendChild(svg('circle', { class: 'handle', 'data-handle': 'rotate', cx: box.x + box.width / 2, cy: rotY, r: 5 / k, 'stroke-width': 1 / k }));
    }
  }
  const guides = S.drag && S.drag.guides;
  if (guides) {
    for (const x of guides.x) g.appendChild(svg('line', { class: 'guide', x1: x, y1: -1e6, x2: x, y2: 1e6 }));
    for (const y of guides.y) g.appendChild(svg('line', { class: 'guide', x1: -1e6, y1: y, x2: 1e6, y2: y }));
  }
  if (S.drag && S.drag.mode === 'marquee') {
    const r = S.drag.rect;
    g.appendChild(svg('rect', { class: 'marquee', x: r.x, y: r.y, width: r.width, height: r.height }));
  }
  if (S.drag && S.drag.mode === 'connector-preview') {
    g.appendChild(svg('line', { x1: S.drag.from[0], y1: S.drag.from[1], x2: S.drag.to[0], y2: S.drag.to[1], stroke: '#3b6fd8', 'stroke-dasharray': '4 3' }));
  }
  // Remote collaborators: selections in world space, cursors in screen space.
  const now = Date.now();
  for (const [actor, r] of S.remote) {
    if (now - r.at > 60000) { S.remote.delete(actor); continue; }
    for (const id of r.selection || []) {
      const el = S.doc.get(id);
      if (!el) continue;
      g.appendChild(svg('rect', { x: el.x - 2, y: el.y - 2, width: el.width + 4, height: el.height + 4, fill: 'none', stroke: colorFor(actor), 'stroke-width': 2 / k, 'stroke-dasharray': '3 2' }));
    }
    if (r.cursor) {
      const x = S.view.x + r.cursor.x * k;
      const y = S.view.y + r.cursor.y * k;
      const grp = svg('g', { class: 'remote-cursor', transform: `translate(${x} ${y})` });
      grp.appendChild(svg('path', { d: 'M0,0 L0,14 L4,10 L7,16 L9,15 L6,9 L11,9 z', fill: colorFor(actor) }));
      const label = svg('text', { x: 14, y: 12 });
      label.textContent = actor;
      grp.appendChild(svg('rect', { x: 10, y: 0, width: 6 * actor.length + 8, height: 14, rx: 3, fill: colorFor(actor), stroke: 'none' }));
      grp.appendChild(label);
      o.appendChild(grp);
    }
  }
}

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 45%)`;
}

function renderLayers() {
  const ul = $('#layers');
  ul.innerHTML = '';
  const layers = S.doc.layers().slice().reverse();
  if (!layers.find(l => l.id === S.activeLayer)) S.activeLayer = layers[0]?.id ?? 'default';
  for (const l of layers) {
    const li = document.createElement('li');
    if (l.id === S.activeLayer) li.classList.add('active');
    li.dataset.layer = l.id;
    li.innerHTML = `<input type="checkbox" data-act="vis" ${l.visible ? 'checked' : ''} title="Visible">` +
      `<input type="checkbox" data-act="lock" ${l.locked ? 'checked' : ''} title="Locked">` +
      `<span class="name" data-act="rename" title="Double-click to rename">${esc(l.name)}</span>` +
      `<button data-act="remove" title="Remove layer">×</button>`;
    ul.appendChild(li);
  }
}

function renderProps() {
  const host = $('#tab-props');
  const ids = [...S.selection].filter(id => S.doc.get(id));
  if (!ids.length) {
    host.innerHTML = `<p class="status">Select an element to edit its properties. Active layer: ${esc(S.activeLayer)}.</p>`;
    return;
  }
  const els = ids.map(id => S.doc.get(id));
  const first = els[0];
  const isConn = first.type === 'connector';
  const st = first.style || {};
  const val = (k, d) => (els.every(e => e.style?.[k] === st[k]) && st[k] !== undefined ? st[k] : d);
  const rot = !isConn && els.length === 1 ? first.rotation : 0;
  const html = `
    <div class="prop-group"><strong>${els.length} selected · ${esc(first.type)}</strong></div>
    ${isConn ? `
      <label>Routing <select data-prop="routing">
        <option value="straight" ${first.routing === 'straight' ? 'selected' : ''}>straight</option>
        <option value="orthogonal" ${first.routing === 'orthogonal' ? 'selected' : ''}>orthogonal</option>
      </select></label>
      <label>Label <input type="text" data-prop="label" value="${esc(first.label || '')}"></label>
    ` : `
      <label>Text <textarea data-prop="text" rows="2">${esc(first.text || '')}</textarea></label>
      <label>Rotation° <input type="number" data-prop="rotation" value="${rot}"></label>
    `}
    <div class="prop-group">
      <label>Fill <input type="color" data-style="fill" value="${toHex(val('fill', '#ffffff'))}"></label>
      <label>Stroke <input type="color" data-style="stroke" value="${toHex(val('stroke', '#333333'))}"></label>
      <label>Stroke width <input type="number" min="0" step="0.5" data-style="strokeWidth" value="${val('strokeWidth', 1.5)}"></label>
      <label>Font size <input type="number" min="6" data-style="fontSize" value="${val('fontSize', 14)}"></label>
      <label>Font color <input type="color" data-style="fontColor" value="${toHex(val('fontColor', '#111111'))}"></label>
      <label>Opacity <input type="number" min="0" max="1" step="0.05" data-style="opacity" value="${val('opacity', 1)}"></label>
    </div>
    <div class="prop-group">
      <label>Layer <select data-prop="layer">${S.doc.layers().map(l => `<option value="${esc(l.id)}" ${first.layer === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <div class="row" style="flex-wrap:wrap">
        <button data-cmd="group">Group</button><button data-cmd="ungroup">Ungroup</button>
        <button data-cmd="front">Front</button><button data-cmd="forward">Forward</button>
        <button data-cmd="backward">Backward</button><button data-cmd="back">Back</button>
        <button data-cmd="delete">Delete</button>
      </div>
    </div>`;
  host.innerHTML = html;
}

function toHex(c) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return c;
  return '#000000';
}

function renderComments() {
  const ul = $('#comment-list');
  ul.innerHTML = '';
  if (!S.docId) return;
  api('GET', `/docs/${S.docId}/comments`).then(threads => {
    const sel = [...S.selection];
    const shown = sel.length ? threads.filter(t => sel.includes(t.elementId)) : threads;
    if (!shown.length) { ul.innerHTML = '<li class="status">No comments.</li>'; return; }
    ul.innerHTML = shown.map(t => `
      <li class="comment ${t.resolved ? 'resolved' : ''}" data-cid="${esc(t.id)}">
        <div><strong>${esc(t.author)}</strong> <span class="status">on ${esc(t.elementId)}</span></div>
        <div>${esc(t.body)}</div>
        <div class="row">
          <button data-cact="reply">Reply</button>
          <button data-cact="resolve">${t.resolved ? 'Reopen' : 'Resolve'}</button>
        </div>
        ${t.replies.map(r => `<div class="reply"><strong>${esc(r.author)}</strong>: ${esc(r.body)}</div>`).join('')}
      </li>`).join('');
  }).catch(err => { ul.innerHTML = `<li class="msg">${esc(err.message)}</li>`; });
}

function renderVersions() {
  if (!S.docId) return;
  api('GET', `/docs/${S.docId}/versions`).then(list => {
    const ul = $('#version-list');
    ul.innerHTML = list.length ? list.map(v => `
      <li class="version"><span>${esc(v.label)} <span class="status">${esc(new Date(v.createdAt).toLocaleString())}</span></span>
      <button data-vid="${esc(v.id)}" data-vact="restore" ${S.role === 'viewer' ? 'disabled' : ''}>Restore</button></li>`).join('')
      : '<li class="status">No versions yet.</li>';
  }).catch(() => {});
}

function renderMinimap() {
  const mm = $('#minimap');
  mm.replaceChildren();
  const b = S.doc.bounds() || { x: 0, y: 0, width: 400, height: 300 };
  const pad = 40;
  const vb = { x: b.x - pad, y: b.y - pad, w: b.width + 2 * pad, h: b.height + 2 * pad };
  mm.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const vis = visibleLayerIds();
  for (const el of S.doc.elements()) {
    if (!vis.has(el.layer) || el.type === 'connector') continue;
    mm.appendChild(svg('rect', { x: el.x, y: el.y, width: el.width, height: el.height, fill: '#cfd8ea', stroke: '#8895b5', 'stroke-width': vb.w / 180 }));
  }
  const wrap = $('#canvas-wrap').getBoundingClientRect();
  const vx = -S.view.x / S.view.k, vy = -S.view.y / S.view.k;
  mm.appendChild(svg('rect', { x: vx, y: vy, width: wrap.width / S.view.k, height: wrap.height / S.view.k, fill: 'rgba(59,111,216,0.1)', stroke: '#3b6fd8', 'stroke-width': vb.w / 150 }));
}

function updateFooter() {
  const sync = S.queue.length ? `${S.queue.length} change(s) queued` : 'all changes synced';
  const role = S.role ? ` · role: ${S.role}` : '';
  $('#footer').textContent = `${sync}${role} · ${S.doc ? S.doc.elements().length : 0} elements · ${S.doc ? S.doc.layers().length : 0} layers`;
}

function setFooter(msg) { $('#footer').textContent = msg; }

// ---------- coordinates / view ----------
function toWorld(e) {
  const r = $('#canvas').getBoundingClientRect();
  return { x: (e.clientX - r.left - S.view.x) / S.view.k, y: (e.clientY - r.top - S.view.y) / S.view.k, sx: e.clientX - r.left, sy: e.clientY - r.top };
}

function zoomAt(sx, sy, factor) {
  const k = Math.min(8, Math.max(0.1, S.view.k * factor));
  const wx = (sx - S.view.x) / S.view.k;
  const wy = (sy - S.view.y) / S.view.k;
  S.view = { x: sx - wx * k, y: sy - wy * k, k };
  renderContent();
  renderOverlay();
  renderMinimap();
}

function fitView() {
  const b = S.doc.bounds();
  const r = $('#canvas').getBoundingClientRect();
  if (!b) { S.view = { x: 40, y: 40, k: 1 }; }
  else {
    const k = Math.min(4, Math.min((r.width - 80) / Math.max(b.width, 1), (r.height - 80) / Math.max(b.height, 1)));
    S.view = { k, x: 40 - b.x * k + ((r.width - 80) - b.width * k) / 2, y: 40 - b.y * k + ((r.height - 80) - b.height * k) / 2 };
  }
  refreshAll();
}

// ---------- commands ----------
function run(fn) {
  try {
    fn();
  } catch (err) {
    setFooter(err.message);
  }
  flush();
  refreshAll();
}

function removeSelection() {
  const ids = [...S.selection];
  if (!ids.length) return;
  run(() => S.doc.transaction(() => { for (const id of ids) if (S.doc.get(id)) S.doc.apply({ type: 'remove', id }); }));
  S.selection.clear();
}

function copySelection() {
  const ids = new Set(S.selection);
  const els = S.doc.elements().filter(e => ids.has(e.id));
  S.clipboard = els;
}

function pasteClipboard(offset = 20) {
  if (!S.clipboard || !S.clipboard.length) return;
  const map = new Map();
  for (const el of S.clipboard) if (el.type !== 'connector') map.set(el.id, rid('e'));
  const newSel = new Set();
  run(() => S.doc.transaction(() => {
    for (const el of S.clipboard) {
      if (el.type === 'connector') continue;
      const id = map.get(el.id);
      const copy = { ...el, id, x: el.x + offset, y: el.y + offset, layer: S.doc.getLayer(el.layer) ? el.layer : S.activeLayer };
      delete copy.groupId;
      S.doc.apply({ type: 'add', element: copy });
      newSel.add(id);
    }
    for (const el of S.clipboard) {
      if (el.type !== 'connector') continue;
      const s = map.get(el.source.elementId), t = map.get(el.target.elementId);
      if (!s || !t) continue;
      S.doc.apply({ type: 'add', element: { ...el, id: rid('c'), source: { elementId: s }, target: { elementId: t }, layer: S.activeLayer } });
    }
  }));
  S.selection = newSel;
  refreshAll();
}

function alignSelection(mode) {
  run(() => S.doc.align([...S.selection], mode));
}

function nudge(dx, dy) {
  if (!S.selection.size) return;
  run(() => S.doc.apply({ type: 'move', ids: [...S.selection], dx, dy }));
}

function addShape(type, box) {
  const id = rid('e');
  const defaults = { rect: [120, 80], ellipse: [120, 80], diamond: [120, 90], text: [140, 32], line: [120, 0] }[type] || [120, 80];
  const w = box && box.width >= 4 ? box.width : defaults[0];
  const h = box && box.height >= 4 ? box.height : defaults[1];
  const x = box ? box.x : 100;
  const y = box ? box.y : 100;
  const el = { id, type, x, y, width: w, height: h, layer: S.activeLayer, text: type === 'text' ? 'Text' : '', style: type === 'text' ? { fill: 'none', stroke: 'none' } : {} };
  run(() => S.doc.apply({ type: 'add', element: el }));
  S.selection = new Set([id]);
  return id;
}

function groupSelection() {
  if (S.selection.size < 2) return;
  run(() => S.doc.apply({ type: 'group', ids: [...S.selection] }));
}

function ungroupSelection() {
  const el = [...S.selection].map(id => S.doc.get(id)).find(e => e?.groupId);
  if (el) run(() => S.doc.apply({ type: 'ungroup', groupId: el.groupId }));
}

function reorderSelection(to) {
  run(() => S.doc.transaction(() => { for (const id of S.selection) S.doc.apply({ type: 'reorder', id, to }); }));
}

function setStyleOnSelection(key, value) {
  run(() => S.doc.apply({ type: 'setStyle', ids: [...S.selection], style: { [key]: value } }));
}

// ---------- pointer interaction ----------
function handleOf(target) {
  return target && target.dataset && target.dataset.handle ? target.dataset.handle : null;
}

function startDrag(e) {
  const w = toWorld(e);
  const handle = handleOf(e.target);
  if (S.spaceDown || e.button === 1) {
    S.drag = { mode: 'pan', sx: w.sx, sy: w.sy, vx: S.view.x, vy: S.view.y };
    return;
  }
  if (handle && S.selection.size === 1) {
    const id = [...S.selection][0];
    const el = S.doc.get(id);
    if (handle === 'rotate') {
      const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
      S.drag = { mode: 'rotate', id, cx, cy, deg: el.rotation };
    } else {
      S.drag = { mode: 'resize', id, handle, start: { ...el }, box: { x: el.x, y: el.y, width: el.width, height: el.height }, wx: w.x, wy: w.y };
    }
    return;
  }
  if (S.tool === 'connector') {
    const hit = e.target.closest('[data-id]');
    if (!hit || S.doc.get(hit.dataset.id)?.type === 'connector') {
      S.connFrom = null;
      S.drag = null;
      return;
    }
    if (!S.connFrom) {
      S.connFrom = hit.dataset.id;
      S.drag = { mode: 'connector-preview', from: [w.x, w.y], to: [w.x, w.y] };
    } else if (S.connFrom !== hit.dataset.id) {
      const from = S.connFrom;
      S.connFrom = null;
      S.drag = null;
      run(() => S.doc.apply({ type: 'add', element: { id: rid('c'), type: 'connector', source: { elementId: from }, target: { elementId: hit.dataset.id }, routing: 'straight', layer: S.activeLayer } }));
    }
    return;
  }
  if (['rect', 'ellipse', 'diamond', 'text', 'line'].includes(S.tool)) {
    S.drag = { mode: 'create', type: S.tool, start: { x: w.x, y: w.y }, cur: { x: w.x, y: w.y } };
    return;
  }
  const hit = e.target.closest('[data-id]');
  if (hit) {
    const id = hit.dataset.id;
    if (e.shiftKey) {
      if (S.selection.has(id)) S.selection.delete(id); else S.selection.add(id);
    } else if (!S.selection.has(id)) {
      S.selection = new Set([id]);
    }
    if (S.selection.has(id) && S.doc.get(id)) {
      S.activeLayer = S.doc.get(id).layer;
      S.drag = { mode: 'move', startX: w.x, startY: w.y, dx: 0, dy: 0, guides: null };
    }
    refreshAll();
    return;
  }
  if (!e.shiftKey) S.selection = new Set();
  S.drag = { mode: 'marquee', start: { x: w.x, y: w.y }, rect: { x: w.x, y: w.y, width: 0, height: 0 }, base: new Set(S.selection) };
  refreshAll();
}

function moveDrag(e) {
  const d = S.drag;
  const w = toWorld(e);
  maybePresence(w);
  if (!d) {
    if (S.connFrom) {
      S.drag = { mode: 'connector-preview', from: centerOfId(S.connFrom), to: [w.x, w.y] };
      renderOverlay();
    }
    return;
  }
  if (d.mode === 'pan') {
    S.view.x = d.vx + (w.sx - d.sx);
    S.view.y = d.vy + (w.sy - d.sy);
    renderContent(); renderOverlay(); renderMinimap();
    return;
  }
  if (d.mode === 'move') {
    let dx = w.x - d.startX, dy = w.y - d.startY;
    const box = S.doc.bounds([...S.selection]);
    const tol = 6 / S.view.k;
    const guides = guideCandidates([...S.selection]);
    const { x: gx, y: gy } = snapDelta(box, dx, dy, guides, tol);
    dx = gx.dx; dy = gy.dy;
    if (S.snapGrid) {
      const sx = snap({ x: box.x + dx, y: box.y + dy }, { grid: GRID }).x - box.x;
      const sy = snap({ x: box.x + dx, y: box.y + dy }, { grid: GRID }).y - box.y;
      if (!gx.hit) dx = sx;
      if (!gy.hit) dy = sy;
    }
    d.dx = dx; d.dy = dy;
    d.guides = { x: gx.hit ? [gx.hit] : [], y: gy.hit ? [gy.hit] : [] };
    renderContent(); renderOverlay();
  } else if (d.mode === 'resize') {
    const dx = w.x - d.wx, dy = w.y - d.wy;
    const s = d.start;
    let { x, y, width, height } = s;
    const h = d.handle;
    if (h.includes('e')) width = Math.max(1, s.width + dx);
    if (h.includes('s')) height = Math.max(1, s.height + dy);
    if (h.includes('w')) { width = Math.max(1, s.width - dx); x = s.x + s.width - width; }
    if (h.includes('n')) { height = Math.max(1, s.height - dy); y = s.y + s.height - height; }
    if (e.shiftKey && s.width && s.height) {
      const r = s.width / s.height;
      if (Math.abs(width / s.width) > Math.abs(height / s.height)) height = width / r; else width = height * r;
    }
    d.box = { x, y, width, height };
    renderContent(); renderOverlay();
  } else if (d.mode === 'rotate') {
    const deg = (Math.atan2(w.y - d.cy, w.x - d.cx) * 180) / Math.PI + 90;
    d.deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg);
    renderContent(); renderOverlay();
  } else if (d.mode === 'marquee') {
    const x = Math.min(d.start.x, w.x), y = Math.min(d.start.y, w.y);
    d.rect = { x, y, width: Math.abs(w.x - d.start.x), height: Math.abs(w.y - d.start.y) };
    renderOverlay();
  } else if (d.mode === 'create') {
    d.cur = { x: w.x, y: w.y };
    renderOverlay();
  } else if (d.mode === 'connector-preview') {
    d.to = [w.x, w.y];
    renderOverlay();
  }
}

function endDrag(e) {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.mode === 'pan') { refreshAll(); return; }
  if (d.mode === 'move') {
    if (Math.abs(d.dx) + Math.abs(d.dy) > 0.01) {
      run(() => S.doc.apply({ type: 'move', ids: [...S.selection], dx: d.dx, dy: d.dy }));
    } else refreshAll();
  } else if (d.mode === 'resize') {
    const b = d.box;
    run(() => S.doc.apply({ type: 'resize', id: d.id, box: b, keepAspect: !!e.shiftKey }));
  } else if (d.mode === 'rotate') {
    run(() => S.doc.apply({ type: 'rotate', id: d.id, deg: d.deg }));
  } else if (d.mode === 'marquee') {
    const found = S.doc.select(d.rect).map(el => el.id);
    S.selection = new Set([...d.base, ...found]);
    refreshAll();
  } else if (d.mode === 'create') {
    const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
    const box = { x, y, width: Math.abs(d.cur.x - d.start.x), height: Math.abs(d.cur.y - d.start.y) };
    addShape(d.type, box);
    S.tool = 'select';
    setTool('select');
  } else if (d.mode === 'connector-preview') {
    refreshAll();
  }
}

function centerOfId(id) {
  const el = S.doc.get(id);
  return el ? [el.x + el.width / 2, el.y + el.height / 2] : [0, 0];
}

// Guide lines: edges and centres of unselected visible shapes.
function guideCandidates(selectedIds) {
  const vis = visibleLayerIds();
  const xs = [], ys = [];
  const sel = new Set(selectedIds);
  for (const el of S.doc.elements()) {
    if (sel.has(el.id) || el.type === 'connector' || !vis.has(el.layer)) continue;
    xs.push(el.x, el.x + el.width / 2, el.x + el.width);
    ys.push(el.y, el.y + el.height / 2, el.y + el.height);
  }
  return { xs, ys };
}

function snapDelta(box, dx, dy, guides, tol) {
  const lefts = [box.x, box.x + box.width / 2, box.x + box.width].map(v => v + dx);
  const tops = [box.y, box.y + box.height / 2, box.y + box.height].map(v => v + dy);
  const pick = (vals, cands) => {
    let best = null;
    for (const v of vals) for (const c of cands) {
      const diff = c - v;
      if (Math.abs(diff) <= tol && (best === null || Math.abs(diff) < Math.abs(best.diff))) best = { diff, line: c };
    }
    return best;
  };
  const bx = pick(lefts, guides.xs);
  const by = pick(tops, guides.ys);
  return {
    x: { dx: bx ? dx + bx.diff : dx, hit: bx ? bx.line : null },
    y: { dy: by ? dy + by.diff : dy, hit: by ? by.line : null },
  };
}

function maybePresence(w) {
  S.lastCursor = w;
  if (S.presenceTimer || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.presenceTimer = setTimeout(() => {
    S.presenceTimer = null;
    if (S.ws && S.ws.readyState === WebSocket.OPEN && S.lastCursor) {
      S.ws.send(JSON.stringify({ type: 'presence', actor: S.username, cursor: { x: Math.round(S.lastCursor.x), y: Math.round(S.lastCursor.y) }, selection: [...S.selection] }));
    }
  }, 80);
}

function setTool(tool) {
  S.tool = tool;
  S.connFrom = null;
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('#canvas').style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

// ---------- panels ----------
function onPropInput(e) {
  const t = e.target;
  if (t.dataset.style) {
    const v = t.type === 'number' ? (t.value === '' ? 0 : Number(t.value)) : t.value;
    setStyleOnSelection(t.dataset.style, v);
  } else if (t.dataset.prop === 'text') {
    run(() => S.doc.transaction(() => { for (const id of S.selection) S.doc.apply({ type: 'update', id, patch: { text: t.value } }); }));
  } else if (t.dataset.prop === 'rotation') {
    const deg = Number(t.value) || 0;
    run(() => S.doc.transaction(() => { for (const id of S.selection) if (S.doc.get(id)?.type !== 'connector') S.doc.apply({ type: 'rotate', id, deg }); }));
  } else if (t.dataset.prop === 'label') {
    run(() => S.doc.transaction(() => { for (const id of S.selection) S.doc.apply({ type: 'update', id, patch: { label: t.value } }); }));
  } else if (t.dataset.prop === 'routing') {
    run(() => S.doc.transaction(() => { for (const id of S.selection) S.doc.apply({ type: 'update', id, patch: { routing: t.value } }); }));
  } else if (t.dataset.prop === 'layer') {
    run(() => S.doc.transaction(() => { for (const id of S.selection) S.doc.apply({ type: 'update', id, patch: { layer: t.value } }); }));
  }
}

function onPropClick(e) {
  const cmd = e.target.dataset.cmd;
  if (!cmd) return;
  if (cmd === 'group') groupSelection();
  else if (cmd === 'ungroup') ungroupSelection();
  else if (cmd === 'delete') removeSelection();
  else reorderSelection(cmd);
}

function onLayerClick(e) {
  const li = e.target.closest('li[data-layer]');
  if (!li) return;
  const id = li.dataset.layer;
  const act = e.target.dataset.act;
  if (act === 'vis') run(() => S.doc.apply({ type: 'updateLayer', id, patch: { visible: e.target.checked } }));
  else if (act === 'lock') run(() => S.doc.apply({ type: 'updateLayer', id, patch: { locked: e.target.checked } }));
  else if (act === 'remove') {
    if (confirm(`Remove layer "${id}" and its elements?`)) run(() => S.doc.apply({ type: 'removeLayer', id }));
  } else if (!act) {
    S.activeLayer = id;
    refreshAll();
  }
}

function onLayerDblClick(e) {
  const li = e.target.closest('li[data-layer]');
  if (!li || e.target.dataset.act !== 'rename') return;
  const id = li.dataset.layer;
  const name = prompt('Layer name', S.doc.getLayer(id)?.name || id);
  if (name) run(() => S.doc.apply({ type: 'updateLayer', id, patch: { name } }));
}

// ---------- import / export ----------
async function importFile(file) {
  const xml = await file.text();
  const imported = importDrawio(xml, { id: 'import', actor: 'import' });
  const snapJson = imported.toJSON();
  run(() => S.doc.transaction(() => {
    const layerIds = new Set(S.doc.layers().map(l => l.id));
    for (const l of snapJson.layers) {
      if (!layerIds.has(l.id)) {
        S.doc.apply({ type: 'addLayer', layer: { id: l.id, name: l.name, visible: l.visible, locked: false } });
        layerIds.add(l.id);
      }
    }
    const idMap = new Map();
    for (const el of snapJson.elements.filter(e => e.type !== 'connector')) {
      const id = S.doc.get(el.id) ? rid('e') : el.id;
      idMap.set(el.id, id);
      S.doc.apply({ type: 'add', element: { ...el, id, layer: layerIds.has(el.layer) ? el.layer : S.activeLayer } });
    }
    for (const el of snapJson.elements.filter(e => e.type === 'connector')) {
      const s = idMap.get(el.source.elementId), t = idMap.get(el.target.elementId);
      if (!s || !t) continue;
      S.doc.apply({ type: 'add', element: { ...el, id: rid('c'), source: { elementId: s }, target: { elementId: t }, layer: layerIds.has(el.layer) ? el.layer : S.activeLayer } });
    }
  }));
}

async function downloadExport(kind) {
  const res = await fetch(`/api/docs/${S.docId}/export.${kind}`, { headers: { Authorization: `Bearer ${S.token}` } });
  if (!res.ok) { setFooter(`export failed: ${res.status}`); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.docId}.${kind}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- wiring ----------
function bindEvents() {
  $('#auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try { await login(f.username.value, f.password.value); setAuthMsg(''); location.hash = ''; await route(); }
    catch (err) { setAuthMsg(err.message); }
  });
  $('#register-btn').addEventListener('click', async () => {
    const f = $('#auth-form');
    try {
      await api('POST', '/auth/register', { username: f.username.value, password: f.password.value });
      await login(f.username.value, f.password.value);
      setAuthMsg('');
      await route();
    } catch (err) { setAuthMsg(err.message); }
  });
  $('#logout-btn').addEventListener('click', logout);
  $('#new-doc').addEventListener('submit', async e => {
    e.preventDefault();
    const title = e.target.title.value.trim() || 'Untitled';
    try {
      const d = await api('POST', '/docs', { title });
      location.hash = `#doc/${d.id}`;
    } catch (err) { $('#home-msg').textContent = err.message; }
  });
  window.addEventListener('hashchange', route);

  $('#home-link').addEventListener('click', e => { e.preventDefault(); location.hash = ''; });
  for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#undo').addEventListener('click', () => run(() => S.doc.undo()));
  $('#redo').addEventListener('click', () => run(() => S.doc.redo()));
  for (const b of $$('[data-align]')) b.addEventListener('click', () => alignSelection(b.dataset.align));
  $('#dist-h').addEventListener('click', () => run(() => S.doc.distribute([...S.selection], 'horizontal')));
  $('#dist-v').addEventListener('click', () => run(() => S.doc.distribute([...S.selection], 'vertical')));
  $('#layout-menu').addEventListener('change', e => {
    const v = e.target.value;
    e.target.value = '';
    if (!v) return;
    const [kind, dir] = v.split(':');
    run(() => S.doc.layout(kind, kind === 'layered' ? { direction: dir, spacing: 60 } : { spacing: 40 }));
  });
  $('#import-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) { try { await importFile(f); } catch (err) { setFooter(`import failed: ${err.message}`); } flush(); refreshAll(); }
  });
  $('#export-svg').addEventListener('click', () => downloadExport('svg'));
  $('#export-json').addEventListener('click', () => downloadExport('json'));
  $('#zoom-in').addEventListener('click', () => zoomAt($('#canvas').clientWidth / 2, $('#canvas').clientHeight / 2, 1.25));
  $('#zoom-out').addEventListener('click', () => zoomAt($('#canvas').clientWidth / 2, $('#canvas').clientHeight / 2, 0.8));
  $('#zoom-fit').addEventListener('click', fitView);
  $('#snap-grid').addEventListener('change', e => { S.snapGrid = e.target.checked; });
  $('#add-layer').addEventListener('click', () => {
    const n = S.doc.layers().length + 1;
    run(() => S.doc.apply({ type: 'addLayer', layer: { id: rid('l'), name: `Layer ${n}` } }));
  });
  $('#layers').addEventListener('click', onLayerClick);
  $('#layers').addEventListener('dblclick', onLayerDblClick);
  $('#tab-props').addEventListener('input', onPropInput);
  $('#tab-props').addEventListener('change', onPropInput);
  $('#tab-props').addEventListener('click', onPropClick);

  for (const t of $$('.tabs button')) {
    t.addEventListener('click', () => {
      for (const b of $$('.tabs button')) b.classList.toggle('active', b === t);
      for (const pane of ['props', 'comments', 'versions']) $(`#tab-${pane}`).classList.toggle('hidden', t.dataset.tab !== pane);
      if (t.dataset.tab === 'comments') renderComments();
      if (t.dataset.tab === 'versions') renderVersions();
    });
  }

  $('#comment-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    const anchor = [...S.selection][0];
    if (!body || !anchor) { setFooter('Select an element and enter a comment.'); return; }
    try {
      await api('POST', `/docs/${S.docId}/comments`, { elementId: anchor, body });
      e.target.body.value = '';
      renderComments();
    } catch (err) { setFooter(err.message); }
  });
  $('#comment-list').addEventListener('click', async e => {
    const li = e.target.closest('[data-cid]');
    if (!li) return;
    const cid = li.dataset.cid;
    try {
      if (e.target.dataset.cact === 'reply') {
        const body = prompt('Reply');
        if (body) await api('POST', `/docs/${S.docId}/comments`, { parentId: cid, body });
      } else if (e.target.dataset.cact === 'resolve') {
        const resolved = e.target.textContent === 'Resolve';
        await api('POST', `/docs/${S.docId}/comments/${cid}/resolve`, { resolved });
      }
      renderComments();
    } catch (err) { setFooter(err.message); }
  });
  $('#version-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('POST', `/docs/${S.docId}/versions`, { label: e.target.label.value });
      e.target.label.value = '';
      renderVersions();
    } catch (err) { setFooter(err.message); }
  });
  $('#version-list').addEventListener('click', async e => {
    if (e.target.dataset.vact !== 'restore') return;
    if (!confirm('Restore this version? Current edits will be replaced by a single undoable change.')) return;
    try {
      await api('POST', `/docs/${S.docId}/versions/${e.target.dataset.vid}/restore`);
      await pullOps();
      refreshAll();
    } catch (err) { setFooter(err.message); }
  });

  const canvas = $('#canvas');
  canvas.addEventListener('pointerdown', e => {
    if (!S.doc) return;
    canvas.setPointerCapture(e.pointerId);
    if (S.role === 'viewer' && S.tool !== 'select') { setFooter('Viewers cannot edit.'); return; }
    startDrag(e);
    refreshAll();
  });
  canvas.addEventListener('pointermove', moveDrag);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => { S.drag = null; refreshAll(); });
  canvas.addEventListener('dblclick', e => {
    const hit = e.target.closest('[data-id]');
    if (!hit) return;
    const el = S.doc.get(hit.dataset.id);
    if (!el || el.type === 'connector') return;
    const text = prompt('Text', el.text || '');
    if (text !== null) run(() => S.doc.apply({ type: 'update', id: el.id, patch: { text } }));
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    } else {
      S.view.x -= e.deltaY;
      renderContent(); renderOverlay(); renderMinimap();
    }
  }, { passive: false });
  // Pinch zoom with two pointers.
  const pts = new Map();
  let pinch = null;
  canvas.addEventListener('pointerdown', e => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) pinch = { d: dist(), k: S.view.k }; });
  canvas.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const r = canvas.getBoundingClientRect();
      const [a, b] = [...pts.values()];
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const k = pinch.k * (dist() / pinch.d);
      zoomAt(mx, my, k / S.view.k);
    }
  });
  const endPts = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  canvas.addEventListener('pointerup', endPts);
  canvas.addEventListener('pointercancel', endPts);
  function dist() {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  $('#minimap').addEventListener('click', e => {
    const mm = $('#minimap');
    const r = mm.getBoundingClientRect();
    const vb = mm.viewBox.baseVal;
    const wx = vb.x + ((e.clientX - r.left) / r.width) * vb.width;
    const wy = vb.y + ((e.clientY - r.top) / r.height) * vb.height;
    const c = $('#canvas-wrap').getBoundingClientRect();
    S.view.x = c.width / 2 - wx * S.view.k;
    S.view.y = c.height / 2 - wy * S.view.k;
    refreshAll();
  });

  window.addEventListener('keydown', e => {
    if (!S.doc || $('#editor').classList.contains('hidden')) return;
    if (e.target.matches('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { S.spaceDown = true; e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); run(() => S.doc.undo()); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); run(() => S.doc.redo()); return; }
    if (mod && e.key.toLowerCase() === 'c') { copySelection(); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(20); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); copySelection(); pasteClipboard(10); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); S.selection = new Set(S.doc.elements().map(x => x.id)); refreshAll(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelection(); return; }
    if (e.key === 'Escape') { S.selection = new Set(); S.connFrom = null; setTool('select'); refreshAll(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); const s = e.shiftKey ? 10 : 1; nudge(arrows[e.key][0] * s, arrows[e.key][1] * s); return; }
    const toolKeys = { v: 'select', r: 'rect', o: 'ellipse', d: 'diamond', t: 'text', c: 'connector' };
    if (toolKeys[e.key.toLowerCase()] && !mod) setTool(toolKeys[e.key.toLowerCase()]);
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') S.spaceDown = false; });
  window.addEventListener('resize', () => refreshAll());
  window.addEventListener('online', () => { if (S.docId && !S.ws) connect(); });
}

bindEvents();
setTool('select');
route().catch(err => setAuthMsg(err.message));
