import {useEffect,useMemo,useRef,useState} from 'react';
import {MapContainer,TileLayer,Polyline,Marker,Popup,useMap,useMapEvents} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {MapPin,Map,Route,ClipboardList,Camera,Plus,Check,ChevronLeft,ChevronRight,ArrowRight,RefreshCw,LogOut,Search,Clock,AlertTriangle,CheckCircle2,X,Upload,LocateFixed,Layers,Navigation,Menu,Building2,UserRound,ShieldCheck,Loader2,Eye,FileText,ArrowUpRight,Activity,SlidersHorizontal,History as HistoryIcon} from 'lucide-react';
import type {AuditEvent,Defect,Photo,Section,Status,TrackPoint} from './types';
import {STATUS_LABELS} from './types';
export {UploadField} from './PhotoUpload';
import {useDeviceLocation} from './geolocation';
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
function MapBehaviour({section,defects,onPosition,locateOnOpen}:{section?:Section;defects:Defect[];onPosition?:(lat:number,lng:number)=>void;locateOnOpen:boolean}) {
 const map=useMap();
 const location=useDeviceLocation();
 const positioned=useRef(false),userMoved=useRef(false),locateRequested=useRef(false);
 const locateButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(locateButton.current){L.DomEvent.disableClickPropagation(locateButton.current);L.DomEvent.disableScrollPropagation(locateButton.current);}},[]);
 useMapEvents({click:e=>onPosition?.(e.latlng.lat,e.latlng.lng),dragstart:()=>{userMoved.current=true;},zoomstart:()=>{userMoved.current=true;}});
 const boundsKey=JSON.stringify(section?.geometry.coordinates??defects.map(d=>[d.lng,d.lat]));
 useEffect(()=>{
  const points=JSON.parse(boundsKey).map((c:number[])=>[c[1],c[0]] as [number,number]);
  if(!locateOnOpen&&points.length)map.fitBounds(L.latLngBounds(points),{padding:[35,35],maxZoom:15,animate:false});
 },[map,boundsKey,locateOnOpen]);
 useEffect(()=>{
  const observer=new ResizeObserver(()=>map.invalidateSize({pan:false}));
  observer.observe(map.getContainer());
  return()=>observer.disconnect();
 },[map]);
 useEffect(()=>{
  if(location.ready&&location.position&&(locateRequested.current||(locateOnOpen&&!positioned.current&&!userMoved.current))){
   positioned.current=true;locateRequested.current=false;
   map.setView([location.position.lat,location.position.lng],15,{animate:false});
  }
 },[map,location.ready,location.position,locateOnOpen]);
 return <button ref={locateButton} type="button" className="map-locate-button" title="Моё местоположение" aria-label="Моё местоположение" onClick={event=>{
  event.stopPropagation();
  if(location.ready&&location.position){positioned.current=true;map.setView([location.position.lat,location.position.lng],15,{animate:false});}
  else{locateRequested.current=true;location.retry();}
 }} onDoubleClick={event=>event.stopPropagation()}><Icon name="locate" size={20}/></button>;
}
export function MapView({section,defects=[],track=[],selectedId,onSelect,onPosition,selectedPosition,locateOnOpen=true,height=360}:{section?:Section;defects?:Defect[];track?:TrackPoint[];selectedId?:string;onSelect?:(id:string)=>void;onPosition?:(lat:number,lng:number)=>void;selectedPosition?:{lat:number;lng:number}|null;locateOnOpen?:boolean;height?:number}) {
 const [tileError,setTileError]=useState(false);
 const location=useDeviceLocation();
 const route=section?.geometry?.coordinates?.map(c=>[c[1],c[0]] as [number,number])||[];
 const segments=useMemo(()=>{
  const lines:[number,number][][]=[],gaps:[number,number][][]=[];
  let line:[number,number][]=[];
  track.forEach((point,i)=>{
   const prior=track[i-1];
   if(prior&&new Date(point.recorded_at).getTime()-new Date(prior.recorded_at).getTime()>60000){
    if(line.length)lines.push(line);line=[];
    gaps.push([[prior.lat,prior.lng],[point.lat,point.lng]]);
   }
   line.push([point.lat,point.lng]);
  });
  if(line.length)lines.push(line);
  return {lines,gaps};
 },[track]);
 return <div className={`map-shell ${onPosition?'selectable-map':''}`} style={{height}}>
  <MapContainer center={locateOnOpen&&location.position?[location.position.lat,location.position.lng]:!locateOnOpen&&route[0]?route[0]:[48,67]} zoom={locateOnOpen&&location.position?15:!locateOnOpen&&route.length?13:5} zoomSnap={0.25} zoomDelta={0.5} wheelPxPerZoomLevel={180} inertia={false} zoomAnimation={false} fadeAnimation={false} markerZoomAnimation={false} scrollWheelZoom={true} touchZoom={true} style={{height:'100%',width:'100%'}}>
   <MapBehaviour section={section} defects={defects} onPosition={onPosition} locateOnOpen={locateOnOpen}/>
   <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' eventHandlers={{tileerror:()=>setTileError(true)}}/>
   {route.length>0&&<><Polyline positions={route} pathOptions={{color:'#fff',weight:12,opacity:.85}}/><Polyline positions={route} pathOptions={{color:'#6976a0',weight:5,dashArray:'8 8'}}/></>}
   {segments.lines.map((line,i)=><Polyline key={'t'+i} positions={line} pathOptions={{color:'#126e60',weight:5}}/>)}
   {segments.gaps.map((line,i)=><Polyline key={'g'+i} positions={line} pathOptions={{color:'#b45309',weight:5,dashArray:'3 10'}}/>)}
   {route.length>1&&[route[0],route[route.length-1]].map((point,i)=><Marker key={'endpoint'+i} position={point} title={i?'Конец маршрута':'Начало маршрута'} icon={L.divIcon({className:'road-marker',html:`<span class="route-endpoint ${i?'finish':''}">${i?'Б':'А'}</span>`,iconSize:[26,26],iconAnchor:[13,13]})}/>)}
   {defects.map(d=><Marker key={d.id} position={[d.lat,d.lng]} title={`${d.number}: ${d.type}`} icon={L.divIcon({className:'road-marker',html:`<span class="map-dot ${d.status==='closed'?'done':''} ${selectedId===d.id?'selected':''}"></span>`,iconSize:[30,30],iconAnchor:[15,15]})} eventHandlers={{click:()=>onSelect?.(d.id)}}><Popup><strong>{d.number} · {d.type}</strong><br/>{STATUS_LABELS[d.status]}<br/>{d.lat.toFixed(5)}, {d.lng.toFixed(5)}</Popup></Marker>)}
   {track.length>0&&<Marker position={[track.at(-1)!.lat,track.at(-1)!.lng]} title="Последняя GPS-точка" icon={L.divIcon({className:'road-marker',html:'<span class="position-dot"></span>',iconSize:[22,22],iconAnchor:[11,11]})}/>}
   {location.ready&&location.position&&<Marker position={[location.position.lat,location.position.lng]} title="Моё местоположение" zIndexOffset={900} icon={L.divIcon({className:'road-marker',html:'<span class="device-location-dot"></span>',iconSize:[24,24],iconAnchor:[12,12]})}><Popup>Вы здесь · точность ±{Math.round(location.position.accuracy_m)} м</Popup></Marker>}
   {selectedPosition&&<Marker position={[selectedPosition.lat,selectedPosition.lng]} title="Выбранное место дефекта" zIndexOffset={1000} icon={L.divIcon({className:'road-marker',html:'<span class="selected-location-pin"></span>',iconSize:[32,40],iconAnchor:[16,36]})}><Popup>Выбранное место дефекта<br/>{selectedPosition.lat.toFixed(5)}, {selectedPosition.lng.toFixed(5)}</Popup></Marker>}
  </MapContainer>
  <div className="map-caption"><span className="legend-line planned"/>{section?`План · ${section.code}`:'Дефекты'}{track.length>0&&<><span className="legend-line actual"/>GPS-путь</>}</div>
  {tileError&&<div className="map-warning">Подложка карты недоступна. Точки и геометрия маршрута сохранены.</div>}
  {locateOnOpen&&!location.ready&&<div className="map-location-status" role="status">{location.status==='requesting'?'Определяем ваше местоположение…':'Местоположение не получено. Разрешите GPS и нажмите прицел на карте.'}</div>}
  {onPosition&&<div className="map-hint"><Icon name="pin" size={14}/>Нажмите на карту, чтобы выбрать точку</div>}
 </div>;
}
