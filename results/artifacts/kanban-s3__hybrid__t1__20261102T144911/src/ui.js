export const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:1em}.cols{display:flex;gap:1em;align-items:flex-start}.col{background:#eee;padding:.5em;min-width:200px}.card{background:#fff;margin:.4em 0;padding:.4em;border:1px solid #ccc}</style></head>
<body><h1>Kanban</h1><div id="app"></div>
<script>
let token=localStorage.getItem('token'),boardId=null;
async function api(m,p,b){const r=await fetch('/api'+p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
if(r.status===204)return null;const j=await r.json();if(!r.ok){alert(j.message||j.error);throw new Error(j.error)}return j}
const $=s=>document.getElementById(s);
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function render(){const app=$('app');
if(!token){app.innerHTML='<h2>Login / Register</h2><input id="u" placeholder="username"> <input id="p" type="password" placeholder="password"> <button id="login">Login</button> <button id="reg">Register</button>';
$('login').onclick=async()=>{const r=await api('POST','/auth/login',{username:$('u').value,password:$('p').value});token=r.token;localStorage.setItem('token',token);render()};
$('reg').onclick=async()=>{await api('POST','/auth/register',{username:$('u').value,password:$('p').value});$('login').click()};return}
if(!boardId){const bs=await api('GET','/boards');
app.innerHTML='<button id="out">Logout</button><h2>Boards</h2><ul>'+bs.map(b=>'<li><a href="#" data-id="'+b.id+'">'+esc(b.name)+'</a> ('+b.role+')</li>').join('')+'</ul><input id="bn" placeholder="new board"> <button id="bc">Create</button>';
app.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();boardId=a.dataset.id;render()});
$('bc').onclick=async()=>{await api('POST','/boards',{name:$('bn').value});render()};
$('out').onclick=async()=>{await api('POST','/auth/logout');token=null;localStorage.removeItem('token');render()};return}
const b=await api('GET','/boards/'+boardId);
app.innerHTML='<button id="back">Back</button><h2>'+esc(b.name)+'</h2><div class="cols">'+b.columns.map(c=>'<div class="col" data-col="'+c.id+'"><h3>'+esc(c.name)+(c.wipLimit?' ('+c.cards.length+'/'+c.wipLimit+')':'')+'</h3>'+
c.cards.map(k=>'<div class="card" draggable="true" data-card="'+k.id+'">'+esc(k.title)+'<br>'+b.columns.filter(o=>o.id!==c.id).map(o=>'<button data-move="'+k.id+'" data-to="'+o.id+'">→ '+esc(o.name)+'</button>').join('')+'</div>').join('')+
'<input placeholder="new card" data-new="'+c.id+'"><button data-add="'+c.id+'">Add</button></div>').join('')+'</div>';
$('back').onclick=()=>{boardId=null;render()};
app.querySelectorAll('[data-add]').forEach(x=>x.onclick=async()=>{const t=app.querySelector('[data-new="'+x.dataset.add+'"]').value;await api('POST','/columns/'+x.dataset.add+'/cards',{title:t});render()});
app.querySelectorAll('[data-move]').forEach(x=>x.onclick=async()=>{await api('POST','/cards/'+x.dataset.move+'/move',{columnId:x.dataset.to});render()});
app.querySelectorAll('.card').forEach(x=>x.ondragstart=e=>e.dataTransfer.setData('text',x.dataset.card));
app.querySelectorAll('.col').forEach(x=>{x.ondragover=e=>e.preventDefault();x.ondrop=async e=>{e.preventDefault();await api('POST','/cards/'+e.dataTransfer.getData('text')+'/move',{columnId:x.dataset.col});render()}});
}
render().catch(()=>{});
</script></body></html>`;
