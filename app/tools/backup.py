"""Create and verify complete SQLite plus photo backups for Roads Region."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import uuid


MANIFEST_NAME = "manifest.json"
DATABASE_NAME = "roads.sqlite"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _reject_symlink_components(path: Path) -> None:
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink path is not allowed: {current}")


def _safe_archive_file(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or "\\" in relative:
        raise ValueError("unsafe archive path")
    parsed = PurePosixPath(relative)
    if parsed.is_absolute() or not parsed.parts or any(part in ("", ".", "..") for part in parsed.parts):
        raise ValueError("unsafe archive path")
    root_real = root.resolve(strict=True)
    candidate = root.joinpath(*parsed.parts)
    _reject_symlink_components(candidate)
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root_real)
    except ValueError as exc:
        raise ValueError("archive path escapes backup directory") from exc
    return candidate


def _photo_rows(database_path: Path) -> list[tuple[str, str]]:
    with sqlite3.connect(database_path) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "photos" not in tables:
            raise ValueError("database has no photos table")
        columns = {row[1] for row in db.execute("PRAGMA table_info(photos)")}
        if not {"id", "path"}.issubset(columns):
            raise ValueError("photos table must contain id and path columns")
        return [(str(photo_id), str(path)) for photo_id, path in db.execute("SELECT id, path FROM photos ORDER BY id")]


def _safe_filename(value: str, default: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(value).name).strip("._-")
    return cleaned[:100] or default


def create_backup(
    database_path: str | Path,
    photo_root: str | Path,
    destination: str | Path,
    *,
    additional_photo_roots: list[str | Path] | tuple[str | Path, ...] = (),
) -> dict:
    """Create a new backup directory. Existing destinations are never modified."""
    source_db = Path(database_path)
    source_photos = Path(photo_root)
    target = Path(destination)
    if not source_db.is_file() or source_db.is_symlink():
        raise FileNotFoundError(f"SQLite database not found: {source_db}")
    if not source_photos.is_dir() or source_photos.is_symlink():
        raise FileNotFoundError(f"photo directory not found: {source_photos}")
    _reject_symlink_components(source_db)
    _reject_symlink_components(source_photos)
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"backup destination already exists: {target}")
    _reject_symlink_components(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    (target / "INCOMPLETE").write_text("Backup is incomplete until manifest.json is written.\n", encoding="utf-8")
    try:
        snapshot = target / DATABASE_NAME
        with sqlite3.connect(f"file:{source_db.resolve().as_posix()}?mode=ro", uri=True) as source, sqlite3.connect(snapshot) as output:
            source.backup(output)
            result = output.execute("PRAGMA integrity_check").fetchone()
            if not result or result[0] != "ok":
                raise ValueError("SQLite backup failed integrity check")

        photo_entries = []
        photo_archive = target / "photos"
        photo_archive.mkdir()
        allowed_roots = [source_photos, *(Path(root) for root in additional_photo_roots)]
        root_reals = []
        for allowed_root in allowed_roots:
            if not allowed_root.is_dir() or allowed_root.is_symlink():
                raise FileNotFoundError(f"photo directory not found: {allowed_root}")
            _reject_symlink_components(allowed_root)
            resolved_root = allowed_root.resolve(strict=True)
            if resolved_root not in root_reals:
                root_reals.append(resolved_root)
        seen_ids = set()
        seen_archive_paths = set()
        for photo_id, stored_path in _photo_rows(snapshot):
            if not photo_id or photo_id in seen_ids:
                raise ValueError("photos table contains an empty or duplicate photo id")
            seen_ids.add(photo_id)
            original = Path(stored_path)
            if not original.is_absolute():
                original = source_photos / original
            _reject_symlink_components(original)
            original_real = original.resolve(strict=True)
            if not any(_is_relative_to(original_real, allowed) for allowed in root_reals):
                raise ValueError(f"photo path is outside allowed photo roots: {photo_id}")
            if not original_real.is_file():
                raise FileNotFoundError(f"referenced photo is not a file: {photo_id}")
            archive_name = f"{_safe_filename(photo_id, 'photo')}_{_safe_filename(original.name, 'image')}"
            archive_relative = f"photos/{archive_name}"
            if archive_relative in seen_archive_paths:
                raise ValueError("photo ids collide after filename sanitization")
            seen_archive_paths.add(archive_relative)
            archived = _safe_archive_file(target, archive_relative)
            shutil.copyfile(original_real, archived)
            photo_entries.append({
                "id": photo_id,
                "archive_path": archive_relative,
                "size_bytes": archived.stat().st_size,
                "sha256": _sha256(archived),
            })

        manifest = {
            "format_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "database": {"archive_path": DATABASE_NAME, "size_bytes": snapshot.stat().st_size, "sha256": _sha256(snapshot)},
            "photos": photo_entries,
            "complete": True,
        }
        (target / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        try:
            verify_backup(target, allow_incomplete_marker=True)
        except Exception:
            (target / MANIFEST_NAME).unlink(missing_ok=True)
            raise
        (target / "INCOMPLETE").unlink()
        verify_backup(target)
        return manifest
    except Exception:
        # Keep the evidence directory and marker for diagnosis; never claim a partial backup is complete.
        (target / MANIFEST_NAME).unlink(missing_ok=True)
        if not (target / "INCOMPLETE").exists():
            (target / "INCOMPLETE").write_text("Backup is incomplete.\n", encoding="utf-8")
        raise


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def verify_backup(directory: str | Path, *, allow_incomplete_marker: bool = False) -> dict:
    root = Path(directory)
    if not root.is_dir() or root.is_symlink():
        raise FileNotFoundError(f"backup directory not found: {root}")
    _reject_symlink_components(root)
    if (root / "INCOMPLETE").exists() and not allow_incomplete_marker:
        raise ValueError("backup is marked incomplete")
    manifest_path = root / MANIFEST_NAME
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise FileNotFoundError("backup manifest is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format_version") != 1 or manifest.get("complete") is not True:
        raise ValueError("unsupported or incomplete backup manifest")
    db_entry = manifest.get("database")
    if not isinstance(db_entry, dict):
        raise ValueError("database manifest entry is missing")
    db_file = _safe_archive_file(root, db_entry.get("archive_path"))
    if not db_file.is_file():
        raise FileNotFoundError("backup database is missing")
    if db_file.stat().st_size != db_entry.get("size_bytes") or _sha256(db_file) != db_entry.get("sha256"):
        raise ValueError("database hash or size mismatch")
    with sqlite3.connect(db_file) as db:
        integrity = db.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError("backup database integrity check failed")
    rows = _photo_rows(db_file)
    row_ids = [photo_id for photo_id, _ in rows]
    entries = manifest.get("photos")
    if not isinstance(entries, list):
        raise ValueError("photo manifest must be a list")
    entry_ids = [entry.get("id") for entry in entries if isinstance(entry, dict)]
    if len(entry_ids) != len(entries) or len(set(entry_ids)) != len(entry_ids) or set(entry_ids) != set(row_ids):
        raise ValueError("photo manifest does not match database photo references")
    for entry in entries:
        archived = _safe_archive_file(root, entry.get("archive_path"))
        if not archived.is_file():
            raise FileNotFoundError(f"backup photo is missing: {entry.get('id')}")
        if archived.stat().st_size != entry.get("size_bytes") or _sha256(archived) != entry.get("sha256"):
            raise ValueError(f"photo hash or size mismatch: {entry.get('id')}")
    return {"valid": True, "database": str(db_file), "photo_count": len(entries), "manifest": manifest}


def restore_backup(directory: str | Path, target_directory: str | Path) -> Path:
    """Restore into an empty or nonexistent directory, updating photo paths there."""
    source = Path(directory)
    verified = verify_backup(source)
    target = Path(target_directory)
    _reject_symlink_components(target)
    if target.is_symlink():
        raise ValueError("restore target cannot be a symlink")
    if target.exists():
        if not target.is_dir() or any(target.iterdir()):
            raise FileExistsError("restore target must be a new or empty directory")
    else:
        target.mkdir(parents=True)
    (target / "INCOMPLETE").write_text("Restore is incomplete until verification succeeds.\n", encoding="utf-8")
    try:
        manifest = verified["manifest"]
        photo_root = target / "photos"
        photo_root.mkdir()
        for entry in manifest["photos"]:
            archived = _safe_archive_file(source, entry["archive_path"])
            output = photo_root / f"{_safe_filename(entry['id'], 'photo')}_{_safe_filename(Path(entry['archive_path']).name, 'image')}"
            shutil.copyfile(archived, output)
        restored_db = target / DATABASE_NAME
        shutil.copyfile(_safe_archive_file(source, manifest["database"]["archive_path"]), restored_db)
        restored_paths = {entry["id"]: str((photo_root / f"{_safe_filename(entry['id'], 'photo')}_{_safe_filename(Path(entry['archive_path']).name, 'image')}").resolve()) for entry in manifest["photos"]}
        with sqlite3.connect(restored_db) as db:
            cursor = db.executemany("UPDATE photos SET path = ? WHERE id = ?", [(path, photo_id) for photo_id, path in restored_paths.items()])
            if cursor.rowcount != len(restored_paths):
                raise ValueError("failed to update all restored photo paths")
            db.commit()
            integrity = db.execute("PRAGMA integrity_check").fetchone()
            if not integrity or integrity[0] != "ok":
                raise ValueError("restored database integrity check failed")
        (target / "INCOMPLETE").unlink()
        return target
    except Exception:
        raise


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Create, verify, or restore a Roads Region SQLite backup")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create")
    create.add_argument("--database", required=True)
    create.add_argument("--photos", required=True)
    create.add_argument("--extra-photo-root", action="append", default=[], help="additional allowed photo directory; may be repeated")
    create.add_argument("--destination", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("directory")
    restore = sub.add_parser("restore")
    restore.add_argument("directory")
    restore.add_argument("target")
    args = parser.parse_args()
    if args.command == "create":
        result = create_backup(args.database, args.photos, args.destination, additional_photo_roots=args.extra_photo_root)
    elif args.command == "verify":
        result = verify_backup(args.directory)
    else:
        result = {"restored_to": str(restore_backup(args.directory, args.target))}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
