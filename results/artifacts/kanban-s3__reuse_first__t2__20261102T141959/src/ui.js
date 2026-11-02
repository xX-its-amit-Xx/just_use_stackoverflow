export const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:1em}.cols{display:flex;gap:1em;align-items:flex-start}.col{background:#eee;padding:.5em;min-width:200px;border-radius:4px}.card{background:#fff;margin:.4em 0;padding:.4em;border-radius:3px;cursor:grab}.err{color:#b00}</style></head>
<body><h1>Kanban</h1><div id="err" class="err"></div><div id="app"></div>
<script>
let token=localStorage.getItem('token');
const $=s=>document.querySelector(s), app=$('#app');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(m,p,b){const r=await fetch(p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
 if(r.status===204)return null;const j=await r.json();if(!r.ok){$('#err').textContent=j.message||j.error;throw new Error(j.error)}$('#err').textContent='';return j}
function login(){app.innerHTML='<h2>Login / Register</h2><input id=u placeholder=username><input id=p type=password placeholder=password><button id=li>Login</button><button id=rg>Register</button>';
 $('#li').onclick=async()=>{const r=await api('POST','/api/auth/login',{username:$('#u').value,password:$('#p').value});token=r.token;localStorage.setItem('token',token);boards()};
 $('#rg').onclick=async()=>{await api('POST','/api/auth/register',{username:$('#u').value,password:$('#p').value});$('#li').click()}}
async function boards(){const l=await api('GET','/api/boards');
 app.innerHTML='<button id=lo>Logout</button><h2>Boards</h2><ul>'+l.map(b=>'<li><a href="#" data-id="'+esc(b.id)+'">'+esc(b.name)+'</a> ('+esc(b.role)+')</li>').join('')+'</ul><input id=bn placeholder="new board"><button id=bc>Create</button>';
 $('#lo').onclick=async()=>{await api('POST','/api/auth/logout');token=null;localStorage.removeItem('token');login()};
 $('#bc').onclick=async()=>{await api('POST','/api/boards',{name:$('#bn').value});boards()};
 app.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();board(a.dataset.id)})}
async function board(id){const b=await api('GET','/api/boards/'+id);
 app.innerHTML='<button id=bk>Back</button><h2>'+esc(b.name)+'</h2><div class=cols>'+b.columns.map(c=>'<div class=col data-id="'+esc(c.id)+'"><b>'+esc(c.name)+'</b>'+(c.wipLimit?' (limit '+c.wipLimit+')':'')+
 c.cards.map(k=>'<div class=card draggable=true data-id="'+esc(k.id)+'">'+esc(k.title)+'<br>'+b.columns.filter(o=>o.id!==c.id).map(o=>'<button data-mv="'+esc(k.id)+'" data-to="'+esc(o.id)+'">→ '+esc(o.name)+'</button>').join('')+'</div>').join('')+
 '<input placeholder="new card" data-new="'+esc(c.id)+'"><button data-add="'+esc(c.id)+'">Add</button></div>').join('')+'</div>';
 $('#bk').onclick=boards;
 const mv=async(k,to)=>{try{await api('POST','/api/cards/'+k+'/move',{columnId:to})}catch{}board(id)};
 app.querySelectorAll('[data-mv]').forEach(x=>x.onclick=()=>mv(x.dataset.mv,x.dataset.to));
 app.querySelectorAll('[data-add]').forEach(x=>x.onclick=async()=>{const i=app.querySelector('[data-new="'+x.dataset.add+'"]');try{await api('POST','/api/columns/'+x.dataset.add+'/cards',{title:i.value})}catch{}board(id)});
 app.querySelectorAll('.card').forEach(c=>c.ondragstart=e=>e.dataTransfer.setData('text',c.dataset.id));
 app.querySelectorAll('.col').forEach(c=>{c.ondragover=e=>e.preventDefault();c.ondrop=e=>{e.preventDefault();mv(e.dataTransfer.getData('text'),c.dataset.id)}})}
token?boards().catch(login):login();
</script></body></html>`;
