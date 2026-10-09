import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import backup
import manage_users


def make_photo_db(root: Path, photo_bytes: bytes = b"original photo") -> tuple[Path, Path]:
    db_path = root / "roads.sqlite"
    photo_root = root / "uploads"
    photo_root.mkdir()
    photo_path = photo_root / "photo.jpg"
    photo_path.write_bytes(photo_bytes)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE photos (id TEXT PRIMARY KEY, path TEXT NOT NULL)")
        db.execute("INSERT INTO photos (id, path) VALUES (?, ?)", ("p-1", str(photo_path)))
    return db_path, photo_root


def test_backup_restore_round_trip_and_verification(tmp_path):
    db_path, photo_root = make_photo_db(tmp_path)
    destination = tmp_path / "backup-1"
    created = backup.create_backup(db_path, photo_root, destination)
    assert created["complete"] is True
    assert backup.verify_backup(destination)["valid"] is True

    restored = tmp_path / "restore-1"
    backup.restore_backup(destination, restored)
    with sqlite3.connect(restored / "roads.sqlite") as db:
        integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
        stored_path = db.execute("SELECT path FROM photos WHERE id='p-1'").fetchone()[0]
    assert integrity == "ok"
    assert Path(stored_path).read_bytes() == b"original photo"


def test_backup_accepts_explicit_extra_roots_and_rejects_unlisted_roots(tmp_path):
    db_path, photo_root = make_photo_db(tmp_path)
    extra_root = tmp_path / "demo_photos"
    extra_root.mkdir()
    extra_photo = extra_root / "fixture.png"
    extra_photo.write_bytes(b"demo fixture")
    outside_root = tmp_path / "unlisted"
    outside_root.mkdir()
    outside_photo = outside_root / "secret.png"
    outside_photo.write_bytes(b"not allowed")
    with sqlite3.connect(db_path) as db:
        db.executemany("INSERT INTO photos (id, path) VALUES (?, ?)", [
            ("demo-1", str(extra_photo)), ("outside-1", str(outside_photo)),
        ])

    with pytest.raises(ValueError, match="outside allowed photo roots"):
        backup.create_backup(db_path, photo_root, tmp_path / "rejected")
    assert (tmp_path / "rejected" / "INCOMPLETE").exists()
    assert not (tmp_path / "rejected" / "manifest.json").exists()

    with sqlite3.connect(db_path) as db:
        db.execute("DELETE FROM photos WHERE id='outside-1'")
    manifest = backup.create_backup(db_path, photo_root, tmp_path / "allowed", additional_photo_roots=[extra_root])
    assert {entry["id"] for entry in manifest["photos"]} == {"p-1", "demo-1"}
    assert backup.verify_backup(tmp_path / "allowed")["photo_count"] == 2


def test_backup_rejects_existing_destination_and_marks_failed_copy_incomplete(tmp_path, monkeypatch):
    db_path, photo_root = make_photo_db(tmp_path)
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(FileExistsError):
        backup.create_backup(db_path, photo_root, existing)

    (photo_root / "photo.jpg").unlink()
    failed = tmp_path / "failed-backup"
    with pytest.raises(FileNotFoundError):
        backup.create_backup(db_path, photo_root, failed)
    assert (failed / "INCOMPLETE").exists()
    assert not (failed / "manifest.json").exists()


def test_backup_detects_tampered_archive_missing_photo_and_manifest_traversal(tmp_path):
    db_path, photo_root = make_photo_db(tmp_path)
    destination = tmp_path / "backup"
    backup.create_backup(db_path, photo_root, destination)
    manifest_path = destination / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    photo_entry = manifest["photos"][0]
    stored_photo = destination / photo_entry["archive_path"]
    stored_photo.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="hash"):
        backup.verify_backup(destination)

    stored_photo.write_bytes(b"original photo")
    stored_photo.unlink()
    with pytest.raises(FileNotFoundError):
        backup.verify_backup(destination)

    manifest["photos"][0]["archive_path"] = "../outside.jpg"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="path"):
        backup.verify_backup(destination)


def test_restore_refuses_existing_nonempty_target_and_symlink_target(tmp_path):
    db_path, photo_root = make_photo_db(tmp_path)
    destination = tmp_path / "backup"
    backup.create_backup(db_path, photo_root, destination)
    occupied = tmp_path / "occupied"
    occupied.mkdir()
    (occupied / "keep.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(FileExistsError):
        backup.restore_backup(destination, occupied)
    link = tmp_path / "linked-target"
    try:
        link.symlink_to(occupied, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks are unavailable on this host")
    with pytest.raises(ValueError, match="symlink"):
        backup.restore_backup(destination, link)


def test_account_cli_uses_real_user_model_rejects_duplicate_and_resets_sessions(tmp_path):
    backend = Path(__file__).resolve().parents[1] / "backend"
    script = r'''import os, sys
sys.path.insert(0, sys.argv[1])
sys.path.insert(0, sys.argv[2])
import app.main as main
import manage_users as users
with main.SessionLocal() as db:
    user = users.create_account(db, main, email="dispatcher@example.test", name="Dispatch", role="dispatcher", password="SafePassphrase2026!")
    token = "session-to-reset"
    db.add(main.SessionRow(token=token, user_id=user.id, expires_at=main.utcnow()))
    db.commit()
    try:
        users.create_account(db, main, email="DISPATCHER@example.test", name="Duplicate", role="dispatcher", password="SafePassphrase2026!")
    except ValueError as exc:
        assert "already exists" in str(exc)
    else:
        raise AssertionError("duplicate account was accepted")
    try:
        users.create_account(db, main, email="weak@example.test", name="Weak", role="inspector", password="short")
    except ValueError:
        pass
    else:
        raise AssertionError("weak password was accepted")
    users.reset_account_password(db, main, "dispatcher@example.test", "AnotherSafePass2026!")
    assert db.get(main.SessionRow, token) is None
    assert main.check_password("AnotherSafePass2026!", db.get(main.UserRow, user.id).password_hash)
    assert db.scalar(main.select(main.UserRow).where(main.UserRow.email == "dispatcher@example.test")) is not None
entered = iter(["CliStrongPassphrase2026!", "CliStrongPassphrase2026!"])
users.getpass.getpass = lambda prompt: next(entered)
assert users.main(["create", "--email", "cli@example.test", "--name", "CLI User", "--role", "inspector"]) == 0
'''
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": f"sqlite:///{(tmp_path / 'users.sqlite').as_posix()}",
        "PHOTO_DIR": str(tmp_path / "photos"),
        "ROADS_DEMO_MODE": "false",
    })
    result = subprocess.run([sys.executable, "-c", script, str(backend), str(TOOLS)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "CliStrongPassphrase2026!" not in result.stdout + result.stderr


def test_account_validation_checks_role_email_contractor_and_password():
    assert manage_users.validate_account(email=" person@example.test ", name=" A Person ", role="inspector", password="StrongPassword2026!", contractor_id=None) == {
        "email": "person@example.test", "name": "A Person", "role": "inspector", "contractor_id": None,
    }
    for values in [
        {"email": "missing-at", "name": "A", "role": "dispatcher", "password": "StrongPassword2026!", "contractor_id": None},
        {"email": "a@example.test", "name": "A", "role": "unknown", "password": "StrongPassword2026!", "contractor_id": None},
        {"email": "a@example.test", "name": "A", "role": "contractor", "password": "StrongPassword2026!", "contractor_id": None},
        {"email": "a@example.test", "name": "A", "role": "dispatcher", "password": "short", "contractor_id": None},
    ]:
        with pytest.raises(ValueError):
            manage_users.validate_account(**values)


def test_account_cli_uses_database_url_environment_and_fails_if_missing(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(manage_users.getpass, "getpass", lambda prompt: pytest.fail("must validate config before prompting"))
    result = manage_users.main(["create", "--email", "a@example.test", "--name", "A Person", "--role", "inspector"])
    assert result == 2
    assert "DATABASE_URL" in capsys.readouterr().err
