// zumzum server — один файл, без зависимостей. Node 18+.
// Запуск:  ANTHROPIC_API_KEY=sk-... node server.js
// Переменные: PORT (3000), DATA_DIR (./data), AI_MODEL, MAX_BODY_MB (80)
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,DIR=path.resolve(process.env.DATA_DIR||path.join(__dirname,'data')),
  KEY=process.env.ANTHROPIC_API_KEY||'',MODEL=process.env.AI_MODEL||'claude-sonnet-5-5',MAXB=(+process.env.MAX_BODY_MB||80)*1048576,
  HTML=process.env.HTML_FILE||path.join(__dirname,'zumzum.html');
fs.mkdirSync(DIR,{recursive:true});
const F={db:path.join(DIR,'db.json'),st:path.join(DIR,'state.json')};
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return d}};
const wr=(f,o)=>{const t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(o));fs.renameSync(t,f)};
let DB=rd(F.db,{users:[],sessions:[]}),ST=rd(F.st,{ver:0,state:{}});
const saveDB=()=>wr(F.db,DB);
let lastBak=0;const saveST=()=>{wr(F.st,ST);if(Date.now()-lastBak>36e5){lastBak=Date.now();try{fs.mkdirSync(path.join(DIR,'backup'),{recursive:true});fs.copyFileSync(F.st,path.join(DIR,'backup','state-'+new Date().toISOString().slice(0,13)+'.json'));const a=fs.readdirSync(path.join(DIR,'backup')).sort();while(a.length>48)fs.unlinkSync(path.join(DIR,'backup',a.shift()))}catch(e){}}};
const uid=()=>crypto.randomBytes(5).toString('hex'),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const hashPw=(p,salt)=>crypto.scryptSync(String(p),salt,64).toString('hex');
const okPw=(u,p)=>{const a=Buffer.from(hashPw(p,u.salt),'hex'),b=Buffer.from(u.hash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const pub=u=>({id:u.id,name:u.name,role:u.role,phone:u.phone||'',email:u.email||'',logo:u.logo||''});
const mkUser=(name,pass,role,extra={})=>{const salt=crypto.randomBytes(16).toString('hex');return{id:uid(),name,role,salt,hash:hashPw(pass,salt),phone:'',email:'',logo:'',...extra}};
const hits=new Map();const limit=(k,max,ms)=>{const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);a.push(n);hits.set(k,a);return a.length>max};
setInterval(()=>{const n=Date.now();for(const[k,a]of hits)if(!a.some(t=>n-t<36e5))hits.delete(k);DB.sessions=DB.sessions.filter(s=>s.exp>n);saveDB()},36e5).unref();
const send=(res,code,obj,h={})=>{const b=Buffer.from(JSON.stringify(obj));res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store',...h});res.end(b)};
const body=req=>new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>MAXB){no(Object.assign(new Error('Слишком большой объём данных'),{code:413}));req.destroy()}else c.push(d)});req.on('end',()=>{try{ok(c.length?JSON.parse(Buffer.concat(c).toString('utf8')):{})}catch(e){no(Object.assign(new Error('Некорректный запрос'),{code:400}))}});req.on('error',no)});
const auth=req=>{const t=(req.headers.authorization||'').replace(/^Bearer /,'');if(!t)return null;const h=sha(t),s=DB.sessions.find(x=>x.h===h&&x.exp>Date.now());return s?{u:DB.users.find(u=>u.id===s.uid),h}:null};
const newSession=u=>{const t=crypto.randomBytes(32).toString('hex');DB.sessions.push({h:sha(t),uid:u.id,exp:Date.now()+30*864e5});saveDB();return t};
const ip=req=>req.socket.remoteAddress||'';
const err=(m,c=400)=>Object.assign(new Error(m),{code:c});

async function ai(b){
  if(!KEY)throw err('ИИ не настроен на сервере (нет ANTHROPIC_API_KEY)',503);
  const content=[];for(const d of(b.images||[]).slice(0,4)){const m=/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(String(d));if(m)content.push({type:'image',source:{type:'base64',media_type:m[1],data:m[2]}})}
  content.push({type:'text',text:String(b.prompt||'').slice(0,60000)});
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:4000,messages:[{role:'user',content}]})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw err('Ошибка ИИ: '+((j.error&&j.error.message)||r.status),502);
  return(j.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
}

async function api(req,res,u){
  const m=req.method,p=u.pathname.replace(/^\/api\//,''),a=auth(req);
  if(p==='status'&&m==='GET')return send(res,200,{hasUsers:DB.users.length>0,ai:!!KEY});
  if(p==='register'&&m==='POST'){
    if(DB.users.length)throw err('Регистрация закрыта: аккаунты создаёт администратор',403);
    const b=await body(req),n=String(b.name||'').trim().slice(0,40),w=String(b.pass||'');
    if(!n||w.length<6)throw err('Введите имя и пароль не короче 6 символов');
    const us=mkUser(n,w,'admin',{logo:String(b.logo||'').slice(0,400000)});DB.users.push(us);const t=newSession(us);saveDB();return send(res,200,{token:t,user:pub(us)});
  }
  if(p==='login'&&m==='POST'){
    if(limit('l'+ip(req),10,3e5))throw err('Слишком много попыток входа, подождите 5 минут',429);
    const b=await body(req),us=DB.users.find(x=>x.name.toLowerCase()===String(b.name||'').trim().toLowerCase());
    if(!us||!okPw(us,b.pass||''))throw err('Неверный ник или пароль',401);
    return send(res,200,{token:newSession(us),user:pub(us)});
  }
  if(!a||!a.u)throw err('Нужен вход',401);
  const me=a.u,adm=me.role==='admin';
  if(p==='logout'&&m==='POST'){DB.sessions=DB.sessions.filter(s=>s.h!==a.h);saveDB();return send(res,200,{ok:true})}
  if(p==='me'&&m==='GET')return send(res,200,{user:pub(me),users:DB.users.map(pub)});
  if(p==='me'&&m==='PATCH'){
    const b=await body(req);
    if(b.name!==undefined){const n=String(b.name).trim().slice(0,40);if(!n)throw err('Ник не может быть пустым');if(DB.users.some(x=>x.id!==me.id&&x.name.toLowerCase()===n.toLowerCase()))throw err('Такой ник уже занят');me.name=n}
    if(b.phone!==undefined)me.phone=String(b.phone).slice(0,40);if(b.email!==undefined)me.email=String(b.email).slice(0,100);
    if(b.newPass){if(!okPw(me,b.oldPass||''))throw err('Текущий пароль неверный',403);if(String(b.newPass).length<6)throw err('Пароль не короче 6 символов');me.salt=crypto.randomBytes(16).toString('hex');me.hash=hashPw(b.newPass,me.salt);DB.sessions=DB.sessions.filter(s=>s.uid!==me.id||s.h===a.h)}
    saveDB();return send(res,200,{user:pub(me),users:DB.users.map(pub)});
  }
  if(p==='users'&&m==='POST'){
    if(!adm)throw err('Только администратор',403);const b=await body(req),n=String(b.name||'').trim().slice(0,40),w=String(b.pass||'');
    if(!n||w.length<6)throw err('Введите имя и пароль не короче 6 символов');if(DB.users.some(x=>x.name.toLowerCase()===n.toLowerCase()))throw err('Такой ник уже занят');
    DB.users.push(mkUser(n,w,'editor'));saveDB();return send(res,200,{users:DB.users.map(pub)});
  }
  const um=/^users\/(\w+)$/.exec(p);
  if(um&&m==='DELETE'){if(!adm)throw err('Только администратор',403);if(um[1]===me.id)throw err('Нельзя удалить себя');DB.users=DB.users.filter(x=>x.id!==um[1]);DB.sessions=DB.sessions.filter(s=>s.uid!==um[1]);saveDB();return send(res,200,{users:DB.users.map(pub)})}
  if(um&&m==='PATCH'){if(!adm)throw err('Только администратор',403);const t=DB.users.find(x=>x.id===um[1]);if(!t)throw err('Нет такого пользователя',404);const b=await body(req);if(String(b.pass||'').length<6)throw err('Пароль не короче 6 символов');t.salt=crypto.randomBytes(16).toString('hex');t.hash=hashPw(b.pass,t.salt);DB.sessions=DB.sessions.filter(s=>s.uid!==t.id);saveDB();return send(res,200,{ok:true})}
  if(p==='state'&&m==='GET'){const v=+u.searchParams.get('ver');return send(res,200,v===ST.ver?{same:true,ver:ST.ver}:{ver:ST.ver,state:ST.state})}
  if(p==='state'&&m==='PUT'){const b=await body(req);if(!b.state||typeof b.state!=='object')throw err('Нет данных');
    if(ST.ver>0&&+b.ver!==ST.ver)return send(res,409,{error:'Данные изменены на другом устройстве',ver:ST.ver,state:ST.state});
    ST={ver:ST.ver+1,state:b.state};saveST();return send(res,200,{ver:ST.ver})}
  if(p==='ai'&&m==='POST'){if(limit('a'+me.id,30,6e4))throw err('Слишком часто, подождите минуту',429);const b=await body(req);return send(res,200,{text:await ai(b)})}
  throw err('Не найдено',404);
}

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  try{
    if(u.pathname.startsWith('/api/'))return await api(req,res,u);
    if(req.method==='GET'&&(u.pathname==='/'||u.pathname==='/index.html'||u.pathname==='/zumzum.html')){const b=fs.readFileSync(HTML);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-cache'});return res.end(b)}
    if(u.pathname==='/healthz'){res.writeHead(200);return res.end('ok')}
    res.writeHead(404);res.end('Not found');
  }catch(e){if(!res.headersSent)send(res,e.code&&e.code<600?e.code:500,{error:e.message||'Ошибка сервера'});else res.end()}
}).listen(PORT,()=>console.log(`zumzum: http://localhost:${PORT}  данные: ${DIR}  ИИ: ${KEY?'включён ('+MODEL+')':'выключен'}`));
