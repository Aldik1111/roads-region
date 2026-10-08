import os
import sys
import tempfile
from pathlib import Path

# Keep both test database and uploads away from the app's live local data.
os.environ["DATABASE_URL"] = "sqlite://"
TEST_PHOTO_DIR = tempfile.TemporaryDirectory(prefix="roads-backend-test-photos-")
os.environ["PHOTO_DIR"] = TEST_PHOTO_DIR.name
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient
import app.main as main
from app.main import DefectRow, PhotoRow, SessionLocal, app

client = TestClient(app)
PASSWORD = "RoadsDemo2026!"


def login(email):
    response = client.post("/api/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()


def upload_png():
    data = (Path(__file__).parent / "demo_photos" / "demo-road-condition.png").read_bytes()
    response = client.post("/api/files", files={"file": ("demo.png", data, "image/png")})
    assert response.status_code == 200, response.text
    return response.json()


def create_ticket(photo, key="test-create-1"):
    return client.post("/api/defects", headers={"Idempotency-Key": key}, json={
        "section_id": "r-01", "type": "Выбоина", "description": "Демо: тестовая выбоина",
        "lat": 44.8491, "lng": 65.5022, "location_source": "gps", "accuracy_m": 6.2,
        "observed_at": "2026-10-08T10:00:00Z", "photo_ids": [photo["id"]],
    })


def act(defect, action, payload=None, as_user=None):
    return client.post(f"/api/defects/{defect['id']}/actions", json={"action": action, "version": defect["version"], **(payload or {})})


def test_login_upload_idempotency_duplicate_and_full_repair_cycle():
    login("inspector@roads.local")
    photo = upload_png()
    created = create_ticket(photo)
    assert created.status_code == 200, created.text
    ticket = created.json()
    assert ticket["status"] == "new" and ticket["version"] == 1
    repeated = create_ticket(photo)
    assert repeated.status_code == 200
    assert repeated.json()["id"] == ticket["id"]

    dispatcher = login("dispatcher@roads.local")
    assigned = act(ticket, "assign", {"contractor_id": "c-1", "due_at": "2026-10-20T12:00:00Z"})
    assert assigned.status_code == 200, assigned.text
    ticket = assigned.json()
    assert ticket["status"] == "assigned" and ticket["version"] == 2
    assert ticket["contractor_name"] == "Кызылорда ЖолСервис"

    login("contractor@roads.local")
    assert client.get(f"/api/defects/{ticket['id']}").status_code == 200
    assert client.get(f"/api/photos/{photo['id']}").status_code == 200
    accept = act(ticket, "accept")
    assert accept.status_code == 200, accept.text
    ticket = accept.json()
    started = act(ticket, "start")
    assert started.status_code == 200, started.text
    ticket = started.json()
    repair_photo = upload_png()
    submitted = act(ticket, "submit", {"photo_ids": [repair_photo["id"]], "comment": "Демо: ремонт выполнен"})
    assert submitted.status_code == 200, submitted.text
    ticket = submitted.json()
    assert ticket["status"] == "review" and len(ticket["repairs"]) == 1

    login("inspector@roads.local")
    rejected = act(ticket, "reject", {"comment": "Демо: нужна дополнительная обработка"})
    assert rejected.status_code == 200, rejected.text
    ticket = rejected.json()
    assert ticket["status"] == "rework" and ticket["repairs"][0]["decision"] == "rejected"
    assert len(ticket["history"]) == 6

    login("contractor@roads.local")
    ticket = act(ticket, "start").json()
    ticket = act(ticket, "submit", {"photo_ids": [repair_photo["id"]], "comment": "Демо: повторная отправка"}).json()
    login("inspector@roads.local")
    closed = act(ticket, "approve", {"comment": "Демо: принято"})
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "closed"
    assert closed.json()["repairs"][-1]["decision"] == "accepted"


def test_role_org_enforcement_conflicts_and_required_fields():
    login("inspector@roads.local")
    photo = upload_png()
    ticket = create_ticket(photo, "role-test-ticket").json()
    assert act(ticket, "assign", {"contractor_id": "c-1", "due_at": "2026-10-20T12:00:00Z"}).status_code == 403
    login("dispatcher@roads.local")
    assert act(ticket, "approve").status_code == 403
    login("inspector@roads.local")
    assert act(ticket, "clarify", {"comment": "не может"}).status_code == 403

    login("dispatcher@roads.local")
    assigned = act(ticket, "assign", {"contractor_id": "c-1", "due_at": "2026-10-20T12:00:00Z"}).json()
    stale = client.post(f"/api/defects/{ticket['id']}/actions", json={"action": "cancel", "version": ticket["version"], "reason": "устарело"})
    assert stale.status_code == 409
    assert stale.json()["code"] == "CONFLICT"

    login("contractor2@roads.local")
    assert client.get(f"/api/defects/{ticket['id']}").status_code == 404
    assert client.get(f"/api/photos/{photo['id']}").status_code == 404
    foreign_accept = act(assigned, "accept")
    assert foreign_accept.status_code == 404
    login("contractor@roads.local")
    accepted = act(assigned, "accept").json()
    started = act(accepted, "start").json()
    assert act(started, "submit", {"comment": "нет фото"}).status_code == 422


def test_deadline_and_contractor_changes_keep_before_after_values_in_audit():
    login("inspector@roads.local")
    ticket = create_ticket(upload_png(), "audit-change-test").json()
    login("dispatcher@roads.local")
    assigned = client.post(f"/api/defects/{ticket['id']}/actions", json={
        "action": "assign", "version": ticket["version"], "contractor_id": "c-1",
        "due_at": "2026-10-20T12:00:00Z", "comment": "Первичное назначение",
    }).json()

    deadline = client.post(f"/api/defects/{ticket['id']}/actions", json={
        "action": "change_deadline", "version": assigned["version"],
        "due_at": "2026-10-25T12:00:00Z", "reason": "Погодные условия",
    }).json()
    deadline_event = deadline["history"][-1]
    assert deadline_event["comment"] == "Погодные условия"
    assert deadline_event["before"] == {
        "status": "assigned", "due_at": "2026-10-20T12:00:00Z",
        "contractor_id": "c-1", "contractor_name": "Кызылорда ЖолСервис",
    }
    assert deadline_event["after"] == {
        "status": "assigned", "due_at": "2026-10-25T12:00:00Z",
        "contractor_id": "c-1", "contractor_name": "Кызылорда ЖолСервис",
    }

    reassigned = client.post(f"/api/defects/{ticket['id']}/actions", json={
        "action": "reassign", "version": deadline["version"], "contractor_id": "c-2",
        "due_at": "2026-10-28T12:00:00Z", "reason": "Перераспределение работ",
    }).json()
    reassignment_event = reassigned["history"][-1]
    assert reassignment_event["comment"] == "Перераспределение работ"
    assert reassignment_event["before"]["contractor_id"] == "c-1"
    assert reassignment_event["before"]["contractor_name"] == "Кызылорда ЖолСервис"
    assert reassignment_event["before"]["due_at"] == "2026-10-25T12:00:00Z"
    assert reassignment_event["after"]["status"] == "assigned"
    assert reassignment_event["after"]["contractor_id"] == "c-2"
    assert reassignment_event["after"]["contractor_name"] == "ДорСтрой Сырдарья"
    assert reassignment_event["after"]["due_at"] == "2026-10-28T12:00:00Z"


def test_inspection_ownership_and_track_deduplication():
    login("inspector@roads.local")
    inspection = client.post("/api/inspections", json={"section_id": "r-01"}).json()
    point = {"client_id": "point-1", "lat": 44.85, "lng": 65.51, "recorded_at": "2026-10-08T10:01:00Z", "accuracy_m": 4}
    posted = client.post(f"/api/inspections/{inspection['id']}/points", json={"points": [point, point]})
    assert posted.status_code == 200
    assert len(posted.json()["points"]) == 1
    assert client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": False}).status_code == 422
    first_finish = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True})
    assert first_finish.json()["status"] == "finished"
    confirmed_false = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": False})
    assert confirmed_false.status_code == 422
    repeated_finish = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True})
    assert repeated_finish.status_code == 200
    assert repeated_finish.json() == first_finish.json()
    login("dispatcher@roads.local")
    assert client.get(f"/api/inspections/{inspection['id']}").status_code == 403


def test_restarting_section_returns_existing_active_inspection():
    login("inspector@roads.local")
    first = client.post("/api/inspections", json={"section_id": "r-01"})
    second = client.post("/api/inspections", json={"section_id": "r-01"})
    assert first.status_code == second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    active = [item for item in client.get("/api/inspections").json() if item["status"] == "active" and item["section_id"] == "r-01"]
    assert len(active) == 1


def test_duplicate_search_and_photo_validation():
    login("inspector@roads.local")
    photo = upload_png()
    ticket = create_ticket(photo, "duplicate-test-ticket").json()
    nearby = client.post("/api/defects", headers={"Idempotency-Key": "another-ticket"}, json={
        "section_id": "r-01", "type": "Выбоина", "description": "Демо: рядом",
        "lat": 44.84915, "lng": 65.50225, "location_source": "manual", "observed_at": "2026-10-08T10:02:00Z", "photo_ids": [photo["id"]],
    })
    assert nearby.status_code == 200, nearby.text
    matches = client.get(f"/api/defects/{ticket['id']}/duplicates")
    assert matches.status_code == 200
    assert any(item["id"] == nearby.json()["id"] for item in matches.json())
    login("dispatcher@roads.local")
    linked = client.post(f"/api/defects/{nearby.json()['id']}/actions", json={"action": "link_duplicate", "version": nearby.json()["version"], "target_id": ticket["id"]})
    assert linked.status_code == 200, linked.text
    assert linked.json()["status"] == "cancelled"
    assert linked.json()["duplicate_of_id"] == ticket["id"]
    assert linked.json()["history"][-1]["action"] == "link_duplicate"
    bad = client.post("/api/files", files={"file": ("spoof.png", b"not an image", "image/png")})
    assert bad.status_code == 415
    login("inspector@roads.local")
    denied = client.get(f"/api/photos/{photo['id']}")
    assert denied.status_code == 200


def test_closed_defect_can_be_referenced_as_recurrence_and_idempotency_conflict():
    login("inspector@roads.local")
    with SessionLocal() as db:
        previous = db.get(DefectRow, "demo-defect-1")
        previous.status = "closed"
        db.commit()
    photo = upload_png()
    payload = {
        "section_id": "r-01", "type": "Выбоина", "description": "Демо: повторный дефект после ремонта",
        "lat": 44.84895, "lng": 65.50210, "location_source": "gps", "observed_at": "2026-10-08T11:00:00Z",
        "photo_ids": [photo["id"]], "previous_defect_id": "demo-defect-1",
    }
    created = client.post("/api/defects", headers={"Idempotency-Key": "recurrence-key"}, json=payload)
    assert created.status_code == 200, created.text
    assert created.json()["previous_defect_id"] == "demo-defect-1"
    prior = client.get("/api/defects/demo-defect-1")
    assert any(item["id"] == created.json()["id"] for item in prior.json()["linked_observations"])
    payload["description"] = "Демо: другая запись"
    conflict = client.post("/api/defects", headers={"Idempotency-Key": "recurrence-key"}, json=payload)
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"


def test_new_defect_cannot_reference_finished_inspection():
    login("inspector@roads.local")
    inspection = client.post("/api/inspections", json={"section_id": "r-01"}).json()
    finished = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True})
    assert finished.status_code == 200
    photo = upload_png()
    response = client.post("/api/defects", headers={"Idempotency-Key": "finished-inspection-link"}, json={
        "section_id": "r-01", "inspection_id": inspection["id"], "type": "Выбоина",
        "description": "Демо: дефект после завершённого осмотра", "lat": 44.85, "lng": 65.51,
        "location_source": "manual", "observed_at": "2026-10-08T12:00:00Z", "photo_ids": [photo["id"]],
    })
    assert response.status_code == 422
    assert response.json()["code"] == "INSPECTION_FINISHED"


def test_unknown_api_path_remains_json_not_spa_html():
    response = client.get("/api/not-a-real-endpoint")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["code"] == "NOT_FOUND"


def test_built_frontend_serves_assets_and_spa_fallback(monkeypatch, tmp_path):
    app_root = tmp_path / "application"
    dist = app_root / "frontend" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<main>Demo app</main>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("window.demo = true;", encoding="utf-8")
    monkeypatch.setattr(main, "ROOT", app_root / "backend")

    page = client.get("/inspector/survey")
    assert page.status_code == 200
    assert page.text == "<main>Demo app</main>"
    asset = client.get("/assets/app.js")
    assert asset.status_code == 200
    assert asset.text == "window.demo = true;"
    api_miss = client.get("/api/does-not-exist")
    assert api_miss.status_code == 404
    assert api_miss.headers["content-type"].startswith("application/json")


def test_missing_photo_file_returns_json_404():
    login("inspector@roads.local")
    photo = upload_png()
    with SessionLocal() as db:
        row = db.get(PhotoRow, photo["id"])
        path = Path(row.path)
    path.unlink()

    response = client.get(f"/api/photos/{photo['id']}")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["code"] == "NOT_FOUND"
