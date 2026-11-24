import { createDocument, fromJSON, importDrawio, snap } from '/static/core/index.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
let token = localStorage.getItem('token'), me = localStorage.getItem('username');
const actor = 'c-' + Math.random().toString(36).slice(2, 8);
let docId = null, doc = null, ws = null, lastSeq = 0, queue = [], online = false;
let tool = 'select', selection = new Set(), activeLayer = 'default', view = { x: 0, y: 0, k: 1 };
let drag = null, guides = [], remote = new Map(), clipboard = [];
const GRID = 10;

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j.message || r.statusText);
  return j;
}
// ---------- auth & docs ----------
async function auth(kind) {
  try {
    const u = $('#user').value, p = $('#pass').value;
    if (kind === 'register') await api('POST', '/auth/register', { username: u, password: p });
    const r = await api('POST', '/auth/login', { username: u, password: p });
    token = r.token; me = u; localStorage.setItem('token', token); localStorage.setItem('username', me);
    showDocs();
  } catch (e) { $('#autherr').textContent = e.message; }
}
$('#login').onclick = () => auth('login'); $('#register').onclick = () => auth('register');
async function showDocs() {
  $('#auth').hidden = true; $('#app').hidden = true; $('#docs').hidden = false;
  try {
    const { docs } = await api('GET', '/docs');
    $('#doclist').innerHTML = '';
    for (const d of docs) { const li = document.createElement('li'); li.textContent = `${d.title} (${d.role})`; li.style.cursor = 'pointer'; li.onclick = () => openDoc(d.id); $('#doclist').appendChild(li); }
  } catch { token = null; $('#auth').hidden = false; $('#docs').hidden = true; }
}
$('#newdoc').onclick = async () => { const d = await api('POST', '/docs', { title: prompt('Title', 'Untitled') || 'Untitled' }); openDoc(d.id); };

// ---------- document + sync ----------
async function openDoc(id) {
  docId = id;
  const snapJson = await api('GET', '/docs/' + id);
  doc = fromJSON(snapJson, { actor }); lastSeq = snapJson.seq;
  queue = JSON.parse(localStorage.getItem('queue:' + id) || '[]');
  doc.on('op', (op) => { queue.push(op); localStorage.setItem('queue:' + docId, JSON.stringify(queue)); flush(); });
  doc.on('change', () => { render(); refreshSide(); });
  $('#docs').hidden = true; $('#app').hidden = false;
  connect(); render(); refreshSide(); loadVersions(); loadComments(); fitView();
  if (queue.length) flush();
}
function connect() {
  if (ws) try { ws.close(); } catch { /* */ }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/docs/${docId}?token=${token}&actor=${actor}`);
  ws.onopen = async () => { online = true; $('#status').textContent = 'online'; try { await pull(); } catch { /* */ } flush(); };
  ws.onclose = () => { online = false; $('#status').textContent = 'offline (edits queued)'; setTimeout(() => docId && connect(), 2000); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'ops') { doc.receive(m.ops); lastSeq = Math.max(lastSeq, m.seq); }
    else if (m.type === 'presence') { if (m.gone) remote.delete(m.actor); else remote.set(m.actor, m); renderOverlay(); refreshPeople(); }
    else if (m.type === 'comments') loadComments();
  };
}
async function pull() { const r = await api('GET', `/docs/${docId}/ops?since=${lastSeq}`); doc.receive(r.ops); lastSeq = r.seq; }
let flushing = false;
async function flush() {
  if (flushing || !queue.length || !online) return;
  flushing = true;
  try {
    const batch = queue.slice();
    const r = await api('POST', `/docs/${docId}/ops`, { ops: batch });
    queue = queue.slice(batch.length); localStorage.setItem('queue:' + docId, JSON.stringify(queue));
    lastSeq = Math.max(lastSeq, r.seq);
  } catch { /* retry on next op / reconnect */ }
  flushing = false;
  if (queue.length) setTimeout(flush, 1000);
}
let lastPresence = 0;
function sendPresence(cursor) {
  const now = Date.now(); if (now - lastPresence < 50 || !ws || ws.readyState !== 1) return; lastPresence = now;
  ws.send(JSON.stringify({ type: 'presence', actor, cursor, selection: [...selection] }));
}

// ---------- rendering ----------
const canvas = $('#canvas'), content = $('#content'), overlay = $('#overlay');
const toWorld = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k }; };
function applyView() { $('#vp').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`); }
function drawShape(e, parent) {
  const st = e.style || {};
  const g = el('g', { 'data-id': e.id }, parent);
  if (st.opacity !== undefined) g.setAttribute('opacity', st.opacity);
  const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
  if (e.rotation) g.setAttribute('transform', `rotate(${e.rotation} ${cx} ${cy})`);
  const a = { fill: st.fill ?? '#ffffff', stroke: st.stroke ?? '#000000', 'stroke-width': st.strokeWidth ?? 1 };
  if (e.type === 'rect') el('rect', { x: e.x, y: e.y, width: e.width, height: e.height, ...a }, g);
  else if (e.type === 'ellipse') el('ellipse', { cx, cy, rx: e.width / 2, ry: e.height / 2, ...a }, g);
  else if (e.type === 'diamond') el('polygon', { points: `${cx},${e.y} ${e.x + e.width},${cy} ${cx},${e.y + e.height} ${e.x},${cy}`, ...a }, g);
  else if (e.type === 'line') el('line', { x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height, stroke: a.stroke, 'stroke-width': a['stroke-width'] }, g);
  else if (e.type === 'image') el('image', { x: e.x, y: e.y, width: e.width, height: e.height, href: st.src || '' }, g);
  if (e.text) { const t = el('text', { x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': st.fontSize ?? 14, fill: st.color ?? '#000' }, g); t.textContent = e.text; }
}
function render() {
  if (!doc) return;
  content.innerHTML = '';
  const layers = new Map(doc.layers().map((l) => [l.id, l]));
  for (const e of doc.elements()) {
    if (layers.get(e.layer)?.visible === false) continue;
    if (e.type === 'connector') {
      let pts; try { pts = doc.route(e.id); } catch { continue; }
      const g = el('g', { 'data-id': e.id }, content);
      el('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: e.style?.stroke ?? '#000', 'stroke-width': e.style?.strokeWidth ?? 1.5 }, g);
      const [ax, ay] = pts[pts.length - 1], [bx, by] = pts[Math.max(0, pts.length - 2)];
      const ang = Math.atan2(ay - by, ax - bx);
      el('polygon', { points: `${ax},${ay} ${ax - 10 * Math.cos(ang - 0.4)},${ay - 10 * Math.sin(ang - 0.4)} ${ax - 10 * Math.cos(ang + 0.4)},${ay - 10 * Math.sin(ang + 0.4)}`, fill: e.style?.stroke ?? '#000' }, g);
      if (e.label) { const m = pts[Math.floor(pts.length / 2)]; const t = el('text', { x: m[0], y: m[1] - 4, 'text-anchor': 'middle', 'font-size': 12 }, g); t.textContent = e.label; }
    } else drawShape(e, content);
  }
  renderOverlay(); renderMinimap();
}
function renderOverlay() {
  overlay.innerHTML = '';
  if (!doc) return;
  for (const g of guides) el('line', g.axis === 'x' ? { x1: g.v, y1: -1e5, x2: g.v, y2: 1e5, stroke: '#f0f', 'stroke-width': 1 / view.k } : { x1: -1e5, y1: g.v, x2: 1e5, y2: g.v, stroke: '#f0f', 'stroke-width': 1 / view.k }, overlay);
  const sel = [...selection].map((id) => doc.get(id)).filter((e) => e && e.type !== 'connector');
  for (const s of sel) {
    el('rect', { class: 'sel', x: s.x, y: s.y, width: s.width, height: s.height, transform: s.rotation ? `rotate(${s.rotation} ${s.x + s.width / 2} ${s.y + s.height / 2})` : '' }, overlay);
  }
  if (sel.length === 1) {
    const s = sel[0], hs = 8 / view.k;
    for (const h of handles(s)) { const r = el('rect', { class: 'handle', x: h.x - hs / 2, y: h.y - hs / 2, width: hs, height: hs, 'data-handle': h.name, 'stroke-width': 1 / view.k }, overlay); if (h.name === 'rot') { r.setAttribute('rx', hs / 2); } }
  }
  for (const [a, p] of remote) {
    if (p.cursor) { el('circle', { cx: p.cursor.x, cy: p.cursor.y, r: 4 / view.k, fill: colorOf(a) }, overlay); const t = el('text', { x: p.cursor.x + 6 / view.k, y: p.cursor.y - 6 / view.k, 'font-size': 11 / view.k, fill: colorOf(a) }, overlay); t.textContent = p.user || a; }
    for (const id of p.selection || []) { const s = doc.get(id); if (s && s.type !== 'connector') el('rect', { x: s.x, y: s.y, width: s.width, height: s.height, fill: 'none', stroke: colorOf(a), 'stroke-width': 2 / view.k }, overlay); }
  }
}
const colorOf = (a) => `hsl(${[...a].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)} 70% 45%)`;
function rotPt(s, x, y) { const cx = s.x + s.width / 2, cy = s.y + s.height / 2, a = (s.rotation || 0) * Math.PI / 180; const dx = x - cx, dy = y - cy; return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) }; }
function handles(s) {
  const xs = [s.x, s.x + s.width / 2, s.x + s.width], ys = [s.y, s.y + s.height / 2, s.y + s.height];
  const names = [['nw', 0, 0], ['n', 1, 0], ['ne', 2, 0], ['e', 2, 1], ['se', 2, 2], ['s', 1, 2], ['sw', 0, 2], ['w', 0, 1]];
  const out = names.map(([n, i, j]) => ({ name: n, ...rotPt(s, xs[i], ys[j]) }));
  out.push({ name: 'rot', ...rotPt(s, s.x + s.width / 2, s.y - 25 / view.k) });
  return out;
}
function renderMinimap() {
  const mm = $('#minimap'); mm.innerHTML = '';
  const b = doc.bounds(); if (!b) return;
  const pad = 20; mm.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);
  for (const s of doc.elements()) if (s.type !== 'connector') el('rect', { x: s.x, y: s.y, width: s.width, height: s.height, fill: '#9bd', stroke: '#235' }, mm);
  const r = canvas.getBoundingClientRect();
  el('rect', { x: -view.x / view.k, y: -view.y / view.k, width: r.width / view.k, height: r.height / view.k, fill: 'none', stroke: 'red', 'stroke-width': Math.max(1, b.width / 150) }, mm);
}
function fitView() {
  const b = doc.bounds(); const r = canvas.getBoundingClientRect();
  if (!b || !r.width) { view = { x: 0, y: 0, k: 1 }; applyView(); return; }
  view.k = Math.min(1.5, r.width / (b.width + 100), r.height / (b.height + 100));
  view.x = r.width / 2 - (b.x + b.width / 2) * view.k; view.y = r.height / 2 - (b.y + b.height / 2) * view.k; applyView(); renderMinimap();
}

// ---------- interaction ----------
function setTool(t) { tool = t; document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); canvas.style.cursor = t === 'select' ? 'default' : 'crosshair'; }
document.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
setTool('select');
const uid = () => actor + '-' + Math.random().toString(36).slice(2, 9);
const safe = (fn) => { try { return fn(); } catch (e) { $('#status').textContent = e.message; } };
function snapGuides(ids, box) {
  const others = doc.elements().filter((e) => e.type !== 'connector' && !ids.includes(e.id));
  const gx = [], gy = [];
  for (const o of others) { gx.push(o.x, o.x + o.width / 2, o.x + o.width); gy.push(o.y, o.y + o.height / 2, o.y + o.height); }
  return { x: gx, y: gy };
}
canvas.addEventListener('pointerdown', (ev) => {
  canvas.focus(); canvas.setPointerCapture(ev.pointerId);
  const p = toWorld(ev);
  if (ev.button === 1 || ev.altKey || ev.getModifierState?.('Space')) { drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y }; return; }
  if (tool === 'select') {
    const hnd = ev.target.getAttribute?.('data-handle');
    if (hnd) { const s = doc.get([...selection][0]); drag = { kind: hnd === 'rot' ? 'rotate' : 'resize', h: hnd, id: s.id, orig: { ...s }, tx: doc.transaction.bind(doc) }; return; }
    const hit = doc.hitTest(p.x, p.y);
    let hitConn = null;
    if (!hit) for (const c of doc.elements({ type: 'connector' })) { try { const r = doc.route(c.id); for (let i = 0; i + 1 < r.length; i++) if (distSeg(p, r[i], r[i + 1]) < 5 / view.k) hitConn = c; } catch { /* */ } }
    const target = hit || hitConn;
    if (target) {
      const ids = target.groupId ? doc.elements().filter((e) => e.groupId === target.groupId).map((e) => e.id) : [target.id];
      if (ev.shiftKey) { ids.forEach((i) => (selection.has(i) ? selection.delete(i) : selection.add(i))); }
      else if (!selection.has(target.id)) selection = new Set(ids);
      drag = { kind: 'move', start: p, last: p, total: { x: 0, y: 0 }, started: false };
    } else {
      if (!ev.shiftKey) selection = new Set();
      drag = { kind: 'marquee', start: p, cur: p };
    }
    renderOverlay(); refreshSide(); return;
  }
  const sp = snap(p, { grid: GRID });
  drag = { kind: 'create', start: sp, cur: sp, tool };
  if (tool === 'connector') { const hit = doc.hitTest(p.x, p.y); drag.source = hit?.id; }
});
canvas.addEventListener('pointermove', (ev) => {
  const p = toWorld(ev); sendPresence(p);
  if (!drag) return;
  if (drag.kind === 'pan') { view.x = drag.vx + ev.clientX - drag.sx; view.y = drag.vy + ev.clientY - drag.sy; applyView(); renderMinimap(); return; }
  if (drag.kind === 'move') {
    const ids = [...selection];
    let dx = p.x - drag.last.x, dy = p.y - drag.last.y;
    if (!drag.started && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * view.k < 3) return;
    if (!drag.started) { drag.started = true; drag.txOpen = true; }
    // snapping of the combined box
    const b = doc.bounds(ids.filter((i) => doc.get(i)?.type !== 'connector'));
    guides = [];
    if (b) {
      const g = snapGuides(ids, b); const nx = b.x + dx, ny = b.y + dy;
      const sx = snap({ x: nx, y: ny }, { guides: g, grid: GRID });
      const sx2 = snap({ x: nx + b.width, y: ny + b.height }, { guides: g });
      if (sx2.x !== nx + b.width) { dx += sx2.x - (nx + b.width); guides.push({ axis: 'x', v: sx2.x }); } else { if (sx.x !== nx) dx += sx.x - nx; if (g.x.includes(sx.x)) guides.push({ axis: 'x', v: sx.x }); }
      if (sx2.y !== ny + b.height) { dy += sx2.y - (ny + b.height); guides.push({ axis: 'y', v: sx2.y }); } else { if (sx.y !== ny) dy += sx.y - ny; if (g.y.includes(sx.y)) guides.push({ axis: 'y', v: sx.y }); }
    }
    safe(() => { doc.apply({ type: 'move', ids, dx, dy }); });
    drag.last = { x: drag.last.x + dx, y: drag.last.y + dy }; drag.merged = (drag.merged || 0) + 1;
    return;
  }
  if (drag.kind === 'resize') {
    const o = drag.orig; let x1 = o.x, y1 = o.y, x2 = o.x + o.width, y2 = o.y + o.height;
    const a = -(o.rotation || 0) * Math.PI / 180, cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    const lp = { x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a) };
    const sn = snap(lp, { grid: GRID });
    if (drag.h.includes('w')) x1 = Math.min(sn.x, x2); if (drag.h.includes('e')) x2 = Math.max(sn.x, x1);
    if (drag.h.includes('n')) y1 = Math.min(sn.y, y2); if (drag.h.includes('s')) y2 = Math.max(sn.y, y1);
    safe(() => doc.apply({ type: 'resize', id: o.id, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, keepAspect: ev.shiftKey }));
    drag.merged = (drag.merged || 0) + 1; return;
  }
  if (drag.kind === 'rotate') {
    const o = drag.orig, cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    let deg = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90; if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    safe(() => doc.apply({ type: 'rotate', id: o.id, deg: Math.round(deg) })); drag.merged = (drag.merged || 0) + 1; return;
  }
  if (drag.kind === 'marquee') { drag.cur = p; overlay.querySelector('.marq')?.remove(); el('rect', { class: 'sel marq', x: Math.min(drag.start.x, p.x), y: Math.min(drag.start.y, p.y), width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y) }, overlay); return; }
  if (drag.kind === 'create') { drag.cur = snap(p, { grid: GRID }); overlay.querySelector('.marq')?.remove(); el('rect', { class: 'sel marq', x: Math.min(drag.start.x, drag.cur.x), y: Math.min(drag.start.y, drag.cur.y), width: Math.abs(drag.cur.x - drag.start.x), height: Math.abs(drag.cur.y - drag.start.y) }, overlay); }
});
// Merge the many incremental ops of one gesture into one undo step by undoing/redoing nothing: we group via history marker.
canvas.addEventListener('pointerup', (ev) => {
  const d = drag; drag = null; guides = [];
  if (!d) return;
  const p = toWorld(ev);
  if (d.kind === 'marquee') {
    const r = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), width: Math.abs(p.x - d.start.x), height: Math.abs(p.y - d.start.y) };
    for (const id of doc.select(r)) selection.add(id);
  } else if (d.kind === 'create') {
    const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y), w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
    if (d.tool === 'connector') {
      const tgt = doc.hitTest(p.x, p.y);
      if (d.source && tgt && tgt.id !== d.source) { const id = uid(); safe(() => doc.apply({ type: 'add', element: { id, type: 'connector', source: { elementId: d.source }, target: { elementId: tgt.id }, routing: $('#routing').value } })); selection = new Set([id]); }
    } else {
      const id = uid(); const big = w > 4 || h > 4;
      const el0 = { id, type: d.tool, x, y, width: big ? w : 100, height: big ? h : d.tool === 'text' ? 30 : 60, layer: activeLayer, text: d.tool === 'text' ? 'Text' : '', style: d.tool === 'text' ? { fill: 'none', stroke: 'none' } : {} };
      safe(() => doc.apply({ type: 'add', element: el0 })); selection = new Set([id]);
    }
    setTool('select');
  }
  renderOverlay(); refreshSide();
});
canvas.addEventListener('dblclick', (ev) => {
  const p = toWorld(ev); const hit = doc.hitTest(p.x, p.y);
  if (hit) { const t = prompt('Text', hit.text); if (t !== null) safe(() => doc.apply({ type: 'update', id: hit.id, patch: { text: t } })); }
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect(); const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  if (ev.ctrlKey || ev.metaKey || true) { // wheel zooms (pinch on trackpads arrives as ctrl+wheel)
    const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
    const k = Math.max(0.1, Math.min(8, view.k * f));
    view.x = mx - (mx - view.x) * (k / view.k); view.y = my - (my - view.y) * (k / view.k); view.k = k;
  }
  applyView(); renderOverlay(); renderMinimap();
}, { passive: false });
let pinch = null;
canvas.addEventListener('touchmove', (ev) => {
  if (ev.touches.length !== 2) return;
  const d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
  if (pinch) { view.k = Math.max(0.1, Math.min(8, view.k * d / pinch)); applyView(); renderMinimap(); }
  pinch = d;
}, { passive: true });
canvas.addEventListener('touchend', () => { pinch = null; });
function distSeg(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy; let t = l2 ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy)); }

canvas.addEventListener('keydown', (ev) => {
  const ids = [...selection]; const mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'Delete' || ev.key === 'Backspace') { doc.transaction(() => ids.forEach((id) => doc.get(id) && safe(() => doc.apply({ type: 'remove', id })))); selection = new Set(); }
  else if (mod && ev.key.toLowerCase() === 'z') { ev.shiftKey ? doc.redo() : doc.undo(); }
  else if (mod && ev.key.toLowerCase() === 'y') doc.redo();
  else if (mod && ev.key.toLowerCase() === 'c') clipboard = ids.map((i) => doc.get(i)).filter(Boolean);
  else if (mod && ev.key.toLowerCase() === 'v') paste(30);
  else if (mod && ev.key.toLowerCase() === 'd') { clipboard = ids.map((i) => doc.get(i)).filter(Boolean); paste(20); }
  else if (mod && ev.key.toLowerCase() === 'a') { selection = new Set(doc.elements().map((e) => e.id)); }
  else if (mod && ev.key.toLowerCase() === 'g') { const gid = ev.shiftKey ? null : safe(() => doc.apply({ type: 'group', ids })); if (ev.shiftKey) ids.forEach((i) => { const g = doc.get(i)?.groupId; if (g) safe(() => doc.apply({ type: 'ungroup', groupId: g })); }); }
  else if (ev.key.startsWith('Arrow')) { const s = ev.shiftKey ? 10 : 1; safe(() => doc.apply({ type: 'move', ids, dx: ev.key === 'ArrowLeft' ? -s : ev.key === 'ArrowRight' ? s : 0, dy: ev.key === 'ArrowUp' ? -s : ev.key === 'ArrowDown' ? s : 0 })); }
  else if (ev.key === 'Escape') { selection = new Set(); setTool('select'); }
  else return;
  ev.preventDefault(); renderOverlay(); refreshSide();
});
function paste(off) {
  const map = new Map(), ids = [];
  doc.transaction(() => {
    for (const e of clipboard) { const id = uid(); map.set(e.id, id); ids.push(id); }
    for (const e of clipboard) {
      const n = { ...e, id: map.get(e.id), groupId: null, z: undefined };
      if (e.type === 'connector') { if (!map.has(e.source.elementId) || !map.has(e.target.elementId)) continue; n.source = { ...e.source, elementId: map.get(e.source.elementId) }; n.target = { ...e.target, elementId: map.get(e.target.elementId) }; n.waypoints = []; }
      else { n.x += off; n.y += off; }
      safe(() => doc.apply({ type: 'add', element: n }));
    }
  });
  selection = new Set(ids);
}

// ---------- toolbar ----------
$('#undo').onclick = () => doc.undo(); $('#redo').onclick = () => doc.redo();
$('#del').onclick = () => { doc.transaction(() => [...selection].forEach((id) => doc.get(id) && safe(() => doc.apply({ type: 'remove', id })))); selection = new Set(); renderOverlay(); };
document.querySelectorAll('[data-align]').forEach((b) => { b.onclick = () => safe(() => doc.align([...selection].filter((i) => doc.get(i)?.type !== 'connector'), b.dataset.align)); });
document.querySelectorAll('[data-dist]').forEach((b) => { b.onclick = () => safe(() => doc.distribute([...selection].filter((i) => doc.get(i)?.type !== 'connector'), b.dataset.dist)); });
$('#layout').onchange = (e) => { const v = e.target.value; if (v) safe(() => v === 'grid' ? doc.layout('grid') : doc.layout('layered', { direction: v.split('-')[1] })); e.target.value = ''; fitView(); };
$('#routing').onchange = (e) => { for (const id of selection) if (doc.get(id)?.type === 'connector') safe(() => doc.apply({ type: 'update', id, patch: { routing: e.target.value } })); };
$('#zoomin').onclick = () => { view.k = Math.min(8, view.k * 1.2); applyView(); renderMinimap(); };
$('#zoomout').onclick = () => { view.k = Math.max(0.1, view.k / 1.2); applyView(); renderMinimap(); };
const download = (name, text, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); };
$('#expsvg').onclick = () => download('diagram.svg', doc.toSVG(), 'image/svg+xml');
$('#expjson').onclick = () => download('diagram.json', JSON.stringify(doc.toJSON()), 'application/json');
$('#importbtn').onclick = () => $('#importfile').click();
$('#importfile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; const text = await f.text();
  safe(() => {
    const imp = importDrawio(text); const map = new Map();
    doc.transaction(() => {
      const list = imp.elements();
      for (const x of list) if (x.type !== 'connector') { const id = uid(); map.set(x.id, id); doc.apply({ type: 'add', element: { ...x, id, z: undefined, layer: activeLayer } }); }
      for (const x of list) if (x.type === 'connector') doc.apply({ type: 'add', element: { ...x, id: uid(), z: undefined, layer: activeLayer, source: { ...x.source, elementId: map.get(x.source.elementId) }, target: { ...x.target, elementId: map.get(x.target.elementId) } } });
    });
    fitView();
  });
  e.target.value = '';
};

// ---------- side panels ----------
function styleSel(patch) { const ids = [...selection]; if (ids.length) safe(() => doc.apply({ type: 'setStyle', ids, style: patch })); }
$('#p-fill').oninput = (e) => styleSel({ fill: e.target.value });
$('#p-stroke').oninput = (e) => styleSel({ stroke: e.target.value });
$('#p-sw').oninput = (e) => styleSel({ strokeWidth: Number(e.target.value) });
$('#p-fs').oninput = (e) => styleSel({ fontSize: Number(e.target.value) });
$('#p-op').oninput = (e) => styleSel({ opacity: Number(e.target.value) });
$('#p-text').onchange = (e) => { for (const id of selection) { const c = doc.get(id); if (c) safe(() => doc.apply({ type: 'update', id, patch: c.type === 'connector' ? { label: e.target.value } : { text: e.target.value } })); } };
function refreshSide() {
  if (!doc) return;
  const first = doc.get([...selection][0]);
  if (first) { $('#p-fill').value = /^#[0-9a-f]{6}$/i.test(first.style?.fill) ? first.style.fill : '#ffffff'; $('#p-stroke').value = /^#[0-9a-f]{6}$/i.test(first.style?.stroke) ? first.style.stroke : '#000000'; $('#p-sw').value = first.style?.strokeWidth ?? 1; $('#p-fs').value = first.style?.fontSize ?? 14; $('#p-op').value = first.style?.opacity ?? 1; $('#p-text').value = (first.type === 'connector' ? first.label : first.text) || ''; }
  const ll = $('#layerlist'); ll.innerHTML = '';
  for (const l of [...doc.layers()].reverse()) {
    const li = document.createElement('li'); li.className = l.id === activeLayer ? 'active' : '';
    li.innerHTML = `<span>${l.name}</span> <button data-a="v">${l.visible ? '👁' : '–'}</button><button data-a="l">${l.locked ? '🔒' : '🔓'}</button>`;
    li.querySelector('span').onclick = () => { activeLayer = l.id; refreshSide(); };
    li.querySelector('[data-a=v]').onclick = () => safe(() => doc.apply({ type: 'updateLayer', id: l.id, patch: { visible: !l.visible } }));
    li.querySelector('[data-a=l]').onclick = () => safe(() => doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: !l.locked } }));
    ll.appendChild(li);
  }
  refreshPeople();
}
$('#addlayer').onclick = () => { const n = prompt('Layer name', 'Layer'); if (n) safe(() => doc.apply({ type: 'addLayer', layer: { id: uid(), name: n } })); };
function refreshPeople() { const ul = $('#plist'); ul.innerHTML = ''; const li0 = document.createElement('li'); li0.textContent = me + ' (you)'; ul.appendChild(li0); for (const [a, p] of remote) { const li = document.createElement('li'); li.textContent = p.user || a; li.style.color = colorOf(a); ul.appendChild(li); } }
async function loadVersions() {
  const { versions } = await api('GET', `/docs/${docId}/versions`); const ul = $('#verlist'); ul.innerHTML = '';
  for (const v of versions) { const li = document.createElement('li'); li.textContent = `${v.label || 'version'} — ${new Date(v.createdAt).toLocaleString()} `; const b = document.createElement('button'); b.textContent = 'Restore'; b.onclick = async () => { await api('POST', `/docs/${docId}/versions/${v.id}/restore`); await pull(); }; li.appendChild(b); ul.appendChild(li); }
}
$('#savever').onclick = async () => { await api('POST', `/docs/${docId}/versions`, { label: prompt('Label', 'v') || '' }); loadVersions(); };
async function loadComments() {
  const { comments } = await api('GET', `/docs/${docId}/comments`); const ul = $('#clist'); ul.innerHTML = '';
  for (const c of comments) {
    const li = document.createElement('li'); li.style.opacity = c.resolved ? 0.5 : 1;
    li.innerHTML = `<b>${esc(c.author)}</b> on ${esc(c.elementId)}: ${esc(c.text)}` + c.replies.map((r) => `<div>↳ <b>${esc(r.author)}</b>: ${esc(r.text)}</div>`).join('');
    const rb = document.createElement('button'); rb.textContent = 'Reply'; rb.onclick = async () => { const t = prompt('Reply'); if (t) { await api('POST', `/docs/${docId}/comments/${c.id}/replies`, { text: t }); loadComments(); } };
    const sb = document.createElement('button'); sb.textContent = c.resolved ? 'Reopen' : 'Resolve'; sb.onclick = async () => { await api('POST', `/docs/${docId}/comments/${c.id}/${c.resolved ? 'unresolve' : 'resolve'}`, {}); loadComments(); };
    li.append(rb, sb); li.onclick = (e) => { if (e.target.tagName !== 'BUTTON' && doc.get(c.elementId)) { selection = new Set([c.elementId]); renderOverlay(); } }; ul.appendChild(li);
  }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
$('#addcomment').onclick = async () => { const id = [...selection][0]; if (!id) return alert('Select an element first'); await api('POST', `/docs/${docId}/comments`, { elementId: id, text: $('#ctext').value }); $('#ctext').value = ''; loadComments(); };
window.addEventListener('online', () => { if (!ws || ws.readyState > 1) connect(); });
if (token) showDocs();
