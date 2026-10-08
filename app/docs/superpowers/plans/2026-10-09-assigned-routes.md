# Assigned routes implementation plan

**Goal:** dispatcher builds and assigns an explicitly selected road route; inspector selects one assignment and records an inspection.
**Architecture:** persisted previews and routes with existing section_id compatibility; OSRM routing behind a server adapter; role UIs consume common contract.
**Stack:** existing React/TS/Leaflet + FastAPI/SQLAlchemy; OSRM HTTP API.
**Spec:** ../../ROUTES-CONTRACT.md. User approved this flow in chat; existing authorization covers implementation and Luna delegation.

## Constraints and review focus
- Preserve existing SQLite data/photos, API defect workflow, design. No live upload cleanup.
- Exactly two points; no fabricated geometry if provider fails.
- More than one option requires explicit selection, including after endpoints change.
- API enforces preview ownership, assignment and one active inspection; idempotent publication.
- Old requests must not overwrite new selection; saved geometry immutable.
- Tests use mocked network and isolated storage; live routing smoke reported separately.

## Tasks
- [x] Backend: add routes/preview persistence, OSRM adapter, selection/assignment APIs and results. Tests first for routing failures, invalid/foreign preview, publication retry, foreign inspector, active-route conflict, persisted geometry and results. Run complete pytest suite.
- [x] Dispatcher: implement RoutePlanner and responsive map/candidate cards/results. Update Operations route labels/filter. Verify build and choices single/multiple/reset/error.
- [x] Inspector: route list/select/start/resume/finish, correct route association and list scoping. Preserve foreground GPS and exact request retries. Verify build and active assignment guards.
- [x] Root: shared types, navigation, shared map fit/captions, API integration review, fresh build/tests, desktop/mobile browser workflow including routing service failure. Review each agent diff.
- [x] Save evidence/docs; restart local app; sync project to existing GitHub app/ preserving repository docs, commit/push and verify remote hash.

Publication verified: origin/main 52456cc6daf4181d326f202a263820564b291589. Local health returned ok=true after GPS checks.
