let token = localStorage.getItem('token');
const app = document.getElementById('app');
const $ = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d; };
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(j.message || r.status);
  return j;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function authView() {
  app.innerHTML = `<h2>Sign in</h2><input id=u placeholder=username><input id=p type=password placeholder=password>
  <button id=li>Login</button><button id=re>Register</button><p class=err id=e></p>`;
  const go = (reg) => async () => {
    try {
      const u = document.getElementById('u').value, p = document.getElementById('p').value;
      if (reg) await api('POST', '/api/auth/register', { username: u, password: p });
      const r = await api('POST', '/api/auth/login', { username: u, password: p });
      token = r.token; localStorage.setItem('token', token); boards();
    } catch (e) { document.getElementById('e').textContent = e.message; }
  };
  document.getElementById('li').onclick = go(false); document.getElementById('re').onclick = go(true);
}
async function boards() {
  try { const me = await api('GET', '/api/auth/me'); document.getElementById('who').textContent = me.user.displayName; } catch { return authView(); }
  document.getElementById('logout').hidden = false;
  const list = await api('GET', '/api/boards');
  app.innerHTML = `<h2>Boards</h2><ul>${list.map(b => `<li><a href="#" data-id="${esc(b.id)}">${esc(b.name)}</a> (${esc(b.role)})</li>`).join('')}</ul>
  <input id=bn placeholder="New board name"><button id=bc>Create</button>`;
  app.querySelectorAll('a').forEach(a => a.onclick = (e) => { e.preventDefault(); board(a.dataset.id); });
  document.getElementById('bc').onclick = async () => { await api('POST', '/api/boards', { name: document.getElementById('bn').value }); boards(); };
}
async function board(id) {
  const b = await api('GET', '/api/boards/' + id);
  app.innerHTML = `<button id=back>&larr; Boards</button><h2>${esc(b.name)}</h2><div class=cols>${b.columns.map(c => `
  <div class=col data-id="${esc(c.id)}"><b>${esc(c.name)}</b>${c.wipLimit ? ` (limit ${c.wipLimit})` : ''}
  ${c.cards.map(k => `<div class=card draggable=true data-id="${esc(k.id)}">${esc(k.title)}<br>
    ${b.columns.filter(o => o.id !== c.id).map(o => `<button data-move="${esc(k.id)}" data-to="${esc(o.id)}">&rarr; ${esc(o.name)}</button>`).join('')}</div>`).join('')}
  <input placeholder="New card" data-new="${esc(c.id)}"><button data-add="${esc(c.id)}">Add</button></div>`).join('')}</div><p class=err id=e></p>`;
  const wrap = (fn) => async (...a) => { try { await fn(...a); board(id); } catch (e) { document.getElementById('e').textContent = e.message; } };
  document.getElementById('back').onclick = boards;
  app.querySelectorAll('[data-move]').forEach(x => x.onclick = wrap(() => api('POST', `/api/cards/${x.dataset.move}/move`, { columnId: x.dataset.to })));
  app.querySelectorAll('[data-add]').forEach(x => x.onclick = wrap(() => api('POST', `/api/columns/${x.dataset.add}/cards`, { title: app.querySelector(`[data-new="${x.dataset.add}"]`).value })));
  app.querySelectorAll('.card').forEach(k => k.ondragstart = (e) => e.dataTransfer.setData('text', k.dataset.id));
  app.querySelectorAll('.col').forEach(c => { c.ondragover = (e) => e.preventDefault(); c.ondrop = wrap((e) => { e.preventDefault(); return api('POST', `/api/cards/${e.dataTransfer.getData('text')}/move`, { columnId: c.dataset.id }); }); });
}
document.getElementById('logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} token = null; localStorage.removeItem('token'); location.reload(); };
token ? boards() : authView();
