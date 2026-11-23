import { fromJSON, createDocument, importDrawio, snap } from '/static/core/index.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const GRID = 10;
let token = localStorage.getItem('token') || null;
let me = null;
let docMeta = null, doc = null, ws = null, lastSeq = 0, role = 'viewer';
const actor = 'c-' + Math.random().toString(36).slice(2, 8);
let tool = 'select';
let sel = new Set();
let view = { x: 0, y: 0, k: 1 };
let activeLayer = 'default';
let drag = null, preview = new Map(), guides = [], cursorPos = null, marquee = null, connDraft = null;
const peers = new Map();
let clipboard = [];
let outbox = [];

// ---------- API ----------
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j.message || j.error || r.status);
  return j;
}
const status = (t) => { $('#status').textContent = t; };

// ---------- auth ----------
async function doAuth(register) {
  const username = $('#u').value, password = $('#p').value;
  try {
    if (register) await api('POST', '/api/auth/register', { username, password });
    const r = await api('POST', '/api/auth/login', { username, password });
    token = r.token; me = r.user; localStorage.setItem('token', token);
    start();
  } catch (e) { $('#authMsg').textContent = e.message; }
}
$('#authForm').onsubmit = (e) => { e.preventDefault(); doAuth(false); };
$('#register').onclick = () => doAuth(true);

async function start() {
  $('#auth').hidden = true; $('#app').hidden = false;
  await refreshDocs();
}
async function refreshDocs(selectId) {
  const { docs } = await api('GET', '/api/docs');
  const s = $('#docSel');
  s.innerHTML = docs.map((d) => `<option value="${d.id}">${esc(d.title)} (${d.role})</option>`).join('');
  if (!docs.length) { const d = await api('POST', '/api/docs', { title: 'My diagram' }); return refreshDocs(d.id); }
  if (selectId) s.value = selectId;
  else if (localStorage.getItem('lastDoc') && docs.some((d) => d.id === localStorage.getItem('lastDoc'))) s.value = localStorage.getItem('lastDoc');
  await openDoc(s.value);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
$('#docSel').onchange = () => openDoc($('#docSel').value);
$('#newDoc').onclick = async () => { const t = prompt('Title', 'Untitled'); if (t) { const d = await api('POST', '/api/docs', { title: t }); refreshDocs(d.id); } };
$('#shareBtn').onclick = async () => {
  const username = prompt('Share with username'); if (!username) return;
  const r = prompt('Role (editor/viewer)', 'editor');
  try { await api('POST', `/api/docs/${docMeta.id}/share`, { username, role: r }); status('shared'); } catch (e) { alert(e.message); }
};

// ---------- doc / sync ----------
async function openDoc(id) {
  if (ws) { ws.onclose = null; ws.close(); }
  localStorage.setItem('lastDoc', id);
  const snapData = await api('GET', `/api/docs/${id}`);
  docMeta = snapData; role = snapData.role; lastSeq = snapData.seq;
  doc = fromJSON(snapData, { actor });
  outbox = JSON.parse(localStorage.getItem('outbox:' + id) || '[]');
  if (outbox.length) doc.receive(outbox);
  doc.on('op', (op) => { outbox.push(op); persistOutbox(); flush(); });
  doc.on('change', () => { render(); panels(); });
  sel = new Set(); peers.clear(); fitView();
  connect();
  render(); panels(); loadVersions(); loadComments();
  flush();
}
const persistOutbox = () => localStorage.setItem('outbox:' + docMeta.id, JSON.stringify(outbox));
let flushing = false;
async function flush() {
  if (flushing || !outbox.length || role === 'viewer') return;
  flushing = true;
  try {
    const batch = outbox.slice();
    const r = await api('POST', `/api/docs/${docMeta.id}/ops`, { ops: batch });
    outbox = outbox.filter((o) => !batch.includes(o)); persistOutbox();
    lastSeq = Math.max(lastSeq, r.seq);
    status('synced');
  } catch (e) { status('offline – edits queued'); }
  flushing = false;
  if (outbox.length) setTimeout(flush, 2000);
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/docs/${docMeta.id}?token=${token}`);
  ws.onopen = async () => {
    status('connected');
    try { const r = await api('GET', `/api/docs/${docMeta.id}/ops?since=${lastSeq}`); if (r.ops.length) doc.receive(r.ops); lastSeq = r.seq; } catch {}
    flush();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'ops') { doc.receive(m.ops); lastSeq = Math.max(lastSeq, m.seq); }
    else if (m.type === 'presence') { peers.set(m.actor, { ...m, t: Date.now() }); render(); }
    else if (m.type === 'leave') { peers.delete(m.actor); render(); }
    else if (m.type === 'comments') loadComments();
  };
  ws.onclose = () => { status('offline – edits queued'); setTimeout(() => docMeta && ws && ws.readyState === 3 && connect(), 2000); };
}
let lastPresence = 0;
function sendPresence() {
  if (!ws || ws.readyState !== 1 || Date.now() - lastPresence < 50) return;
  lastPresence = Date.now();
  ws.send(JSON.stringify({ type: 'presence', actor, cursor: cursorPos, selection: [...sel] }));
}

// ---------- view helpers ----------
const canvas = $('#canvas'), vp = $('#vp'), content = $('#content'), overlay = $('#overlay');
function toWorld(ev) { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k }; }
function applyView() { vp.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); }
function fitView() { view = { x: 40, y: 40, k: 1 }; applyView(); }
function el(name, attrs = {}, parent) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
const eff = (o) => (preview.has(o.id) ? { ...o, ...preview.get(o.id) } : o);

// ---------- render ----------
function render() {
  if (!doc) return;
  applyView();
  content.innerHTML = ''; overlay.innerHTML = '';
  const items = doc.elements();
  const layers = new Map(doc.layers().map((l) => [l.id, l]));
  const byId = new Map(items.map((o) => [o.id, eff(o)]));
  for (const raw of items) {
    const l = layers.get(raw.layer);
    if (l && l.visible === false) continue;
    const o = eff(raw);
    const st = o.style || {};
    const g = el('g', { 'data-id': o.id, opacity: st.opacity ?? 1 }, content);
    if (l?.locked) g.setAttribute('data-locked', '1');
    if (o.type === 'connector') {
      let pts;
      if (preview.size && [...preview.keys()].some((k) => k === o.source?.elementId || k === o.target?.elementId)) {
        const tmp = createDocument({ id: 't', actor: 't' });
        for (const s of items) if (s.type !== 'connector') tmp.apply({ type: 'add', element: eff(s) });
        tmp.apply({ type: 'add', element: o });
        pts = tmp.route(o.id);
      } else pts = doc.route(o.id);
      if (pts.length < 2) continue;
      el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' '), fill: 'none', stroke: st.stroke || '#333', 'stroke-width': st.strokeWidth || 1.5, 'marker-end': 'url(#arr)' }, g);
      el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': 10 }, g);
      if (o.label) { const m = pts[Math.floor(pts.length / 2)]; const t = el('text', { x: m[0], y: m[1] - 6, 'text-anchor': 'middle', 'font-size': 12 }, g); t.textContent = o.label; }
    } else {
      const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
      if (o.rotation) g.setAttribute('transform', `rotate(${o.rotation} ${cx} ${cy})`);
      const a = { fill: st.fill || '#fff', stroke: st.stroke || '#333', 'stroke-width': st.strokeWidth || 1.5 };
      if (o.type === 'ellipse') el('ellipse', { cx, cy, rx: o.width / 2, ry: o.height / 2, ...a }, g);
      else if (o.type === 'diamond') el('polygon', { points: `${cx},${o.y} ${o.x + o.width},${cy} ${cx},${o.y + o.height} ${o.x},${cy}`, ...a }, g);
      else if (o.type === 'line') { el('line', { x1: o.x, y1: o.y, x2: o.x + o.width, y2: o.y + o.height, stroke: a.stroke, 'stroke-width': 2 }, g); }
      else if (o.type === 'text') el('rect', { x: o.x, y: o.y, width: o.width, height: o.height, fill: 'transparent' }, g);
      else if (o.type === 'image') el('image', { x: o.x, y: o.y, width: o.width, height: o.height, href: o.src || st.src || '' }, g);
      else el('rect', { x: o.x, y: o.y, width: o.width, height: o.height, rx: st.radius || 0, ...a }, g);
      if (o.text) {
        const lines = String(o.text).split('\n'), fs = Number(st.fontSize) || 14;
        lines.forEach((ln, i) => { const t = el('text', { x: cx, y: cy + (i - (lines.length - 1) / 2) * fs * 1.2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': fs, fill: st.fontColor || '#000' }, g); t.textContent = ln; });
      }
    }
  }
  // selection
  for (const id of sel) {
    const raw = doc.get(id); if (!raw || raw.type === 'connector') continue;
    const o = eff(raw);
    const g = el('g', {}, overlay);
    if (o.rotation) g.setAttribute('transform', `rotate(${o.rotation} ${o.x + o.width / 2} ${o.y + o.height / 2})`);
    el('rect', { x: o.x, y: o.y, width: o.width, height: o.height, fill: 'none', stroke: '#1a73e8', 'stroke-dasharray': '4 3' }, g);
    if (sel.size === 1 && role !== 'viewer') {
      for (const [n, hx, hy] of handles(o)) el('rect', { x: hx - 4 / view.k, y: hy - 4 / view.k, width: 8 / view.k, height: 8 / view.k, fill: '#fff', stroke: '#1a73e8', 'data-handle': n, style: 'cursor:pointer' }, g);
      el('line', { x1: o.x + o.width / 2, y1: o.y, x2: o.x + o.width / 2, y2: o.y - 24 / view.k, stroke: '#1a73e8' }, g);
      el('circle', { cx: o.x + o.width / 2, cy: o.y - 24 / view.k, r: 5 / view.k, fill: '#fff', stroke: '#1a73e8', 'data-handle': 'rot' }, g);
    }
  }
  for (const gd of guides) {
    if (gd.axis === 'x') el('line', { x1: gd.v, y1: -50000, x2: gd.v, y2: 50000, stroke: '#e0245e', 'stroke-width': 1 / view.k }, overlay);
    else el('line', { x1: -50000, y1: gd.v, x2: 50000, y2: gd.v, stroke: '#e0245e', 'stroke-width': 1 / view.k }, overlay);
  }
  if (marquee) el('rect', { x: marquee.x, y: marquee.y, width: marquee.width, height: marquee.height, fill: '#1a73e822', stroke: '#1a73e8' }, overlay);
  if (preview.has('__new')) { const b = preview.get('__new'); el('rect', { ...b, fill: '#1a73e811', stroke: '#1a73e8', 'stroke-dasharray': '4 3' }, overlay); }
  if (connDraft) el('line', { x1: connDraft.from.x, y1: connDraft.from.y, x2: connDraft.to.x, y2: connDraft.to.y, stroke: '#1a73e8', 'stroke-dasharray': '4 3' }, overlay);
  const colors = ['#e0245e', '#17bf63', '#f45d22', '#794bc4', '#00a3a3'];
  let ci = 0;
  for (const [pid, p] of peers) {
    const c = colors[ci++ % colors.length];
    for (const id of p.selection || []) { const o = doc.get(id); if (o && o.type !== 'connector') el('rect', { x: o.x - 3, y: o.y - 3, width: o.width + 6, height: o.height + 6, fill: 'none', stroke: c, 'stroke-width': 2 }, overlay); }
    if (p.cursor) {
      el('path', { d: `M${p.cursor.x} ${p.cursor.y} l0 14 l4 -4 l6 0z`, fill: c }, overlay);
      const t = el('text', { x: p.cursor.x + 12, y: p.cursor.y + 22, 'font-size': 11 / view.k, fill: c }, overlay); t.textContent = p.user || pid;
    }
  }
  minimap();
  toolbarState();
}
function handles(o) {
  const { x, y, width: w, height: h } = o;
  return [['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + h / 2], ['se', x + w, y + h], ['s', x + w / 2, y + h], ['sw', x, y + h], ['w', x, y + h / 2]];
}
function minimap() {
  const m = $('#minimap'); m.innerHTML = '';
  const b = doc.bounds() || { x: 0, y: 0, width: 100, height: 100 };
  const r = canvas.getBoundingClientRect();
  const vx = -view.x / view.k, vy = -view.y / view.k, vw = r.width / view.k, vh = r.height / view.k;
  const x1 = Math.min(b.x, vx) - 20, y1 = Math.min(b.y, vy) - 20, x2 = Math.max(b.x + b.width, vx + vw) + 20, y2 = Math.max(b.y + b.height, vy + vh) + 20;
  m.setAttribute('viewBox', `${x1} ${y1} ${x2 - x1} ${y2 - y1}`);
  for (const o of doc.elements()) if (o.type !== 'connector') el('rect', { x: o.x, y: o.y, width: o.width, height: o.height, fill: '#9ab' }, m);
  el('rect', { x: vx, y: vy, width: vw, height: vh, fill: 'none', stroke: '#e0245e', 'stroke-width': (x2 - x1) / 160 }, m);
}
function toolbarState() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#toolbar').querySelectorAll('button:not([data-tool]), select').forEach((b) => { if (b.id !== 'docSel' && b.id !== 'newDoc') b.disabled = role === 'viewer' && !['exportSvg', 'exportJson'].includes(b.id); });
}

// ---------- panels ----------
function panels() {
  const ls = $('#layers'); ls.innerHTML = '';
  for (const l of doc.layers().slice().reverse()) {
    const d = document.createElement('div'); d.className = 'layer' + (l.id === activeLayer ? ' act' : '');
    d.innerHTML = `<span>${esc(l.name)}</span><button data-v>${l.visible ? '👁' : '—'}</button><button data-l>${l.locked ? '🔒' : '🔓'}</button><button data-x>✕</button>`;
    d.querySelector('span').onclick = () => { activeLayer = l.id; panels(); };
    d.querySelector('[data-v]').onclick = () => doc.apply({ type: 'updateLayer', id: l.id, patch: { visible: !l.visible } });
    d.querySelector('[data-l]').onclick = () => doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: !l.locked } });
    d.querySelector('[data-x]').onclick = () => { try { doc.apply({ type: 'removeLayer', id: l.id }); } catch (e) { alert(e.message); } };
    ls.appendChild(d);
  }
  const first = [...sel].map((i) => doc.get(i)).find(Boolean);
  const st = first?.style || {};
  $('#pFill').value = st.fill || '#ffffff'; $('#pStroke').value = st.stroke || '#333333';
  $('#pFont').value = st.fontSize || 14; $('#pOpacity').value = st.opacity ?? 1;
}
$('#addLayer').onclick = () => { const n = prompt('Layer name', 'Layer'); if (n) { const id = 'L' + Date.now().toString(36); doc.apply({ type: 'addLayer', layer: { id, name: n } }); activeLayer = id; panels(); } };
function setStyle(style) { if (sel.size) safe(() => doc.apply({ type: 'setStyle', ids: [...sel], style })); }
$('#pFill').oninput = (e) => setStyle({ fill: e.target.value });
$('#pStroke').oninput = (e) => setStyle({ stroke: e.target.value });
$('#pFont').onchange = (e) => setStyle({ fontSize: +e.target.value });
$('#pOpacity').oninput = (e) => setStyle({ opacity: +e.target.value });
function safe(fn) { try { return fn(); } catch (e) { status(e.message); } }

async function loadVersions() {
  const { versions } = await api('GET', `/api/docs/${docMeta.id}/versions`);
  const v = $('#versions'); v.innerHTML = '';
  for (const x of versions.slice().reverse()) {
    const d = document.createElement('div'); d.className = 'ver';
    d.innerHTML = `${esc(x.label || 'version')}<br><small>${new Date(x.created).toLocaleString()}</small> <button>Restore</button>`;
    d.querySelector('button').onclick = async () => { await api('POST', `/api/docs/${docMeta.id}/versions/${x.id}/restore`, {}); const r = await api('GET', `/api/docs/${docMeta.id}/ops?since=${lastSeq}`); doc.receive(r.ops); lastSeq = r.seq; sel.clear(); render(); panels(); };
    v.appendChild(d);
  }
}
$('#saveVersion').onclick = async () => { const label = prompt('Version label', ''); if (label === null) return; await flush(); await api('POST', `/api/docs/${docMeta.id}/versions`, { label }); loadVersions(); };
async function loadComments() {
  const { comments } = await api('GET', `/api/docs/${docMeta.id}/comments`);
  const c = $('#comments'); c.innerHTML = '';
  for (const x of comments) {
    const d = document.createElement('div'); d.className = 'cm' + (x.resolved ? ' res' : '');
    d.innerHTML = `<b>${esc(x.author)}</b> on ${esc(x.elementId)}<br>${esc(x.text)}${x.replies.map((r) => `<div>↳ <b>${esc(r.author)}</b> ${esc(r.text)}</div>`).join('')}<br><button data-r>Reply</button><button data-s>${x.resolved ? 'Reopen' : 'Resolve'}</button>`;
    d.querySelector('[data-r]').onclick = async () => { const t = prompt('Reply'); if (t) { await api('POST', `/api/docs/${docMeta.id}/comments/${x.id}/replies`, { text: t }); loadComments(); } };
    d.querySelector('[data-s]').onclick = async () => { await api('PATCH', `/api/docs/${docMeta.id}/comments/${x.id}`, { resolved: !x.resolved }); loadComments(); };
    d.onclick = (e) => { if (e.target.tagName !== 'BUTTON' && doc.get(x.elementId)) { sel = new Set([x.elementId]); render(); } };
    c.appendChild(d);
  }
}
$('#addComment').onclick = async () => {
  const id = [...sel][0]; const text = $('#newComment').value;
  if (!id || !text.trim()) return status('select an element and type a comment');
  await api('POST', `/api/docs/${docMeta.id}/comments`, { elementId: id, text }); $('#newComment').value = ''; loadComments();
};

// ---------- toolbar ----------
document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => { tool = b.dataset.tool; toolbarState(); }; });
document.querySelectorAll('[data-align]').forEach((b) => { b.onclick = () => safe(() => doc.align([...sel], b.dataset.align)); });
document.querySelectorAll('[data-dist]').forEach((b) => { b.onclick = () => safe(() => doc.distribute([...sel], b.dataset.dist)); });
$('#undo').onclick = () => doc.undo(); $('#redo').onclick = () => doc.redo();
$('#group').onclick = () => sel.size > 1 && safe(() => doc.apply({ type: 'group', ids: [...sel] }));
$('#ungroup').onclick = () => safe(() => { const gids = new Set([...sel].map((i) => doc.get(i)?.groupId).filter(Boolean)); doc.transaction(() => gids.forEach((g) => doc.apply({ type: 'ungroup', groupId: g }))); });
$('#front').onclick = () => safe(() => doc.transaction(() => sel.forEach((i) => doc.apply({ type: 'reorder', id: i, to: 'front' }))));
$('#back').onclick = () => safe(() => doc.transaction(() => sel.forEach((i) => doc.apply({ type: 'reorder', id: i, to: 'back' }))));
$('#layoutSel').onchange = (e) => { const v = e.target.value; e.target.value = ''; if (!v) return; const [k, d] = v.split(':'); safe(() => doc.layout(k, { direction: d || 'TB', spacing: 60 })); };
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const imp = importDrawio(await f.text());
    const existing = new Set(doc.elements().map((o) => o.id));
    const map = (id) => (existing.has(id) ? 'i' + Math.random().toString(36).slice(2, 6) + '-' + id : id);
    const ids = new Map(imp.elements().map((o) => [o.id, map(o.id)]));
    doc.transaction(() => {
      for (const o of imp.elements()) {
        const n = { ...o, id: ids.get(o.id), layer: activeLayer };
        if (o.type === 'connector') { n.source = { ...o.source, elementId: ids.get(o.source.elementId) ?? o.source.elementId }; n.target = { ...o.target, elementId: ids.get(o.target.elementId) ?? o.target.elementId }; delete n.layer; }
        delete n.z;
        doc.apply({ type: 'add', element: n });
      }
    });
  } catch (err) { alert('Import failed: ' + err.message); }
  e.target.value = '';
};
function download(name, type, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
$('#exportSvg').onclick = () => download('diagram.svg', 'image/svg+xml', doc.toSVG());
$('#exportJson').onclick = () => download('diagram.json', 'application/json', JSON.stringify(doc.toJSON(), null, 2));

// ---------- pointer interaction ----------
const pointers = new Map();
let pinch = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const k = Math.min(8, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) / view.k) * k; view.y = my - ((my - view.y) / view.k) * k; view.k = k;
  } else { view.x -= e.deltaY; }
  render();
}, { passive: false });

function targetId(e) { const g = e.target.closest?.('g[data-id]'); return g ? g.getAttribute('data-id') : null; }
function expandGroup(id) { const o = doc.get(id); if (!o?.groupId) return [id]; return doc.elements().filter((x) => x.groupId === o.groupId).map((x) => x.id); }
let spaceDown = false;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; drag = null; return; }
  const w = toWorld(e);
  if (e.button === 1 || spaceDown || e.altKey) { drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
  if (role === 'viewer' && tool !== 'select') return;
  const handle = e.target.getAttribute?.('data-handle');
  if (handle && sel.size === 1) {
    const id = [...sel][0], o = doc.get(id);
    drag = { kind: handle === 'rot' ? 'rotate' : 'resize', handle, id, o, start: w };
    return;
  }
  if (tool === 'select') {
    const id = targetId(e);
    if (id) {
      const ids = expandGroup(id);
      if (e.shiftKey) { ids.forEach((i) => (sel.has(i) ? sel.delete(i) : sel.add(i))); }
      else if (!sel.has(id)) sel = new Set(ids);
      drag = { kind: 'move', start: w, ids: [...sel], moved: false };
      render(); panels(); sendPresence();
    } else {
      if (!e.shiftKey) sel = new Set();
      drag = { kind: 'marquee', start: w, base: new Set(sel) };
      render(); panels();
    }
  } else if (tool === 'connector') {
    const id = targetId(e);
    if (id && doc.get(id)?.type !== 'connector') { drag = { kind: 'connect', from: id }; connDraft = { from: w, to: w }; }
  } else {
    drag = { kind: 'create', start: snapPt(w), type: tool };
  }
});
function snapPt(p) { return snap(p, { grid: GRID }); }

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const w = toWorld(e);
  cursorPos = w; sendPresence();
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = canvas.getBoundingClientRect(); const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const k = Math.min(8, Math.max(0.1, pinch.k * d / pinch.d));
    view.x = mx - ((mx - view.x) / view.k) * k; view.y = my - ((my - view.y) / view.k) * k; view.k = k; render(); return;
  }
  if (!drag) return;
  guides = [];
  if (drag.kind === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; }
  else if (drag.kind === 'move') {
    let dx = w.x - drag.start.x, dy = w.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const first = doc.get(drag.ids[0]);
    if (first && first.type !== 'connector') {
      const others = doc.elements().filter((o) => o.type !== 'connector' && !drag.ids.includes(o.id));
      const gx = [], gy = [];
      for (const o of others) { gx.push(o.x, o.x + o.width / 2, o.x + o.width); gy.push(o.y, o.y + o.height / 2, o.y + o.height); }
      const thr = 6 / view.k;
      const cand = { x: [first.x + dx, first.x + dx + first.width / 2, first.x + dx + first.width], y: [first.y + dy, first.y + dy + first.height / 2, first.y + dy + first.height] };
      const fit = (vals, list) => { let best = null; for (const v of vals) for (const g of list) { const d = g - v; if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, g }; } return best; };
      const bx = fit(cand.x, gx), by = fit(cand.y, gy);
      if (bx) { dx += bx.d; guides.push({ axis: 'x', v: bx.g }); } else dx = Math.round((first.x + dx) / GRID) * GRID - first.x;
      if (by) { dy += by.d; guides.push({ axis: 'y', v: by.g }); } else dy = Math.round((first.y + dy) / GRID) * GRID - first.y;
    }
    preview = new Map();
    for (const id of drag.ids) { const o = doc.get(id); if (o && o.type !== 'connector') preview.set(id, { x: o.x + dx, y: o.y + dy }); }
    drag.dx = dx; drag.dy = dy;
  } else if (drag.kind === 'resize') {
    const o = drag.o, h = drag.handle; let { x, y, width, height } = o;
    const p = e.shiftKey ? w : snapPt(w);
    if (h.includes('e')) width = p.x - o.x; if (h.includes('s')) height = p.y - o.y;
    if (h.includes('w')) { width = o.x + o.width - p.x; x = p.x; } if (h.includes('n')) { height = o.y + o.height - p.y; y = p.y; }
    if (width < 4) { width = 4; x = h.includes('w') ? o.x + o.width - 4 : x; } if (height < 4) { height = 4; y = h.includes('n') ? o.y + o.height - 4 : y; }
    drag.box = { x, y, width, height };
    preview = new Map([[o.id, drag.box]]);
  } else if (drag.kind === 'rotate') {
    const o = drag.o, cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    let deg = (Math.atan2(w.y - cy, w.x - cx) * 180) / Math.PI + 90;
    if (!e.shiftKey) deg = Math.round(deg / 15) * 15;
    drag.deg = ((deg % 360) + 360) % 360; preview = new Map([[o.id, { rotation: drag.deg }]]);
  } else if (drag.kind === 'marquee') {
    const s = drag.start; marquee = { x: Math.min(s.x, w.x), y: Math.min(s.y, w.y), width: Math.abs(w.x - s.x), height: Math.abs(w.y - s.y) };
    sel = new Set([...drag.base, ...doc.select(marquee).map((o) => o.id)]);
  } else if (drag.kind === 'create') {
    const p = snapPt(w), s = drag.start;
    drag.box = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) };
    preview = new Map([['__new', drag.box]]);
  } else if (drag.kind === 'connect') connDraft.to = w;
  render();
});

function endDrag(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  const d = drag; drag = null;
  const w = toWorld(e);
  const hadPreview = preview; preview = new Map(); guides = []; marquee = null; connDraft = null;
  if (!d) { render(); return; }
  safe(() => {
    if (d.kind === 'move' && d.moved) doc.apply({ type: 'move', ids: d.ids.filter((i) => doc.get(i)?.type !== 'connector'), dx: d.dx, dy: d.dy });
    else if (d.kind === 'resize' && d.box) doc.apply({ type: 'resize', id: d.id, box: d.box });
    else if (d.kind === 'rotate' && d.deg !== undefined) doc.apply({ type: 'rotate', id: d.id, deg: d.deg });
    else if (d.kind === 'connect') {
      const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('g[data-id]')?.getAttribute('data-id');
      if (t && t !== d.from && doc.get(t)?.type !== 'connector') {
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        doc.apply({ type: 'add', element: { id, type: 'connector', source: { elementId: d.from }, target: { elementId: t }, routing: 'orthogonal' } });
        sel = new Set([id]);
      }
    } else if (d.kind === 'create') {
      let b = d.box || { x: d.start.x, y: d.start.y, width: 0, height: 0 };
      if (b.width < 5 && b.height < 5) b = { x: d.start.x, y: d.start.y, width: d.type === 'line' ? 100 : d.type === 'text' ? 120 : 100, height: d.type === 'line' ? 0 : d.type === 'text' ? 30 : 60 };
      const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      let text = ''; if (d.type === 'text') text = prompt('Text', 'Text') || 'Text';
      doc.apply({ type: 'add', element: { id, type: d.type, ...b, text, layer: activeLayer, style: d.type === 'text' ? {} : { fill: '#ffffff', stroke: '#333333' } } });
      sel = new Set([id]); tool = 'select';
    }
  });
  render(); panels(); sendPresence();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', (e) => {
  const id = targetId(e); if (!id || role === 'viewer') return;
  const o = doc.get(id);
  if (o.type === 'connector') { const t = prompt('Label', o.label || ''); if (t !== null) safe(() => doc.apply({ type: 'update', id, patch: { label: t } })); }
  else { const t = prompt('Text', o.text || ''); if (t !== null) safe(() => doc.apply({ type: 'update', id, patch: { text: t } })); }
});

// ---------- keyboard ----------
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
window.addEventListener('keydown', (e) => {
  if (!doc || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { spaceDown = true; e.preventDefault(); return; }
  if (role === 'viewer') return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doc.redo() : doc.undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); doc.redo(); }
  else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); sel = new Set(doc.elements().map((o) => o.id)); render(); }
  else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); $('#group').click(); }
  else if (mod && e.key.toLowerCase() === 'c') { clipboard = [...sel].map((i) => doc.get(i)).filter(Boolean); }
  else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(20); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); clipboard = [...sel].map((i) => doc.get(i)).filter(Boolean); paste(20); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { safe(() => doc.transaction(() => { for (const i of sel) if (doc.get(i)) doc.apply({ type: 'remove', id: i }); })); sel = new Set(); render(); }
  else if (e.key.startsWith('Arrow') && sel.size) {
    e.preventDefault();
    const s = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
    safe(() => doc.apply({ type: 'move', ids: [...sel].filter((i) => doc.get(i)?.type !== 'connector'), dx, dy }));
  } else if (e.key === 'Escape') { sel = new Set(); tool = 'select'; render(); }
  else if (!mod && e.key.toLowerCase() === 'v') { tool = 'select'; toolbarState(); }
  else if (!mod && e.key.toLowerCase() === 'c') { tool = 'connector'; toolbarState(); }
  else if (!mod && e.key.toLowerCase() === 'r') { tool = 'rect'; toolbarState(); }
});
function paste(off) {
  if (!clipboard.length) return;
  const map = new Map(clipboard.map((o) => [o.id, 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)]));
  const ns = new Set();
  safe(() => doc.transaction(() => {
    for (const o of clipboard) {
      const n = JSON.parse(JSON.stringify(o)); n.id = map.get(o.id); delete n.z; delete n.groupId;
      if (o.type === 'connector') {
        if (!map.has(o.source?.elementId) || !map.has(o.target?.elementId)) continue;
        n.source.elementId = map.get(o.source.elementId); n.target.elementId = map.get(o.target.elementId);
        n.waypoints = (o.waypoints || []).map((p) => ({ x: p.x + off, y: p.y + off }));
      } else { n.x += off; n.y += off; }
      doc.apply({ type: 'add', element: n }); ns.add(n.id);
    }
  }));
  clipboard = clipboard.map((o) => (o.type === 'connector' ? o : { ...o, x: o.x + off, y: o.y + off }));
  sel = ns; render(); panels();
}
window.addEventListener('resize', () => doc && render());

if (token) api('GET', '/api/auth/me').then((r) => { me = r.user; start(); }).catch(() => { token = null; localStorage.removeItem('token'); });
