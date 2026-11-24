// kanban-s3 single-page UI. Talks to the JSON API under /api.
const app = document.getElementById('app');
const whoami = document.getElementById('whoami');
const notice = document.getElementById('notice');
const TOKEN_KEY = 'kanban-s3-token';
let token = localStorage.getItem(TOKEN_KEY);
let me = null;

function showNotice(text, isError = true) {
  notice.textContent = text;
  notice.className = isError ? 'notice error' : 'notice';
  notice.hidden = !text;
  if (text) setTimeout(() => { if (notice.textContent === text) notice.hidden = true; }, 6000);
}

async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error;
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
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setWhoami() {
  whoami.replaceChildren();
  if (me) {
    whoami.append(
      el('span', {}, `Signed in as ${me.displayName} (@${me.username})`),
      el('button', { onclick: logout }, 'Log out'),
    );
  }
}

async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  token = null;
  me = null;
  localStorage.removeItem(TOKEN_KEY);
  setWhoami();
  location.hash = '#/login';
}

function handleError(err) {
  if (err.status === 401) {
    token = null;
    me = null;
    localStorage.removeItem(TOKEN_KEY);
    setWhoami();
    location.hash = '#/login';
    showNotice('Please log in again.');
    return;
  }
  showNotice(err.message || 'Something went wrong');
}

// ---------- auth ----------
function renderAuth(mode = 'login') {
  const isLogin = mode === 'login';
  const username = el('input', { name: 'username', autocomplete: 'username', required: '', placeholder: 'username (3-32 chars a-z 0-9 _)' });
  const displayName = el('input', { name: 'displayName', placeholder: 'display name (optional)' });
  const password = el('input', { name: 'password', type: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', required: '', placeholder: 'password (min 8 chars)' });
  const errorBox = el('div', { class: 'error-text' });
  const form = el('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    try {
      if (isLogin) {
        const data = await api('POST', '/api/auth/login', { username: username.value, password: password.value });
        token = data.token;
        me = data.user;
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        const body = { username: username.value, password: password.value };
        if (displayName.value.trim()) body.displayName = displayName.value.trim();
        await api('POST', '/api/auth/register', body);
        const data = await api('POST', '/api/auth/login', { username: username.value, password: password.value });
        token = data.token;
        me = data.user;
        localStorage.setItem(TOKEN_KEY, token);
      }
      setWhoami();
      location.hash = '#/';
    } catch (err) {
      errorBox.textContent = err.message;
    }
  } },
    el('h2', {}, isLogin ? 'Log in' : 'Create account'),
    username,
    isLogin ? null : displayName,
    password,
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'submit' }, isLogin ? 'Log in' : 'Register'),
      el('button', { class: 'secondary', type: 'button', onclick: () => renderAuth(isLogin ? 'register' : 'login') },
        isLogin ? 'Need an account? Register' : 'Have an account? Log in')),
    errorBox);
  app.replaceChildren(el('div', { class: 'card-panel' }, form));
}

// ---------- boards list ----------
async function renderBoards() {
  const boards = await api('GET', '/api/boards');
  const nameInput = el('input', { placeholder: 'New board name', required: '', maxlength: '100' });
  const colsInput = el('input', { placeholder: 'Columns, comma separated (optional)' });
  const errorBox = el('div', { class: 'error-text' });
  const createForm = el('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    errorBox.textContent = '';
    const body = { name: nameInput.value.trim() };
    const cols = colsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (cols.length) body.columns = cols;
    try {
      const board = await api('POST', '/api/boards', body);
      location.hash = `#/boards/${board.id}`;
    } catch (err) {
      errorBox.textContent = err.message;
    }
  } }, nameInput, colsInput, el('button', { class: 'primary', type: 'submit' }, 'Create board'));

  const list = el('ul', { class: 'boards-list' },
    boards.length
      ? boards.map((b) => el('li', {}, el('a', { href: `#/boards/${b.id}` },
        el('span', {}, b.name), el('span', { class: 'muted' }, b.role))))
      : el('li', { class: 'muted' }, 'You are not a member of any boards yet.'));

  app.replaceChildren(el('section', {}, el('h2', {}, 'Your boards'), list, createForm, errorBox));
}

// ---------- board view ----------
let dragCardId = null;

async function renderBoard(boardId) {
  const [board, boards] = await Promise.all([api('GET', `/api/boards/${boardId}`), api('GET', '/api/boards')]);
  const myRole = boards.find((b) => b.id === boardId)?.role || 'viewer';
  const canEdit = myRole === 'owner' || myRole === 'editor';

  const header = el('div', { class: 'board-header' },
    el('div', {},
      el('h1', {}, board.name),
      board.description ? el('div', { class: 'muted' }, board.description) : null,
      el('div', { class: 'muted' }, `Role: ${myRole} · Members: ${board.members.map((m) => `${m.username} (${m.role})`).join(', ')}`)),
    el('a', { href: '#/' }, '← All boards'));

  const columns = el('div', { class: 'columns' });
  for (const col of board.columns) {
    columns.append(renderColumn(board, col, canEdit));
  }

  app.replaceChildren(header, columns);
}

function renderColumn(board, col, canEdit) {
  const full = col.wipLimit != null && col.cards.length >= col.wipLimit;
  const count = el('span', { class: full ? 'count full' : 'count' },
    col.wipLimit != null ? `${col.cards.length}/${col.wipLimit}` : `${col.cards.length}`);
  const cardsEl = el('div', { class: 'cards' }, col.cards.map((c) => renderCard(board, col, c, canEdit)));

  const columnEl = el('section', { class: 'column', 'data-column-id': col.id },
    el('div', { class: 'column-head' }, el('span', {}, col.name), count),
    cardsEl);

  if (canEdit) {
    columnEl.addEventListener('dragover', (e) => { if (dragCardId) { e.preventDefault(); columnEl.classList.add('drop-target'); } });
    columnEl.addEventListener('dragleave', () => columnEl.classList.remove('drop-target'));
    columnEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      columnEl.classList.remove('drop-target');
      const id = dragCardId || e.dataTransfer.getData('text/plain');
      dragCardId = null;
      if (id) await moveCard(board.id, id, col.id, null);
    });

    const titleInput = el('input', { placeholder: 'Card title', maxlength: '200', required: '' });
    columnEl.append(el('form', { class: 'add-card', onsubmit: async (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) return;
      try {
        await api('POST', `/api/columns/${col.id}/cards`, { title });
        await renderBoard(board.id);
      } catch (err) {
        if (err.code === 'wip_limit') showNotice('This column has reached its WIP limit.');
        else handleError(err);
      }
    } }, titleInput, el('button', { class: 'secondary', type: 'submit' }, 'Add card')));
  }
  return columnEl;
}

function renderCard(board, col, card, canEdit) {
  const others = board.columns.filter((c) => c.id !== col.id);
  const idx = board.columns.findIndex((c) => c.id === col.id);
  const doMove = (targetId) => moveCard(board.id, card.id, targetId, null);

  const controls = canEdit ? el('div', { class: 'moves' },
    el('button', { class: 'secondary', title: 'Move left', disabled: idx <= 0 ? '' : null,
      onclick: () => doMove(board.columns[idx - 1].id) }, '←'),
    el('button', { class: 'secondary', title: 'Move right', disabled: idx >= board.columns.length - 1 ? '' : null,
      onclick: () => doMove(board.columns[idx + 1].id) }, '→'),
    others.length ? el('select', { 'aria-label': 'Move to column', onchange: (e) => { if (e.target.value) doMove(e.target.value); } },
      el('option', { value: '' }, 'Move to…'),
      others.map((c) => el('option', { value: c.id }, c.name))) : null) : null;

  const meta = [];
  if (card.dueDate) meta.push(`Due ${card.dueDate}`);
  if (card.assignees.length) {
    const names = card.assignees.map((id) => board.members.find((m) => m.userId === id)?.username || id);
    meta.push(`Assignees: ${names.join(', ')}`);
  }
  if (card.labels.length) {
    const names = card.labels.map((id) => board.labels.find((l) => l.id === id)?.name || id);
    meta.push(`Labels: ${names.join(', ')}`);
  }

  const node = el('div', { class: 'kcard', 'data-card-id': card.id, draggable: canEdit ? 'true' : 'false' },
    el('div', { class: 'title' }, card.title),
    card.description ? el('div', { class: 'desc' }, card.description) : null,
    meta.length ? el('div', { class: 'meta' }, meta.join(' · ')) : null,
    controls);

  if (canEdit) {
    node.addEventListener('dragstart', (e) => {
      dragCardId = card.id;
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => {
      dragCardId = null;
      node.classList.remove('dragging');
    });
  }
  return node;
}

async function moveCard(boardId, cardId, columnId, position) {
  try {
    const body = { columnId };
    if (position !== null) body.position = position;
    await api('POST', `/api/cards/${cardId}/move`, body);
    await renderBoard(boardId);
  } catch (err) {
    if (err.code === 'wip_limit') showNotice('Target column has reached its WIP limit.');
    else handleError(err);
  }
}

// ---------- router ----------
async function route() {
  setWhoami();
  const hash = location.hash || '#/';
  const boardMatch = /^#\/boards\/([^/]+)$/.exec(hash);
  if (hash === '#/register') return renderAuth('register');
  if (hash === '#/login' || !token) return renderAuth('login');
  if (!me) {
    try {
      me = (await api('GET', '/api/auth/me')).user;
      setWhoami();
    } catch (err) {
      return handleError(err);
    }
  }
  try {
    if (boardMatch) return await renderBoard(decodeURIComponent(boardMatch[1]));
    return await renderBoards();
  } catch (err) {
    if (err.status === 404 || err.status === 403) {
      app.replaceChildren(el('section', { class: 'card-panel' }, el('h2', {}, 'Not available'), el('p', {}, err.message), el('a', { href: '#/' }, 'Back to boards')));
    } else {
      handleError(err);
    }
  }
}

window.addEventListener('hashchange', route);
route();
