# Implementation ledger — docs/PLAN.md

Completed: reference saved byte-for-byte; React/TypeScript frontend and FastAPI/SQLAlchemy backend integrated; three Luna subagents implemented and reviewed their modules. Root performed integration and browser review, fixed shared UI and responsive issues, and verified the full repair cycle.

Local application: http://localhost:8000, SQLite. PostgreSQL compose configuration provided; Docker engine unavailable. 11 backend tests pass; TypeScript/Vite build passes. Screenshots and review evidence saved in docs/GALLERY.html and docs/VERIFICATION.md. Startup and stop scripts, README, and API contract saved.

Reference SHA256: F804319BE5CE0A8985A9C78179338464A7EA0E792CEA0AB28AA4C094273FF4A2.

## 2026-10-09: assigned routes and required location

Dispatcher routing from A/B with OSRM alternatives and explicit choice, persisted assignments, inspector route selection, one active inspection, results showing planned path/GPS/defects. Mandatory fresh device location gates the inspector workspace and app mutations; current-location map focus, selected marker, wheel and pinch zoom implemented. Three Luna agents worked on backend, inspector and operations; root integrated and reviewed. Current evidence: 16 API tests pass, frontend build passes, desktop/mobile browser checks pass (including emulated permission loss, stale location, recovery and two-finger gesture). See ROUTES-VERIFICATION.md and GPS-VERIFICATION.md; ROUTES-GALLERY.html contains route screenshots. Production GPS/device checks and PostgreSQL remain untested.

Follow-up fixes 2026-10-09: prevented endpoint/option map jumps; reduced wheel sensitivity; repaired permission grant race and file-picker visibility GPS reset; sequential fresh-position refresh; retained photo retry with timeout and upload-in-progress guards; content-sniffed upload types. 20 API tests and browser photo/map regression pass. Actual desktop provider still did not return a real position in a permitted Chrome probe; see FIXES-2026-10-09.md.

GPS recovery follow-up 2026-10-09: bounded 60-second reconnect window after a previously acquired fix, delayed notice after 15 seconds, edit/upload continuity, fresh-position checks for starting inspections and submitting defects, no stale track points. Build, 17 provider regression groups and isolated Chrome scenarios at 1440/390 pass. Retry does not renew the deadline; permission revocation blocks immediately. See GPS-RECOVERY.md for current behavior and the unimplemented highway/offline roadmap.

## 2026-10-10: field persistence and repair acceptance

Completed user-scoped IndexedDB drafts and original photo storage, durable FIFO for track points/defects/finish, server-confirmed receipts, upload/defect idempotency, session-owner checks, and service-worker shell for reopening a previously loaded inspection offline. Added before/after repair comparison, mandatory control photo/checklist/fresh GPS for acceptance, and evidence history across roles. Preserved GPS grace behavior. Three Luna agents implemented backend, queue and review modules; root integrated and reviewed.

Verified: 28 API tests; 19 GPS regression groups; 10 queue checks; production browser offline/reload/lost-response scenario; repair acceptance and GPS grace at 1440/390 px; TypeScript/Vite production build. Local health endpoint responds successfully. Browser tests use mocked APIs and GPS, not a real highway trip. See FIELD-WORK.md for usage and limits: new inspections start online, no offline basemap or background location, retained local photo archive has no automatic cleanup.

## 2026-10-10: Android test over local HTTPS

User selected Android Chrome on the same Wi-Fi as the PC. Added dedicated LAN HTTPS and public certificate/QR onboarding servers, start/stop scripts, a firewall helper restricted to physical interface/address/two ports/LocalSubnet, and a mobile diagnostics page. HTTPS sessions now use Secure cookies; HTTP localhost still works. Standalone diagnostics cannot replace the offline SPA cache. Keys/certificates are ignored by Git; the CA signing key is never written to disk.

Verified 38 pytest checks (29 API + 9 certificate/setup tests), production build, mobile browser diagnostics with an isolated certificate pin and simulated GPS, zero diagnostic mutations, offline shell retention, strict Python TLS validation, stop/restart while localhost remains healthy. The scoped Windows firewall rule was installed and inspected. A Luna agent reviewed the setup; failed startup cleanup was corrected. Android CA installation and a real phone GPS/photo session remain user-device steps. Usage and cleanup: PHONE-TEST.md.
