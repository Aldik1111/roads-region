import type {TrackPoint} from './types';

export function pointDistanceM(a:TrackPoint,b:TrackPoint){
 const rad=Math.PI/180,dy=(b.lat-a.lat)*rad,dx=(b.lng-a.lng)*rad;
 const h=Math.sin(dy/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dx/2)**2;
 return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));
}
export const preciseTrackPoint=(point:TrackPoint)=>point.accuracy_m!==null&&Number.isFinite(point.accuracy_m)&&point.accuracy_m>=0&&point.accuracy_m<=100;
export function buildTrackHistory(input:TrackPoint[]){
 const seen=new Set<string>();let invalidCount=0;
 const points=input.filter(point=>{
  if(!Number.isFinite(point.lat)||Math.abs(point.lat)>90||!Number.isFinite(point.lng)||Math.abs(point.lng)>180||!Number.isFinite(Date.parse(point.recorded_at))){invalidCount++;return false}
  const key=point.client_id||`${point.recorded_at}:${point.lat}:${point.lng}`;
  if(seen.has(key))return false;seen.add(key);return true;
 }).slice().sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at));
 const segments:TrackPoint[][]=[];const gaps:{from:TrackPoint;to:TrackPoint;reason:string}[]=[];
 let distanceM=0,current:TrackPoint[]=[];
 for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i],dt=(Date.parse(b.recorded_at)-Date.parse(a.recorded_at))/1000;
  const distance=pointDistanceM(a,b);
  const reason=dt>60?'Перерыв записи более минуты':dt<=0?'Одинаковое время разных позиций':!preciseTrackPoint(a)||!preciseTrackPoint(b)?'Недостаточная точность':distance>55*dt+(a.accuracy_m||0)+(b.accuracy_m||0)+30?'Неправдоподобный скачок позиции':'';
  if(reason){if(current.length>1)segments.push(current);current=[];gaps.push({from:a,to:b,reason});continue}
  if(!current.length)current=[a];current.push(b);distanceM+=distance;
 }
 if(current.length>1)segments.push(current);
 return {points,segments,gaps,distanceM,invalidCount,approximateCount:points.filter(p=>!preciseTrackPoint(p)).length};
}
