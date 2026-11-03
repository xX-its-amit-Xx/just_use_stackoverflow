// Single-page Kanban client. Uses only the public JSON API; all DOM text is set via textContent.
const TOKEN_KEY = 'kanban.token';
const state = { token: localStorage.getItem(TOKEN_KEY), user: null, boardId: null, board: null, role: null };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
};
const setStatus = (msg, isError = false) => {
  const s = $('status');
  s.textContent = msg || '';
  s.className = isError ? 'error' : '';
};

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

function show(view) {
  for (const v of ['auth-view', 'boards-view', 'board-view']) $(v).hidden = v !== view;
  $('userbar').hidden = !state.user;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  $('whoami').textContent = `Signed in as ${user.displayName} (@${user.username})`;
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
}

// ---------- auth ----------
document.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => {
  const toRegister = b.dataset.switch === 'register';
  $('login-form').hidden = toRegister;
  $('register-form').hidden = !toRegister;
  setStatus('');
}));

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { token, user } = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
    setSession(token, user);
    setStatus('');
    e.target.reset();
    await showBoards();
  } catch (err) { setStatus(err.message, true); }
});

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const payload = { username: f.get('username'), password: f.get('password') };
  if (f.get('displayName')) payload.displayName = f.get('displayName');
  try {
    await api('POST', '/api/auth/register', payload);
    const { token, user } = await api('POST', '/api/auth/login', { username: payload.username, password: payload.password });
    setSession(token, user);
    e.target.reset();
    await showBoards();
  } catch (err) { setStatus(err.message, true); }
});

$('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* token may already be gone */ }
  clearSession();
  $('userbar').hidden = true;
  setStatus('Logged out');
  show('auth-view');
});

// ---------- boards list ----------
async function showBoards() {
  show('boards-view');
  const boards = await api('GET', '/api/boards');
  const list = $('board-list');
  list.replaceChildren();
  if (!boards.length) list.append(el('li', { class: 'muted', text: 'No boards yet.' }));
  for (const b of boards) {
    list.append(el('li', { class: 'board-item' }, [
      el('button', { type: 'button', class: 'link', text: b.name, onclick: () => openBoard(b.id) }),
      el('span', { class: 'muted', text: ` (${b.role})` }),
    ]));
  }
}

$('new-board-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  try {
    const b = await api('POST', '/api/boards', { name });
    e.target.reset();
    await openBoard(b.id);
  } catch (err) { setStatus(err.message, true); }
});

$('back-btn').addEventListener('click', () => { state.boardId = null; showBoards().catch(onError); });

// ---------- board view ----------
async function openBoard(id) {
  state.boardId = id;
  await loadBoard();
}

async function loadBoard() {
  const board = await api('GET', `/api/boards/${state.boardId}`);
  state.board = board;
  const me = board.members.find((m) => m.userId === state.user.id);
  state.role = me ? me.role : 'viewer';
  show('board-view');
  $('board-name').textContent = board.name;
  $('board-role').textContent = `Your role: ${state.role}`;
  $('board-desc').textContent = board.description || '';
  renderColumns();
}

const canEdit = () => state.role === 'owner' || state.role === 'editor';

function renderColumns() {
  const wrap = $('columns');
  wrap.replaceChildren();
  const labelById = new Map(state.board.labels.map((l) => [l.id, l]));
  for (const col of state.board.columns) {
    const count = col.cards.length;
    const full = col.wipLimit != null && count >= col.wipLimit;
    const header = el('header', { class: 'col-header' }, [
      el('strong', { text: col.name }),
      el('span', { class: full ? 'wip full' : 'wip', text: col.wipLimit != null ? ` ${count}/${col.wipLimit}` : ` ${count}` }),
    ]);
    const cardsEl = el('div', { class: 'cards', 'data-column-id': col.id });
    if (canEdit()) {
      cardsEl.addEventListener('dragover', (e) => { e.preventDefault(); cardsEl.classList.add('drop'); });
      cardsEl.addEventListener('dragleave', () => cardsEl.classList.remove('drop'));
      cardsEl.addEventListener('drop', (e) => {
        e.preventDefault();
        cardsEl.classList.remove('drop');
        const cardId = e.dataTransfer.getData('text/plain');
        if (cardId) moveCard(cardId, col.id);
      });
    }
    for (const card of col.cards) cardsEl.append(renderCard(card, col, labelById));
    const addForm = canEdit() ? renderAddCard(col) : null;
    wrap.append(el('section', { class: 'column' }, [header, cardsEl, ...(addForm ? [addForm] : [])]));
  }
}

function renderCard(card, col, labelById) {
  const labels = card.labels.map((id) => labelById.get(id)).filter(Boolean)
    .map((l) => el('span', { class: 'label', text: l.name, style: `background:${l.color}` }));
  const meta = [];
  if (card.dueDate) meta.push(el('span', { class: 'due', text: `due ${card.dueDate}` }));
  const node = el('article', { class: 'card', draggable: canEdit() ? 'true' : 'false' }, [
    el('div', { class: 'card-title', text: card.title }),
    ...(card.description ? [el('div', { class: 'card-desc', text: card.description })] : []),
    el('div', { class: 'card-meta' }, [...labels, ...meta]),
  ]);
  if (canEdit()) {
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    const idx = state.board.columns.findIndex((c) => c.id === col.id);
    const buttons = el('div', { class: 'card-actions' });
    if (idx > 0) buttons.append(el('button', { type: 'button', text: '◀', title: 'Move left', onclick: () => moveCard(card.id, state.board.columns[idx - 1].id) }));
    if (idx < state.board.columns.length - 1) buttons.append(el('button', { type: 'button', text: '▶', title: 'Move right', onclick: () => moveCard(card.id, state.board.columns[idx + 1].id) }));
    const select = el('select', { 'aria-label': 'Move to column' }, [
      el('option', { value: '', text: 'Move to…' }),
      ...state.board.columns.filter((c) => c.id !== col.id).map((c) => el('option', { value: c.id, text: c.name })),
    ]);
    select.addEventListener('change', () => { if (select.value) moveCard(card.id, select.value); });
    buttons.append(select);
    node.append(buttons);
  }
  return node;
}

function renderAddCard(col) {
  const form = el('form', { class: 'add-card' }, [
    el('input', { name: 'title', placeholder: 'Add a card…', maxlength: '200', required: 'required', 'aria-label': `New card in ${col.name}` }),
    el('button', { type: 'submit', text: 'Add' }),
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = form.elements.title.value;
    try {
      await api('POST', `/api/columns/${col.id}/cards`, { title });
      await loadBoard();
    } catch (err) { setStatus(err.message, true); }
  });
  return form;
}

async function moveCard(cardId, columnId) {
  try {
    await api('POST', `/api/cards/${cardId}/move`, { columnId });
    setStatus('');
    await loadBoard();
  } catch (err) {
    setStatus(err.code === 'wip_limit' ? `Cannot move: ${err.message}` : err.message, true);
  }
}

function onError(err) { setStatus(err.message, true); }

// ---------- startup ----------
(async function init() {
  if (!state.token) { show('auth-view'); return; }
  try {
    const { user } = await api('GET', '/api/auth/me');
    setSession(state.token, user);
    await showBoards();
  } catch {
    clearSession();
    show('auth-view');
  }
})();
