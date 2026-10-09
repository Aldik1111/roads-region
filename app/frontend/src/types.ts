export type Role='inspector'|'dispatcher'|'contractor';
export type Status='new'|'needs_info'|'assigned'|'accepted'|'in_progress'|'review'|'rework'|'closed'|'cancelled';
export const STATUS_LABELS:Record<Status,string>={new:'Новое',needs_info:'Требует уточнения',assigned:'Назначено',accepted:'Принято исполнителем',in_progress:'В работе',review:'На проверке',rework:'На доработке',closed:'Закрыто',cancelled:'Отменено'};
export const DEFECT_TYPES=['Выбоина','Трещина','Просадка','Люк'];
export interface User{id:string;name:string;email:string;role:Role;contractor_id?:string|null}
export interface Contractor{id:string;name:string}
export interface RoutePoint {lat:number;lng:number}
export interface RouteOption {id:string;geometry:{type:'LineString';coordinates:number[][]};distance_m:number;duration_s:number;summary:string}
export interface RoutePreview {id:string;expires_at:string;start:RoutePoint;end:RoutePoint;options:RouteOption[];decision_points:{lat:number;lng:number;label:string}[];provider:string}
export interface Section {version?:number;id:string;name:string;code:string;length_km:number;geometry:{type:'LineString';coordinates:number[][]};responsible:string;is_demo:boolean;inspector_id:string;inspector_name:string;notes:string;created_at:string;state:'assigned'|'in_progress'|'completed';duration_min:number;source:'osrm'|'demo';start:RoutePoint;end:RoutePoint}
export interface TrackPoint{client_id:string;lat:number;lng:number;recorded_at:string;accuracy_m:number|null}
export interface Inspection{id:string;section_id:string;inspector_id:string;started_at:string;finished_at:string|null;status:'active'|'finished';confirmed:boolean;points:TrackPoint[]}
export interface Photo{id:string;url:string;name:string}
export interface AuditEvent{id:string;action:string;actor_name:string;created_at:string;comment:string|null;before?:Record<string,unknown>;after?:Record<string,unknown>}
export interface Repair{id:string;created_at:string;comment:string;photos:Photo[];decision:'accepted'|'rejected'|null;decision_comment:string|null}
export interface Defect{review_due_at?:string|null;review_overdue?:boolean;id:string;number:string;section_id:string;inspection_id:string|null;type:string;description:string;status:Status;lat:number;lng:number;location_source:'gps'|'manual';accuracy_m:number|null;observed_at:string;received_at:string;inspector_id:string;contractor_id:string|null;contractor_name:string|null;due_at:string|null;overdue:boolean;version:number;photos:Photo[];previous_defect_id:string|null;duplicate_of_id:string|null}
export interface DefectDetail extends Defect{history:AuditEvent[];repairs:Repair[];linked_observations?:Defect[]}
export interface Bootstrap{user:User;sections:Section[];contractors:Contractor[];inspectors:User[]}
export interface RouteResults{route:Section;inspections:Inspection[];defects:Defect[]}

export type WorkTarget={defectId?:string;routeId?:string;nonce:number};
