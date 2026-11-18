// Kanban S3 single-page UI.
// Toast, rendering structure and drag & drop logic adapted from zjambor/kanban-board
// (MIT, Copyright (c) 2026 Zoltan Jambor) — see src/THIRD_PARTY_NOTICES.md.

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const ACCENTS = ['--col-todo', '--col-progress', '--col-validation', '--col-completed'];

let token = localStorage.getItem('kanban-token');
let me = null;
let board = null;
let draggingId = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Toast ---------- */
function toast(message, type = 'info') {
  const icons = { success: '✔', error: '✖', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3200);
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') { logoutLocal(); }
    throw new Error(data.message || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------- Views ---------- */
function show(view) {
  for (const v of ['view-auth', 'view-boards', 'view-board']) $(v).classList.toggle('hidden', v !== view);
  const authed = view !== 'view-auth';
  $('btn-logout').classList.toggle('hidden', !authed);
  $('btn-boards').classList.toggle('hidden', view !== 'view-board');
  $('user-chip').classList.toggle('hidden', !authed);
  if (me) $('user-chip').textContent = me.displayName;
}

function logoutLocal() {
  token = null; me = null; board = null;
  localStorage.removeItem('kanban-token');
  show('view-auth');
}

async function start() {
  if (token) {
    try { me = (await api('GET', '/api/auth/me')).user; return showBoards(); } catch { /* fall through */ }
  }
  show('view-auth');
}

/* ---------- Auth ---------- */
function authError(msg) { const e = $('auth-error'); e.textContent = msg; e.classList.toggle('hidden', !msg); }

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/auth/login', { username: $('username').value, password: $('password').value });
    token = r.token; me = r.user; localStorage.setItem('kanban-token', token);
    authError(''); showBoards();
  } catch (err) { authError(err.message); }
});

$('btn-register').addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/register', { username: $('username').value, password: $('password').value });
    toast('Registered — logging in', 'success');
    $('auth-form').requestSubmit();
  } catch (err) { authError(err.message); }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  logoutLocal();
});
$('btn-boards').addEventListener('click', () => showBoards());

/* ---------- Boards list ---------- */
async function showBoards() {
  show('view-boards');
  const boards = await api('GET', '/api/boards');
  $('board-list').innerHTML = boards.length
    ? boards.map((b) => `<li data-id="${escapeHtml(b.id)}"><span>${escapeHtml(b.name)}</span><span class="muted">${escapeHtml(b.role)}</span></li>`).join('')
    : '<li class="muted">No boards yet</li>';
}

$('board-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openBoard(li.dataset.id);
});

$('board-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const b = await api('POST', '/api/boards', { name: $('board-name').value });
    $('board-name').value = '';
    openBoard(b.id);
  } catch (err) { toast(err.message, 'error'); }
});

/* ---------- Board view ---------- */
async function openBoard(id) {
  try {
    board = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
  } catch (err) { toast(err.message, 'error'); return; }
  show('view-board');
  $('board-title').textContent = board.name;
  const role = board.members.find((m) => m.userId === me.id)?.role || '';
  $('board-role').textContent = `Your role: ${role}`;
  renderAll();
}
const reloadBoard = () => openBoard(board.id);
const canEdit = () => ['owner', 'editor'].includes(board.members.find((m) => m.userId === me.id)?.role);

function cardHtml(c, colIdx) {
  const desc = c.description ? `<p class="card-desc">${escapeHtml(c.description)}</p>` : '';
  const edit = canEdit();
  const left = colIdx > 0 ? `<button class="btn btn-ghost" data-action="move" data-dir="-1">◀</button>` : '';
  const right = colIdx < board.columns.length - 1 ? `<button class="btn btn-ghost" data-action="move" data-dir="1">▶</button>` : '';
  return `
    <article class="card" draggable="${edit}" data-id="${escapeHtml(c.id)}">
      <div class="card-top">
        <h3 class="card-title">${escapeHtml(c.title)}</h3>
        ${edit ? `<div class="card-actions"><button class="btn-icon" data-action="delete" title="Delete">🗑</button></div>` : ''}
      </div>
      ${desc}
      <div class="card-meta">${c.dueDate ? `<span class="card-date">Due ${escapeHtml(c.dueDate)}</span>` : ''}</div>
      ${edit ? `<div class="move-btns">${left}${right}</div>` : ''}
    </article>`;
}

function renderAll() {
  const edit = canEdit();
  boardEl.innerHTML = board.columns.map((col, i) => `
    <section class="column" data-column="${escapeHtml(col.id)}" style="--col-accent: var(${ACCENTS[i % ACCENTS.length]})">
      <div class="column-header">
        <span class="column-dot"></span>
        <span class="column-title">${escapeHtml(col.name)}</span>
        <span class="column-count">${col.cards.length}${col.wipLimit ? ' / ' + col.wipLimit : ''}</span>
      </div>
      <div class="card-list" data-column="${escapeHtml(col.id)}">
        ${col.cards.length ? col.cards.map((c) => cardHtml(c, i)).join('') : '<div class="empty-hint">No cards</div>'}
      </div>
      ${edit ? `<div class="column-footer"><button class="btn-add-card" data-action="add" data-column="${escapeHtml(col.id)}">+ Add card</button></div>` : ''}
    </section>`).join('');
}

boardEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  try {
    if (btn.dataset.action === 'add') {
      const title = prompt('Card title');
      if (!title) return;
      await api('POST', `/api/columns/${btn.dataset.column}/cards`, { title });
    } else {
      const cardId = btn.closest('.card').dataset.id;
      if (btn.dataset.action === 'delete') {
        if (!confirm('Delete this card?')) return;
        await api('DELETE', `/api/cards/${cardId}`);
      } else if (btn.dataset.action === 'move') {
        const idx = board.columns.findIndex((c) => c.cards.some((x) => x.id === cardId));
        const target = board.columns[idx + Number(btn.dataset.dir)];
        if (!target) return;
        await api('POST', `/api/cards/${cardId}/move`, { columnId: target.id });
      }
    }
  } catch (err) { toast(err.message, 'error'); }
  reloadBoard();
});

/* ---------- Drag & drop (adapted from zjambor/kanban-board) ---------- */
function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = { offset: -Infinity, element: null };
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

boardEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  draggingId = card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.id);
  setTimeout(() => card.classList.add('dragging'), 0);
  boardEl.querySelectorAll('.empty-hint').forEach((el) => el.remove());
});

boardEl.addEventListener('dragover', (e) => {
  const list = e.target.closest('.card-list');
  if (!list || draggingId === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  boardEl.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
  list.closest('.column').classList.add('drag-over');
  const dragged = boardEl.querySelector('.card.dragging');
  if (!dragged) return;
  const after = getDragAfterElement(list, e.clientY);
  if (after) list.insertBefore(dragged, after);
  else list.appendChild(dragged);
});

boardEl.addEventListener('drop', async (e) => {
  const list = e.target.closest('.card-list');
  if (!list || draggingId === null) return;
  e.preventDefault();
  const id = draggingId;
  const position = [...list.querySelectorAll('.card')].findIndex((el) => el.dataset.id === id);
  try {
    await api('POST', `/api/cards/${id}/move`, { columnId: list.dataset.column, position: Math.max(0, position) });
  } catch (err) { toast(err.message, 'error'); }
  reloadBoard();
});

boardEl.addEventListener('dragend', () => {
  draggingId = null;
  boardEl.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
  boardEl.querySelectorAll('.column.drag-over').forEach((c) => c.classList.remove('drag-over'));
});

start();
