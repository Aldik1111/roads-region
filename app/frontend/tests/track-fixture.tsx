import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LocationProvider} from '../src/geolocation';
import TrackHistory from '../src/TrackHistory';
import {MapView} from '../src/components';
import type {Section,Inspection,TrackPoint} from '../src/types';
import '../src/styles.css';
const points:TrackPoint[]=Array.from({length:30},(_,i)=>({client_id:`p${i}`,lat:44.85+i*.0001,lng:65.49+i*.0001,accuracy_m:i===15?3000:8,recorded_at:new Date(Date.UTC(2026,9,10,8,0,i*10+(i>=20?120:0))).toISOString()}));
const section={id:'history-route',name:'Маршрут',code:'T-1',geometry:{type:'LineString',coordinates:[[65.48,44.85],[65.481,44.851]]}} as Section;
const inspection={id:'history-one',section_id:section.id,inspector_id:'inspector-old',inspector_name:'Инспектор прежнего осмотра',status:'finished',points,started_at:points[0].recorded_at,finished_at:points.at(-1)!.recorded_at,confirmed:true} as Inspection;
function Fixture(){const [second,setSecond]=useState(false);const [device,setDevice]=useState(false);return <main style={{maxWidth:1100,margin:'auto',padding:12}}><button className="button secondary" onClick={()=>setSecond(!second)}>Другой осмотр</button><button className="button secondary" onClick={()=>setDevice(!device)}>Карта устройства</button>{device?<MapView viewportKey="device-fixture"/>:<TrackHistory section={section} inspection={second?{...inspection,id:'history-two',points:[{...points[0],client_id:'other',lat:43,lng:66}]}:inspection} defects={[]}/>}</main>}
createRoot(document.getElementById('root')!).render(<LocationProvider><Fixture/></LocationProvider>);
