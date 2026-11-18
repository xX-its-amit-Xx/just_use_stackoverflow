// Single-page UI for the kanban API. All user-provided text is inserted via textContent.
const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
const state = { token: localStorage.getItem('kanban_token'), user: null };

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setError(container, msg) {
  container.textContent = msg || '';
}

function logout() {
  if (state.token) api('POST', '/api/auth/logout').catch(() => {});
  localStorage.removeItem('kanban_token');
  state.token = null;
  state.user = null;
  location.hash = '#/';
  route();
}

function renderUserbox() {
  userbox.replaceChildren();
  if (state.user) {
    userbox.append(
      el('span', {}, `${state.user.displayName} (${state.user.username}) `),
      el('button', { class: 'secondary', onclick: logout }, 'Log out'),
    );
  }
}

function authView(mode = 'login') {
  const err = el('p', { class: 'error' });
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    setError(err, '');
    try {
      const username = f.get('username');
      const password = f.get('password');
      if (mode === 'register') {
        await api('POST', '/api/auth/register', { username, password, displayName: f.get('displayName') || undefined });
      }
      const { token, user } = await api('POST', '/api/auth/login', { username, password });
      state.token = token;
      state.user = user;
      localStorage.setItem('kanban_token', token);
      location.hash = '#/';
      route();
    } catch (ex) {
      setError(err, ex.message);
    }
  };
  const form = mode === 'register'
    ? el('form', { onsubmit: submit },
        el('input', { name: 'username', placeholder: 'username', required: true, pattern: '[a-zA-Z0-9_]{3,32}' }),
        el('input', { name: 'displayName', placeholder: 'display name (optional)' }),
        el('input', { name: 'password', type: 'password', placeholder: 'password (8+ chars)', required: true, minlength: 8 }),
        el('button', { type: 'submit' }, 'Register'))
    : el('form', { onsubmit: submit },
        el('input', { name: 'username', placeholder: 'username', required: true }),
        el('input', { name: 'password', type: 'password', placeholder: 'password', required: true }),
        el('button', { type: 'submit' }, 'Log in'));
  const toggle = el('button', {
    class: 'secondary',
    onclick: () => authView(mode === 'login' ? 'register' : 'login'),
  }, mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in');
  app.replaceChildren(el('div', { class: 'card-box' }, el('h2', {}, mode === 'login' ? 'Log in' : 'Register'), form, err, el('p', {}, toggle)));
}

async function boardsView() {
  const list = el('ul', { class: 'boards' });
  const err = el('p', { class: 'error' });
  const nameInput = el('input', { name: 'name', placeholder: 'New board name', required: true, maxlength: 100 });
  const colsInput = el('input', { name: 'columns', placeholder: 'Columns, comma-separated (optional)', size: 40 });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      setError(err, '');
      const cols = colsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const board = await api('POST', '/api/boards', { name: nameInput.value, columns: cols.length ? cols : undefined });
        location.hash = `#/boards/${board.id}`;
      } catch (ex) {
        setError(err, ex.message);
      }
    },
  }, nameInput, colsInput, el('button', { type: 'submit' }, 'Create board'));
  app.replaceChildren(el('h2', {}, 'Your boards'), form, err, list);
  try {
    const boards = await api('GET', '/api/boards');
    if (!boards.length) list.append(el('li', {}, 'No boards yet.'));
    for (const b of boards) {
      list.append(el('li', {}, el('a', { href: `#/boards/${b.id}` }, b.name), ` — ${b.role}`));
    }
  } catch (ex) {
    setError(err, ex.message);
  }
}

async function boardView(boardId) {
  const err = el('p', { class: 'error' });
  let board;
  try {
    board = await api('GET', `/api/boards/${encodeURIComponent(boardId)}`);
  } catch (ex) {
    app.replaceChildren(el('p', { class: 'error' }, ex.message), el('a', { href: '#/' }, 'Back to boards'));
    return;
  }
  const me = board.members.find((m) => m.userId === state.user?.id);
  const role = me?.role ?? null;
  const canEdit = role === 'owner' || role === 'editor';
  const refresh = () => boardView(boardId);
  const run = (fn) => async () => {
    setError(err, '');
    try { await fn(); await refresh(); } catch (ex) { setError(err, ex.message); }
  };

  const moveCard = async (cardId, columnId) => {
    await api('POST', `/api/cards/${encodeURIComponent(cardId)}/move`, { columnId });
  };

  const columns = board.columns.map((col, idx) => {
    const wipFull = col.wipLimit && col.cards.length >= col.wipLimit;
    const cards = col.cards.map((c) => {
      const prev = board.columns[idx - 1];
      const next = board.columns[idx + 1];
      const due = c.dueDate ? `due ${c.dueDate}` : '';
      return el('div', {
        class: 'card',
        draggable: canEdit ? 'true' : undefined,
        ondragstart: (e) => e.dataTransfer.setData('text/plain', c.id),
      },
        el('div', { class: 'title' }, c.title),
        due ? el('div', { class: 'meta' }, due) : null,
        canEdit ? el('div', { class: 'actions' },
          prev ? el('button', { class: 'secondary', onclick: run(() => moveCard(c.id, prev.id)) }, '◀') : null,
          next ? el('button', { class: 'secondary', onclick: run(() => moveCard(c.id, next.id)) }, '▶') : null,
          el('button', { class: 'danger', onclick: run(() => api('DELETE', `/api/cards/${encodeURIComponent(c.id)}`)) }, 'Delete'),
        ) : null,
      );
    });
    const addForm = canEdit ? el('form', {
      class: 'add-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const title = new FormData(e.target).get('title');
        setError(err, '');
        try {
          await api('POST', `/api/columns/${encodeURIComponent(col.id)}/cards`, { title });
          await refresh();
        } catch (ex) {
          setError(err, ex.code === 'wip_limit' ? 'Column WIP limit reached' : ex.message);
        }
      },
    }, el('input', { name: 'title', placeholder: 'Add a card…', required: true, maxlength: 200 }),
       el('button', { type: 'submit' }, 'Add')) : null;
    return el('div', {
      class: 'column',
      ondragover: canEdit ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop-target'); } : undefined,
      ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: canEdit ? (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        const cardId = e.dataTransfer.getData('text/plain');
        if (cardId) run(() => moveCard(cardId, col.id))();
      } : undefined,
    },
      el('h2', {}, el('span', {}, col.name),
        el('span', { class: wipFull ? 'wip-over' : '' }, col.wipLimit ? `${col.cards.length}/${col.wipLimit}` : `${col.cards.length}`)),
      cards,
      addForm,
    );
  });

  const newCol = canEdit ? el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get('name');
      setError(err, '');
      try { await api('POST', `/api/boards/${encodeURIComponent(boardId)}/columns`, { name }); await refresh(); }
      catch (ex) { setError(err, ex.message); }
    },
  }, el('input', { name: 'name', placeholder: 'New column', required: true, maxlength: 100 }),
     el('button', { type: 'submit', class: 'secondary' }, 'Add column')) : null;

  app.replaceChildren(
    el('p', {}, el('a', { href: '#/' }, '← Boards')),
    el('h2', {}, board.name, role ? ` (${role})` : ''),
    board.description ? el('p', {}, board.description) : null,
    el('p', {}, 'Members: ', board.members.map((m) => `${m.username} (${m.role})`).join(', ')),
    err,
    el('div', { class: 'columns' }, columns),
    newCol,
  );
}

async function route() {
  renderUserbox();
  if (!state.token) return authView('login');
  if (!state.user) {
    try {
      state.user = (await api('GET', '/api/auth/me')).user;
    } catch {
      localStorage.removeItem('kanban_token');
      state.token = null;
      return authView('login');
    }
    renderUserbox();
  }
  const m = location.hash.match(/^#\/boards\/(.+)$/);
  return m ? boardView(decodeURIComponent(m[1])) : boardsView();
}

window.addEventListener('hashchange', route);
route();
