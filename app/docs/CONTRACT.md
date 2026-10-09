# Roads Region MVP — implementation contract

User authorized complete implementation, local startup, multi-agent work and testing. Preserve design/reference.html visual language: warm off-white, deep forest header, teal actions, rounded white panels, pastel status badges, restrained borders. Russian UI. Three roles inspector / dispatcher / contractor, single database. Persistent routes built and assigned by dispatcher; original synthetic R-01 retained for history. See [ROUTES-CONTRACT.md](ROUTES-CONTRACT.md) for current routing and assignment API, types and permissions, which extend this baseline contract. Responsive phone/tablet/desktop, functional camera/file attachment, foreground GPS with manual fallback, defect workflow, immutable originals and audit.

## API
All below /api. Browser fetch credentials include. JSON errors {code,message,details?,request_id}. UUID/string IDs; UTC ISO timestamps; lat/lng degrees. Login seeded users inspector@roads.local / dispatcher@roads.local / contractor@roads.local and contractor2@roads.local; password RoadsDemo2026!. Password hashes and server sessions, HttpOnly SameSite cookie, role+organization checks. Only authorized photo access through API.

GET /me -> User; POST /login {email,password} -> User; POST /logout -> {ok:true}.
GET /bootstrap -> {user,sections:Section[],contractors:Contractor[]}.
GET /defects -> Defect[] (contractor restricted to own assignments; other roles see demo region).
GET /defects/{id} -> DefectDetail (same access checks).
POST /files multipart field file -> Photo. Validate image MIME/content and size <=10MB, keep original bytes. GET photo url must enforce access.
POST /inspections {section_id} -> Inspection; GET /inspections -> Inspection[]; GET /inspections/{id} -> Inspection.
POST /inspections/{id}/points {points:TrackPoint[]} -> Inspection. Points have client_id dedupe. POST /inspections/{id}/finish {confirmed:true} -> Inspection. Only owner inspector.
POST /defects {section_id,inspection_id?,type,description,lat,lng,location_source,accuracy_m,observed_at,photo_ids:string[],previous_defect_id?} with Idempotency-Key header -> DefectDetail. At least one own uploaded photo, original metadata immutable.
GET /defects/{id}/duplicates -> Defect[] same section/type and <=30m, open defects only.
POST /defects/{id}/actions {action,version,...payload} -> DefectDetail. Optimistic version check (409 CONFLICT). Mutations atomic with audit.
- assign: contractor_id,due_at,comment?; new -> assigned, dispatcher
- request_info: comment required; new -> needs_info, dispatcher
- clarify: comment required; needs_info -> new, original inspector
- accept: assigned -> accepted, assigned contractor
- start: accepted/rework -> in_progress, assigned contractor
- submit: photo_ids new own files + comment required; in_progress -> review, assigned contractor, creates repair attempt
- approve: review -> closed, inspector
- reject: comment required; review -> rework, inspector
- reassign: contractor_id,due_at,reason required; assigned/accepted/in_progress/rework -> assigned, dispatcher
- change_deadline: due_at,reason required; assigned/accepted/in_progress/review/rework, dispatcher
- report_assignment: reason required; assigned only, own contractor, journal event no status change
- cancel: reason required; new/needs_info/assigned -> cancelled, dispatcher
- link_duplicate: target_id required; new/needs_info -> cancelled with duplicate_of_id; preserve observations and originals, only matching open candidate; dispatcher
Closed defect never reopens. A new defect can link previous_defect_id when recurrence after closure. overdue independent boolean computed server.

## TypeScript shape
User {id,name,email,role,contractor_id?:string|null}
Contractor {id,name}
Section {id,name,code,length_km,geometry:{type:'LineString',coordinates:number[][]},responsible,is_demo:boolean}
TrackPoint {client_id,lat,lng,recorded_at,accuracy_m:number|null}
Inspection {id,section_id,inspector_id,started_at,finished_at:string|null,status:'active'|'finished',confirmed:boolean,points:TrackPoint[]}
Photo {id,url,name}
AuditEvent {id,action,actor_name,created_at,comment:string|null,before?:object,after?:object}
Repair {id,created_at,comment,photos:Photo[],decision:'accepted'|'rejected'|null,decision_comment:string|null}
Defect {id,number,section_id,inspection_id:string|null,type,description,status,lat,lng,location_source:'gps'|'manual',accuracy_m:number|null,observed_at,received_at,inspector_id,contractor_id:string|null,contractor_name:string|null,due_at:string|null,overdue:boolean,version:number,photos:Photo[],previous_defect_id:string|null,duplicate_of_id:string|null}
DefectDetail extends Defect {history:AuditEvent[],repairs:Repair[],linked_observations?:Defect[]}
Status = new | needs_info | assigned | accepted | in_progress | review | rework | closed | cancelled.

## Frontend shared interfaces (root owns)
src/api.ts exports api.get<T>(path), api.post<T>(path,body?,headers?), upload(file):Promise<Photo>, ApiError with message/code. Paths include /api prefix in helper, consumers pass '/defects'.
src/types.ts exports all shapes above, STATUS_LABELS, DEFECT_TYPES (Выбоина/Трещина/Просадка/Люк).
src/components.tsx exports MapView({section?:Section,defects?:Defect[],track?:TrackPoint[],selectedId?:string,onSelect?:(id:string)=>void,onPosition?:(lat:number,lng:number)=>void,height?:number}), StatusBadge({status:Status,overdue?:boolean}), PhotoGallery({photos:Photo[]}), UploadField({photos:Photo[],onChange:(photos:Photo[])=>void,label?:string}), History({events:AuditEvent[]}), Icon({name:string,size?:number}), formatDate(value?:string|null).
src/styles.css root owns global styles. Shared classes: page-head, eyebrow, muted, button (primary/secondary/danger/small), card, field, input, textarea, select, badge, alert (error/success/warning), empty, stack, row, split, tabs, tab (active), section-label, stat, toolbar, modal-backdrop, modal, photo-grid, action-bar. Feature styles in own files.
src/Inspector.tsx default Inspector({user:User}); owns src/inspector.css. Internal navigation for sections/survey/create/list/detail.
src/Operations.tsx default Operations({user:User}); owns src/operations.css. Dispatcher+contractor, registry/map/detail/role actions, refresh, visible errors.

## QA
Backend pytest: full cycle, rejection/resubmit, wrong role/org, illegal transitions, required fields, immutable originals/history, idempotency and version conflict, duplicate and recurrence, inspection ownership. Frontend tsc+build. Browser end-to-end three roles same ticket, errors/manual GPS, photo upload, responsive sizes 390/820/1440, no horizontal overflow. Photo gallery uses real local sample image assets labelled demo; design placeholders only on empty upload.

## Ownership
Backend agent backend/** only. Inspector agent frontend/src/Inspector.tsx + inspector.css only. Operations agent frontend/src/Operations.tsx + operations.css only. Root owns frontend scaffold, shared files, assets, docs, start scripts and integration. Do not change another owner's files without coordination. No cloud deployment or external messages.

## Field-work extensions (2026-10-10)

- `POST /api/files` accepts optional `Idempotency-Key`; replay with identical bytes returns the existing photo, different bytes return 409.
- Queue requests include `X-Field-Owner`; authenticated owner mismatch returns 403 before mutation.
- Finish accepts optional `finished_at` with the original device completion time, between inspection start and server time plus 30 seconds.
- Approve requires `review_evidence: {photo_ids, checklist: {surface_restored:true, no_visible_damage:true, area_safe:true}, lat, lng, accuracy_m, recorded_at}`. Server validates photos belong to the reviewing inspector, finite location values and a position no older than five minutes (future tolerance 30 seconds). Any authorized inspector may review; the original author is not required. Reject requires a comment and no acceptance evidence.
- `Repair.review_evidence` is optional for legacy reports and includes submitted evidence plus `photos`, `inspector_id`, `checked_at`, `distance_m`. See FIELD-WORK.md for UI and offline behavior.
