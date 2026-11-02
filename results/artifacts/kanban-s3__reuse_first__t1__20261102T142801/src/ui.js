export const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:1em}.cols{display:flex;gap:1em;align-items:flex-start}.col{background:#eee;padding:.5em;min-width:200px}.card{background:#fff;margin:.4em 0;padding:.4em;border:1px solid #ccc}</style></head>
<body><h1>Kanban</h1><div id="app"></div>
<script>
let token=localStorage.getItem('token'),board=null;
async function api(m,p,b){const r=await fetch('/api'+p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
if(r.status===204)return null;const j=await r.json();if(!r.ok){alert(j.message);throw new Error(j.message)}return j}
const $=s=>document.getElementById(s);
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function login(){return '<h2>Login / Register</h2><input id=u placeholder=username><input id=p type=password placeholder=password><button onclick="doAuth(false)">Login</button><button onclick="doAuth(true)">Register</button>'}
async function doAuth(reg){const username=$('u').value,password=$('p').value;if(reg)await api('POST','/auth/register',{username,password});
const r=await api('POST','/auth/login',{username,password});token=r.token;localStorage.setItem('token',token);render()}
async function logout(){await api('POST','/auth/logout');token=null;localStorage.removeItem('token');board=null;render()}
async function render(){const a=$('app');if(!token){a.innerHTML=login();return}
try{if(board){const b=await api('GET','/boards/'+board);
a.innerHTML='<button onclick="board=null;render()">Back</button> <button onclick="logout()">Logout</button><h2>'+esc(b.name)+'</h2><div class=cols>'+b.columns.map(c=>'<div class=col data-id="'+c.id+'" ondragover="event.preventDefault()" ondrop="drop(event,\\''+c.id+'\\')"><b>'+esc(c.name)+'</b>'+(c.wipLimit?' (max '+c.wipLimit+')':'')+c.cards.map(k=>'<div class=card draggable=true ondragstart="event.dataTransfer.setData(\\'text\\',\\''+k.id+'\\')">'+esc(k.title)+'<br>'+b.columns.filter(o=>o.id!==c.id).map(o=>'<button onclick="mv(\\''+k.id+'\\',\\''+o.id+'\\')">→ '+esc(o.name)+'</button>').join('')+'</div>').join('')+'<br><input id="t'+c.id+'" placeholder="new card"><button onclick="addCard(\\''+c.id+'\\')">Add</button></div>').join('')+'</div>'}
else{const bs=await api('GET','/boards');a.innerHTML='<button onclick="logout()">Logout</button><h2>Boards</h2><ul>'+bs.map(b=>'<li><a href=# onclick="board=\\''+b.id+'\\';render()">'+esc(b.name)+'</a> ('+b.role+')</li>').join('')+'</ul><input id=bn placeholder="board name"><button onclick="addBoard()">Create</button>'}}
catch(e){token=null;a.innerHTML=login()}}
async function addBoard(){await api('POST','/boards',{name:$('bn').value});render()}
async function addCard(c){await api('POST','/columns/'+c+'/cards',{title:$('t'+c).value});render()}
async function mv(id,columnId){await api('POST','/cards/'+id+'/move',{columnId});render()}
function drop(e,c){e.preventDefault();mv(e.dataTransfer.getData('text'),c)}
render();
</script></body></html>`;
