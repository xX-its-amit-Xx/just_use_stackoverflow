// Single-page UI for kanban-s3. Talks to the JSON API under /api.
(function () {
  'use strict';

  const TOKEN_KEY = 'kanban-s3.token';
  const app = document.getElementById('app');
  const errorBox = document.getElementById('error');
  const userbar = document.getElementById('userbar');
  const whoami = document.getElementById('whoami');
  const state = { token: localStorage.getItem(TOKEN_KEY), user: null, boardId: null };

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.hidden = !msg;
  }

  async function api(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.message) || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data && data.error;
      throw err;
    }
    return data;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'className') node.className = v;
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function setUser(user) {
    state.user = user;
    userbar.hidden = !user;
    whoami.textContent = user ? `${user.displayName} (@${user.username})` : '';
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  // ---------- auth screen ----------
  function renderAuth(mode = 'login') {
    app.replaceChildren();
    const isLogin = mode === 'login';
    const username = el('input', { name: 'username', placeholder: 'username', required: 'required', autocomplete: 'username' });
    const password = el('input', { name: 'password', type: 'password', placeholder: 'password (min 8)', required: 'required', autocomplete: isLogin ? 'current-password' : 'new-password' });
    const displayName = el('input', { name: 'displayName', placeholder: 'display name (optional)' });
    const submit = el('button', { type: 'submit', text: isLogin ? 'Log in' : 'Register' });
    const form = el('form', {
      id: isLogin ? 'login-form' : 'register-form',
      on: {
        submit: async (ev) => {
          ev.preventDefault();
          showError('');
          try {
            if (isLogin) {
              const r = await api('POST', '/api/auth/login', { username: username.value, password: password.value });
              state.token = r.token;
              localStorage.setItem(TOKEN_KEY, r.token);
              setUser(r.user);
              go('#/boards');
            } else {
              const body = { username: username.value, password: password.value };
              if (displayName.value.trim()) body.displayName = displayName.value.trim();
              await api('POST', '/api/auth/register', body);
              const r = await api('POST', '/api/auth/login', { username: username.value, password: password.value });
              state.token = r.token;
              localStorage.setItem(TOKEN_KEY, r.token);
              setUser(r.user);
              go('#/boards');
            }
          } catch (e) {
            showError(e.message);
          }
        },
      },
    }, username, password, ...(isLogin ? [] : [displayName]), submit);
    const toggle = el('button', {
      type: 'button', className: 'secondary', text: isLogin ? 'Need an account? Register' : 'Have an account? Log in',
      on: { click: () => renderAuth(isLogin ? 'register' : 'login') },
    });
    app.append(el('section', { className: 'section' }, el('h2', { text: isLogin ? 'Log in' : 'Register' }), form, toggle));
  }

  // ---------- boards list ----------
  async function renderBoards() {
    app.replaceChildren();
    const boards = await api('GET', '/api/boards');
    const nameInput = el('input', { name: 'name', placeholder: 'New board name', required: 'required', maxlength: '100' });
    const createForm = el('form', {
      id: 'create-board-form',
      on: {
        submit: async (ev) => {
          ev.preventDefault();
          showError('');
          try {
            const b = await api('POST', '/api/boards', { name: nameInput.value });
            go(`#/boards/${b.id}`);
          } catch (e) { showError(e.message); }
        },
      },
    }, nameInput, el('button', { type: 'submit', text: 'Create board' }));
    const list = el('ul', { className: 'boards', id: 'board-list' });
    for (const b of boards) {
      list.append(el('li', {},
        el('a', { href: `#/boards/${b.id}`, text: b.name }),
        el('span', { className: 'muted', text: b.role })));
    }
    if (!boards.length) list.append(el('li', { className: 'muted', text: 'No boards yet.' }));
    app.append(el('section', { className: 'section' }, el('h2', { text: 'Your boards' }), createForm, list));
  }

  // ---------- board view ----------
  const LABEL_COLORS = ['#0052cc', '#36b37e', '#ff991f', '#de350b', '#6554c0'];

  async function renderBoard(boardId) {
    const board = await api('GET', `/api/boards/${boardId}`);
    const myMember = board.members.find((m) => state.user && m.userId === state.user.id);
    const role = myMember ? myMember.role : 'none';
    const canEdit = role === 'owner' || role === 'editor';
    const isOwner = role === 'owner';
    const memberUserIds = new Set(board.members.map((m) => m.userId));
    const memberById = new Map(board.members.map((m) => [m.userId, m.username]));
    const labelById = new Map(board.labels.map((l) => [l.id, l]));

    app.replaceChildren();

    const header = el('section', { className: 'section' },
      el('a', { href: '#/boards', text: '← All boards' }),
      el('h2', { text: board.name }),
      el('p', { className: 'muted', text: `${board.description || ''} · your role: ${role}` }));
    app.append(header);

    if (canEdit) {
      const labelName = el('input', { name: 'labelName', placeholder: 'label name', maxlength: '50' });
      const labelColor = el('select', { name: 'labelColor' },
        ...LABEL_COLORS.map((c) => el('option', { value: c, text: c })));
      app.append(el('section', { className: 'section' },
        el('form', {
          id: 'label-form',
          on: {
            submit: async (ev) => {
              ev.preventDefault();
              try {
                await api('POST', `/api/boards/${boardId}/labels`, { name: labelName.value, color: labelColor.value });
                renderBoard(boardId);
              } catch (e) { showError(e.message); }
            },
          },
        }, labelName, labelColor, el('button', { type: 'submit', text: 'Add label' }))));
    }

    if (isOwner) {
      const memberName = el('input', { name: 'memberName', placeholder: 'username' });
      const memberRole = el('select', { name: 'memberRole' },
        el('option', { value: 'editor', text: 'editor' }),
        el('option', { value: 'viewer', text: 'viewer' }));
      app.append(el('section', { className: 'section' },
        el('h3', { text: 'Members' }),
        el('p', { className: 'muted', text: board.members.map((m) => `${m.username} (${m.role})`).join(', ') }),
        el('form', {
          id: 'member-form',
          on: {
            submit: async (ev) => {
              ev.preventDefault();
              try {
                await api('POST', `/api/boards/${boardId}/members`, { username: memberName.value, role: memberRole.value });
                renderBoard(boardId);
              } catch (e) { showError(e.message); }
            },
          },
        }, memberName, memberRole, el('button', { type: 'submit', text: 'Add member' })),
        el('button', {
          type: 'button', className: 'danger', text: 'Delete board',
          on: {
            click: async () => {
              if (!confirm('Delete this board and all its contents?')) return;
              try {
                await api('DELETE', `/api/boards/${boardId}`);
                go('#/boards');
              } catch (e) { showError(e.message); }
            },
          },
        })));
    }

    const boardEl = el('div', { className: 'board', id: 'board' });
    for (const col of board.columns) {
      boardEl.append(renderColumn(board, col, { canEdit, memberUserIds, memberById, labelById, boardId }));
    }
    if (canEdit) {
      const colName = el('input', { name: 'columnName', placeholder: 'New column', maxlength: '100' });
      boardEl.append(el('div', { className: 'column' },
        el('form', {
          id: 'column-form',
          on: {
            submit: async (ev) => {
              ev.preventDefault();
              try {
                await api('POST', `/api/boards/${boardId}/columns`, { name: colName.value });
                renderBoard(boardId);
              } catch (e) { showError(e.message); }
            },
          },
        }, colName, el('button', { type: 'submit', text: 'Add' }))));
    }
    app.append(boardEl);
  }

  function renderColumn(board, col, ctx) {
    const count = col.cards.length;
    const overWip = col.wipLimit !== null && count > col.wipLimit;
    const wipText = col.wipLimit !== null ? `${count}/${col.wipLimit}` : `${count}`;
    const colEl = el('div', { className: `column${overWip ? ' over-wip' : ''}`, 'data-column-id': col.id },
      el('h3', {}, el('span', { text: col.name }), el('span', { className: 'wip', text: wipText })));

    if (ctx.canEdit) {
      colEl.addEventListener('dragover', (ev) => { ev.preventDefault(); colEl.classList.add('drop-target'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drop-target'));
      colEl.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        colEl.classList.remove('drop-target');
        const cardId = ev.dataTransfer.getData('text/plain');
        if (cardId) await moveCard(ctx.boardId, cardId, col.id, null);
      });
    }

    for (const card of col.cards) colEl.append(renderCard(board, col, card, ctx));

    if (ctx.canEdit) {
      const title = el('input', { name: 'cardTitle', placeholder: 'Card title', maxlength: '200' });
      colEl.append(el('form', {
        className: 'add-card-form',
        on: {
          submit: async (ev) => {
            ev.preventDefault();
            try {
              await api('POST', `/api/columns/${col.id}/cards`, { title: title.value });
              renderBoard(ctx.boardId);
            } catch (e) { showError(e.message); }
          },
        },
      }, title, el('button', { type: 'submit', text: 'Add card' })));
    }
    return colEl;
  }

  function renderCard(board, col, card, ctx) {
    const labels = card.labels.map((id) => ctx.labelById.get(id)).filter(Boolean);
    const assignees = card.assignees.map((id) => ctx.memberById.get(id)).filter(Boolean);
    const cardEl = el('div', { className: 'card', 'data-card-id': card.id, draggable: ctx.canEdit ? 'true' : 'false' },
      el('div', { className: 'title', text: card.title }),
      card.description ? el('div', { className: 'meta', text: card.description }) : null,
      labels.length ? el('div', { className: 'labels' },
        ...labels.map((l) => el('span', { style: `background:${l.color}`, text: l.name }))) : null,
      assignees.length ? el('div', { className: 'meta', text: `@${assignees.join(', @')}` }) : null,
      card.dueDate ? el('div', { className: 'meta', text: `due ${card.dueDate}` }) : null);

    if (ctx.canEdit) {
      cardEl.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', card.id);
        ev.dataTransfer.effectAllowed = 'move';
      });
      const idx = board.columns.findIndex((c) => c.id === col.id);
      const left = board.columns[idx - 1];
      const right = board.columns[idx + 1];
      cardEl.append(el('div', { className: 'actions' },
        left ? el('button', { type: 'button', className: 'secondary', text: `← ${left.name}`,
          on: { click: () => moveCard(ctx.boardId, card.id, left.id, null) } }) : null,
        right ? el('button', { type: 'button', className: 'secondary', text: `${right.name} →`,
          on: { click: () => moveCard(ctx.boardId, card.id, right.id, null) } }) : null));
    }
    return cardEl;
  }

  async function moveCard(boardId, cardId, columnId, position) {
    showError('');
    try {
      const body = { columnId };
      if (position !== null) body.position = position;
      await api('POST', `/api/cards/${cardId}/move`, body);
      renderBoard(boardId);
    } catch (e) {
      showError(e.code === 'wip_limit' ? 'That column is at its WIP limit.' : e.message);
    }
  }

  // ---------- router ----------
  async function render() {
    showError('');
    const hash = location.hash || '#/boards';
    try {
      if (!state.token) { renderAuth('login'); return; }
      if (!state.user) {
        const r = await api('GET', '/api/auth/me');
        setUser(r.user);
      }
      const m = /^#\/boards\/([^/]+)$/.exec(hash);
      if (m) await renderBoard(decodeURIComponent(m[1]));
      else await renderBoards();
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        state.token = null;
        setUser(null);
        renderAuth('login');
        showError('Please log in again.');
      } else {
        showError(e.message);
      }
    }
  }

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    setUser(null);
    go('#/boards');
    render();
  });

  window.addEventListener('hashchange', render);
  render();
})();
