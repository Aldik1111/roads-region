# Implementation plan

Goal: locally runnable Roads Region MVP following preserved reference and CONTRACT.md.

1. Root preserves design and writes common API/types/scaffold and reusable map/photo/history widgets.
2. Luna backend implements persistent FastAPI service, PostgreSQL-compatible SQLAlchemy models, local SQLite fallback, access and audit, seeded demo, tests.
3. Luna inspector implements field workflow and acceptance responsive UI.
4. Luna operations implements dispatcher/contractor workflow responsive UI.
5. Root integrates, builds, runs server, performs desktop/mobile browser checks and full role workflow, delegates review/fixes, saves evidence and launch instructions.

Rulings: user explicitly authorized implementation after reviewing design, so proceed without another approval. Fresh repository under outputs/roads-region-app is isolated. Local runtime may use SQLite if Docker cannot start; PostgreSQL compose configuration remains provided and the active database is disclosed. All subagents use gpt-6-luna as explicitly requested; root model cannot be changed by tool.

Interface review: backend produces CONTRACT API consumed by both role modules; root produces types/api/components consumed by both modules. No shared file ownership except contract changes coordinated through root. Status and upload constraints apply to all components.
