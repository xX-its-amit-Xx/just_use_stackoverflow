export const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:0;background:#eef}header{background:#246;color:#fff;padding:8px 16px}
.cols{display:flex;gap:12px;padding:12px;align-items:flex-start}.col{background:#dde;padding:8px;min-width:220px;border-radius:6px}
.card{background:#fff;margin:6px 0;padding:6px;border-radius:4px;box-shadow:0 1px 2px #0004}.err{color:#c00}main{padding:12px}</style></head>
<body><header><b>Kanban</b> <span id="who"></span> <button id="logout" hidden>Logout</button></header><main id="app"></main>
<script>
let token=localStorage.getItem('token'),boardId=null;
const app=document.getElementById('app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(m,p,b){const r=await fetch(p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
 const j=r.status===204?null:await r.json();if(!r.ok)throw new Error(j.message||j.error);return j}
const val=id=>document.getElementById(id).value;
function authView(msg){document.getElementById('logout').hidden=true;
 app.innerHTML='<h2>Login / Register</h2><div class="err">'+esc(msg||'')+'</div><input id="u" placeholder="username"> <input id="p" type="password" placeholder="password"> <button id="li">Login</button> <button id="rg">Register</button>';
 li.onclick=async()=>{try{const r=await api('POST','/api/auth/login',{username:val('u'),password:val('p')});token=r.token;localStorage.setItem('token',token);boards()}catch(e){authView(e.message)}};
 rg.onclick=async()=>{try{await api('POST','/api/auth/register',{username:val('u'),password:val('p')});li.onclick()}catch(e){authView(e.message)}}}
async function boards(){try{const me=await api('GET','/api/auth/me');who.textContent=me.user.username;logout.hidden=false;
 const l=await api('GET','/api/boards');
 app.innerHTML='<h2>Boards</h2><ul>'+l.map(b=>'<li><a href="#" data-id="'+esc(b.id)+'">'+esc(b.name)+'</a> ('+b.role+')</li>').join('')+'</ul><input id="bn" placeholder="new board"> <button id="cb">Create</button>';
 app.querySelectorAll('a[data-id]').forEach(a=>a.onclick=e=>{e.preventDefault();board(a.dataset.id)});
 cb.onclick=async()=>{try{await api('POST','/api/boards',{name:val('bn')});boards()}catch(e){alert(e.message)}}}catch(e){token=null;localStorage.removeItem('token');authView()}}
async function board(id){boardId=id;const b=await api('GET','/api/boards/'+id);
 app.innerHTML='<a href="#" id="back">&larr; boards</a><h2>'+esc(b.name)+'</h2><div class="cols">'+b.columns.map(c=>'<div class="col" data-col="'+esc(c.id)+'"><b>'+esc(c.name)+'</b>'+(c.wipLimit?' (WIP '+c.wipLimit+')':'')+
 c.cards.map(k=>'<div class="card" draggable="true" data-card="'+esc(k.id)+'">'+esc(k.title)+'<br>'+b.columns.filter(x=>x.id!==c.id).map(x=>'<button data-mv="'+esc(k.id)+'" data-to="'+esc(x.id)+'">&rarr; '+esc(x.name)+'</button>').join(' ')+'</div>').join('')+
 '<br><input data-nt="'+esc(c.id)+'" placeholder="new card"><button data-add="'+esc(c.id)+'">Add</button></div>').join('')+'</div>';
 back.onclick=e=>{e.preventDefault();boards()};
 const mv=async(card,to)=>{try{await api('POST','/api/cards/'+card+'/move',{columnId:to})}catch(e){alert(e.message)}board(id)};
 app.querySelectorAll('[data-mv]').forEach(x=>x.onclick=()=>mv(x.dataset.mv,x.dataset.to));
 app.querySelectorAll('[data-add]').forEach(x=>x.onclick=async()=>{try{await api('POST','/api/columns/'+x.dataset.add+'/cards',{title:app.querySelector('[data-nt="'+x.dataset.add+'"]').value})}catch(e){alert(e.message)}board(id)});
 app.querySelectorAll('.card').forEach(k=>k.ondragstart=e=>e.dataTransfer.setData('text/plain',k.dataset.card));
 app.querySelectorAll('.col').forEach(c=>{c.ondragover=e=>e.preventDefault();c.ondrop=e=>{e.preventDefault();mv(e.dataTransfer.getData('text/plain'),c.dataset.col)}})}
logout.onclick=async()=>{try{await api('POST','/api/auth/logout')}catch{}token=null;localStorage.removeItem('token');who.textContent='';authView()};
token?boards():authView();
</script></body></html>`;
