"""Create and reset personal Roads Region accounts without exposing passwords."""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import re
import sys
import uuid

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError


VALID_ROLES = {"dispatcher", "inspector", "contractor"}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_account(*, email: str, name: str, role: str, password: str, contractor_id: str | None) -> dict:
    normalized_email = email.strip().lower()
    normalized_name = name.strip()
    normalized_role = role.strip().lower()
    if not EMAIL_RE.fullmatch(normalized_email) or len(normalized_email) > 254:
        raise ValueError("enter a valid email address")
    if not normalized_name or len(normalized_name) > 160 or any(ord(char) < 32 for char in normalized_name):
        raise ValueError("name must contain 1 to 160 printable characters")
    if normalized_role not in VALID_ROLES:
        raise ValueError("role must be dispatcher, inspector, or contractor")
    if not isinstance(password, str) or len(password) < 12:
        raise ValueError("password must be at least 12 characters")
    normalized_contractor_id = contractor_id.strip() if isinstance(contractor_id, str) else None
    if normalized_role == "contractor":
        if not normalized_contractor_id or len(normalized_contractor_id) > 128 or any(ord(char) < 32 for char in normalized_contractor_id):
            raise ValueError("contractor accounts require a valid contractor id")
    elif normalized_contractor_id:
        raise ValueError("contractor id is only valid for contractor accounts")
    else:
        normalized_contractor_id = None
    return {"email": normalized_email, "name": normalized_name, "role": normalized_role, "contractor_id": normalized_contractor_id}


def create_account(db, backend, *, email: str, name: str, role: str, password: str, contractor_id: str | None = None):
    fields = validate_account(email=email, name=name, role=role, password=password, contractor_id=contractor_id)
    if db.scalar(select(backend.UserRow.id).where(backend.UserRow.email == fields["email"])):
        raise ValueError("email already exists")
    user = backend.UserRow(id=str(uuid.uuid4()), **fields, password_hash=backend.hash_password(password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ValueError("email already exists") from exc
    db.refresh(user)
    return user


def reset_account_password(db, backend, email: str, password: str):
    normalized_email = email.strip().lower()
    if not EMAIL_RE.fullmatch(normalized_email):
        raise ValueError("enter a valid email address")
    if not isinstance(password, str) or len(password) < 12:
        raise ValueError("password must be at least 12 characters")
    user = db.scalar(select(backend.UserRow).where(backend.UserRow.email == normalized_email))
    if not user:
        raise ValueError("account not found")
    user.password_hash = backend.hash_password(password)
    db.execute(delete(backend.SessionRow).where(backend.SessionRow.user_id == user.id))
    db.commit()
    db.refresh(user)
    return user


def _load_backend(database_url: str):
    if not database_url.strip():
        raise ValueError("database URL is required")
    os.environ["DATABASE_URL"] = database_url
    # Account management must never trigger demo account or sample record creation.
    os.environ["ROADS_DEMO_MODE"] = "false"
    backend_directory = Path(__file__).resolve().parents[1] / "backend"
    sys.path.insert(0, str(backend_directory))
    import app.main as backend

    if backend.DEMO_MODE:
        raise RuntimeError("backend imported with demo mode enabled")
    return backend


def _password_twice(prompt: str) -> str:
    first = getpass.getpass(prompt)
    second = getpass.getpass("Confirm password: ")
    if first != second:
        raise ValueError("password entries do not match")
    return first


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage Roads Region personal accounts")
    parser.add_argument("--database-url", help="SQLAlchemy database URL (defaults to DATABASE_URL)")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="create a personal account")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--role", required=True, choices=sorted(VALID_ROLES))
    create.add_argument("--contractor-id")
    reset = commands.add_parser("reset-password", help="reset a password and invalidate sessions")
    reset.add_argument("--email", required=True)
    args = parser.parse_args(argv)
    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        print("Account operation failed: provide --database-url or set DATABASE_URL.", file=sys.stderr)
        return 2
    try:
        password = _password_twice("New password: ")
        backend = _load_backend(database_url)
        with backend.SessionLocal() as db:
            if args.command == "create":
                user = create_account(db, backend, email=args.email, name=args.name, role=args.role, password=password, contractor_id=args.contractor_id)
            else:
                user = reset_account_password(db, backend, args.email, password)
        print(f"Account {user.email} is ready. Passwords were not written to output.")
        return 0
    except (ValueError, RuntimeError) as exc:
        print(f"Account operation failed: {exc}", file=sys.stderr)
        return 2
    except Exception:
        # Keep database connection details and credentials out of terminal logs.
        print("Account operation failed. Check the database connection and try again.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
