# Backend report

Implemented the Roads Region API in `app/main.py` using FastAPI and SQLAlchemy. It uses `DATABASE_URL` when set and defaults to a local SQLite database at `backend/roads.db`; PostgreSQL URLs are supported through psycopg. Demo accounts use salted PBKDF2 password hashes and server-side HttpOnly, SameSite session cookies.

All contract endpoints are implemented under `/api`: login/session, bootstrap, defect registry and detail, validated original photo upload/access, inspector-owned GPS inspections and deduplicated track points, defect creation with idempotency, same-section/type duplicate search, recurrence links, and role and contractor scoped transitions with audit history and optimistic version checks. Action payload fields work both at the top level and in a nested `payload` object.

Demo ticket photos are synthetic illustrations in `demo_photos/`, clearly named as demo material. Seeded tickets and responsible-organization text are labelled as demo. Uploaded originals are stored without re-encoding under `uploads/` by default; set `PHOTO_DIR` to change that location.

Run from the repository root with `uvicorn app.main:app --app-dir backend --reload`. Install dependencies with `python -m pip install -r backend/requirements.txt`. Seeded login password for all four demo accounts is `RoadsDemo2026!`.

FastAPI also serves `frontend/dist` when that build exists: static assets are returned directly, browser routes fall back to `index.html`, and unknown `/api/...` paths remain JSON 404 responses.

Audit snapshots record status, due date, contractor id, and contractor name before and after each defect action. Dispatcher `reason` values are recorded as the audit event comment.

Backend verification: `python -m pytest backend/test_api.py -q` — 11 passed. Tests use an isolated temporary `PHOTO_DIR`, so they cannot alter the local app's upload originals. Coverage includes the full defect/repair/rejection cycle, required fields, role and organization/photo access, optimistic conflicts, inspection ownership and track deduplication, idempotency, duplicate linking/search, recurrence links, API 404 behavior, SPA asset/fallback serving, repeat-safe inspection start/finish, rejection of defects linked to finished inspections, deadline/contractor audit snapshots, and JSON 404 for a missing photo file. The only observed test warning was Starlette's deprecation notice for the installed `httpx` integration.

Known limitations: the schema is created on startup without a migration framework, sessions are local MVP sessions with a 14 day expiry, and uploaded files are local filesystem originals. Use persistent shared storage and a migration process before multi-instance production use.
