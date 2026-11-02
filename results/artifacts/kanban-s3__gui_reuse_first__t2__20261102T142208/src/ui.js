export const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kanban</title>
<style>body{font-family:sans-serif;margin:1em}.cols{display:flex;gap:1em;align-items:flex-start}.col{background:#eee;padding:.5em;min-width:200px}.card{background:#fff;margin:.4em 0;padding:.4em;border:1px solid #ccc}</style></head><body>
<h1>Kanban</h1><div id="app"></div>
<script>
let token=localStorage.getItem('token'),boardId=null;
async function api(m,p,b){const r=await fetch('/api'+p,{method:m,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:b?JSON.stringify(b):undefined});
 if(r.status===204)return null;const j=await r.json();if(!r.ok){alert(j.message||j.error);throw new Error(j.error)}return j}
const $=(t,a={},...c)=>{const e=document.createElement(t);for(const k in a){if(k.startsWith('on'))e[k]=a[k];else e.setAttribute(k,a[k])}c.flat().forEach(x=>e.append(x));return e};
async function auth(kind){const username=document.getElementById('u').value,password=document.getElementById('p').value;
 if(kind==='register')await api('POST','/auth/register',{username,password});
 const r=await api('POST','/auth/login',{username,password});token=r.token;localStorage.setItem('token',token);render()}
async function render(){const app=document.getElementById('app');app.innerHTML='';
 if(!token){app.append($('div',{},$('input',{id:'u',placeholder:'username'}),$('input',{id:'p',type:'password',placeholder:'password'}),$('button',{id:'login',onclick:()=>auth('login')},'Login'),$('button',{id:'register',onclick:()=>auth('register')},'Register')));return}
 const top=$('div',{},$('button',{onclick:async()=>{await api('POST','/auth/logout').catch(()=>{});token=null;boardId=null;localStorage.removeItem('token');render()}},'Logout'));app.append(top);
 if(!boardId){const bs=await api('GET','/boards').catch(()=>{token=null;localStorage.removeItem('token');render();return null});if(!bs)return;
  app.append($('h2',{},'Boards'),$('ul',{},bs.map(b=>$('li',{},$('a',{href:'#',onclick:e=>{e.preventDefault();boardId=b.id;render()}},b.name+' ('+b.role+')')))),
  $('input',{id:'bn',placeholder:'new board name'}),$('button',{onclick:async()=>{await api('POST','/boards',{name:document.getElementById('bn').value});render()}},'Create board'));return}
 const b=await api('GET','/boards/'+boardId);
 app.append($('button',{onclick:()=>{boardId=null;render()}},'< Boards'),$('h2',{},b.name));
 const cols=$('div',{class:'cols'});
 for(const c of b.columns){const col=$('div',{class:'col',ondragover:e=>e.preventDefault(),ondrop:async e=>{e.preventDefault();await api('POST','/cards/'+e.dataTransfer.getData('text')+'/move',{columnId:c.id}).catch(()=>{});render()}},
  $('h3',{},c.name+(c.wipLimit?' ('+c.cards.length+'/'+c.wipLimit+')':'')));
  for(const k of c.cards){const idx=b.columns.indexOf(c);col.append($('div',{class:'card',draggable:'true',ondragstart:e=>e.dataTransfer.setData('text',k.id)},k.title,
   $('div',{},b.columns.filter(x=>x.id!==c.id).map(x=>$('button',{onclick:async()=>{await api('POST','/cards/'+k.id+'/move',{columnId:x.id}).catch(()=>{});render()}},'→ '+x.name)))))}
  const inp=$('input',{placeholder:'new card'});col.append(inp,$('button',{onclick:async()=>{await api('POST','/columns/'+c.id+'/cards',{title:inp.value});render()}},'Add'));cols.append(col)}
 app.append(cols)}
render();
</script></body></html>`;
