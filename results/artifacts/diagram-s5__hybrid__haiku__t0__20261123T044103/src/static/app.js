// Editor UI: dashboard + SVG canvas. Uses the core library in the browser and syncs over WebSocket.
import { createDocument, importDrawio, snap, DiagramError } from '/static/core/index.js';
import { elementMarkup, esc } from '/static/core/svg.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const app = {
  token: localStorage.getItem('diagram.token'),
  user: localStorage.getItem('diagram.user'),
  docId: null,
  doc: null,
  role: 'viewer',
  ws: null,
  wsRetry: null,
  seq: 0,
  outbox: [],
  inflight: new Set(),
  tool: 'select',
  selection: new Set(),
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
  preview: null,
  guides: [],
  presence: new Map(),
  clipboard: [],
  connectorFrom: null,
  spaceDown: false,
  currentLayer: 'default',
  lastPresenceAt: 0,
};

// ---- helpers ------------------------------------------------------------------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message ?? res.statusText);
  return data;
}

function randomActor() {
  return `web-${crypto.randomUUID().slice(0, 8)}`;
}

function showView(name) {
  for (const id of ['auth', 'dashboard', 'editor']) $(`#${id}`).classList.toggle('hidden', id !== name);
}

// ---- auth & dashboard ---------------------------------------------------------
async function authenticate(path, username, password) {
  const r = await api('POST', `/api/auth/${path}`, { username, password });
  app.token = r.token ?? app.token;
  app.user = username;
  if (r.token) {
    localStorage.setItem('diagram.token', r.token);
    localStorage.setItem('diagram.user', username);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#auth-error').textContent = '';
  try {
    await authenticate('login', f.username.value, f.password.value);
    await showDashboard();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#register-btn').addEventListener('click', async () => {
  const f = $('#login-form');
  $('#auth-error').textContent = '';
  try {
    await api('POST', '/api/auth/register', { username: f.username.value, password: f.password.value });
    await authenticate('login', f.username.value, f.password.value);
    await showDashboard();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', () => {
  localStorage.removeItem('diagram.token');
  localStorage.removeItem('diagram.user');
  app.token = null;
  showView('auth');
});

async function showDashboard() {
  showView('dashboard');
  $('#whoami').textContent = app.user;
  const docs = await api('GET', '/api/docs');
  const list = $('#doc-list');
  list.innerHTML = '';
  for (const d of docs) {
    const li = document.createElement('li');
    li.textContent = `${d.title} (${d.role})`;
    li.addEventListener('click', () => openDoc(d.id));
    list.appendChild(li);
  }
}

$('#new-doc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = await api('POST', '/api/docs', { title: e.target.title.value || 'Untitled' });
  openDoc(d.id);
});

$('#back').addEventListener('click', () => {
  disconnect();
  showDashboard();
});

// ---- document session ---------------------------------------------------------
async function openDoc(id) {
  disconnect();
  const meta = await api('GET', `/api/docs/${id}`);
  app.docId = id;
  app.role = meta.role;
  app.doc = createDocument({ id, actor: randomActor() });
  app.seq = 0;
  app.selection = new Set();
  app.outbox = [];
  app.inflight = new Set();
  app.presence = new Map();
  app.connectorFrom = null;
  app.tool = 'select';
  await syncOps();
  showView('editor');
  $('#undo').disabled = app.role === 'viewer';
  document.title = `${meta.title} – diagram-s5`;
  connect();
  refreshLayerSelect();
  loadVersions();
  loadComments();
  render();
}

async function syncOps() {
  const r = await api('GET', `/api/docs/${app.docId}/ops?since=${app.seq}`);
  app.doc.receive(r.ops);
  app.seq = r.seq;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/docs/${app.docId}?token=${encodeURIComponent(app.token)}`);
  app.ws = ws;
  ws.onopen = async () => {
    try { await syncOps(); } catch { /* retried on next message */ }
    sendOutbox();
    setStatus();
    render();
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ops') {
      app.doc.receive(msg.ops);
      app.seq = Math.max(app.seq, msg.seq);
      render();
    } else if (msg.type === 'ack') {
      for (const id of app.inflight) app.outbox = app.outbox.filter((o) => o.id !== id);
      app.inflight = new Set();
      app.seq = Math.max(app.seq, msg.seq);
      setStatus();
    } else if (msg.type === 'hello') {
      app.role = msg.role;
    } else if (msg.type === 'presence') {
      app.presence.set(msg.actor, { username: msg.username, cursor: msg.cursor, selection: msg.selection, seen: Date.now() });
      renderPresence();
      renderCanvas();
    } else if (msg.type === 'error') {
      toast(msg.message);
    }
  };
  ws.onclose = () => {
    setStatus();
    if (app.ws === ws) {
      app.ws = null;
      clearTimeout(app.wsRetry);
      app.wsRetry = setTimeout(() => app.docId && connect(), 1500);
    }
  };
}

function disconnect() {
  clearTimeout(app.wsRetry);
  const ws = app.ws;
  app.ws = null;
  if (ws) ws.close();
  app.docId = null;
}

function setStatus() {
  const online = app.ws && app.ws.readyState === WebSocket.OPEN;
  const pending = app.outbox.length;
  $('#status').textContent = `${online ? 'Online' : 'Offline'}${pending ? ` · ${pending} pending` : ''} · ${app.role}`;
}

// Collect local ops, queue them and send when connected.
function flushLocal() {
  const ops = app.doc.pendingOps();
  if (ops.length) app.outbox.push(...ops);
  sendOutbox();
  setStatus();
}

function sendOutbox() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN || !app.outbox.length) return;
  app.inflight = new Set(app.outbox.map((o) => o.id));
  app.ws.send(JSON.stringify({ type: 'ops', ops: app.outbox }));
}

function commit(fn) {
  if (app.role === 'viewer') {
    toast('Read-only: viewers cannot edit');
    return;
  }
  try {
    fn();
  } catch (err) {
    if (err instanceof DiagramError || err instanceof Error) toast(err.message);
  }
  flushLocal();
  render();
}

// ---- view & coordinates -------------------------------------------------------
const canvas = $('#canvas');

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  return [app.view.x + sx / app.view.scale, app.view.y + sy / app.view.scale];
}

function applyViewBox() {
  const r = canvas.getBoundingClientRect();
  const w = r.width / app.view.scale;
  const h = r.height / app.view.scale;
  canvas.setAttribute('viewBox', `${app.view.x} ${app.view.y} ${w} ${h}`);
  $('#zoom').textContent = `${Math.round(app.view.scale * 100)}%`;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    const [wx, wy] = toWorld(e);
    const factor = Math.exp(-e.deltaY * 0.01);
    const next = Math.min(8, Math.max(0.1, app.view.scale * factor));
    app.view.x = wx - (wx - app.view.x) * (app.view.scale / next);
    app.view.y = wy - (wy - app.view.y) * (app.view.scale / next);
    app.view.scale = next;
  } else {
    app.view.x += e.deltaX / app.view.scale;
    app.view.y += e.deltaY / app.view.scale;
  }
  render();
}, { passive: false });

function centerOn(wx, wy) {
  const r = canvas.getBoundingClientRect();
  app.view.x = wx - r.width / app.view.scale / 2;
  app.view.y = wy - r.height / app.view.scale / 2;
  render();
}

// ---- picking ------------------------------------------------------------------
function distToSegment(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / l2)) : 0;
  return Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy);
}

function pick(wx, wy) {
  const shape = app.doc.hitTest(wx, wy);
  if (shape) return shape.id;
  const tol = 6 / app.view.scale;
  for (const el of app.doc.elements({ type: 'connector' }).reverse()) {
    const pts = app.doc.route(el.id);
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSegment(wx, wy, pts[i], pts[i + 1]) <= tol) return el.id;
    }
  }
  return null;
}

// ---- rendering ----------------------------------------------------------------
function previewed(el) {
  const p = app.preview;
  if (!p) return el;
  if (p.kind === 'move' && p.ids.includes(el.id) && el.type !== 'connector') {
    return { ...el, x: el.x + p.dx, y: el.y + p.dy };
  }
  if (p.kind === 'box' && p.id === el.id) return { ...el, ...p.box };
  if (p.kind === 'rotate' && p.id === el.id) return { ...el, rotation: p.deg };
  return el;
}

function renderCanvas() {
  applyViewBox();
  const doc = app.doc;
  const parts = [];
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000"/></marker></defs>');
  parts.push('<rect id="hit" x="-1e6" y="-1e6" width="2e6" height="2e6" fill="transparent"/>');
  for (const el of doc.elements()) {
    if (doc.layers().find((l) => l.id === el.layer)?.visible === false) continue;
    const e2 = previewed(el);
    const route = el.type === 'connector' ? doc.route(el.id) : null;
    let markup = elementMarkup(e2, route);
    if (el.type === 'connector' && app.selection.has(el.id)) markup = markup.replace('marker-end', 'stroke-dasharray="4 2" marker-end');
    parts.push(markup);
  }
  parts.push(...selectionOverlay());
  for (const [actor, p] of app.presence) {
    if (actor === app.doc.actor) continue;
    if (p.cursor) parts.push(`<g class="cursor" transform="translate(${p.cursor[0]} ${p.cursor[1]})"><path d="M0 0 L0 14 L4 11 L7 17 L9 16 L6 10 L11 10 z" fill="#e64980"/><text x="12" y="10" font-size="11" fill="#e64980">${esc(p.username ?? actor)}</text></g>`);
    for (const id of p.selection ?? []) {
      const b = doc.get(id);
      if (b && b.type !== 'connector') parts.push(`<rect x="${b.x - 3}" y="${b.y - 3}" width="${b.width + 6}" height="${b.height + 6}" fill="none" stroke="#e64980" stroke-dasharray="2 2"/>`);
    }
  }
  for (const g of app.guides) {
    parts.push(g.axis === 'x'
      ? `<line x1="${g.v}" y1="${g.from}" x2="${g.v}" y2="${g.to}" stroke="#ff0066" stroke-width="1"/>`
      : `<line x1="${g.from}" y1="${g.v}" x2="${g.to}" y2="${g.v}" stroke="#ff0066" stroke-width="1"/>`);
  }
  if (app.marquee) {
    const m = app.marquee;
    parts.push(`<rect x="${Math.min(m.x0, m.x1)}" y="${Math.min(m.y0, m.y1)}" width="${Math.abs(m.x1 - m.x0)}" height="${Math.abs(m.y1 - m.y0)}" fill="rgba(0,120,255,0.1)" stroke="#0078ff"/>`);
  }
  canvas.innerHTML = parts.join('');
  renderMinimap();
}

function selectionOverlay() {
  const ids = [...app.selection].filter((id) => app.doc.get(id));
  if (!ids.length) return [];
  const out = [];
  if (ids.length === 1 && app.doc.get(ids[0]).type !== 'connector') {
    const el = previewed(app.doc.get(ids[0]));
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const tr = el.rotation ? ` transform="rotate(${el.rotation} ${cx} ${cy})"` : '';
    const hs = handlesFor(el);
    out.push(`<g${tr}><rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="none" stroke="#0078ff" stroke-width="1" pointer-events="none"/>`);
    out.push(`<line x1="${cx}" y1="${el.y}" x2="${cx}" y2="${el.y - 22}" stroke="#0078ff"/>`);
    out.push(`<circle data-handle="rotate" cx="${cx}" cy="${el.y - 22}" r="5" fill="#fff" stroke="#0078ff"/>`);
    for (const h of hs) out.push(`<rect data-handle="${h.name}" x="${h.x - 4}" y="${h.y - 4}" width="8" height="8" fill="#fff" stroke="#0078ff"/>`);
    out.push('</g>');
  } else {
    const b = app.doc.bounds(ids);
    if (b) out.push(`<rect x="${b.x - 4}" y="${b.y - 4}" width="${b.width + 8}" height="${b.height + 8}" fill="none" stroke="#0078ff" stroke-dasharray="4 3" pointer-events="none"/>`);
  }
  return out;
}

function handlesFor(el) {
  const { x, y, width: w, height: h } = el;
  const pts = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
  return Object.entries(pts).map(([name, [px, py]]) => ({ name, x: px, y: py }));
}

function renderPresence() {
  const ul = $('#presence');
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = `You (${app.user})`;
  ul.appendChild(li);
  for (const [actor, p] of app.presence) {
    if (actor === app.doc.actor || Date.now() - p.seen > 60000) continue;
    const el = document.createElement('li');
    el.textContent = p.username ?? actor;
    el.style.color = '#e64980';
    ul.appendChild(el);
  }
}

function renderLayers() {
  const box = $('#layers');
  box.innerHTML = '';
  for (const l of app.doc.layers()) {
    const row = document.createElement('div');
    row.className = `layer${l.id === app.currentLayer ? ' current' : ''}`;
    row.innerHTML = `<input type="checkbox" data-layer-vis="${esc(l.id)}" ${l.visible ? 'checked' : ''} title="visible"><input type="checkbox" data-layer-lock="${esc(l.id)}" ${l.locked ? 'checked' : ''} title="locked"><span data-layer-select="${esc(l.id)}">${esc(l.name)}</span>`;
    box.appendChild(row);
  }
}

function refreshLayerSelect() {
  const sel = $('#current-layer');
  sel.innerHTML = app.doc.layers().map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  sel.value = app.currentLayer;
}

function renderProps() {
  const box = $('#props');
  const ids = [...app.selection].filter((id) => app.doc.get(id));
  if (!ids.length) {
    box.innerHTML = '<p>Nothing selected.</p>';
    return;
  }
  const el = app.doc.get(ids[0]);
  const st = el.style ?? {};
  const layerOpts = app.doc.layers().map((l) => `<option value="${esc(l.id)}" ${l.id === el.layer ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  box.innerHTML = `
    <p>${ids.length} selected (${esc(el.type)})</p>
    <label>Fill <input type="color" data-style="fill" value="${toHex(st.fill ?? '#ffffff')}"></label>
    <label>Stroke <input type="color" data-style="stroke" value="${toHex(st.stroke ?? '#000000')}"></label>
    <label>Stroke width <input type="number" min="0" step="0.5" data-style="strokeWidth" value="${st.strokeWidth ?? 1}"></label>
    <label>Opacity <input type="number" min="0" max="1" step="0.1" data-style="opacity" value="${st.opacity ?? 1}"></label>
    <label>Font size <input type="number" min="6" step="1" data-style="fontSize" value="${st.fontSize ?? 14}"></label>
    ${el.type !== 'connector' ? `<label>Text <input type="text" data-field="text" value="${esc(el.text ?? '')}"></label>` : `<label>Label <input type="text" data-field="label" value="${esc(el.label ?? '')}"></label>`}
    <label>Layer <select data-field="layer">${layerOpts}</select></label>`;
}

function toHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  return ctx.fillStyle.startsWith('#') ? ctx.fillStyle : '#000000';
}

function renderMinimap() {
  const mm = $('#minimap');
  const b = app.doc.bounds() ?? { x: 0, y: 0, width: 100, height: 100 };
  const pad = 20;
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  const w = b.width + 2 * pad;
  const h = b.height + 2 * pad;
  const parts = [];
  for (const el of app.doc.elements({ type: 'rect' }).concat(app.doc.elements({ type: 'ellipse' }), app.doc.elements({ type: 'diamond' }), app.doc.elements({ type: 'text' }), app.doc.elements({ type: 'image' }), app.doc.elements({ type: 'line' }))) {
    parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="#ccd" stroke="#668"/>`);
  }
  const r = canvas.getBoundingClientRect();
  parts.push(`<rect x="${app.view.x}" y="${app.view.y}" width="${r.width / app.view.scale}" height="${r.height / app.view.scale}" fill="rgba(255,0,0,0.08)" stroke="red"/>`);
  mm.setAttribute('viewBox', `${x0} ${y0} ${w} ${h}`);
  mm.innerHTML = parts.join('');
}

function renderVersionsAndComments() {}

function render() {
  if (!app.doc || !app.docId) return;
  renderCanvas();
  renderLayers();
  renderProps();
  renderPresence();
  setStatus();
  for (const b of $$('#tools button')) b.classList.toggle('active', b.dataset.tool === app.tool);
  for (const b of $$('#tools button')) b.disabled = app.role === 'viewer';
}

// ---- pointer interaction ------------------------------------------------------
function sendPresence(wx, wy) {
  const now = Date.now();
  if (now - app.lastPresenceAt < 80 || !app.ws || app.ws.readyState !== WebSocket.OPEN) return;
  app.lastPresenceAt = now;
  app.ws.send(JSON.stringify({ type: 'presence', actor: app.doc.actor, cursor: [wx, wy], selection: [...app.selection] }));
}

canvas.addEventListener('pointerdown', (e) => {
  if (!app.doc) return;
  const [wx, wy] = toWorld(e);
  if (e.button === 1 || app.spaceDown) {
    app.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: app.view.x, vy: app.view.y };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  const handle = e.target.dataset?.handle;
  if (handle && app.selection.size === 1) {
    const el = app.doc.get([...app.selection][0]);
    if (handle === 'rotate') {
      app.drag = { kind: 'rotate', id: el.id, cx: el.x + el.width / 2, cy: el.y + el.height / 2 };
    } else {
      app.drag = { kind: 'resize', id: el.id, handle, start: el, sx: wx, sy: wy };
    }
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (app.tool === 'select') {
    const hit = pick(wx, wy);
    if (hit) {
      if (!app.selection.has(hit)) {
        if (!e.shiftKey) app.selection.clear();
        app.selection.add(hit);
      } else if (e.shiftKey) {
        app.selection.delete(hit);
      }
      app.drag = { kind: 'move', sx: wx, sy: wy, dx: 0, dy: 0, moved: false };
    } else {
      if (!e.shiftKey) app.selection.clear();
      app.drag = { kind: 'marquee', sx: wx, sy: wy };
    }
  } else if (app.tool === 'connector') {
    const hit = app.doc.hitTest(wx, wy);
    if (hit) {
      if (!app.connectorFrom) {
        app.connectorFrom = hit.id;
        toast('Now click the target shape');
      } else if (hit.id !== app.connectorFrom) {
        const source = app.connectorFrom;
        app.connectorFrom = null;
        commit(() => app.doc.apply({ type: 'add', element: { type: 'connector', source: { elementId: source }, target: { elementId: hit.id }, routing: $('#routing').value, label: '' } }));
      }
    } else {
      app.connectorFrom = null;
    }
    render();
    return;
  } else if (app.tool === 'text') {
    const text = prompt('Text', 'Text');
    if (text !== null) {
      commit(() => app.doc.apply({ type: 'add', element: { type: 'text', x: wx, y: wy, width: 120, height: 30, text, layer: app.currentLayer } }));
    }
    app.tool = 'select';
    render();
    return;
  } else {
    app.drag = { kind: 'create', type: app.tool, sx: wx, sy: wy, x: wx, y: wy };
  }
  canvas.setPointerCapture(e.pointerId);
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!app.doc) return;
  const [wx, wy] = toWorld(e);
  sendPresence(wx, wy);
  const d = app.drag;
  if (!d) return;
  if (d.kind === 'pan') {
    app.view.x = d.vx - (e.clientX - d.sx) / app.view.scale;
    app.view.y = d.vy - (e.clientY - d.sy) / app.view.scale;
  } else if (d.kind === 'move') {
    let dx = wx - d.sx;
    let dy = wy - d.sy;
    const snapped = snapDelta(dx, dy);
    dx = snapped.dx;
    dy = snapped.dy;
    d.dx = dx;
    d.dy = dy;
    d.moved = true;
    app.guides = snapped.guides;
    app.preview = { kind: 'move', ids: [...app.selection], dx, dy };
  } else if (d.kind === 'marquee') {
    app.marquee = { x0: d.sx, y0: d.sy, x1: wx, y1: wy };
  } else if (d.kind === 'create') {
    d.x = wx;
    d.y = wy;
    const box = normBox(d.sx, d.sy, wx, wy);
    app.preview = { kind: 'box', id: '__new', box };
    app.newBox = box;
  } else if (d.kind === 'resize') {
    const box = resizeBox(d.start, d.handle, wx - d.sx, wy - d.sy);
    app.preview = { kind: 'box', id: d.id, box };
    d.box = box;
  } else if (d.kind === 'rotate') {
    const deg = (Math.atan2(wy - d.cy, wx - d.cx) * 180) / Math.PI + 90;
    d.deg = Math.round(deg);
    app.preview = { kind: 'rotate', id: d.id, deg: d.deg };
  }
  renderCanvas();
});

canvas.addEventListener('pointerup', (e) => {
  const d = app.drag;
  app.drag = null;
  app.guides = [];
  const [wx, wy] = toWorld(e);
  if (d) {
    if (d.kind === 'move' && d.moved) {
      const ids = [...app.selection];
      commit(() => app.doc.apply({ type: 'move', ids, dx: d.dx, dy: d.dy }));
    } else if (d.kind === 'marquee') {
      const box = normBox(d.sx, d.sy, wx, wy);
      if (box.width < 2 && box.height < 2) {
        app.selection.clear();
      } else {
        for (const el of app.doc.select(box)) app.selection.add(el.id);
      }
    } else if (d.kind === 'create') {
      const box = normBox(d.sx, d.sy, wx, wy);
      const minW = box.width < 4 ? 100 : box.width;
      const minH = box.height < 4 ? 60 : box.height;
      const el = { type: d.type, x: box.x, y: box.y, width: minW, height: minH, layer: app.currentLayer, text: d.type === 'text' ? '' : '' };
      commit(() => app.doc.apply({ type: 'add', element: el }));
      const created = app.doc.elements().filter((x) => x.type === d.type).pop();
      if (created) {
        app.selection = new Set([created.id]);
      }
      app.tool = 'select';
    } else if (d.kind === 'resize' && d.box) {
      commit(() => app.doc.apply({ type: 'resize', id: d.id, box: d.box }));
    } else if (d.kind === 'rotate' && d.deg !== undefined) {
      commit(() => app.doc.apply({ type: 'rotate', id: d.id, deg: d.deg }));
    }
  }
  app.preview = null;
  app.marquee = null;
  render();
});

// Snap a move delta so the selection's edges/centres align with other shapes or the grid.
function snapDelta(dx, dy) {
  const ids = [...app.selection].filter((id) => app.doc.get(id)?.type !== 'connector');
  const guides = [];
  if (!ids.length) return { dx, dy, guides };
  const b = app.doc.bounds(ids);
  if (!b) return { dx, dy, guides };
  const others = app.doc.elements().filter((e) => e.type !== 'connector' && !app.selection.has(e.id));
  const tol = 5 / app.view.scale;
  const xs = [];
  const ys = [];
  for (const o of others) {
    xs.push(o.x, o.x + o.width / 2, o.x + o.width);
    ys.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  const cur = { x: [b.x + dx, b.x + dx + b.width / 2, b.x + dx + b.width], y: [b.y + dy, b.y + dy + b.height / 2, b.y + dy + b.height] };
  let bestX = null;
  let bestY = null;
  for (const v of cur.x) for (const g of xs) {
    const d = g - v;
    if (Math.abs(d) <= tol && (bestX === null || Math.abs(d) < Math.abs(bestX))) bestX = d;
  }
  for (const v of cur.y) for (const g of ys) {
    const d = g - v;
    if (Math.abs(d) <= tol && (bestY === null || Math.abs(d) < Math.abs(bestY))) bestY = d;
  }
  if (bestX !== null) dx += bestX;
  if (bestY !== null) dy += bestY;
  if (bestX === null && bestY === null && $('#grid-snap')?.checked !== false) {
    const s = snap({ x: b.x + dx, y: b.y + dy }, { grid: 10 });
    dx = s.x - b.x;
    dy = s.y - b.y;
  }
  if (bestX !== null) guides.push({ axis: 'x', v: b.x + dx, from: b.y - 50, to: b.y + b.height + 50 });
  if (bestY !== null) guides.push({ axis: 'y', v: b.y + dy, from: b.x - 50, to: b.x + b.width + 50 });
  return { dx, dy, guides };
}

function normBox(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function resizeBox(start, handle, dx, dy) {
  let { x, y, width: w, height: h } = start;
  if (handle.includes('e')) w += dx;
  if (handle.includes('s')) h += dy;
  if (handle.includes('w')) { x += dx; w -= dx; }
  if (handle.includes('n')) { y += dy; h -= dy; }
  return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
}

// ---- toolbar, panels, keyboard ------------------------------------------------
for (const b of $$('#tools button')) {
  b.addEventListener('click', () => {
    app.tool = b.dataset.tool;
    app.connectorFrom = null;
    render();
  });
}

function selectedIds() {
  return [...app.selection].filter((id) => app.doc.get(id));
}

$('#undo').addEventListener('click', () => { app.doc.undo(); flushLocal(); render(); });
$('#redo').addEventListener('click', () => { app.doc.redo(); flushLocal(); render(); });
$('#delete').addEventListener('click', () => deleteSelection());
$('#dup').addEventListener('click', () => duplicateSelection());
$('#group').addEventListener('click', () => commit(() => app.doc.apply({ type: 'group', ids: selectedIds() })));
$('#ungroup').addEventListener('click', () => {
  const first = app.doc.get(selectedIds()[0]);
  if (first?.groupId) commit(() => app.doc.apply({ type: 'ungroup', groupId: first.groupId }));
});
for (const b of $$('[data-align]')) b.addEventListener('click', () => commit(() => app.doc.align(selectedIds(), b.dataset.align)));
for (const b of $$('[data-dist]')) b.addEventListener('click', () => commit(() => app.doc.distribute(selectedIds(), b.dataset.dist)));
for (const b of $$('[data-z]')) {
  b.addEventListener('click', () => {
    const ids = selectedIds();
    if (ids.length) commit(() => { app.doc.transaction(() => { for (const id of ids) app.doc.apply({ type: 'reorder', id, to: b.dataset.z }); }); });
  });
}

$('#layout-kind').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (!v) return;
  if (v === 'grid') commit(() => app.doc.layout('grid'));
  else commit(() => app.doc.layout('layered', { direction: v.split('-')[1] }));
});

$('#routing').addEventListener('change', () => {});

function deleteSelection() {
  const ids = selectedIds();
  if (!ids.length) return;
  commit(() => app.doc.transaction(() => { for (const id of ids) if (app.doc.get(id)) app.doc.apply({ type: 'remove', id }); }));
  app.selection.clear();
  render();
}

function duplicateSelection() {
  const ids = selectedIds().filter((id) => app.doc.get(id).type !== 'connector');
  if (!ids.length) return;
  const newIds = [];
  commit(() => app.doc.transaction(() => {
    for (const id of ids) {
      const el = app.doc.get(id);
      const copy = { ...el, x: el.x + 20, y: el.y + 20, id: undefined };
      delete copy.id;
      app.doc.apply({ type: 'add', element: copy });
      newIds.push(app.doc.elements().pop().id);
    }
  }));
  app.selection = new Set(newIds);
  render();
}

$('#add-layer').addEventListener('click', () => {
  const name = prompt('Layer name', 'Layer');
  if (!name) return;
  commit(() => app.doc.apply({ type: 'addLayer', layer: { name } }));
  refreshLayerSelect();
});

$('#layers').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.layerVis) commit(() => app.doc.apply({ type: 'updateLayer', id: t.dataset.layerVis, patch: { visible: t.checked } }));
  if (t.dataset.layerLock) commit(() => app.doc.apply({ type: 'updateLayer', id: t.dataset.layerLock, patch: { locked: t.checked } }));
});
$('#layers').addEventListener('click', (e) => {
  const id = e.target.dataset.layerSelect;
  if (id) {
    app.currentLayer = id;
    refreshLayerSelect();
    render();
  }
});
$('#current-layer').addEventListener('change', (e) => {
  app.currentLayer = e.target.value;
  render();
});

$('#props').addEventListener('change', (e) => {
  const t = e.target;
  const ids = selectedIds();
  if (!ids.length) return;
  if (t.dataset.style) {
    const raw = t.type === 'number' ? Number(t.value) : t.value;
    commit(() => app.doc.apply({ type: 'setStyle', ids, style: { [t.dataset.style]: raw } }));
  } else if (t.dataset.field === 'text' || t.dataset.field === 'label') {
    commit(() => app.doc.transaction(() => {
      for (const id of ids) app.doc.apply({ type: 'update', id, patch: { [t.dataset.field]: t.value } });
    }));
  } else if (t.dataset.field === 'layer') {
    commit(() => app.doc.transaction(() => {
      for (const id of ids) app.doc.apply({ type: 'update', id, patch: { layer: t.value } });
    }));
  }
});

// Export / import
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#export-svg').addEventListener('click', () => download('diagram.svg', app.doc.toSVG({ padding: 20 }), 'image/svg+xml'));
$('#export-json').addEventListener('click', () => download('diagram.json', JSON.stringify(app.doc.toJSON(), null, 2), 'application/json'));

$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const imported = importDrawio(await file.text()).toJSON();
    const idMap = new Map();
    commit(() => app.doc.transaction(() => {
      for (const l of imported.layers) {
        if (!app.doc.layers().some((x) => x.id === l.id)) app.doc.apply({ type: 'addLayer', layer: { ...l } });
      }
      const added = [];
      for (const el of imported.elements.filter((x) => x.type !== 'connector')) {
        const { z, ...rest } = el;
        const newId = crypto.randomUUID().slice(0, 8);
        idMap.set(el.id, newId);
        app.doc.apply({ type: 'add', element: { ...rest, id: newId, layer: app.currentLayer } });
        added.push(newId);
      }
      for (const el of imported.elements.filter((x) => x.type === 'connector')) {
        const s = idMap.get(el.source.elementId);
        const t = idMap.get(el.target.elementId);
        if (!s || !t) continue;
        const { z, ...rest } = el;
        app.doc.apply({ type: 'add', element: { ...rest, id: crypto.randomUUID().slice(0, 8), source: { ...el.source, elementId: s }, target: { ...el.target, elementId: t } } });
      }
    }));
    toast(`Imported ${imported.elements.length} items`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
  e.target.value = '';
});

// Versions
async function loadVersions() {
  if (!app.docId) return;
  const list = await api('GET', `/api/docs/${app.docId}/versions`);
  const ul = $('#versions');
  ul.innerHTML = '';
  for (const v of list.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `${esc(v.label)} <small>${esc(v.createdAt)}</small> <button data-restore="${esc(v.id)}">Restore</button>`;
    ul.appendChild(li);
  }
}

$('#version-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', `/api/docs/${app.docId}/versions`, { label: e.target.label.value || 'Version' });
    e.target.label.value = '';
    loadVersions();
  } catch (err) { toast(err.message); }
});

$('#versions').addEventListener('click', async (e) => {
  const id = e.target.dataset.restore;
  if (!id) return;
  try {
    await api('POST', `/api/docs/${app.docId}/versions/${id}/restore`, {});
    await syncOps();
    render();
  } catch (err) { toast(err.message); }
});

// Comments
async function loadComments() {
  if (!app.docId) return;
  const sel = selectedIds();
  const path = sel.length === 1 ? `?elementId=${encodeURIComponent(sel[0])}` : '';
  const threads = await api('GET', `/api/docs/${app.docId}/comments${path}`);
  const ul = $('#comments');
  ul.innerHTML = '';
  for (const t of threads) {
    const li = document.createElement('li');
    if (t.resolved) li.className = 'resolved';
    li.innerHTML = `<b>${esc(t.author)}</b> on <i>${esc(t.elementId)}</i>: ${esc(t.body)}
      <button data-reply="${esc(t.id)}">Reply</button>
      <button data-resolve="${esc(t.id)}" data-value="${t.resolved ? '0' : '1'}">${t.resolved ? 'Reopen' : 'Resolve'}</button>
      ${t.replies.map((r) => `<div>↳ <b>${esc(r.author)}</b>: ${esc(r.body)}</div>`).join('')}`;
    ul.appendChild(li);
  }
}

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sel = selectedIds();
  if (sel.length !== 1) return toast('Select exactly one element to comment on');
  try {
    await api('POST', `/api/docs/${app.docId}/comments`, { elementId: sel[0], body: e.target.body.value });
    e.target.body.value = '';
    loadComments();
  } catch (err) { toast(err.message); }
});

$('#comments').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.reply) {
      const body = prompt('Reply');
      if (body) await api('POST', `/api/docs/${app.docId}/comments`, { parentId: t.dataset.reply, body });
    } else if (t.dataset.resolve) {
      await api('POST', `/api/docs/${app.docId}/comments/${t.dataset.resolve}/resolve`, { resolved: t.dataset.value === '1' });
    }
    loadComments();
  } catch (err) { toast(err.message); }
});

// Keyboard
window.addEventListener('keydown', (e) => {
  if (!app.doc || $('#editor').classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { app.spaceDown = true; e.preventDefault(); return; }
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); $('#undo').click(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); $('#redo').click(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); app.clipboard = selectedIds().map((id) => app.doc.get(id)).filter((x) => x.type !== 'connector'); return; }
  if (mod && e.key.toLowerCase() === 'v') {
    e.preventDefault();
    commit(() => app.doc.transaction(() => {
      const ids = [];
      for (const el of app.clipboard) {
        const copy = { ...el, x: el.x + 20, y: el.y + 20 };
        delete copy.id;
        app.doc.apply({ type: 'add', element: copy });
        ids.push(app.doc.elements().pop().id);
      }
      app.selection = new Set(ids);
    }));
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const ids = selectedIds();
    if (ids.length) commit(() => app.doc.apply({ type: 'move', ids, dx, dy }));
    return;
  }
  const toolKeys = { v: 'select', r: 'rect', e: 'ellipse', d: 'diamond', t: 'text', c: 'connector' };
  if (!mod && toolKeys[e.key.toLowerCase()]) { app.tool = toolKeys[e.key.toLowerCase()]; render(); }
});

window.addEventListener('keyup', (e) => { if (e.code === 'Space') app.spaceDown = false; });
$('#minimap').addEventListener('click', (e) => {
  const r = $('#minimap').getBoundingClientRect();
  const b = app.doc.bounds() ?? { x: 0, y: 0, width: 100, height: 100 };
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  centerOn(b.x - 20 + fx * (b.width + 40), b.y - 20 + fy * (b.height + 40));
});

window.addEventListener('resize', () => app.doc && renderCanvas());

// Boot
if (app.token) {
  showDashboard().catch(() => { localStorage.removeItem('diagram.token'); showView('auth'); });
} else {
  showView('auth');
}
