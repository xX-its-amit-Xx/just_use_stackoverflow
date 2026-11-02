export const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:1em}.cols{display:flex;gap:1em;align-items:flex-start}.col{background:#eee;padding:.5em;min-width:200px}.card{background:#fff;margin:.3em 0;padding:.4em;border:1px solid #ccc}</style></head><body>
<h1>Kanban</h1><div id="app"></div>
<script>
let token=localStorage.getItem('token'),boardId=null;
async function api(m,p,b){const r=await fetch('/api'+p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
const t=r.status===204?null:await r.json();if(!r.ok)throw new Error(t.message||r.status);return t}
const app=document.getElementById('app');
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function err(e){alert(e.message)}
function authView(){app.innerHTML='<h2>Login / Register</h2><input id="u" placeholder="username"> <input id="p" type="password" placeholder="password"> <button id="li">Login</button> <button id="rg">Register</button>';
u=document.getElementById('u');p=document.getElementById('p');
document.getElementById('li').onclick=async()=>{try{const r=await api('POST','/auth/login',{username:u.value,password:p.value});token=r.token;localStorage.setItem('token',token);boardsView()}catch(e){err(e)}};
document.getElementById('rg').onclick=async()=>{try{await api('POST','/auth/register',{username:u.value,password:p.value});alert('registered; now login')}catch(e){err(e)}}}
async function boardsView(){try{const bs=await api('GET','/boards');
app.innerHTML='<button id="lo">Logout</button><h2>Boards</h2><ul>'+bs.map(b=>'<li><a href="#" data-id="'+esc(b.id)+'">'+esc(b.name)+'</a> ('+b.role+')</li>').join('')+'</ul><input id="bn" placeholder="new board"> <button id="bc">Create</button>';
document.getElementById('lo').onclick=async()=>{try{await api('POST','/auth/logout')}catch(e){}token=null;localStorage.removeItem('token');authView()};
document.getElementById('bc').onclick=async()=>{try{await api('POST','/boards',{name:document.getElementById('bn').value});boardsView()}catch(e){err(e)}};
app.querySelectorAll('a[data-id]').forEach(a=>a.onclick=e=>{e.preventDefault();boardView(a.dataset.id)})}catch(e){token=null;authView()}}
async function boardView(id){boardId=id;try{const b=await api('GET','/boards/'+id);
app.innerHTML='<button id="bk">Back</button><h2>'+esc(b.name)+'</h2><div class="cols">'+b.columns.map(c=>'<div class="col" data-col="'+c.id+'"><h3>'+esc(c.name)+(c.wipLimit?' ('+c.cards.length+'/'+c.wipLimit+')':'')+'</h3>'+
c.cards.map(k=>'<div class="card" draggable="true" data-card="'+k.id+'">'+esc(k.title)+'<br>'+b.columns.filter(o=>o.id!==c.id).map(o=>'<button data-mv="'+k.id+'" data-to="'+o.id+'">→ '+esc(o.name)+'</button>').join('')+'</div>').join('')+
'<input placeholder="new card" data-new="'+c.id+'"><button data-add="'+c.id+'">Add</button></div>').join('')+'</div>';
document.getElementById('bk').onclick=boardsView;
app.querySelectorAll('[data-mv]').forEach(x=>x.onclick=()=>mv(x.dataset.mv,x.dataset.to));
app.querySelectorAll('[data-add]').forEach(x=>x.onclick=async()=>{const i=app.querySelector('[data-new="'+x.dataset.add+'"]');try{await api('POST','/columns/'+x.dataset.add+'/cards',{title:i.value});boardView(id)}catch(e){err(e)}});
app.querySelectorAll('.card').forEach(c=>c.ondragstart=e=>e.dataTransfer.setData('text/plain',c.dataset.card));
app.querySelectorAll('.col').forEach(c=>{c.ondragover=e=>e.preventDefault();c.ondrop=e=>{e.preventDefault();mv(e.dataTransfer.getData('text/plain'),c.dataset.col)}})}catch(e){err(e)}}
async function mv(card,to){try{await api('POST','/cards/'+card+'/move',{columnId:to});boardView(boardId)}catch(e){err(e)}}
token?boardsView():authView();
</script></body></html>`;
