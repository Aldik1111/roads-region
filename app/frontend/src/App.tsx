import {useEffect,useState} from 'react';
import {api} from './api';
import {fieldStorage} from './fieldStorage';
import {isConnectionFailure} from './fieldClient';
import type {Role,User,WorkTarget} from './types';
import {Icon} from './components';
import Inspector from './Inspector';
import Operations from './Operations';
import RoutePlanner from './RoutePlanner';
import TeamOverview from './TeamOverview';
import {LocationProvider} from './geolocation';
const roleNames:Record<Role,string>={inspector:'Инспектор',dispatcher:'Диспетчер',contractor:'Подрядчик'};
const roles:{role:Role;title:string;description:string;icon:string}[]=[{role:'inspector',title:'Инспектор',description:'Обследование и приёмка',icon:'route'},{role:'dispatcher',title:'Диспетчер',description:'Назначение и контроль',icon:'layers'},{role:'contractor',title:'Подрядчик',description:'Выполнение и сдача работ',icon:'building'}];
export default function App() {
 const [user,setUser]=useState<User|null>(null);
 const [loading,setLoading]=useState(true);
 const [area,setArea]=useState<'routes'|'defects'|'updates'>('routes');
 const [sessionError,setSessionError]=useState('');
 const [demo,setDemo]=useState(false);
 const [noticeCount,setNoticeCount]=useState(0);
 useEffect(()=>{if(!user){setNoticeCount(0);return;}let active=true;const update=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void api.get<unknown[]>('/notifications').then(rows=>{if(active)setNoticeCount(rows.length)}).catch(()=>{});};update();const timer=window.setInterval(update,60000);return()=>{active=false;window.clearInterval(timer)}},[user?.id]);
 const [target,setTarget]=useState<WorkTarget>({nonce:0});
 useEffect(()=>{void api.get<{demo:boolean}>('/health').then(value=>setDemo(value.demo===true)).catch(()=>{});},[]);
 useEffect(()=>{let active=true; void (async()=>{try{const current=await api.get<User>('/me');if(active)setUser(current);await fieldStorage.set('device','session',current);}catch(error){if(isConnectionFailure(error)){try{const saved=await fieldStorage.get<User>('device','session');if(active && saved){setUser(saved);setSessionError('Нет связи с сервером. Открыты сохранённые данные этого устройства.');}}catch{if(active)setSessionError('Локальные данные недоступны. Подключитесь к сети для входа.');}}else{await fieldStorage.remove('device','session').catch(()=>{});}}finally{if(active)setLoading(false);}})();return()=>{active=false;};},[]);
 useEffect(()=>{const reconnect=()=>{if(!user)return;void api.get<User>('/me').then(current=>setSessionError(current.id===user.id?'':'Сеанс изменился. Войдите в свою учётную запись для отправки сохранённых данных.')).catch(()=>{});};window.addEventListener('online',reconnect);return()=>window.removeEventListener('online',reconnect);},[user]);
 async function rememberLogin(current:User){setUser(current);try{await fieldStorage.set('device','session',current);}catch{setSessionError('Не удалось сохранить сеанс для работы без сети.');}}
 async function logout(){try{await api.post('/logout');await fieldStorage.remove('device','session');setUser(null);setArea('routes');setSessionError('')}catch(e){setSessionError((e as Error).message)}}
 if(loading)return <div className="app-loading"><div className="brand-mark"><Icon name="route" size={26}/></div><p>Открываем рабочее пространство…</p></div>;
 if(!user)return <Login demo={demo} onLogin={current=>void rememberLogin(current)}/>;
 const dispatcher=user.role==='dispatcher';
 return <LocationProvider key={user.id} requireGps={user.role==='inspector'}><div className="app-shell">
  <aside className="desktop-sidebar">
   <a href="#" className="brand" onClick={e=>e.preventDefault()}><span className="brand-mark"><Icon name="route" size={24}/></span><span>Дороги<span className="brand-subtitle">ОБЛАСТИ</span></span></a>
   <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
   {dispatcher ? <nav className="sidebar-navigation" aria-label="Разделы диспетчера">
    <button className={`sidebar-nav-item ${area==='routes'?'active':''}`} aria-current={area==='routes'?'page':undefined} onClick={()=>setArea('routes')}><Icon name="route"/><span>Маршруты</span></button>
    <button className={`sidebar-nav-item ${area==='defects'?'active':''}`} aria-current={area==='defects'?'page':undefined} onClick={()=>setArea('defects')}><Icon name="map"/><span>Реестр дефектов</span></button>
   </nav> : <div className="sidebar-current"><Icon name={user.role==='inspector'?'route':'clipboard'}/><span>{user.role==='inspector'?'Мои маршруты':'Мои задания'}</span><span className="live-dot"/></div>}
   <div className="sidebar-info"><span className="section-label">МАРШРУТЫ И ОСМОТРЫ</span><strong>От плана<br/>до результата</strong><span>Назначение · обследование · ремонт</span><div className="mini-road"><i/><b/></div><small>Плановый маршрут и фактический GPS-путь</small></div>
   <div className="sidebar-bottom"><span className="live-dot"/>Локальное рабочее пространство<p>Обследование → ремонт → приёмка</p></div>
  </aside>
  <div className="app-main">
   <header className="topbar"><div className="mobile-brand"><Icon name="route"/>Дороги области</div><div className="breadcrumb">Рабочее пространство <span>/</span> <strong>{roleNames[user.role]}</strong></div><div className="topbar-right">{demo&&<span className="demo-tag">ДЕМО</span>}<button className="button secondary small" onClick={()=>setArea(area==='updates'?'routes':'updates')}>{area==='updates'?'К работе':`Уведомления${noticeCount?` · ${noticeCount}`:''}`}</button><div className="user-avatar">{user.name.slice(0,1)}</div><div className="user-caption"><strong>{user.name}</strong><small>{roleNames[user.role]}</small></div><button className="icon-button" aria-label="Выйти" title="Выйти" onClick={()=>void logout()}><Icon name="logout" size={19}/></button></div></header>
   <main className="workspace" key={user.id}>
    {sessionError&&<div className="alert error" role="alert">{sessionError}</div>}
    {dispatcher&&<nav className="workspace-tabs" aria-label="Рабочие разделы"><button className={area==='routes'?'active':''} onClick={()=>setArea('routes')}><Icon name="route" size={18}/>Маршруты</button><button className={area==='defects'?'active':''} onClick={()=>setArea('defects')}><Icon name="clipboard" size={18}/>Дефекты</button></nav>}
    {area==='updates'&&<TeamOverview user={user} onOpen={notice=>{setTarget({defectId:notice.defect_id,routeId:notice.route_id,nonce:Date.now()});setArea(notice.defect_id?'defects':'routes')}}/>}
    {user.role==='inspector'?<div hidden={area==='updates'}><Inspector user={user} target={target} onLogout={()=>void logout()}/></div>:area==='updates'?null:dispatcher&&area==='routes'?<RoutePlanner user={user} target={target}/>:<Operations user={user} target={target}/>}
   </main>
  </div>
 </div></LocationProvider>;
}
function Login({onLogin,demo}:{onLogin:(user:User)=>void;demo:boolean}){const [selected,setSelected]=useState<Role>('inspector'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');useEffect(()=>{if(demo){setEmail('inspector@roads.local');setPassword('RoadsDemo2026!')}},[demo]);async function login(e:React.FormEvent){e.preventDefault();setBusy(true);setError('');try{onLogin(await api.post<User>('/login',{email,password}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}return <div className="login-page"><section className="login-story"><a className="brand" href="#"><span className="brand-mark"><Icon name="route" size={25}/></span><span>Дороги<span className="brand-subtitle">ОБЛАСТИ</span></span></a><div className="login-message"><span className="eyebrow light"><i/>КОНТРОЛЬ ДОРОЖНОЙ СЕТИ</span><h1>Каждый дефект.<br/>Каждый маршрут.<br/><em>Под контролем.</em></h1><p>От первого снимка до принятого ремонта —<br/>единое пространство для всей команды.</p></div><div className="road-art" aria-hidden="true"><svg viewBox="0 0 600 200"><path d="M-20 150C140 155 180 10 300 65S430 170 650 15" fill="none" stroke="#27433b" strokeWidth="56"/><path d="M-20 150C140 155 180 10 300 65S430 170 650 15" fill="none" stroke="#80a69a" strokeWidth="2" strokeDasharray="10 12"/><circle cx="295" cy="64" r="13" fill="#eaae28" stroke="#f3f4ed" strokeWidth="5"/><circle cx="453" cy="104" r="9" fill="#50ae96" stroke="#f3f4ed" strokeWidth="4"/></svg><span className="art-label"><i/>R-01 · Учебный участок</span></div><div className="login-story-footer"><span>01 / ОБНАРУЖИТЬ</span><span>02 / УСТРАНИТЬ</span><span>03 / ПРИНЯТЬ</span></div></section><section className="login-form-area"><div className="login-form-wrap"><span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2>Добро пожаловать</h2><p className="muted">Войдите, чтобы продолжить работу с дорогами.</p>{demo&&<div className="role-picks">{roles.map(item=><button type="button" key={item.role} className={`role-pick ${selected===item.role?'selected':''}`} onClick={()=>{setSelected(item.role);setEmail(item.role+'@roads.local')}}><Icon name={item.icon}/><span><strong>{item.title}</strong><small>{item.description}</small></span>{selected===item.role&&<Icon name="check" size={16}/>}</button>)}</div>}<form onSubmit={login}><label className="field">Электронная почта<input className="input" type="email" value={email} autoComplete="username" onChange={e=>setEmail(e.target.value)} required/></label><label className="field">Пароль<input className="input" type="password" value={password} autoComplete="current-password" onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div role="alert" className="alert error">{error}</div>}<button className="button primary login-submit" disabled={busy}>{busy?'Входим…':'Войти в систему'}<Icon name="arrow" size={18}/></button></form>{demo&&<div className="demo-note"><Icon name="shield" size={19}/><span><strong>Демонстрационный доступ</strong><br/>Выберите роль — данные для входа уже заполнены.<br/>Учебные заявки отмечены в рабочем пространстве.</span></div>}</div><footer className="login-footer">Дороги области <span>Прозрачный контроль. Проверенный результат.</span></footer></section></div>}
