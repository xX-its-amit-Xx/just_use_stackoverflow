const $ = (sel) => document.querySelector(sel);
const state = { token: localStorage.getItem('kanban_token'), user: null, board: null };

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'className') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function showError(msg) {
  const box = $('#error');
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(showError.t);
  showError.t = setTimeout(() => (box.hidden = true), 4000);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token && !path.startsWith('/api/auth/login')) {
      state.token = null; localStorage.removeItem('kanban_token'); render();
    }
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.status = res.status; err.code = data.error;
    throw err;
  }
  return data;
}

const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { showError(e.message); } };

function showView(id) {
  for (const v of ['auth-view', 'boards-view', 'board-view']) $('#' + v).hidden = v !== id;
  $('#userbar').hidden = !state.user;
  if (state.user) $('#whoami').textContent = `${state.user.displayName} (@${state.user.username})`;
}

async function render() {
  if (!state.token) { state.user = null; return showView('auth-view'); }
  if (!state.user) {
    try { state.user = (await api('GET', '/api/auth/me')).user; } catch { state.token = null; return showView('auth-view'); }
  }
  const m = /^#board\/(.+)$/.exec(location.hash);
  if (m) return renderBoard(decodeURIComponent(m[1]));
  return renderBoards();
}

async function renderBoards() {
  showView('boards-view');
  const boards = await api('GET', '/api/boards');
  const list = $('#board-list');
  list.replaceChildren(...boards.map((b) =>
    el('li', {}, el('a', { href: `#board/${encodeURIComponent(b.id)}` }, b.name), ' ', el('span', { className: 'role' }, b.role))));
  if (!boards.length) list.append(el('li', {}, 'No boards yet.'));
}

async function renderBoard(id) {
  let board;
  try { board = await api('GET', `/api/boards/${encodeURIComponent(id)}`); }
  catch (e) { showError(e.message); location.hash = ''; return; }
  state.board = board;
  showView('board-view');
  const me = board.members.find((m) => m.userId === state.user.id);
  const role = me ? me.role : 'viewer';
  const canEdit = role === 'owner' || role === 'editor';
  $('#board-title').textContent = board.name;
  $('#board-role').textContent = role;
  $('#board-desc').textContent = board.description || '';
  $('#new-column-form').hidden = !canEdit;
  const labelsById = new Map(board.labels.map((l) => [l.id, l]));
  const membersById = new Map(board.members.map((m) => [m.userId, m]));
  const cols = board.columns;

  const columnEls = cols.map((col, ci) => {
    const full = col.wipLimit != null && col.cards.length >= col.wipLimit;
    const cardEls = col.cards.map((card) => el('div', {
      className: 'card', draggable: canEdit ? 'true' : null, 'data-card-id': card.id,
      ondragstart: (ev) => { ev.dataTransfer.setData('text/plain', card.id); },
    },
      el('div', { className: 'title' }, card.title),
      card.description ? el('div', { className: 'meta' }, card.description) : null,
      el('div', {}, card.labels.map((lid) => labelsById.get(lid)).filter(Boolean)
        .map((l) => el('span', { className: 'label-chip', style: `background:${l.color}` }, l.name))),
      (card.dueDate || card.assignees.length) ? el('div', { className: 'meta' },
        card.dueDate ? `Due ${card.dueDate} ` : '',
        card.assignees.map((u) => '@' + (membersById.get(u)?.username || u)).join(' ')) : null,
      canEdit ? el('div', { className: 'actions' },
        ci > 0 ? el('button', { title: 'Move left', onclick: guard(() => moveCard(card.id, cols[ci - 1].id)) }, '◀') : null,
        ci < cols.length - 1 ? el('button', { title: 'Move right', onclick: guard(() => moveCard(card.id, cols[ci + 1].id)) }, '▶') : null,
        el('button', { title: 'Delete', onclick: guard(async () => {
          if (!confirm('Delete this card?')) return;
          await api('DELETE', `/api/cards/${card.id}`); await renderBoard(board.id);
        }) }, '✕')) : null,
    ));
    const colEl = el('div', { className: 'column', 'data-column-id': col.id },
      el('h3', {}, el('span', {}, col.name),
        el('span', { className: full ? 'wip-full' : '' }, col.wipLimit != null ? `${col.cards.length}/${col.wipLimit}` : String(col.cards.length))),
      ...cardEls,
      canEdit ? el('form', { onsubmit: guard(async (ev) => {
        ev.preventDefault();
        const title = ev.target.elements["title"].value.trim();
        if (!title) return;
        await api('POST', `/api/columns/${col.id}/cards`, { title });
        await renderBoard(board.id);
      }) }, el('input', { name: 'title', placeholder: '+ Add card', maxlength: '200' })) : null,
    );
    if (canEdit) {
      colEl.addEventListener('dragover', (ev) => { ev.preventDefault(); colEl.classList.add('drag-over'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
      colEl.addEventListener('drop', guard(async (ev) => {
        ev.preventDefault();
        colEl.classList.remove('drag-over');
        const cardId = ev.dataTransfer.getData('text/plain');
        if (!cardId) return;
        // determine drop position from cursor Y relative to cards
        const cardNodes = [...colEl.querySelectorAll('.card')].filter((n) => n.dataset.cardId !== cardId);
        let position = cardNodes.length;
        for (let i = 0; i < cardNodes.length; i++) {
          const r = cardNodes[i].getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) { position = i; break; }
        }
        await moveCard(cardId, col.id, position);
      }));
    }
    return colEl;
  });
  $('#columns').replaceChildren(...columnEls);
}

async function moveCard(cardId, columnId, position) {
  const body = { columnId };
  if (position !== undefined) body.position = position;
  try { await api('POST', `/api/cards/${cardId}/move`, body); }
  finally { await renderBoard(state.board.id); }
}

$('#login-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const data = await api('POST', '/api/auth/login', { username: f.elements["username"].value, password: f.elements["password"].value });
  state.token = data.token; state.user = data.user;
  localStorage.setItem('kanban_token', data.token);
  f.reset();
  await render();
}));

$('#register-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { username: f.elements["username"].value, password: f.elements["password"].value };
  if (f.elements["displayName"].value.trim()) body.displayName = f.elements["displayName"].value.trim();
  await api('POST', '/api/auth/register', body);
  const data = await api('POST', '/api/auth/login', { username: body.username, password: body.password });
  state.token = data.token; state.user = data.user;
  localStorage.setItem('kanban_token', data.token);
  f.reset();
  await render();
}));

$('#logout-btn').addEventListener('click', guard(async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
  state.token = null; state.user = null; localStorage.removeItem('kanban_token');
  location.hash = '';
  await render();
}));

$('#new-board-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const board = await api('POST', '/api/boards', { name: ev.target.elements["name"].value });
  ev.target.reset();
  location.hash = `#board/${encodeURIComponent(board.id)}`;
}));

$('#new-column-form').addEventListener('submit', guard(async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { name: f.elements["name"].value };
  if (f.elements["wipLimit"].value) body.wipLimit = Number(f.elements["wipLimit"].value);
  await api('POST', `/api/boards/${state.board.id}/columns`, body);
  f.reset();
  await renderBoard(state.board.id);
}));

$('#home-link').addEventListener('click', (ev) => { ev.preventDefault(); location.hash = ''; render(); });
window.addEventListener('hashchange', guard(render));
guard(render)();
