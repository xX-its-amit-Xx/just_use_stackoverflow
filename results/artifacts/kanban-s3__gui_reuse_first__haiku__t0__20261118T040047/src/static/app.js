// Single-page UI for kanban-s3. Uses only the JSON API; no dependencies.
const $ = (sel) => document.querySelector(sel);
const state = { token: localStorage.getItem('kanban.token'), user: null, board: null, role: null };

function flash(msg, isError = false) {
  const el = $('#flash');
  el.textContent = msg || '';
  el.className = isError ? 'error' : '';
}

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

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function showView(name) {
  for (const v of ['auth-view', 'boards-view', 'board-view']) $(`#${v}`).hidden = v !== name;
  $('#logout-btn').hidden = !state.token || name === 'auth-view';
}

async function setSession(token) {
  state.token = token;
  if (token) localStorage.setItem('kanban.token', token);
  else localStorage.removeItem('kanban.token');
}

async function init() {
  if (state.token) {
    try {
      state.user = (await api('GET', '/api/auth/me')).user;
    } catch {
      await setSession(null);
    }
  }
  renderHome();
}

function renderHome() {
  $('#whoami').textContent = state.user ? `Signed in as ${state.user.displayName} (@${state.user.username})` : '';
  if (!state.user) {
    showView('auth-view');
    return;
  }
  loadBoards();
}

async function loadBoards() {
  showView('boards-view');
  const list = $('#board-list');
  list.replaceChildren();
  try {
    const boards = await api('GET', '/api/boards');
    if (boards.length === 0) list.append(el('li', {}, 'No boards yet.'));
    for (const b of boards) {
      list.append(el('li', {}, el('a', { href: `#board/${b.id}`, onclick: (e) => { e.preventDefault(); location.hash = `board/${b.id}`; } }, b.name), ` (${b.role})`));
    }
  } catch (err) {
    flash(err.message, true);
  }
}

async function openBoard(id) {
  try {
    const board = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
    const me = board.members.find((m) => m.userId === state.user.id);
    state.board = board;
    state.role = me ? me.role : null;
    renderBoard();
    showView('board-view');
  } catch (err) {
    flash(err.message, true);
    location.hash = '';
  }
}

const canEdit = () => state.role === 'owner' || state.role === 'editor';

function renderBoard() {
  const board = state.board;
  $('#board-title').textContent = board.name;
  $('#board-desc').textContent = board.description || '';
  const columnsEl = $('#columns');
  columnsEl.replaceChildren();
  const columnIds = board.columns.map((c) => c.id);
  for (const col of board.columns) {
    const count = col.cards.length;
    const full = col.wipLimit !== null && count >= col.wipLimit;
    const header = el('h3', {}, col.name, ` (${count}${col.wipLimit !== null ? `/${col.wipLimit}` : ''})`);
    const cardsEl = el('div', { class: 'cards' + (full ? ' full' : '') });
    if (canEdit()) {
      cardsEl.addEventListener('dragover', (e) => e.preventDefault());
      cardsEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const cardId = e.dataTransfer.getData('text/plain');
        if (cardId) moveCard(cardId, col.id, null);
      });
    }
    for (const card of col.cards) cardsEl.append(renderCard(card, columnIds));
    const addForm = canEdit()
      ? el('form', { class: 'add-card', onsubmit: (e) => addCard(e, col.id) },
          el('input', { name: 'title', placeholder: 'New card title', maxlength: '200', required: '' }),
          el('button', { type: 'submit' }, 'Add'))
      : null;
    columnsEl.append(el('section', { class: 'column' }, header, cardsEl, addForm));
  }
  if (board.columns.length === 0) columnsEl.append(el('p', {}, 'This board has no columns.'));
}

function renderCard(card, columnIds) {
  const node = el('div', { class: 'card', draggable: canEdit() ? 'true' : 'false' }, el('strong', {}, card.title));
  if (card.dueDate) node.append(el('div', { class: 'due' }, `Due ${card.dueDate}`));
  if (card.description) node.append(el('div', { class: 'desc' }, card.description));
  if (canEdit()) {
    node.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.id));
    const idx = columnIds.indexOf(card.columnId);
    const btns = el('div', { class: 'card-actions' });
    if (idx > 0) btns.append(el('button', { type: 'button', onclick: () => moveCard(card.id, columnIds[idx - 1], null) }, '◀'));
    if (idx < columnIds.length - 1) btns.append(el('button', { type: 'button', onclick: () => moveCard(card.id, columnIds[idx + 1], null) }, '▶'));
    node.append(btns);
  }
  return node;
}

async function moveCard(cardId, columnId, position) {
  try {
    const body = { columnId };
    if (position !== null) body.position = position;
    await api('POST', `/api/cards/${encodeURIComponent(cardId)}/move`, body);
    await refreshBoard();
  } catch (err) {
    flash(err.code === 'wip_limit' ? 'That column is at its WIP limit.' : err.message, true);
  }
}

async function addCard(e, columnId) {
  e.preventDefault();
  const input = e.target.elements.title;
  const title = input.value.trim();
  if (!title) return;
  try {
    await api('POST', `/api/columns/${encodeURIComponent(columnId)}/cards`, { title });
    await refreshBoard();
  } catch (err) {
    flash(err.code === 'wip_limit' ? 'That column is at its WIP limit.' : err.message, true);
  }
}

async function refreshBoard() {
  if (!state.board) return;
  await openBoard(state.board.id);
}

async function route() {
  if (!state.user) return renderHome();
  const m = /^#board\/(.+)$/.exec(location.hash);
  if (m) return openBoard(decodeURIComponent(m[1]));
  state.board = null;
  return loadBoards();
}

// ----- event wiring -----
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { token, user } = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
    await setSession(token);
    state.user = user;
    flash('');
    f.reset();
    renderHome();
  } catch (err) {
    flash(err.message, true);
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/auth/register', {
      username: f.username.value,
      password: f.password.value,
      displayName: f.displayName.value || undefined,
    });
    const { token, user } = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
    await setSession(token);
    state.user = user;
    flash('');
    f.reset();
    renderHome();
  } catch (err) {
    flash(err.message, true);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/auth/logout');
  } catch {
    // ignore: token may already be invalid
  }
  await setSession(null);
  state.user = null;
  state.board = null;
  history.replaceState(null, '', '/');
  flash('');
  renderHome();
});

$('#new-board-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const columns = f.columns.value.split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const board = await api('POST', '/api/boards', {
      name: f.name.value,
      description: f.description.value || undefined,
      columns: columns.length ? columns : undefined,
    });
    f.reset();
    location.hash = `board/${board.id}`;
  } catch (err) {
    flash(err.message, true);
  }
});

$('#back-link').addEventListener('click', (e) => {
  e.preventDefault();
  location.hash = '';
});

window.addEventListener('hashchange', route);
init().then(() => route());
