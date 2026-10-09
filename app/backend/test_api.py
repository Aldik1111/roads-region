import os
import sys
import tempfile
from io import BytesIO
from pathlib import Path
from datetime import datetime, timedelta, timezone

# Keep both test database and uploads away from the app's live local data.
os.environ["DATABASE_URL"] = "sqlite://"
TEST_PHOTO_DIR = tempfile.TemporaryDirectory(prefix="roads-backend-test-photos-")
os.environ["PHOTO_DIR"] = TEST_PHOTO_DIR.name
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient
from PIL import Image
import app.main as main
from app.main import DefectRow, PhotoRow, SessionLocal, app

client = TestClient(app)
PASSWORD = "RoadsDemo2026!"


def test_https_login_uses_secure_cookie_and_http_localhost_still_works():
    for base_url, expected_secure in [("https://192.168.1.108:8443", True), ("http://testserver", False)]:
        with TestClient(app, base_url=base_url) as browser:
            result = browser.post("/api/login", json={"email": "inspector@roads.local", "password": PASSWORD})
            assert result.status_code == 200
            cookie = result.headers["set-cookie"].lower()
            assert ("; secure" in cookie) == expected_secure
            assert "httponly" in cookie and "samesite=lax" in cookie
            assert browser.get("/api/me").status_code == 200
            assert browser.post("/api/logout").status_code == 200
            assert browser.get("/api/me").status_code == 401


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


def make_review_evidence(photo_ids, *, checklist=None, lat=44.9, lng=65.6, accuracy_m=7.5, recorded_at=None):
    return {
        "photo_ids": photo_ids,
        "checklist": checklist or {"surface_restored": True, "no_visible_damage": True, "area_safe": True},
        "lat": lat, "lng": lng, "accuracy_m": accuracy_m,
        "recorded_at": recorded_at or main.iso(main.utcnow()),
    }


def create_review_ticket(key):
    login("inspector@roads.local")
    source_photo = upload_png()
    ticket = create_ticket(source_photo, key).json()
    login("contractor2@roads.local")
    report_photo = upload_png()
    with SessionLocal() as db:
        row = db.get(DefectRow, ticket["id"])
        row.status = "review"
        row.contractor_id = "c-2"
        row.repairs = [{
            "id": f"report-{key}", "created_at": main.iso(main.utcnow()),
            "comment": "Демо: ремонт передан на проверку.", "photos": [report_photo["id"]],
            "decision": None, "decision_comment": None,
        }]
        db.commit()
    login("inspector@roads.local")
    return client.get(f"/api/defects/{ticket['id']}").json()


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
    evidence_photo = upload_png()
    closed = act(ticket, "approve", {"comment": "Демо: принято", "review_evidence": make_review_evidence([evidence_photo["id"]])})
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


def make_image_bytes(fmt):
    buffer = BytesIO()
    Image.new("RGB", (3, 2), color=(32, 96, 64)).save(buffer, format=fmt)
    return buffer.getvalue()


def test_upload_accepts_jpeg_png_webp_and_returns_original_bytes():
    login("inspector@roads.local")
    for extension, media_type, image_format in (
        ("jpg", "image/jpeg", "JPEG"),
        ("png", "image/png", "PNG"),
        ("webp", "image/webp", "WEBP"),
    ):
        original = make_image_bytes(image_format)
        response = client.post("/api/files", files={"file": (f"test.{extension}", original, media_type)})
        assert response.status_code == 200, response.text
        photo = response.json()
        downloaded = client.get(photo["url"])
        assert downloaded.status_code == 200
        assert downloaded.content == original
        assert downloaded.headers["content-type"] == media_type


def test_upload_validation_distinguishes_empty_corrupt_and_heic():
    login("inspector@roads.local")
    cases = (
        (("empty.jpg", b"", "image/jpeg"), 422, "EMPTY_FILE"),
        (("corrupt.jpg", b"not a JPEG image", "image/jpeg"), 415, "INVALID_IMAGE"),
        (("phone.heic", b"00000018ftypheic00000000", "image/heic"), 415, "UNSUPPORTED_IMAGE_FORMAT"),
    )
    for upload, expected_status, expected_code in cases:
        response = client.post("/api/files", files={"file": upload})
        assert response.status_code == expected_status, response.text
        assert response.json()["code"] == expected_code
        assert response.json()["message"]


def test_upload_uses_sniffed_format_when_browser_mime_is_missing_generic_or_wrong():
    login("inspector@roads.local")
    cases = (
        ("missing.jpg", make_image_bytes("JPEG"), "" , "image/jpeg"),
        ("generic.png", make_image_bytes("PNG"), "application/x-binary", "image/png"),
        ("wrong-label.webp", make_image_bytes("WEBP"), "image/png", "image/webp"),
    )
    for filename, original, reported_type, detected_type in cases:
        response = client.post("/api/files", files={"file": (filename, original, reported_type)})
        assert response.status_code == 200, response.text
        photo = response.json()
        downloaded = client.get(photo["url"])
        assert downloaded.status_code == 200
        assert downloaded.content == original
        assert downloaded.headers["content-type"] == detected_type


def test_upload_rejects_over_10_mib_before_image_decode():
    login("inspector@roads.local")
    content = b"\x00" * (10 * 1024 * 1024 + 1)
    response = client.post("/api/files", files={"file": ("oversized.png", content, "image/png")})
    assert response.status_code == 413
    assert response.json()["code"] == "FILE_TOO_LARGE"


def test_upload_idempotency_reuses_photo_and_conflicts_on_different_bytes_per_user():
    login("inspector@roads.local")
    key = "photo-retry-stable-key"
    original = make_image_bytes("PNG")
    first = client.post("/api/files", headers={"Idempotency-Key": key}, files={"file": ("original.png", original, "image/png")})
    retry = client.post("/api/files", headers={"Idempotency-Key": key}, files={"file": ("retry.png", original, "image/png")})
    assert first.status_code == retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]
    assert client.get(retry.json()["url"]).content == original

    changed = client.post("/api/files", headers={"Idempotency-Key": key}, files={"file": ("different.jpg", make_image_bytes("JPEG"), "image/jpeg")})
    assert changed.status_code == 409
    assert changed.json()["code"] == "IDEMPOTENCY_CONFLICT"

    login("contractor@roads.local")
    another_user = client.post("/api/files", headers={"Idempotency-Key": key}, files={"file": ("original.png", original, "image/png")})
    assert another_user.status_code == 200
    assert another_user.json()["id"] != first.json()["id"]


def test_field_owner_header_must_match_session_owner_before_upload_or_defect_mutations():
    login("inspector@roads.local")
    headers = {"X-Field-Owner": "u-dispatcher"}
    rejected_upload = client.post("/api/files", headers=headers, files={
        "file": ("owner-check.png", make_image_bytes("PNG"), "image/png"),
    })
    assert rejected_upload.status_code == 403
    assert rejected_upload.json()["code"] == "FIELD_OWNER_MISMATCH"

    photo = upload_png()
    response = client.post("/api/defects", headers={**headers, "Idempotency-Key": "field-owner-mismatch"}, json={
        "section_id": "r-01", "type": "Выбоина", "description": "Демо: owner guard",
        "lat": 44.85, "lng": 65.51, "location_source": "gps", "observed_at": "2026-10-10T10:00:00Z",
        "photo_ids": [photo["id"]],
    })
    assert response.status_code == 403
    assert response.json()["code"] == "FIELD_OWNER_MISMATCH"


def test_inspection_finish_accepts_original_offline_timestamp_and_rejects_unreasonable_times():
    login("inspector@roads.local")
    inspection = client.post("/api/inspections", json={"section_id": "r-01"}).json()
    started_at = datetime.fromisoformat(inspection["started_at"].replace("Z", "+00:00"))
    before_start = main.iso(started_at - timedelta(seconds=1))
    too_early = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True, "finished_at": before_start})
    assert too_early.status_code == 422
    assert too_early.json()["code"] == "INVALID_FINISH_TIME"
    too_late = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True, "finished_at": main.iso(main.utcnow() + timedelta(seconds=31))})
    assert too_late.status_code == 422
    assert too_late.json()["code"] == "INVALID_FINISH_TIME"

    offline_finish_at = main.iso(started_at + timedelta(seconds=2))
    finished = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True, "finished_at": offline_finish_at})
    assert finished.status_code == 200, finished.text
    assert finished.json()["finished_at"] == offline_finish_at
    repeated = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True, "finished_at": offline_finish_at})
    assert repeated.status_code == 200
    assert repeated.json() == finished.json()


def test_defect_retry_replays_after_its_inspection_has_finished():
    login("inspector@roads.local")
    inspection = client.post("/api/inspections", json={"section_id": "r-01"}).json()
    photo = upload_png()
    payload = {
        "section_id": "r-01", "inspection_id": inspection["id"], "type": "Выбоина",
        "description": "Демо: создание перед потерянным ответом", "lat": 44.85, "lng": 65.51,
        "location_source": "gps", "accuracy_m": 5, "observed_at": "2026-10-10T09:00:00Z", "photo_ids": [photo["id"]],
    }
    key = "lost-response-before-offline-finish"
    first = client.post("/api/defects", headers={"Idempotency-Key": key}, json=payload)
    assert first.status_code == 200, first.text
    finished = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True})
    assert finished.status_code == 200

    retry = client.post("/api/defects", headers={"Idempotency-Key": key}, json=payload)
    assert retry.status_code == 200, retry.text
    assert retry.json()["id"] == first.json()["id"]
    new_key = client.post("/api/defects", headers={"Idempotency-Key": "new-key-after-finish"}, json=payload)
    assert new_key.status_code == 422
    assert new_key.json()["code"] == "INSPECTION_FINISHED"


def test_review_approval_requires_fresh_complete_evidence_and_inspector_owned_photo():
    ticket = create_review_ticket("review-evidence-validation")
    evidence_photo = upload_png()
    contractor_photo_id = ticket["repairs"][0]["photos"][0]["id"]

    missing = act(ticket, "approve")
    assert missing.status_code == 422
    assert missing.json()["code"] == "REVIEW_EVIDENCE_REQUIRED"

    invalid_cases = [
        (make_review_evidence([evidence_photo["id"]], checklist={"surface_restored": True, "no_visible_damage": False, "area_safe": True}), "REVIEW_CHECKLIST_INCOMPLETE"),
        (make_review_evidence([],), "INVALID_REVIEW_EVIDENCE"),
        (make_review_evidence([evidence_photo["id"]], lat=91), "INVALID_REVIEW_EVIDENCE"),
        (make_review_evidence([evidence_photo["id"]], accuracy_m=-1), "INVALID_REVIEW_EVIDENCE"),
        (make_review_evidence([evidence_photo["id"]], recorded_at=main.iso(main.utcnow() - timedelta(minutes=5, seconds=1))), "REVIEW_EVIDENCE_STALE"),
        (make_review_evidence([evidence_photo["id"]], recorded_at=main.iso(main.utcnow() + timedelta(seconds=31))), "REVIEW_EVIDENCE_STALE"),
    ]
    for evidence, expected_code in invalid_cases:
        response = act(ticket, "approve", {"review_evidence": evidence})
        assert response.status_code == 422, response.text
        assert response.json()["code"] == expected_code

    foreign_photo = act(ticket, "approve", {"review_evidence": make_review_evidence([contractor_photo_id])})
    assert foreign_photo.status_code == 403
    assert foreign_photo.json()["code"] == "PHOTO_FORBIDDEN"

    with SessionLocal() as db:
        if not db.get(main.UserRow, "u-inspector-review-other"):
            db.add(main.UserRow(id="u-inspector-review-other", name="Демо инспектор другой", email="review-other@roads.local", role="inspector", contractor_id=None, password_hash=main.hash_password(PASSWORD)))
            db.commit()
    login("review-other@roads.local")
    other_photo = upload_png()
    approved_by_other_inspector = act(ticket, "approve", {
        "comment": "Демо: проверено вторым инспектором",
        "review_evidence": make_review_evidence([other_photo["id"]]),
    })
    assert approved_by_other_inspector.status_code == 200, approved_by_other_inspector.text
    assert approved_by_other_inspector.json()["status"] == "closed"
    assert approved_by_other_inspector.json()["repairs"][-1]["review_evidence"]["inspector_id"] == "u-inspector-review-other"
    assert approved_by_other_inspector.json()["repairs"][-1]["review_evidence"]["photos"][0]["id"] == other_photo["id"]


def test_approval_stores_evidence_and_visible_roles_can_download_evidence_photo():
    ticket = create_review_ticket("review-evidence-success")
    evidence_photo = upload_png()
    evidence = make_review_evidence([evidence_photo["id"]], lat=45.0, lng=66.0)
    approved = act(ticket, "approve", {"comment": "Проверено на месте", "review_evidence": evidence})
    assert approved.status_code == 200, approved.text
    detail = approved.json()
    assert detail["status"] == "closed"
    stored = detail["repairs"][-1]["review_evidence"]
    assert stored["inspector_id"] == "u-inspector"
    assert stored["lat"] == 45.0 and stored["lng"] == 66.0
    assert stored["distance_m"] > 1000
    assert stored["checked_at"]
    assert stored["recorded_at"] == evidence["recorded_at"]
    assert stored["checklist"] == evidence["checklist"]
    assert stored["photos"][0]["id"] == evidence_photo["id"]

    login("contractor2@roads.local")
    download = client.get(stored["photos"][0]["url"])
    assert download.status_code == 200
    assert download.content == client.get(evidence_photo["url"]).content


def test_seeded_demo_review_has_matching_synthetic_repair_report():
    login("inspector@roads.local")
    response = client.get("/api/defects/demo-defect-4")
    assert response.status_code == 200
    defect = response.json()
    assert defect["status"] == "review"
    assert len(defect["repairs"]) == 1
    repair = defect["repairs"][0]
    assert repair["comment"].startswith("Демо:")
    assert len(repair["photos"]) == 1
    assert repair["photos"][0]["name"].startswith("ДЕМО")
    assert client.get(repair["photos"][0]["url"]).status_code == 200


def test_review_without_repair_report_returns_clear_conflict_instead_of_500():
    with SessionLocal() as db:
        defect = db.get(DefectRow, "demo-defect-4")
        old_repairs = defect.repairs
        defect.status = "review"
        defect.repairs = []
        db.commit()
        version = defect.version

    safe_client = TestClient(app, raise_server_exceptions=False)
    try:
        safe_client.post("/api/login", json={"email": "inspector@roads.local", "password": PASSWORD})
        for action, payload in (("approve", {}), ("reject", {"comment": "Демо: нужен отчёт"})):
            response = safe_client.post(f"/api/defects/demo-defect-4/actions", json={
                "action": action, "version": version, **payload,
            })
            assert response.status_code == 409, response.text
            assert response.json()["code"] == "MISSING_REPAIR_REPORT"
            assert "отчёт" in response.json()["message"].lower()
        with SessionLocal() as db:
            unchanged = db.get(DefectRow, "demo-defect-4")
            assert unchanged.status == "review"
            assert unchanged.version == version
    finally:
        with SessionLocal() as db:
            defect = db.get(DefectRow, "demo-defect-4")
            defect.repairs = old_repairs
            defect.status = "review"
            db.commit()


def osrm_response(*, multiple=False):
    routes = [{
        "geometry": {"type": "LineString", "coordinates": [[65.5001, 44.8001], [65.5100, 44.8100], [65.5200, 44.8200], [65.5501, 44.8501]]},
        "distance": 6400, "duration": 480,
        "legs": [{"steps": [{"name": "Абая"}, {"name": "Сырдарья"}]}],
    }]
    if multiple:
        routes.append({
            "geometry": {"type": "LineString", "coordinates": [[65.5001, 44.8001], [65.5100, 44.8100], [65.5350, 44.8350], [65.5501, 44.8501]]},
            "distance": 7100, "duration": 530,
            "legs": [{"steps": [{"name": "Жибек жолы"}]}],
        })
        routes.append({
            "geometry": {"type": "LineString", "coordinates": [[65.5001, 44.8001], [65.5100, 44.8100], [65.5200, 44.8200], [65.5501, 44.8501]]},
            "distance": 6450, "duration": 490,
            "legs": [{"steps": [{"name": "Дублирующий ответ"}]}],
        })
    return {
        "code": "Ok", "routes": routes,
        "waypoints": [{"location": [65.5001, 44.8001]}, {"location": [65.5501, 44.8501]}],
    }


def preview_route(monkeypatch, *, multiple=False):
    monkeypatch.setattr(main, "fetch_osrm_routes", lambda start, end: osrm_response(multiple=multiple), raising=False)
    return client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })


def publish_route(preview, option_id, inspector_id="u-inspector", name="Проверка R-02", notes="Северная объездная"):
    return client.post("/api/routes", json={
        "name": name, "notes": notes, "inspector_id": inspector_id,
        "preview_id": preview["id"], "option_id": option_id,
    })


def test_route_preview_persists_osrm_alternatives_and_requires_explicit_choice(monkeypatch):
    login("dispatcher@roads.local")
    preview = preview_route(monkeypatch, multiple=True)
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["provider"] == "OSRM"
    assert data["start"] == {"lat": 44.8001, "lng": 65.5001}
    assert data["end"] == {"lat": 44.8501, "lng": 65.5501}
    assert len(data["options"]) == 2
    assert data["options"][0]["distance_m"] == 6400
    assert data["decision_points"]
    assert abs(data["decision_points"][0]["lat"] - 44.81) < 1e-6
    assert abs(data["decision_points"][0]["lng"] - 65.51) < 1e-6

    missing = publish_route(data, None)
    assert missing.status_code == 422
    assert missing.json()["code"] == "OPTION_REQUIRED"
    selected = data["options"][1]
    created = publish_route(data, selected["id"])
    assert created.status_code == 200, created.text
    route = created.json()
    assert route["geometry"] == selected["geometry"]
    assert route["source"] == "osrm"
    assert route["duration_min"] == 9
    repeated = publish_route(data, selected["id"])
    assert repeated.status_code == 200
    assert repeated.json()["id"] == route["id"]
    changed = publish_route(data, data["options"][0]["id"], name="Другой маршрут")
    assert changed.status_code == 409
    assert changed.json()["code"] == "PREVIEW_ALREADY_USED"


def test_route_preview_rejects_invalid_points_and_provider_failures(monkeypatch):
    login("dispatcher@roads.local")
    identical = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.8, "lng": 65.5},
    })
    assert identical.status_code == 422
    outside = client.post("/api/routes/preview", json={
        "start": {"lat": 91, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert outside.status_code == 422

    monkeypatch.setattr(main, "fetch_osrm_routes", lambda start, end: {"code": "Ok", "routes": [], "waypoints": []}, raising=False)
    no_route = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert no_route.status_code == 422
    assert no_route.json()["code"] == "NO_ROUTE"

    def timeout(start, end):
        raise TimeoutError("OSRM request timed out")
    monkeypatch.setattr(main, "fetch_osrm_routes", timeout, raising=False)
    unavailable = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert unavailable.status_code == 503

    monkeypatch.setattr(main, "fetch_osrm_routes", lambda start, end: (_ for _ in ()).throw(ValueError("malformed JSON")), raising=False)
    malformed = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert malformed.status_code == 503
    assert malformed.json()["code"] == "INVALID_ROUTING_RESPONSE"


def test_osrm_http_400_no_route_is_reported_as_no_route(monkeypatch):
    class ProviderError:
        is_error = True

        def json(self):
            return {"code": "NoRoute", "message": "No route found"}

        def raise_for_status(self):
            raise AssertionError("NoRoute should be parsed before HTTP status")

    monkeypatch.setattr(main.httpx, "get", lambda *args, **kwargs: ProviderError())
    login("dispatcher@roads.local")
    response = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert response.status_code == 422
    assert response.json()["code"] == "NO_ROUTE"


def test_routes_are_role_scoped_and_inspection_is_single_active_per_inspector(monkeypatch):
    login("inspector@roads.local")
    forbidden_preview = client.post("/api/routes/preview", json={
        "start": {"lat": 44.8, "lng": 65.5}, "end": {"lat": 44.85, "lng": 65.55},
    })
    assert forbidden_preview.status_code == 403
    assert client.get("/api/bootstrap").json()["inspectors"] == []

    with SessionLocal() as db:
        if not db.get(main.UserRow, "u-inspector-2"):
            db.add(main.UserRow(id="u-inspector-2", name="Демо инспектор 2", email="inspector2@roads.local", role="inspector", contractor_id=None, password_hash=main.hash_password("RoadsDemo2026!")))
            db.commit()

    login("dispatcher@roads.local")
    assert len(client.get("/api/bootstrap").json()["inspectors"]) >= 2
    p1 = preview_route(monkeypatch).json()
    p2 = preview_route(monkeypatch).json()
    p3 = preview_route(monkeypatch).json()
    route1 = publish_route(p1, p1["options"][0]["id"], inspector_id="u-inspector").json()
    route2 = publish_route(p2, p2["options"][0]["id"], inspector_id="u-inspector-2", name="Демо второй маршрут").json()
    route3 = publish_route(p3, p3["options"][0]["id"], inspector_id="u-inspector", name="Демо третий маршрут").json()
    dispatcher_routes = client.get("/api/routes").json()
    assert route1["id"] in [route["id"] for route in dispatcher_routes]
    assert route2["id"] in [route["id"] for route in dispatcher_routes]

    login("inspector@roads.local")
    own_routes = client.get("/api/routes").json()
    assert route1["id"] in [route["id"] for route in own_routes]
    assert route3["id"] in [route["id"] for route in own_routes]
    assert route2["id"] not in [route["id"] for route in own_routes]
    active_before = client.get("/api/inspections").json()
    for item in active_before:
        if item["status"] == "active":
            client.post(f"/api/inspections/{item['id']}/finish", json={"confirmed": True})
    first = client.post("/api/inspections", json={"section_id": route1["id"]})
    assert first.status_code == 200, first.text
    assert client.post("/api/inspections", json={"section_id": route1["id"]}).json()["id"] == first.json()["id"]
    other_active = client.post("/api/inspections", json={"section_id": route3["id"]})
    assert other_active.status_code == 409
    assert other_active.json()["code"] == "ACTIVE_INSPECTION"
    assert client.get(f"/api/routes/{route2['id']}/results").status_code == 404


def test_assigned_route_results_preserve_geometry_inspections_and_defects(monkeypatch):
    login("dispatcher@roads.local")
    preview = preview_route(monkeypatch).json()
    route = publish_route(preview, preview["options"][0]["id"]).json()
    login("inspector@roads.local")
    for existing in client.get("/api/inspections").json():
        if existing["status"] == "active":
            client.post(f"/api/inspections/{existing['id']}/finish", json={"confirmed": True})
    inspection = client.post("/api/inspections", json={"section_id": route["id"]}).json()
    assert "id" in inspection, inspection
    point = {"client_id": "route-result-point", "lat": 44.82, "lng": 65.52, "recorded_at": "2026-10-09T08:00:00Z", "accuracy_m": 5}
    points = client.post(f"/api/inspections/{inspection['id']}/points", json={"points": [point]})
    assert points.status_code == 200
    photo = upload_png()
    defect = client.post("/api/defects", headers={"Idempotency-Key": "assigned-route-defect"}, json={
        "section_id": route["id"], "inspection_id": inspection["id"], "type": "Трещина",
        "description": "Демо: трещина на назначенном маршруте", "lat": 44.82, "lng": 65.52,
        "location_source": "gps", "observed_at": "2026-10-09T08:01:00Z", "photo_ids": [photo["id"]],
    })
    assert defect.status_code == 200, defect.text
    finished = client.post(f"/api/inspections/{inspection['id']}/finish", json={"confirmed": True})
    assert finished.status_code == 200

    login("dispatcher@roads.local")
    result = client.get(f"/api/routes/{route['id']}/results")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["route"]["geometry"] == route["geometry"]
    assert data["inspections"][0]["points"] == [point]
    assert any(item["id"] == defect.json()["id"] for item in data["defects"])
