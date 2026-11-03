export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kanban</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header><h1>Kanban</h1><div id="userbox"></div></header>
<main id="app"></main>
<div id="msg" role="alert"></div>
<script type="module" src="/static/app.js"></script>
</body>
</html>`;

export const APP_CSS = `
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;background:#f1f3f6;color:#222}
header{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#2d4a7a;color:#fff}
header h1{font-size:20px;margin:0}main{padding:16px}
form{margin:8px 0}input,textarea,select,button{font:inherit;padding:4px 8px;margin:2px}
button{cursor:pointer}.auth{max-width:320px;background:#fff;padding:16px;border-radius:6px}
.boards li{margin:4px 0}.board{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}
.column{background:#e2e6ec;border-radius:6px;padding:8px;width:260px;flex:none;min-height:80px}
.column.over{outline:2px dashed #2d4a7a}.column h3{margin:4px 0 8px;font-size:15px}
.card{background:#fff;border-radius:4px;padding:6px 8px;margin:6px 0;box-shadow:0 1px 2px rgba(0,0,0,.15);cursor:grab}
.card .t{font-weight:600}.card .d{font-size:12px;color:#555}.card .acts button{font-size:11px;padding:1px 5px}
.lbl{display:inline-block;font-size:11px;color:#fff;border-radius:3px;padding:0 4px;margin-right:3px}
#msg{position:fixed;bottom:12px;left:12px;color:#b00}
`;

export const APP_JS = `
const $app = document.getElementById('app');
const $user = document.getElementById('userbox');
const $msg = document.getElementById('msg');
let token = localStorage.getItem('kanban_token');
let me = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
function flash(t) { $msg.textContent = t || ''; if (t) setTimeout(() => { if ($msg.textContent === t) $msg.textContent = ''; }, 4000); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') { token = null; localStorage.removeItem('kanban_token'); }
    throw new Error(data.message || data.error || ('HTTP ' + res.status));
  }
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { flash(e.message); } };

function renderUser() {
  $user.innerHTML = '';
  if (me) $user.append(me.displayName + ' ', h('button', { onclick: guard(async () => {
    await api('POST', '/api/auth/logout'); token = null; me = null; localStorage.removeItem('kanban_token'); route();
  }) }, 'Log out'));
}

function authView() {
  const u = h('input', { placeholder: 'username', autocomplete: 'username' });
  const p = h('input', { placeholder: 'password', type: 'password', autocomplete: 'current-password' });
  const login = guard(async (e) => {
    e.preventDefault();
    const r = await api('POST', '/api/auth/login', { username: u.value, password: p.value });
    token = r.token; me = r.user; localStorage.setItem('kanban_token', token); location.hash = ''; route();
  });
  const register = guard(async () => {
    await api('POST', '/api/auth/register', { username: u.value, password: p.value });
    flash('Registered — logging in');
    await login({ preventDefault() {} });
  });
  $app.replaceChildren(h('form', { class: 'auth', onsubmit: login },
    h('h2', {}, 'Sign in'), u, h('br'), p, h('br'),
    h('button', { type: 'submit' }, 'Log in'), h('button', { type: 'button', onclick: register }, 'Register')));
}

async function boardsView() {
  const boards = await api('GET', '/api/boards');
  const name = h('input', { placeholder: 'New board name' });
  $app.replaceChildren(
    h('h2', {}, 'Your boards'),
    h('ul', { class: 'boards' }, boards.map((b) => h('li', {}, h('a', { href: '#/board/' + b.id }, b.name), ' (' + b.role + ')'))),
    h('form', { onsubmit: guard(async (e) => {
      e.preventDefault();
      const b = await api('POST', '/api/boards', { name: name.value });
      location.hash = '#/board/' + b.id;
    }) }, name, h('button', {}, 'Create board')));
}

async function boardView(id) {
  const b = await api('GET', '/api/boards/' + id);
  const labelMap = Object.fromEntries(b.labels.map((l) => [l.id, l]));
  const cols = b.columns;
  const reload = () => boardView(id).catch((e) => flash(e.message));
  const move = guard(async (cardId, columnId, position) => {
    await api('POST', '/api/cards/' + cardId + '/move', position === undefined ? { columnId } : { columnId, position });
    reload();
  });
  const colEls = cols.map((c, ci) => {
    const title = h('input', { placeholder: 'Card title' });
    const el = h('div', { class: 'column', 'data-id': c.id },
      h('h3', {}, c.name + ' (' + c.cards.length + (c.wipLimit ? '/' + c.wipLimit : '') + ')'),
      c.cards.map((card) => h('div', { class: 'card', draggable: 'true', 'data-id': card.id,
        ondragstart: (e) => e.dataTransfer.setData('text/plain', card.id) },
        h('div', {}, card.labels.map((l) => labelMap[l] ? h('span', { class: 'lbl', style: 'background:' + labelMap[l].color }, labelMap[l].name) : null)),
        h('div', { class: 't' }, card.title),
        card.description ? h('div', { class: 'd' }, card.description) : null,
        card.dueDate ? h('div', { class: 'd' }, 'Due ' + card.dueDate) : null,
        h('div', { class: 'acts' },
          ci > 0 ? h('button', { onclick: () => move(card.id, cols[ci - 1].id) }, '◀') : null,
          ci < cols.length - 1 ? h('button', { onclick: () => move(card.id, cols[ci + 1].id) }, '▶') : null,
          h('button', { onclick: guard(async () => { if (confirm('Delete card?')) { await api('DELETE', '/api/cards/' + card.id); reload(); } }) }, '✕')))),
      h('form', { onsubmit: guard(async (e) => {
        e.preventDefault();
        await api('POST', '/api/columns/' + c.id + '/cards', { title: title.value });
        reload();
      }) }, title, h('button', {}, 'Add')));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('over');
      const cardId = e.dataTransfer.getData('text/plain');
      const cardEls = [...el.querySelectorAll('.card')].filter((x) => x.dataset.id !== cardId);
      let pos = cardEls.findIndex((x) => e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
      if (pos < 0) pos = cardEls.length;
      if (cardId) move(cardId, c.id, pos);
    });
    return el;
  });
  const colName = h('input', { placeholder: 'New column' });
  $app.replaceChildren(
    h('p', {}, h('a', { href: '#' }, '← Boards')),
    h('h2', {}, b.name), b.description ? h('p', {}, b.description) : null,
    h('div', { class: 'board' }, colEls,
      h('form', { onsubmit: guard(async (e) => {
        e.preventDefault(); await api('POST', '/api/boards/' + id + '/columns', { name: colName.value }); reload();
      }) }, colName, h('button', {}, 'Add column'))));
}

async function route() {
  flash('');
  if (token && !me) {
    try { me = (await api('GET', '/api/auth/me')).user; } catch { me = null; }
  }
  renderUser();
  if (!me) return authView();
  const m = /^#\\/board\\/(.+)$/.exec(location.hash);
  try { await (m ? boardView(m[1]) : boardsView()); } catch (e) { flash(e.message); }
}
window.addEventListener('hashchange', route);
route();
`;
