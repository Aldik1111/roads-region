import type {Defect,Inspection,Section,TrackPoint} from './types';

const EARTH_M=6371000;
function distance(a:{lat:number;lng:number},b:{lat:number;lng:number}){const rad=Math.PI/180,lat1=a.lat*rad,lat2=b.lat*rad,dl=(b.lng-a.lng)*rad,dp=(b.lat-a.lat)*rad;const h=Math.sin(dp/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dl/2)**2;return 2*EARTH_M*Math.asin(Math.sqrt(h));}
type Vertex={lat:number;lng:number;along:number};
export type MatchedRouteSample={point:TrackPoint;alongM:number;offsetM:number};
export type RouteProgressResult={routeKm:number;travelledKm:number;remainingKm:number;durationMin:number;defectCount:number;matchedPoints:number;gpsGaps:number;reliable:boolean;coveragePercent:number|null;matchedSegments:[TrackPoint,TrackPoint][]};
export function calculateRouteProgress(section:Section,inspection:Inspection|null,defects:Defect[]):RouteProgressResult{
 const vertices:Vertex[]=(section.geometry?.coordinates||[]).map(([lng,lat])=>({lat,lng,along:0}));
 for(let i=1;i<vertices.length;i++)vertices[i].along=vertices[i-1].along+distance(vertices[i-1],vertices[i]);
 const routeM=vertices.at(-1)?.along||0,points=inspection?.points||[];
 let matched=0,gaps=0,lastMatchedAt:number|null=null,previous:TrackPoint|undefined;
 const samples:(MatchedRouteSample|null)[]=[];let validEdges=0;
 for(const p of points){
  const at=Date.parse(p.recorded_at),elapsedS=previous?(at-Date.parse(previous.recorded_at))/1000:0;
  if(previous&&elapsedS>60)gaps++;
  const movementAllowance=previous?55*Math.max(0,elapsedS)+(previous.accuracy_m||0)+(p.accuracy_m||0)+30:0;
  if(previous&&distance(previous,p)>movementAllowance)gaps++;
  let best:{along:number;offset:number}|null=null;
  for(let i=1;i<vertices.length;i++){
   const a=vertices[i-1],b=vertices[i],length=b.along-a.along;if(!length)continue;
   const meanLat=(a.lat+b.lat)/2,scaleLng=Math.cos(meanLat*Math.PI/180);
   const bx=(b.lng-a.lng)*scaleLng,by=b.lat-a.lat,px=(p.lng-a.lng)*scaleLng,py=p.lat-a.lat;
   const t=Math.max(0,Math.min(1,(px*bx+py*by)/(bx*bx+by*by||1))),offset=Math.hypot(px-bx*t,py-by*t)*Math.PI/180*EARTH_M;
   if(!best||offset<best.offset)best={along:a.along+t*length,offset};
  }
  const accuracy=p.accuracy_m;
  const tolerance=accuracy!==null&&accuracy<=100?Math.max(60,Math.min(180,accuracy*2.5)):0;
  if(best&&tolerance>0&&best.offset<=tolerance){matched++;lastMatchedAt=Number.isFinite(at)?at:lastMatchedAt;samples.push({point:p,alongM:best.along,offsetM:best.offset});}
  else samples.push(null);
  previous=p;
 }
 const durationEnd=inspection?.finished_at?Date.parse(inspection.finished_at):inspection?.status==='active'?Date.now():lastMatchedAt||Date.now();
 const durationMin=inspection?Math.max(0,Math.round((durationEnd-Date.parse(inspection.started_at))/60000)):0;
 const intervals:[number,number][]=[];
 const matchedSegments:[TrackPoint,TrackPoint][]=[];
 for(let i=1;i<samples.length;i++){
  const a=samples[i-1],b=samples[i];if(!a||!b)continue;
  const dt=Date.parse(b.point.recorded_at)-Date.parse(a.point.recorded_at),travel=distance(a.point,b.point);
  const along=Math.abs(b.alongM-a.alongM),accuracy=(a.point.accuracy_m||0)+(b.point.accuracy_m||0);
  const movementAllowance=55*Math.max(0,dt/1000)+accuracy+30;
  if(dt<=0||dt>60000||travel>movementAllowance||along>travel*1.5+accuracy+20)continue;
  validEdges++;intervals.push([Math.min(a.alongM,b.alongM),Math.max(a.alongM,b.alongM)]);matchedSegments.push([a.point,b.point]);
 }
 // Sum the union of forward observed intervals. This avoids treating the start-to-first-fix gap as traveled and avoids counting backtracks twice.
 intervals.sort((a,b)=>a[0]-b[0]);let travelledM=0,intervalEnd=-1;
 for(const [start,end] of intervals){if(end<=intervalEnd)continue;travelledM+=end-Math.max(start,intervalEnd);intervalEnd=end;}
 const reliable=routeM>0&&matched>=3&&matched/Math.max(1,points.length)>=.6&&gaps===0&&validEdges>=2;
 // Sparse isolated samples don't substantiate a colored traveled segment.
 if(validEdges<2)matchedSegments.length=0;
 const coveragePercent=reliable&&routeM?Math.round(Math.min(routeM,travelledM)/routeM*100):null;
 const inspectionDefects=defects.filter(d=>d.section_id===section.id&&(inspection?d.inspection_id===inspection.id:true));
 return{routeKm:routeM/1000,travelledKm:Math.min(routeM,travelledM)/1000,remainingKm:Math.max(0,routeM-travelledM)/1000,durationMin,defectCount:inspectionDefects.length,matchedPoints:matched,gpsGaps:gaps,reliable,coveragePercent,matchedSegments};
}
