// kanban-s3 single-page UI (vanilla JS, no build step).
const TOKEN_KEY = 'kanban-s3-token';
const app = document.getElementById('app');
const msg = document.getElementById('msg');
const userbar = document.getElementById('userbar');

const state = { token: localStorage.getItem(TOKEN_KEY), user: null };

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

function say(text, kind = 'error') {
  msg.className = text ? kind : '';
  msg.textContent = text || '';
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  renderUserbar();
}

function logout() {
  api('POST', '/auth/logout').catch(() => {});
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  renderUserbar();
  location.hash = '#/auth';
}

function renderUserbar() {
  userbar.replaceChildren();
  if (state.user) {
    userbar.append(
      el('span', {}, `Signed in as ${state.user.displayName} (${state.user.username})`),
      el('button', { onclick: logout }, 'Log out'),
    );
  }
}

async function route() {
  say('');
  const hash = location.hash || '#/boards';
  if (!state.token) return renderAuth();
  if (!state.user) {
    try {
      state.user = (await api('GET', '/auth/me')).user;
    } catch {
      return logout();
    }
    renderUserbar();
  }
  const m = /^#\/boards\/([^/]+)$/.exec(hash);
  if (m) return renderBoard(decodeURIComponent(m[1]));
  return renderBoards();
}

// ---------- auth ----------
function renderAuth() {
  renderUserbar();
  let mode = 'login';
  const panel = el('div', { class: 'card-panel' });
  const draw = () => {
    const form = el('form', { onsubmit: submit },
      el('h2', {}, mode === 'login' ? 'Log in' : 'Register'),
      el('input', { name: 'username', placeholder: 'username', required: true, autocomplete: 'username' }),
      mode === 'register' ? el('input', { name: 'displayName', placeholder: 'display name (optional)' }) : null,
      el('input', { name: 'password', type: 'password', placeholder: 'password (min 8)', required: true, autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
      el('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'Log in' : 'Create account'),
      el('button', { type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; draw(); } },
        mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'),
    );
    panel.replaceChildren(form);
  };
  async function submit(ev) {
    ev.preventDefault();
    const f = ev.target;
    const username = f.username.value.trim();
    const password = f.password.value;
    try {
      if (mode === 'login') {
        const data = await api('POST', '/auth/login', { username, password });
        setSession(data.token, data.user);
      } else {
        const payload = { username, password };
        if (f.displayName.value.trim()) payload.displayName = f.displayName.value.trim();
        await api('POST', '/auth/register', payload);
        const data = await api('POST', '/auth/login', { username, password });
        setSession(data.token, data.user);
      }
      location.hash = '#/boards';
      route();
    } catch (err) {
      say(err.message);
    }
  }
  draw();
  app.replaceChildren(panel);
}

// ---------- boards list ----------
async function renderBoards() {
  renderUserbar();
  let boards;
  try {
    boards = await api('GET', '/boards');
  } catch (err) {
    if (err.status === 401) return logout();
    return say(err.message);
  }
  const createForm = el('form', {
    class: 'inline',
    onsubmit: async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const name = f.name.value.trim();
      const cols = f.columns.value.split(',').map((s) => s.trim()).filter(Boolean);
      try {
        const payload = { name };
        if (cols.length) payload.columns = cols;
        const b = await api('POST', '/boards', payload);
        location.hash = `#/boards/${b.id}`;
      } catch (err) {
        say(err.message);
      }
    },
  },
    el('input', { name: 'name', placeholder: 'New board name', required: true, maxlength: 100 }),
    el('input', { name: 'columns', placeholder: 'Columns, comma-separated (optional)' }),
    el('button', { class: 'primary', type: 'submit' }, 'Create board'),
  );
  const list = el('ul', { class: 'boards' },
    boards.length === 0 ? el('li', { class: 'muted' }, 'No boards yet.') : null,
    boards.map((b) => el('li', {},
      el('a', { href: `#/boards/${b.id}` }, b.name),
      el('div', { class: 'muted' }, `Your role: ${b.role}`),
    )),
  );
  app.replaceChildren(el('h2', {}, 'Your boards'), createForm, list);
}

// ---------- board view ----------
async function renderBoard(id) {
  renderUserbar();
  let board;
  try {
    board = await api('GET', `/boards/${id}`);
  } catch (err) {
    if (err.status === 401) return logout();
    return say(err.message);
  }
  const myRole = board.members.find((m) => m.userId === state.user?.id)?.role ?? 'member';
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const refresh = () => renderBoard(id);
  const labelsById = new Map(board.labels.map((l) => [l.id, l]));
  const membersById = new Map(board.members.map((m) => [m.userId, m]));

  const moveCard = async (cardId, columnId) => {
    try {
      await api('POST', `/cards/${cardId}/move`, { columnId });
      refresh();
    } catch (err) {
      say(err.code === 'wip_limit' ? 'Cannot move: the target column has reached its WIP limit.' : err.message);
    }
  };

  const cardEl = (card, colIndex) => {
    const cols = board.columns;
    const labels = card.labels.map((id) => labelsById.get(id)).filter(Boolean);
    const assignees = card.assignees.map((id) => membersById.get(id)?.username).filter(Boolean);
    const node = el('div', {
      class: 'card',
      draggable: canEdit ? 'true' : 'false',
      'data-card-id': card.id,
      ondragstart: (ev) => {
        ev.dataTransfer.setData('text/plain', card.id);
        ev.dataTransfer.effectAllowed = 'move';
      },
    },
      el('div', { class: 'title' }, card.title),
      card.description ? el('div', { class: 'muted' }, card.description) : null,
      labels.length ? el('div', { class: 'labels' }, labels.map((l) => el('span', { style: `background:${l.color}` }, l.name))) : null,
      card.dueDate ? el('div', { class: 'muted' }, `Due ${card.dueDate}`) : null,
      assignees.length ? el('div', { class: 'muted' }, `Assigned: ${assignees.join(', ')}`) : null,
      canEdit && cols.length > 1
        ? el('div', { class: 'actions' },
            colIndex > 0 ? el('button', { onclick: () => moveCard(card.id, cols[colIndex - 1].id) }, '← Move left') : null,
            colIndex < cols.length - 1 ? el('button', { onclick: () => moveCard(card.id, cols[colIndex + 1].id) }, 'Move right →') : null,
          )
        : null,
    );
    return node;
  };

  const columnEl = (col, colIndex) => {
    const count = col.cards.length;
    const over = col.wipLimit !== null && count > col.wipLimit;
    const colNode = el('div', {
      class: `column${over ? ' over-limit' : ''}`,
      'data-column-id': col.id,
      ondragover: canEdit ? (ev) => { ev.preventDefault(); colNode.classList.add('drop-target'); } : null,
      ondragleave: () => colNode.classList.remove('drop-target'),
      ondrop: canEdit
        ? (ev) => {
            ev.preventDefault();
            colNode.classList.remove('drop-target');
            const cardId = ev.dataTransfer.getData('text/plain');
            if (cardId) moveCard(cardId, col.id);
          }
        : null,
    },
      el('h3', {}, el('span', {}, col.name), el('span', { class: 'muted' }, col.wipLimit ? `${count}/${col.wipLimit}` : `${count}`)),
      col.cards.map((c) => cardEl(c, colIndex)),
      canEdit
        ? el('form', {
            class: 'add-card',
            onsubmit: async (ev) => {
              ev.preventDefault();
              const title = ev.target.title.value.trim();
              if (!title) return;
              try {
                await api('POST', `/columns/${col.id}/cards`, { title });
                refresh();
              } catch (err) {
                say(err.code === 'wip_limit' ? 'Cannot add: this column has reached its WIP limit.' : err.message);
              }
            },
          },
            el('input', { name: 'title', placeholder: 'Add a card', maxlength: 200, required: true }),
            el('button', { type: 'submit' }, 'Add'),
          )
        : null,
    );
    return colNode;
  };

  const addColumnForm = canEdit
    ? el('form', {
        class: 'inline',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const name = ev.target.name.value.trim();
          if (!name) return;
          try {
            await api('POST', `/boards/${id}/columns`, { name });
            refresh();
          } catch (err) {
            say(err.message);
          }
        },
      },
        el('input', { name: 'name', placeholder: 'New column name', maxlength: 100, required: true }),
        el('button', { type: 'submit' }, 'Add column'),
      )
    : null;

  const memberList = board.members.map((m) => `${m.username} (${m.role})`).join(', ');
  app.replaceChildren(
    el('div', { class: 'board-meta' },
      el('a', { href: '#/boards' }, '← All boards'),
      el('h2', {}, board.name),
      board.description ? el('div', { class: 'muted' }, board.description) : null,
      el('div', { class: 'muted' }, `Your role: ${myRole}. Members: ${memberList}`),
    ),
    addColumnForm,
    el('div', { class: 'columns' }, board.columns.map((c, i) => columnEl(c, i))),
  );
}

window.addEventListener('hashchange', route);
renderUserbar();
route();
