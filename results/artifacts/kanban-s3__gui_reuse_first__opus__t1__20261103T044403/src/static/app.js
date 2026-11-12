// Single-page Kanban UI (vanilla JS) using the REST API.
const app = document.getElementById('app');
const userbox = document.getElementById('userbox');
let token = localStorage.getItem('kanban_token');
let me = null;

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
};

function alertMsg(msg) {
  const a = h('div', { class: 'alert' }, msg);
  document.getElementById('alerts').append(a);
  setTimeout(() => a.remove(), 4000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') { setToken(null); showAuth(); }
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function setToken(t) {
  token = t;
  if (t) localStorage.setItem('kanban_token', t); else localStorage.removeItem('kanban_token');
}

function renderUserbox() {
  userbox.replaceChildren();
  if (!me) return;
  userbox.append(h('span', {}, me.displayName),
    h('button', { class: 'secondary', onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch {} setToken(null); me = null; showAuth(); } }, 'Log out'));
}

function showAuth() {
  me = null; renderUserbox();
  const u = h('input', { placeholder: 'username', autocomplete: 'username' });
  const p = h('input', { placeholder: 'password', type: 'password' });
  const d = h('input', { placeholder: 'display name (register only)' });
  const login = async () => {
    try {
      const r = await api('POST', '/api/auth/login', { username: u.value, password: p.value });
      setToken(r.token); me = r.user; renderUserbox(); showBoards();
    } catch (e) { alertMsg(e.message); }
  };
  const register = async () => {
    try {
      await api('POST', '/api/auth/register', { username: u.value, password: p.value, displayName: d.value || undefined });
      await login();
    } catch (e) { alertMsg(e.message); }
  };
  app.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Log in or register'), u, p, d,
    h('button', { onclick: login }, 'Log in'), ' ', h('button', { class: 'secondary', onclick: register }, 'Register')));
}

async function showBoards() {
  let boards;
  try { boards = await api('GET', '/api/boards'); } catch (e) { return alertMsg(e.message); }
  const name = h('input', { placeholder: 'New board name' });
  const create = async () => {
    try { const b = await api('POST', '/api/boards', { name: name.value }); showBoard(b.id); } catch (e) { alertMsg(e.message); }
  };
  app.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Your boards'),
    h('ul', { class: 'board-list' }, boards.map((b) => h('li', { onclick: () => showBoard(b.id) }, h('span', {}, b.name), h('em', {}, b.role)))),
    name, h('button', { onclick: create }, 'Create board')));
}

async function moveCard(cardId, columnId, position, boardId) {
  try { await api('POST', `/api/cards/${cardId}/move`, position === undefined ? { columnId } : { columnId, position }); }
  catch (e) { alertMsg(e.message); }
  showBoard(boardId);
}

async function showBoard(id) {
  let b;
  try { b = await api('GET', `/api/boards/${id}`); } catch (e) { alertMsg(e.message); return showBoards(); }
  const role = b.members.find((m) => m.userId === me?.id)?.role;
  const canEdit = role === 'owner' || role === 'editor';
  const labels = Object.fromEntries(b.labels.map((l) => [l.id, l]));
  const cols = b.columns;

  const columnEls = cols.map((col, ci) => {
    const list = h('ul', {}, col.cards.map((card) => h('li', {
      draggable: canEdit ? 'true' : 'false', 'data-card-id': card.id,
      ondragstart: (e) => e.dataTransfer.setData('text/plain', card.id),
    },
    h('p', { class: 'item-title text-fix' }, card.title),
    h('div', {}, card.labels.map((lid) => labels[lid] && h('span', { class: 'label-chip', style: `background:${labels[lid].color}` }, labels[lid].name))),
    card.dueDate ? h('small', {}, `Due ${card.dueDate}`) : null,
    canEdit ? h('div', { class: 'card-actions' },
      ci > 0 ? h('button', { class: 'small', title: 'Move left', onclick: () => moveCard(card.id, cols[ci - 1].id, undefined, b.id) }, '◀') : null,
      ci < cols.length - 1 ? h('button', { class: 'small', title: 'Move right', onclick: () => moveCard(card.id, cols[ci + 1].id, undefined, b.id) }, '▶') : null,
      h('button', { class: 'small secondary', title: 'Delete', onclick: async () => { try { await api('DELETE', `/api/cards/${card.id}`); } catch (e) { alertMsg(e.message); } showBoard(b.id); } }, '✕'),
    ) : null)));

    const section = h('div', { class: 'parent-card', 'data-column-id': col.id },
      h('span', {}, h('h2', { class: 'card-title text-fix' }, col.name),
        h('span', { class: 'wip' }, col.wipLimit ? `${col.cards.length}/${col.wipLimit}` : `${col.cards.length}`)),
      list);
    if (canEdit) {
      const input = h('input', { type: 'text', placeholder: '+ Add card' });
      input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        try { await api('POST', `/api/columns/${col.id}/cards`, { title: input.value }); } catch (err) { alertMsg(err.message); }
        showBoard(b.id);
      });
      section.append(h('div', { class: 'add-card' }, input));
      section.addEventListener('dragover', (e) => { e.preventDefault(); section.classList.add('drag-over'); });
      section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
      section.addEventListener('drop', (e) => {
        e.preventDefault(); section.classList.remove('drag-over');
        const cardId = e.dataTransfer.getData('text/plain');
        if (!cardId) return;
        // Determine drop position from the cursor's vertical position.
        const items = [...list.children].filter((li) => li.dataset.cardId !== cardId);
        let pos = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
        if (pos === -1) pos = items.length;
        moveCard(cardId, col.id, pos, b.id);
      });
    }
    return section;
  });

  const extra = [];
  if (canEdit) {
    const colName = h('input', { type: 'text', placeholder: '+ Add column' });
    colName.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !colName.value.trim()) return;
      try { await api('POST', `/api/boards/${b.id}/columns`, { name: colName.value }); } catch (err) { alertMsg(err.message); }
      showBoard(b.id);
    });
    extra.push(h('div', { class: 'parent-card' }, colName));
  }

  app.replaceChildren(
    h('div', { style: 'color:white;display:flex;gap:1rem;align-items:center' },
      h('button', { class: 'secondary', onclick: showBoards }, '← Boards'),
      h('h2', {}, b.name), h('em', {}, role || '')),
    h('div', { id: 'cards-container' }, columnEls, extra));
}

document.getElementById('title').addEventListener('click', () => (me ? showBoards() : showAuth()));

(async () => {
  if (token) {
    try { me = (await api('GET', '/api/auth/me')).user; renderUserbox(); return showBoards(); } catch { /* fallthrough */ }
  }
  showAuth();
})();
