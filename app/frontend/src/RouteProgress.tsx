import {Activity,AlertTriangle,Clock,MapPin} from 'lucide-react';
import type {Defect,Inspection,Section} from './types';
import {calculateRouteProgress} from './routeProgressMath';
import './route-progress.css';
export {calculateRouteProgress} from './routeProgressMath';
export function RouteProgress({section,inspection,defects}:{section:Section;inspection:Inspection|null;defects:Defect[]}){
 const p=calculateRouteProgress(section,inspection,defects),fmt=(n:number)=>n<10?n.toFixed(1):Math.round(n).toString();
 return <section className="route-progress" aria-label="Прогресс маршрута">
  <div className="route-progress-head"><div><strong>Прогресс маршрута</strong><small>{inspection?inspection.status==='active'?'Текущий осмотр':'Завершённый осмотр':'Осмотр не выбран'}</small></div><Activity size={18}/></div>
  <div className={`route-progress-bar ${p.reliable?'':'unavailable'}`} role="img" aria-label={p.reliable?`Пройдено примерно ${p.coveragePercent}% маршрута`:'Прогресс нельзя надёжно оценить по GPS'}><span style={{width:`${p.reliable?p.coveragePercent:0}%`}}/></div>
  <div className="route-progress-metrics"><span><MapPin size={14}/><b>{p.reliable?`~${fmt(p.travelledKm)} км пройдено`:'Путь приблизительный'}</b><small>{p.reliable?`~${fmt(p.remainingKm)} км осталось`:`из ${fmt(p.routeKm)} км`}</small></span><span><Clock size={14}/><b>{p.durationMin} мин</b><small>длительность</small></span><span><AlertTriangle size={14}/><b>{p.defectCount}</b><small>дефектов</small></span></div>
  {p.gpsGaps>0&&<p className="route-progress-note">Есть разрывы GPS ({p.gpsGaps}); расстояние и доля маршрута могут быть занижены.</p>}
  {!p.reliable&&inspection&&<p className="route-progress-note">GPS-точки не подтверждают непрерывное прохождение маршрута. Оценка пути приблизительная.</p>}
 </section>;
}
export default RouteProgress;
