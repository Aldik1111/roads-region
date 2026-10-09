import { ApiError } from './api';
import { fieldStorage } from './fieldStorage';
import { listFieldJobs } from './fieldQueue';
import type { Bootstrap, Defect, Inspection, Photo } from './types';

export type FieldSnapshot = { boot: Bootstrap; inspections: Inspection[]; defects: Defect[] };
export type FieldDraft = {
  sectionId: string | null; type: string; description: string; photos: Photo[];
  gps: {lat:number;lng:number;accuracy_m:number|null;source:'gps'|'manual'} | null;
  manualLat: string; manualLng: string; previousDefectId: string | null;
  idempotency: {fingerprint:string;key:string;body:Record<string,unknown>} | null;
  updatedAt: string;
};
export function isConnectionFailure(error: unknown) {
  return error instanceof ApiError && (error.code === 'NETWORK_ERROR' || /^5\d\d$/.test(error.code));
}
export async function mergeLocalInspection(ownerId:string, snapshot:FieldSnapshot):Promise<FieldSnapshot> {
  const jobs=await listFieldJobs(ownerId);
  const local = await fieldStorage.get<Inspection>(ownerId,'activeInspection');
  const inspections = [...snapshot.inspections];
  if (local) {
    const index = inspections.findIndex(i=>i.id===local.id);
    if (index < 0) inspections.unshift(local);
    else if(inspections[index].status==='active' && local.status==='active') {
      const points = new Map(inspections[index].points.map(p=>[p.client_id,p]));
      local.points.forEach(p=>points.set(p.client_id,p));
      inspections[index]={...inspections[index],points:[...points.values()].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at))};
    }
  }
  for (let i=0;i<inspections.length;i++) {
    const queuedPoints=jobs.filter(j=>j.kind==='points' && j.inspectionId===inspections[i].id).flatMap(j=>(j.body.points??[]) as Inspection['points']);
    const points=new Map(inspections[i].points.map(p=>[p.client_id,p]));queuedPoints.forEach(p=>points.set(p.client_id,p));
    inspections[i]={...inspections[i],points:[...points.values()].sort((a,b)=>a.recorded_at.localeCompare(b.recorded_at))};
    const pendingFinish=jobs.find(j=>j.kind==='finish' && j.inspectionId===inspections[i].id);
    const receipt=await fieldStorage.get<{result:Inspection}>(ownerId,'receipt:finish-'+inspections[i].id);
    const finishReceipt=receipt?.result;
    const sealed=pendingFinish?.body.finished_at as string | undefined || finishReceipt?.finished_at;
    if(sealed) inspections[i]={...inspections[i],status:'finished',confirmed:true,finished_at:sealed};
  }
  return {...snapshot,inspections};
}
