import {useEffect,useMemo,useState} from 'react';
import type {Defect,Inspection,Section} from './types';
import {MapView} from './components';
import {buildTrackHistory,preciseTrackPoint} from './trackHistoryMath';
import './track-history.css';

const stamp=(value:string)=>new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});
export default function TrackHistory({section,inspection,defects,height=390}:{section:Section;inspection:Inspection;defects:Defect[];height?:number}){
 const data=useMemo(()=>buildTrackHistory(inspection.points),[inspection.points]);
 const [selectedId,setSelectedId]=useState<string|null>(null),[page,setPage]=useState(0);
 useEffect(()=>{setSelectedId(null);setPage(0)},[inspection.id]);
 const selected=data.points.find(p=>p.client_id===selectedId)||null;
 const selectedIndex=selected?data.points.indexOf(selected):0;
 const choose=(index:number)=>{const point=data.points[index];if(point){setSelectedId(point.client_id);setPage(Math.floor(index/25))}};
 const pageCount=Math.max(1,Math.ceil(data.points.length/25)),visiblePage=Math.min(page,pageCount-1);
 return <section className="track-history" aria-label="История перемещений">
  <header><div><h3>Фактический путь инспектора</h3><p>Инспектор: {inspection.inspector_name||inspection.inspector_id}</p><p>{stamp(inspection.started_at)} → {inspection.finished_at?stamp(inspection.finished_at):'осмотр продолжается'}</p></div><span>{data.points.length} точек · ~{(data.distanceM/1000).toFixed(2)} км по непрерывным отрезкам</span></header>
  <MapView section={section} defects={defects.filter(d=>d.inspection_id===inspection.id)} track={data.points} locateOnOpen={false} showDevicePosition={false} height={height} viewportKey={`track-history:${inspection.id}`} focusTrackPoint={selected} onTrackPointSelect={point=>choose(data.points.findIndex(p=>p.client_id===point.client_id))}/>
  <p className="track-history-help">Синий — полученные координаты, пунктир — план. Путь не привязан к дороге. Разрывы и неточные позиции не соединяются. Запись ведётся только во время осмотра при открытой вкладке.</p>
  {data.points.length>300&&<p className="track-history-help">На обзорной карте показана часть маркеров. Все точки доступны в списке и на шкале времени; линии используют все непрерывные измерения.</p>}
  {data.gaps.length>0&&<p className="track-history-warning">Разрывы или сомнительные интервалы: {data.gaps.length}. Точное прохождение этих мест неизвестно.</p>}
  {data.invalidCount>0&&<p className="track-history-warning">Некорректных записей: {data.invalidCount}. Они не показаны на карте.</p>}
  {data.points.length>0?<><div className="track-history-controls"><button className="button secondary small" disabled={selectedIndex<=0} onClick={()=>choose(selectedIndex-1)}>← Раньше</button><label>Позиция по времени<input aria-label="Позиция по времени" type="range" min={0} max={data.points.length-1} value={selectedIndex} onChange={e=>choose(Number(e.target.value))}/></label><button className="button secondary small" disabled={selectedIndex>=data.points.length-1} onClick={()=>choose(selectedIndex+1)}>Позже →</button></div>
  <div className="track-selected" role="status">{selected?<><b>{stamp(selected.recorded_at)}</b><span>{selected.lat.toFixed(6)}, {selected.lng.toFixed(6)} · {selected.accuracy_m===null?'точность неизвестна':`точность ±${Math.round(selected.accuracy_m)} м`}{!preciseTrackPoint(selected)?' · приблизительная позиция':''}</span></>:<span>Выберите время или точку в списке, чтобы увидеть её на карте.</span>}</div>
  <details><summary>Все GPS-точки и время ({data.points.length})</summary><div className="track-point-list">{data.points.slice(visiblePage*25,(visiblePage+1)*25).map(point=><button key={point.client_id} className={point.client_id===selectedId?'active':''} onClick={()=>choose(data.points.indexOf(point))}><b>{stamp(point.recorded_at)}</b><span>{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</span><small>{point.accuracy_m===null?'Точность неизвестна':`±${Math.round(point.accuracy_m)} м`}{!preciseTrackPoint(point)?' · приблизительно':''}</small></button>)}</div><div className="track-history-pages"><button className="button secondary small" disabled={visiblePage===0} onClick={()=>setPage(visiblePage-1)}>Назад</button><span>{visiblePage+1} / {pageCount}</span><button className="button secondary small" disabled={visiblePage+1>=pageCount} onClick={()=>setPage(visiblePage+1)}>Далее</button></div></details>
  {data.gaps.length>0&&<details><summary>Причины разрывов ({data.gaps.length})</summary><ul>{data.gaps.slice(0,100).map((gap,i)=><li key={i}>{stamp(gap.from.recorded_at)} — {stamp(gap.to.recorded_at)}: {gap.reason}</li>)}</ul>{data.gaps.length>100&&<p>Показаны первые 100 интервалов; все исходные точки доступны выше.</p>}</details>}</>:<p>GPS-точки этого осмотра ещё не поступили.</p>}
  <small className="track-history-help">Координаты и время получены от устройства. Они помогают проверить посещение, но сами по себе не доказывают присутствие человека.</small>
 </section>;
}
