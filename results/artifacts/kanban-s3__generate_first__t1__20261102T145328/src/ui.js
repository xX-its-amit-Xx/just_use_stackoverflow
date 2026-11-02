export const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kanban</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f5f7;color:#222}
header{background:#0079bf;color:#fff;padding:8px 16px;display:flex;gap:12px;align-items:center}
header h1{font-size:18px;margin:0;flex:1}
main{padding:16px}
.cols{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}
.col{background:#ebecf0;border-radius:6px;padding:8px;min-width:240px;width:240px}
.card{background:#fff;border-radius:4px;padding:6px 8px;margin:6px 0;box-shadow:0 1px 2px #0003;cursor:grab}
.card small{color:#666}
.err{color:#b00020}
input,button{padding:5px;margin:2px}
.box{max-width:320px;margin:40px auto;background:#fff;padding:16px;border-radius:6px}
</style></head><body>
<header><h1>Kanban</h1><span id="who"></span><button id="logout" style="display:none">Log out</button></header>
<main id="app"></main>
<script>
let token = sessionStorage.getItem('token'), me = null;
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || d.error);
  return d;
}
document.getElementById('logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} token = null; sessionStorage.removeItem('token'); me = null; init(); };
function authView() {
  app.innerHTML = '<div class="box"><h2>Sign in</h2><input id="u" placeholder="username"><br><input id="p" type="password" placeholder="password"><br><button id="login">Log in</button> <button id="reg">Register</button><div class="err" id="e"></div></div>';
  const cred = () => ({ username: document.getElementById('u').value, password: document.getElementById('p').value });
  const fail = e => document.getElementById('e').textContent = e.message;
  document.getElementById('login').onclick = async () => { try { const d = await api('POST', '/api/auth/login', cred()); token = d.token; sessionStorage.setItem('token', token); init(); } catch (e) { fail(e); } };
  document.getElementById('reg').onclick = async () => { try { await api('POST', '/api/auth/register', cred()); const d = await api('POST', '/api/auth/login', cred()); token = d.token; sessionStorage.setItem('token', token); init(); } catch (e) { fail(e); } };
}
async function boardsView() {
  const list = await api('GET', '/api/boards');
  app.innerHTML = '<h2>Your boards</h2><ul id="bl"></ul><input id="bn" placeholder="New board name"><button id="bc">Create</button><div class="err" id="e"></div>';
  const ul = document.getElementById('bl');
  for (const b of list) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = '#'; a.textContent = b.name + ' (' + b.role + ')'; a.onclick = ev => { ev.preventDefault(); boardView(b.id); }; li.appendChild(a); ul.appendChild(li); }
  document.getElementById('bc').onclick = async () => { try { const b = await api('POST', '/api/boards', { name: document.getElementById('bn').value }); boardView(b.id); } catch (e) { document.getElementById('e').textContent = e.message; } };
}
async function boardView(id) {
  const b = await api('GET', '/api/boards/' + id);
  app.innerHTML = '<p><a href="#" id="back">&larr; Boards</a></p><h2>' + esc(b.name) + '</h2><div class="err" id="e"></div><div class="cols" id="cols"></div>';
  document.getElementById('back').onclick = ev => { ev.preventDefault(); boardsView(); };
  const err = e => document.getElementById('e').textContent = e.message;
  const cols = document.getElementById('cols');
  for (const c of b.columns) {
    const d = document.createElement('div'); d.className = 'col'; d.dataset.id = c.id;
    d.innerHTML = '<strong>' + esc(c.name) + '</strong>' + (c.wipLimit ? ' <small>(' + c.cards.length + '/' + c.wipLimit + ')</small>' : '');
    d.ondragover = ev => ev.preventDefault();
    d.ondrop = async ev => { ev.preventDefault(); const cid = ev.dataTransfer.getData('text/plain'); try { await api('POST', '/api/cards/' + cid + '/move', { columnId: c.id }); boardView(id); } catch (e) { err(e); } };
    for (const k of c.cards) {
      const el = document.createElement('div'); el.className = 'card'; el.draggable = true;
      el.ondragstart = ev => ev.dataTransfer.setData('text/plain', k.id);
      el.innerHTML = '<div>' + esc(k.title) + '</div>';
      const idx = b.columns.indexOf(c);
      for (const [dir, label] of [[-1, '\\u25C0'], [1, '\\u25B6']]) {
        const t = b.columns[idx + dir]; if (!t) continue;
        const btn = document.createElement('button'); btn.textContent = label; btn.title = 'Move to ' + t.name;
        btn.onclick = async () => { try { await api('POST', '/api/cards/' + k.id + '/move', { columnId: t.id }); boardView(id); } catch (e) { err(e); } };
        el.appendChild(btn);
      }
      d.appendChild(el);
    }
    const inp = document.createElement('input'); inp.placeholder = 'New card'; const add = document.createElement('button'); add.textContent = 'Add';
    add.onclick = async () => { try { await api('POST', '/api/columns/' + c.id + '/cards', { title: inp.value }); boardView(id); } catch (e) { err(e); } };
    d.appendChild(inp); d.appendChild(add); cols.appendChild(d);
  }
}
async function init() {
  if (token) { try { me = (await api('GET', '/api/auth/me')).user; } catch { token = null; sessionStorage.removeItem('token'); } }
  document.getElementById('logout').style.display = token ? '' : 'none';
  document.getElementById('who').textContent = me && token ? me.displayName : '';
  if (!token) authView(); else boardsView();
}
init();
</script></body></html>`;
