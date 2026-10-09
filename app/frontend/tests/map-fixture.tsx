import React from 'react';
import {createRoot} from 'react-dom/client';
import {LocationProvider} from '../src/geolocation';
import {MapView} from '../src/components';
import type {Section} from '../src/types';

function section(alternate=false):Section{return{id:alternate?'fixture-route-alt':'fixture-route',name:'Fixture',code:'T-1',length_km:2,geometry:{type:'LineString',coordinates:alternate?[[10,10],[10.02,10]]:[[67,48],[67.02,48]]},responsible:'',is_demo:true,inspector_id:'',inspector_name:'',notes:'',created_at:'',state:'in_progress',duration_min:0,source:'demo',start:{lat:48,lng:67},end:{lat:48,lng:67.02}}}
function Fixture({alternate=false,viewport='browser-fixture'}:{alternate?:boolean;viewport?:string}){return <><div style={{padding:8,display:'flex',gap:8}}><button onClick={()=>window.__changeRoute?.()}>Change route geometry</button><button onClick={()=>window.__changeScope?.()}>Change map scope</button></div><MapView section={section(alternate)} viewportKey={viewport} locateOnOpen={false} height={420}/></>}
const root=createRoot(document.getElementById('root')!);
root.render(<LocationProvider><Fixture/></LocationProvider>);
window.__changeRoute=()=>root.render(<LocationProvider><Fixture alternate/></LocationProvider>);
window.__changeScope=()=>root.render(<LocationProvider><Fixture alternate viewport="other-scope"/></LocationProvider>);
declare global{interface Window{__changeRoute?:()=>void;__changeScope?:()=>void}}
