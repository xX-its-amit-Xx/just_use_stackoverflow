export const UI_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kanban</title>
<style>
body{font-family:sans-serif;margin:0;background:#f4f5f7}header{background:#0079bf;color:#fff;padding:8px 16px;display:flex;justify-content:space-between}
main{padding:16px}.cols{display:flex;gap:12px;align-items:flex-start}.col{background:#ebecf0;border-radius:4px;padding:8px;width:260px}
.card{background:#fff;margin:6px 0;padding:6px;border-radius:3px;box-shadow:0 1px 0 #0003}input,button{margin:2px}.err{color:#c00}
</style></head><body>
<header><b>Kanban</b><span id="who"></span></header>
<main id="app"></main>
<script>
let token=localStorage.getItem('token'),me=null,board=null;
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(method,path,body){
  const r=await fetch(path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const d=r.status===204?null:await r.json();
  if(!r.ok)throw new Error(d.message||d.error);return d;
}
function show(msg){const e=document.getElementById('err');if(e)e.textContent=msg}
function authView(){
  app.innerHTML='<h2>Sign in</h2><div id="err" class="err"></div><input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><button id="login">Log in</button><button id="reg">Register</button>';
  const cred=()=>({username:document.getElementById('u').value,password:document.getElementById('p').value});
  document.getElementById('login').onclick=async()=>{try{const d=await api('POST','/api/auth/login',cred());token=d.token;me=d.user;localStorage.setItem('token',token);boardsView()}catch(e){show(e.message)}};
  document.getElementById('reg').onclick=async()=>{try{await api('POST','/api/auth/register',cred());document.getElementById('login').click()}catch(e){show(e.message)}};
}
async function boardsView(){
  document.getElementById('who').innerHTML=esc(me?.username)+' <button id="out">Logout</button>';
  document.getElementById('out').onclick=async()=>{try{await api('POST','/api/auth/logout')}catch{}token=null;localStorage.removeItem('token');document.getElementById('who').innerHTML='';authView()};
  const bs=await api('GET','/api/boards');
  app.innerHTML='<h2>Boards</h2><div id="err" class="err"></div><ul>'+bs.map(b=>'<li><a href="#" data-id="'+esc(b.id)+'">'+esc(b.name)+'</a> ('+esc(b.role)+')</li>').join('')+'</ul><input id="bn" placeholder="new board name"><button id="nb">Create board</button>';
  app.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();boardView(a.dataset.id)});
  document.getElementById('nb').onclick=async()=>{try{await api('POST','/api/boards',{name:document.getElementById('bn').value});boardsView()}catch(e){show(e.message)}};
}
async function boardView(bid){
  board=await api('GET','/api/boards/'+bid);
  app.innerHTML='<button id="back">&larr; Boards</button><h2>'+esc(board.name)+'</h2><div id="err" class="err"></div><div class="cols">'+board.columns.map(c=>
    '<div class="col" data-col="'+esc(c.id)+'"><b>'+esc(c.name)+'</b>'+(c.wipLimit?' (limit '+c.wipLimit+')':'')+
    c.cards.map(k=>'<div class="card" draggable="true" data-card="'+esc(k.id)+'">'+esc(k.title)+'<div>'+board.columns.filter(o=>o.id!==c.id).map(o=>'<button data-mv="'+esc(k.id)+'" data-to="'+esc(o.id)+'">&rarr; '+esc(o.name)+'</button>').join('')+'</div></div>').join('')+
    '<input placeholder="new card" data-new="'+esc(c.id)+'"><button data-add="'+esc(c.id)+'">Add</button></div>').join('')+'</div>';
  document.getElementById('back').onclick=boardsView;
  const mv=async(card,col)=>{try{await api('POST','/api/cards/'+card+'/move',{columnId:col});boardView(bid)}catch(e){show(e.message)}};
  app.querySelectorAll('[data-mv]').forEach(b=>b.onclick=()=>mv(b.dataset.mv,b.dataset.to));
  app.querySelectorAll('[data-add]').forEach(b=>b.onclick=async()=>{const i=app.querySelector('[data-new="'+b.dataset.add+'"]');try{await api('POST','/api/columns/'+b.dataset.add+'/cards',{title:i.value});boardView(bid)}catch(e){show(e.message)}});
  app.querySelectorAll('.card').forEach(c=>c.ondragstart=e=>e.dataTransfer.setData('text/plain',c.dataset.card));
  app.querySelectorAll('.col').forEach(c=>{c.ondragover=e=>e.preventDefault();c.ondrop=e=>{e.preventDefault();mv(e.dataTransfer.getData('text/plain'),c.dataset.col)}});
}
(async()=>{if(token){try{me=(await api('GET','/api/auth/me')).user;return boardsView()}catch{token=null}}authView()})();
</script></body></html>`;
