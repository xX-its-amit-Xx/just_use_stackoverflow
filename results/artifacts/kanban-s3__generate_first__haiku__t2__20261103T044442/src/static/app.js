// Single-page UI for kanban-s3. Talks to the JSON API under /api.
const app = document.getElementById('app');
const userbar = document.getElementById('userbar');
let token = localStorage.getItem('kanban-token');
let me = null;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && path !== '/auth/login') {
      token = null;
      localStorage.removeItem('kanban-token');
      me = null;
      renderUserbar();
      location.hash = '#/login';
    }
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error;
    throw err;
  }
  return data;
}

function renderUserbar() {
  userbar.replaceChildren();
  if (me) {
    userbar.append(
      el('span', {}, `Signed in as ${me.displayName}`), ' ',
      el('button', { class: 'secondary', onclick: logout }, 'Log out'),
    );
  }
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  token = null;
  localStorage.removeItem('kanban-token');
  me = null;
  renderUserbar();
  location.hash = '#/login';
}

function errorBox() {
  return el('div', { class: 'error', role: 'alert' });
}

function renderLogin(mode = 'login') {
  const err = errorBox();
  const isRegister = mode === 'register';
  const username = el('input', { name: 'username', placeholder: 'username', required: '' });
  const password = el('input', { name: 'password', type: 'password', placeholder: 'password (min 8)', required: '' });
  const displayName = el('input', { name: 'displayName', placeholder: 'display name (optional)' });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        if (isRegister) {
          await api('POST', '/auth/register', {
            username: username.value,
            password: password.value,
            ...(displayName.value ? { displayName: displayName.value } : {}),
          });
        }
        const { token: t, user } = await api('POST', '/auth/login', { username: username.value, password: password.value });
        token = t;
        localStorage.setItem('kanban-token', t);
        me = user;
        renderUserbar();
        location.hash = '#/';
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
    el('h2', {}, isRegister ? 'Create account' : 'Log in'),
    username, password, isRegister ? displayName : null,
    el('button', { type: 'submit' }, isRegister ? 'Register' : 'Log in'),
    err,
  );
  const toggle = el('p', {},
    isRegister ? 'Have an account? ' : 'No account? ',
    el('a', { href: isRegister ? '#/login' : '#/register' }, isRegister ? 'Log in' : 'Register'));
  app.replaceChildren(el('div', { class: 'card-box' }, form, toggle));
}

async function renderBoards() {
  const boards = await api('GET', '/boards');
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      try {
        const b = await api('POST', '/boards', { name });
        location.hash = `#/board/${b.id}`;
      } catch (ex) { toast(ex.message); }
    },
  });
  const nameInput = el('input', { placeholder: 'New board name', maxlength: '100', required: '' });
  form.append(nameInput, el('button', { type: 'submit' }, 'Create board'));
  app.replaceChildren(
    el('h2', {}, 'Your boards'),
    el('div', { class: 'boards' },
      boards.length === 0 ? el('p', {}, 'No boards yet.') : null,
      boards.map((b) => el('a', { href: `#/board/${b.id}` }, el('strong', {}, b.name), el('div', { class: 'meta' }, `Role: ${b.role}`)))),
    el('div', { class: 'card-box' }, el('h3', {}, 'Create a board'), form),
  );
}

async function renderBoard(id) {
  const board = await api('GET', `/boards/${id}`);
  const myRole = board.members.find((m) => m.userId === me.id)?.role || 'viewer';
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const columns = board.columns;

  async function move(cardId, columnId, position) {
    try {
      await api('POST', `/cards/${cardId}/move`, position === undefined ? { columnId } : { columnId, position });
      await renderBoard(id);
    } catch (ex) {
      toast(ex.code === 'wip_limit' ? 'WIP limit reached for that column' : ex.message);
    }
  }

  function cardEl(card, colIndex) {
    const dueText = card.dueDate ? `Due ${card.dueDate}` : null;
    const prev = colIndex > 0 ? columns[colIndex - 1] : null;
    const next = colIndex < columns.length - 1 ? columns[colIndex + 1] : null;
    const node = el('div', { class: 'task', draggable: canEdit ? 'true' : 'false', 'data-card': card.id },
      el('div', { class: 'title' }, card.title),
      dueText ? el('div', { class: 'meta' }, dueText) : null,
      canEdit ? el('div', { class: 'moves' },
        prev ? el('button', { class: 'secondary', onclick: () => move(card.id, prev.id) }, `← ${prev.name}`) : null,
        next ? el('button', { class: 'secondary', onclick: () => move(card.id, next.id) }, `${next.name} →`) : null,
      ) : null,
    );
    if (canEdit) {
      node.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
      });
    }
    return node;
  }

  function columnEl(col, colIndex) {
    const over = col.wipLimit && col.cards.length > col.wipLimit;
    const count = el('span', { class: over ? 'count-over' : '' },
      `${col.cards.length}${col.wipLimit ? `/${col.wipLimit}` : ''}`);
    const colNode = el('div', { class: 'column', 'data-column': col.id },
      el('h2', {}, el('span', {}, col.name), count),
      col.cards.map((c) => cardEl(c, colIndex)),
      canEdit ? addCardForm(col) : null,
    );
    if (canEdit) {
      colNode.addEventListener('dragover', (e) => { e.preventDefault(); colNode.classList.add('drop-target'); });
      colNode.addEventListener('dragleave', () => colNode.classList.remove('drop-target'));
      colNode.addEventListener('drop', (e) => {
        e.preventDefault();
        colNode.classList.remove('drop-target');
        const cardId = e.dataTransfer.getData('text/plain');
        if (cardId) move(cardId, col.id);
      });
    }
    return colNode;
  }

  function addCardForm(col) {
    const input = el('input', { placeholder: 'Add a card…', maxlength: '200' });
    return el('form', {
      class: 'add-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        try {
          await api('POST', `/columns/${col.id}/cards`, { title });
          await renderBoard(id);
        } catch (ex) {
          toast(ex.code === 'wip_limit' ? 'WIP limit reached for that column' : ex.message);
        }
      },
    }, input);
  }

  app.replaceChildren(
    el('p', {}, el('a', { href: '#/' }, '← All boards')),
    el('h2', {}, board.name, ` (${myRole})`),
    board.description ? el('p', {}, board.description) : null,
    el('div', { class: 'board' }, columns.map((c, i) => columnEl(c, i))),
  );
}

async function route() {
  const hash = location.hash || '#/';
  if (!me && token) {
    try { me = await api('GET', '/auth/me').then((r) => r.user); } catch { me = null; token = null; }
    renderUserbar();
  }
  if (!me && hash !== '#/register') {
    if (hash !== '#/login') { location.hash = '#/login'; return; }
  }
  try {
    if (hash === '#/login') return renderLogin('login');
    if (hash === '#/register') return renderLogin('register');
    if (!me) { location.hash = '#/login'; return; }
    const m = /^#\/board\/([^/]+)$/.exec(hash);
    if (m) return await renderBoard(m[1]);
    return await renderBoards();
  } catch (ex) {
    toast(ex.message);
    app.replaceChildren(el('p', { class: 'error' }, ex.message));
  }
}

window.addEventListener('hashchange', route);
route();
