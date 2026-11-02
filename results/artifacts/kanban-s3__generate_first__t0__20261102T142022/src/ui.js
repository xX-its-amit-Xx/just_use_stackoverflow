export const UI_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Kanban</title>
<style>
body{font-family:sans-serif;margin:0;background:#f4f5f7}header{background:#0079bf;color:#fff;padding:8px 16px;display:flex;gap:12px;align-items:center}
main{padding:16px}.cols{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}.col{background:#e2e4e6;border-radius:4px;padding:8px;min-width:240px}
.card{background:#fff;border-radius:3px;padding:6px;margin:6px 0;box-shadow:0 1px 0 #0003}.card.drag{opacity:.5}input,button{margin:2px}.err{color:#c00}
</style></head><body>
<header><b>Kanban</b><span id="who"></span><button id="logout" style="display:none">Logout</button></header>
<main id="app"></main>
<script>
let token=localStorage.getItem('token'),me=null,boardId=null;
const app=document.getElementById('app');
async function api(m,p,b){const r=await fetch(p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
 if(r.status===204)return null;const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);return j;}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function err(e){const d=document.getElementById('err');if(d)d.textContent=e.message;}
function authView(){document.getElementById('logout').style.display='none';
 app.innerHTML='<h2>Login / Register</h2><input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><button id="li">Login</button><button id="rg">Register</button><div id="err" class="err"></div>';
 const cred=()=>({username:u.value,password:p.value});
 li.onclick=async()=>{try{const r=await api('POST','/api/auth/login',cred());token=r.token;localStorage.setItem('token',token);me=r.user;boardsView();}catch(e){err(e)}};
 rg.onclick=async()=>{try{await api('POST','/api/auth/register',cred());li.onclick();}catch(e){err(e)}};}
async function boardsView(){boardId=null;const lo=document.getElementById('logout');lo.style.display='';
 lo.onclick=async()=>{try{await api('POST','/api/auth/logout')}catch{}token=null;localStorage.removeItem('token');authView();};
 const bs=await api('GET','/api/boards');
 app.innerHTML='<h2>Boards</h2><ul>'+bs.map(b=>'<li><a href="#" data-id="'+esc(b.id)+'">'+esc(b.name)+'</a> ('+b.role+')</li>').join('')+'</ul><input id="bn" placeholder="new board name"><button id="bc">Create board</button><div id="err" class="err"></div>';
 app.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();boardView(a.dataset.id)});
 bc.onclick=async()=>{try{const b=await api('POST','/api/boards',{name:bn.value});boardView(b.id)}catch(e){err(e)}};}
async function boardView(id){boardId=id;const b=await api('GET','/api/boards/'+id);
 app.innerHTML='<a href="#" id="back">&larr; Boards</a><h2>'+esc(b.name)+'</h2><div id="err" class="err"></div><div class="cols">'+b.columns.map(c=>
 '<div class="col" data-col="'+c.id+'"><h3>'+esc(c.name)+(c.wipLimit?' ('+c.cards.length+'/'+c.wipLimit+')':'')+'</h3>'+c.cards.map(k=>
 '<div class="card" draggable="true" data-card="'+k.id+'">'+esc(k.title)+'<div>'+b.columns.filter(x=>x.id!==c.id).map(x=>'<button data-mv="'+k.id+'" data-to="'+x.id+'">&rarr; '+esc(x.name)+'</button>').join('')+'</div></div>').join('')+
 '<input placeholder="new card" data-new="'+c.id+'"><button data-add="'+c.id+'">Add</button></div>').join('')+'</div>';
 back.onclick=e=>{e.preventDefault();boardsView()};
 const run=async f=>{try{await f();boardView(id)}catch(e){err(e)}};
 app.querySelectorAll('[data-mv]').forEach(x=>x.onclick=()=>run(()=>api('POST','/api/cards/'+x.dataset.mv+'/move',{columnId:x.dataset.to})));
 app.querySelectorAll('[data-add]').forEach(x=>x.onclick=()=>run(()=>api('POST','/api/columns/'+x.dataset.add+'/cards',{title:app.querySelector('[data-new="'+x.dataset.add+'"]').value})));
 app.querySelectorAll('.card').forEach(k=>k.ondragstart=e=>e.dataTransfer.setData('text/plain',k.dataset.card));
 app.querySelectorAll('.col').forEach(c=>{c.ondragover=e=>e.preventDefault();c.ondrop=e=>{e.preventDefault();const cid=e.dataTransfer.getData('text/plain');run(()=>api('POST','/api/cards/'+cid+'/move',{columnId:c.dataset.col}))}});}
(async()=>{if(token){try{me=(await api('GET','/api/auth/me')).user;return boardsView()}catch{token=null}}authView();})();
</script></body></html>`;
