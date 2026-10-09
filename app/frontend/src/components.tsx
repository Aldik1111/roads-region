import {useEffect,useMemo,useRef,useState} from 'react';
import {MapContainer,TileLayer,Polyline,Marker,Popup,Circle,CircleMarker,useMap,useMapEvents} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {MapPin,Map,Route,ClipboardList,Camera,Plus,Check,ChevronLeft,ChevronRight,ArrowRight,RefreshCw,LogOut,Search,Clock,AlertTriangle,CheckCircle2,X,Upload,LocateFixed,Layers,Navigation,Menu,Building2,UserRound,ShieldCheck,Loader2,Eye,FileText,ArrowUpRight,Activity,SlidersHorizontal,History as HistoryIcon} from 'lucide-react';
import type {AuditEvent,Defect,Photo,Section,Status,TrackPoint} from './types';
import {STATUS_LABELS} from './types';
export {UploadField} from './PhotoUpload';
import {useDeviceLocation} from './geolocation';
import {LocationAccuracy} from './LocationAccuracy';
import {buildTrackHistory,preciseTrackPoint} from './trackHistoryMath';
import './track-history.css';
import './map-feedback.css';
const icons:Record<string,typeof MapPin>={map:Map,pin:MapPin,route:Route,clipboard:ClipboardList,camera:Camera,plus:Plus,check:Check,left:ChevronLeft,right:ChevronRight,arrow:ArrowRight,refresh:RefreshCw,logout:LogOut,search:Search,clock:Clock,alert:AlertTriangle,success:CheckCircle2,close:X,upload:Upload,locate:LocateFixed,layers:Layers,navigation:Navigation,menu:Menu,building:Building2,user:UserRound,shield:ShieldCheck,loader:Loader2,eye:Eye,file:FileText,external:ArrowUpRight,activity:Activity,filter:SlidersHorizontal,history:HistoryIcon};
export function Icon({name,size=20}:{name:string;size?:number}){const Component=icons[name]||MapPin;return <Component size={size} strokeWidth={1.8} aria-hidden="true"/>}
export function formatDate(value?:string|null){if(!value)return 'Не назначен';const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
export function StatusBadge({status,overdue=false}:{status:Status;overdue?:boolean}){return <span className="badge-group"><span className={`badge status-${status}`}>{STATUS_LABELS[status]||status}</span>{overdue&&<span className="badge overdue"><Clock size={12}/>Просрочено</span>}</span>}
export function PhotoGallery({photos}:{photos:Photo[]}){return photos.length?<div className="photo-grid">{photos.map(photo=><a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" className="photo"><img src={photo.url} alt={photo.name||'Фотография дефекта'} loading="lazy"/><span><Icon name="external" size={14}/>Открыть оригинал</span></a>)}</div>:<div className="photo-empty"><Icon name="camera"/><span>Фотографий пока нет</span></div>}
const actionLabels:Record<string,string>={created:'Дефект зарегистрирован',create:'Дефект зарегистрирован',assign:'Назначен подрядчик',request_info:'Запрошено уточнение',clarify:'Добавлено уточнение',accept:'Задание принято',start:'Работы начаты',submit:'Ремонт передан на проверку',approve:'Ремонт принят',reject:'Возвращено на доработку',reassign:'Изменён исполнитель',change_deadline:'Изменён срок',report_assignment:'Сообщение об ошибочном назначении',cancel:'Заявка отменена',link_duplicate:'Наблюдение связано с дефектом'};
export function History({events}:{events:AuditEvent[]}) {
 return <div className="timeline">{events.length ? events.map(event => <div className="timeline-item" key={event.id}>
  <span className="timeline-dot"/><div>
   <strong>{actionLabels[event.action]||event.action}</strong>
   <small>{event.actor_name} · {formatDate(event.created_at)}</small>
   {event.comment && <p>{event.comment}</p>}
   {event.before && event.after && <>
    {event.before.due_at !== event.after.due_at && <small className="history-change">Срок: {formatDate(event.before.due_at as string|null)} → {formatDate(event.after.due_at as string|null)}</small>}
    {event.before.contractor_id !== event.after.contractor_id && <small className="history-change">Исполнитель: {String(event.before.contractor_name||'Не назначен')} → {String(event.after.contractor_name||'Не назначен')}</small>}
   </>}
  </div>
 </div>) : <p className="muted">История появится после первого действия.</p>}</div>
}
export const MapViewportMemory={
 load(key:string):{center:[number,number];zoom:number}|null{try{const raw=sessionStorage.getItem(`roads-map:${key}`);if(!raw)return null;const value=JSON.parse(raw);return Array.isArray(value.center)&&value.center.length===2&&value.center.every(Number.isFinite)&&Number.isFinite(value.zoom)?value as {center:[number,number];zoom:number}:null;}catch{return null}},
 save(key:string,center:[number,number],zoom:number){try{sessionStorage.setItem(`roads-map:${key}`,JSON.stringify({center,zoom}));}catch{/* Storage can be disabled in private browsing. */}},
};
const positionZoom=(accuracy:number)=>accuracy<=100?15:accuracy<=1000?13:accuracy<=10000?10:7;
function MapBehaviour({section,defects,track,onPosition,locateOnOpen,viewportKey,restoredViewport,focusTrackPoint,showDevicePosition}:{section?:Section;defects:Defect[];track:TrackPoint[];showDevicePosition:boolean;focusTrackPoint?:TrackPoint|null;onPosition?:(lat:number,lng:number)=>void;locateOnOpen:boolean;viewportKey:string;restoredViewport:{center:[number,number];zoom:number}|null}) {
 const map=useMap();
 const location=useDeviceLocation();
 const restored=!!restoredViewport;
 const positioned=useRef(false),userMoved=useRef(restored),locateRequested=useRef(false),fitted=useRef(restored);
 const programmatic=useRef(false),centeredAccuracy=useRef<number|null>(null);
 const setView=(center:[number,number],zoom:number)=>{programmatic.current=true;try{map.setView(center,zoom,{animate:false})}finally{programmatic.current=false}};
 const scope=useRef(`${section?.id||'general'}:${viewportKey}`);
 const locateButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(locateButton.current){L.DomEvent.disableClickPropagation(locateButton.current);L.DomEvent.disableScrollPropagation(locateButton.current);}},[]);
 useMapEvents({click:e=>onPosition?.(e.latlng.lat,e.latlng.lng),dragstart:()=>{userMoved.current=true;},zoomstart:()=>{if(!programmatic.current)userMoved.current=true;},moveend:()=>{const c=map.getCenter();MapViewportMemory.save(viewportKey,[c.lat,c.lng],map.getZoom());}});
 useEffect(()=>{
  const nextScope=`${section?.id||'general'}:${viewportKey}`;
  if(scope.current===nextScope)return;
  scope.current=nextScope;positioned.current=false;locateRequested.current=false;userMoved.current=!!restoredViewport;fitted.current=!!restoredViewport;
  centeredAccuracy.current=null;
  if(restoredViewport)setView(restoredViewport.center,restoredViewport.zoom);
 },[map,section?.id,viewportKey,restoredViewport]);
 const boundsKey=JSON.stringify([...(section?.geometry.coordinates??defects.map(d=>[d.lng,d.lat])),...track.map(p=>[p.lng,p.lat])]);
 useEffect(()=>{
  const points=JSON.parse(boundsKey).map((c:number[])=>[c[1],c[0]] as [number,number]);
  if(!locateOnOpen&&!fitted.current&&points.length){programmatic.current=true;try{map.fitBounds(L.latLngBounds(points),{padding:[35,35],maxZoom:15,animate:false});fitted.current=true}finally{programmatic.current=false}}
 },[map,boundsKey,locateOnOpen,viewportKey,section?.id]);
 useEffect(()=>{
  const observer=new ResizeObserver(()=>map.invalidateSize({pan:false}));
  observer.observe(map.getContainer());
  return()=>observer.disconnect();
 },[map]);
 useEffect(()=>{
  if(location.ready&&location.position&&(locateRequested.current||(locateOnOpen&&!userMoved.current&&(!positioned.current||(centeredAccuracy.current!==null&&centeredAccuracy.current>100&&location.position.accuracy_m<=100))))){
   positioned.current=true;locateRequested.current=false;centeredAccuracy.current=location.position.accuracy_m;
   setView([location.position.lat,location.position.lng],positionZoom(location.position.accuracy_m));
  }
 },[map,location.ready,location.position,locateOnOpen]);
 useEffect(()=>{if(focusTrackPoint)map.setView([focusTrackPoint.lat,focusTrackPoint.lng],positionZoom(focusTrackPoint.accuracy_m??10000),{animate:false})},[map,focusTrackPoint?.client_id,focusTrackPoint?.lat,focusTrackPoint?.lng,focusTrackPoint?.accuracy_m]);
 if(!showDevicePosition)return null;
 return <button ref={locateButton} type="button" className="map-locate-button" title="Моё местоположение" aria-label="Моё местоположение" onClick={event=>{
  event.stopPropagation();
  if(location.ready&&location.position){positioned.current=true;map.setView([location.position.lat,location.position.lng],positionZoom(location.position.accuracy_m),{animate:false});}
  else{locateRequested.current=true;location.retry();}
 }} onDoubleClick={event=>event.stopPropagation()}><Icon name="locate" size={20}/></button>;
}
export function MapTileLayer({className=''}:{className?:string}) {
 const [status,setStatus]=useState<'loading'|'slow'|'error'|'ready'>(navigator.onLine?'loading':'error');
 const [retry,setRetry]=useState(0),slowTimer=useRef<number|null>(null);
 const sawTileError=useRef(false);
 useEffect(()=>{const online=()=>{setStatus('loading');setRetry(v=>v+1)},offline=()=>setStatus('error');window.addEventListener('online',online);window.addEventListener('offline',offline);return()=>{window.removeEventListener('online',online);window.removeEventListener('offline',offline)}},[]);
 useEffect(()=>{if(slowTimer.current)window.clearTimeout(slowTimer.current);if(status==='loading')slowTimer.current=window.setTimeout(()=>setStatus(s=>s==='loading'?'slow':s),5000);return()=>{if(slowTimer.current)window.clearTimeout(slowTimer.current)}},[status,retry]);
 const url=import.meta.env.VITE_MAP_TILE_URL||'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
 const attribution=import.meta.env.VITE_MAP_TILE_ATTRIBUTION||'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
 return <><TileLayer key={retry} url={url} attribution={attribution} eventHandlers={{loading:()=>{sawTileError.current=false;setStatus('loading')},load:()=>setStatus(sawTileError.current?'error':'ready'),tileerror:()=>{sawTileError.current=true;setStatus('error')}}}/>{status!=='ready'&&<div className={`map-tile-feedback ${className}`} role="status"><span>{!navigator.onLine?'Нет подключения к интернету. Карта попробует загрузить тайлы после восстановления связи.':status==='slow'?'Карта загружается дольше обычного…':status==='loading'?'Загружаем карту…':'Не удалось загрузить карту. Маршрут и точки доступны.'}</span>{navigator.onLine&&status!=='loading'&&<button type="button" onClick={()=>{setStatus('loading');setRetry(v=>v+1)}}><Icon name="refresh" size={14}/>Повторить</button>}</div>}</>;
}
export function MapView({section,defects=[],track=[],selectedId,onSelect,onPosition,selectedPosition,locateOnOpen=true,height=360,viewportKey,focusTrackPoint,onTrackPointSelect,showDevicePosition=true}:{section?:Section;defects?:Defect[];track?:TrackPoint[];selectedId?:string;onSelect?:(id:string)=>void;onPosition?:(lat:number,lng:number)=>void;selectedPosition?:{lat:number;lng:number}|null;locateOnOpen?:boolean;height?:number;viewportKey?:string;showDevicePosition?:boolean;focusTrackPoint?:TrackPoint|null;onTrackPointSelect?:(point:TrackPoint)=>void}) {
 const purposeKey=viewportKey||`${section?.id||'general'}:${onPosition?'pick':'view'}`;
 const restored=useMemo(()=>MapViewportMemory.load(purposeKey),[purposeKey]);
 const location=useDeviceLocation();
 const route=section?.geometry?.coordinates?.map(c=>[c[1],c[0]] as [number,number])||[];
 const history=useMemo(()=>buildTrackHistory(track),[track]);
 const markerStep=Math.max(1,Math.ceil(history.points.length/300));
 const markers=history.points.filter((_,i)=>i%markerStep===0).slice(0,299);
 const lastPoint=history.points.at(-1);if(lastPoint&&markers.at(-1)!==lastPoint)markers.push(lastPoint);
 const fitPoints=history.segments.flat();
 const selectedTrack=focusTrackPoint;
 return <><div className={`map-shell map-feedback ${onPosition?'selectable-map':''}`} style={{height}}>
  <MapContainer center={restored?.center||(locateOnOpen&&location.position?[location.position.lat,location.position.lng]:!locateOnOpen&&route[0]?route[0]:[48,67])} preferCanvas zoom={restored?.zoom??(locateOnOpen&&location.position?positionZoom(location.position.accuracy_m):!locateOnOpen&&route.length?13:5)} zoomSnap={0.25} zoomDelta={0.5} wheelPxPerZoomLevel={180} inertia={false} zoomAnimation={false} fadeAnimation={false} markerZoomAnimation={false} scrollWheelZoom={true} touchZoom={true} style={{height:'100%',width:'100%'}}>
   <MapBehaviour section={section} defects={defects} onPosition={onPosition} locateOnOpen={locateOnOpen} viewportKey={purposeKey} restoredViewport={restored} track={fitPoints} focusTrackPoint={focusTrackPoint} showDevicePosition={showDevicePosition}/>
   <MapTileLayer/>
   {route.length>0&&<><Polyline positions={route} pathOptions={{color:'#fff',weight:12,opacity:.85}}/><Polyline positions={route} pathOptions={{color:'#6976a0',weight:5,dashArray:'8 8'}}/></>}
   {history.segments.map((segment,i)=><Polyline key={'raw'+i} positions={segment.map(p=>[p.lat,p.lng] as [number,number])} pathOptions={{color:'#2563b0',weight:5,opacity:.9,className:'raw-inspector-track'}}/>)}
   {markers.map(point=><CircleMarker key={point.client_id} bubblingMouseEvents={false} center={[point.lat,point.lng]} radius={4} pathOptions={{color:preciseTrackPoint(point)?'#2563b0':'#ad721a',fillOpacity:.8,className:'map-track-point'}} eventHandlers={{click:()=>onTrackPointSelect?.(point)}}><Popup>Записано {new Date(point.recorded_at).toLocaleString('ru-RU')}<br/>{point.accuracy_m===null?'Точность неизвестна':`Точность ±${Math.round(point.accuracy_m)} м`}</Popup></CircleMarker>)}
   {selectedTrack&&<><CircleMarker center={[selectedTrack.lat,selectedTrack.lng]} radius={9} pathOptions={{color:'#164d88',fillColor:'#fff',fillOpacity:1,weight:3,className:'selected-track-point'}}/>{selectedTrack.accuracy_m!==null&&selectedTrack.accuracy_m>=0&&<Circle center={[selectedTrack.lat,selectedTrack.lng]} radius={selectedTrack.accuracy_m} pathOptions={{color:'#2563b0',weight:1,fillOpacity:.12,className:'selected-track-accuracy'}}/>}</>}
   {route.length>1&&[route[0],route[route.length-1]].map((point,i)=><Marker key={'endpoint'+i} position={point} title={i?'Конец маршрута':'Начало маршрута'} icon={L.divIcon({className:'road-marker',html:`<span class="route-endpoint ${i?'finish':''}">${i?'Б':'А'}</span>`,iconSize:[26,26],iconAnchor:[13,13]})}/>)}
   {(section?.via||[]).map((point,index)=><Marker key={`assigned-via-${index}`} position={[point.lat,point.lng]} title={`Обязательная точка ${index+1}`} icon={L.divIcon({className:'road-marker',html:`<span class="assigned-via-marker">${index+1}</span>`,iconSize:[28,28],iconAnchor:[14,14]})}><Popup>Обязательная точка {index+1} маршрута диспетчера</Popup></Marker>)}
   {defects.map(d=><Marker key={d.id} position={[d.lat,d.lng]} title={`${d.number}: ${d.type}`} icon={L.divIcon({className:'road-marker',html:`<span class="map-dot ${d.status==='closed'?'done':''} ${selectedId===d.id?'selected':''}"></span>`,iconSize:[30,30],iconAnchor:[15,15]})} eventHandlers={{click:()=>onSelect?.(d.id)}}><Popup><strong>{d.number} · {d.type}</strong><br/>{STATUS_LABELS[d.status]}<br/>{d.lat.toFixed(5)}, {d.lng.toFixed(5)}</Popup></Marker>)}
   {showDevicePosition&&location.ready&&location.position&&<><Circle center={[location.position.lat,location.position.lng]} radius={location.position.accuracy_m} pathOptions={{color:location.position.accuracy_m>100?'#ad721a':'#16816d',weight:1,fillOpacity:.08,className:'device-accuracy-circle'}}/><Marker position={[location.position.lat,location.position.lng]} title={location.position.accuracy_m>100?'Приблизительное местоположение':'Моё местоположение'} zIndexOffset={900} icon={L.divIcon({className:'road-marker',html:'<span class="device-location-dot"></span>',iconSize:[24,24],iconAnchor:[12,12]})}><Popup>{location.position.accuracy_m>100?'Приблизительная позиция устройства':'Позиция устройства'} · точность ±{Math.round(location.position.accuracy_m)} м<br/>{formatDate(location.position.recorded_at)}</Popup></Marker></>}
   {selectedPosition&&<Marker position={[selectedPosition.lat,selectedPosition.lng]} title="Выбранное место дефекта" zIndexOffset={1000} icon={L.divIcon({className:'road-marker',html:'<span class="selected-location-pin"></span>',iconSize:[32,40],iconAnchor:[16,36]})}><Popup>Выбранное место дефекта<br/>{selectedPosition.lat.toFixed(5)}, {selectedPosition.lng.toFixed(5)}</Popup></Marker>}
  </MapContainer>
  <div className="map-caption"><span className="legend-line planned"/>{section?`План · ${section.code}`:'Дефекты'}{history.points.length>0&&<><span className="legend-line raw-track"/>Фактические GPS-точки{history.gaps.length>0&&<span> · разрывов: {history.gaps.length}</span>}</>}</div>
  {locateOnOpen&&location.status!=='ready'&&<div className="map-location-status" role="status">{location.status==='requesting'?'Ожидаем GPS…':location.status==='reconnecting'?'Связь с GPS потеряна. Ожидаем новое местоположение…':'GPS недоступен. Нажмите прицел, чтобы повторить запрос.'}</div>}
  {onPosition&&<div className="map-hint"><Icon name="pin" size={14}/>Нажмите на карту, чтобы выбрать точку</div>}
 </div>{showDevicePosition&&locateOnOpen&&<LocationAccuracy/>}</>;
}
