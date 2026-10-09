from __future__ import annotations

import hashlib
import hmac
from io import BytesIO
import json
import math
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
import httpx
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, create_engine, inspect, select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value and value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z") if value else None


ROOT = Path(__file__).resolve().parents[1]
PHOTO_DIR = Path(os.getenv("PHOTO_DIR", str(ROOT / "uploads")))
PHOTO_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{ROOT / 'roads.db'}")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine_options = {"poolclass": StaticPool} if DATABASE_URL in ("sqlite://", "sqlite:///:memory:") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args, future=True, **engine_options)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class UserRow(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String, unique=True, index=True)
    role: Mapped[str] = mapped_column(String)
    contractor_id: Mapped[str | None] = mapped_column(String, nullable=True)
    password_hash: Mapped[str] = mapped_column(String)


class SessionRow(Base):
    __tablename__ = "sessions"
    token: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RoutePreviewRow(Base):
    __tablename__ = "route_previews"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    start: Mapped[dict] = mapped_column(JSON)
    end: Mapped[dict] = mapped_column(JSON)
    options: Mapped[list] = mapped_column(JSON)
    decision_points: Mapped[list] = mapped_column(JSON)
    provider: Mapped[str] = mapped_column(String, default="OSRM")
    published_route_id: Mapped[str | None] = mapped_column(String, nullable=True)
    payload_hash: Mapped[str | None] = mapped_column(String, nullable=True)


class RouteRow(Base):
    __tablename__ = "routes"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    code: Mapped[str] = mapped_column(String, unique=True)
    name: Mapped[str] = mapped_column(String)
    notes: Mapped[str] = mapped_column(Text, default="")
    inspector_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    source: Mapped[str] = mapped_column(String)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    start: Mapped[dict] = mapped_column(JSON)
    end: Mapped[dict] = mapped_column(JSON)
    geometry: Mapped[dict] = mapped_column(JSON)
    length_km: Mapped[float] = mapped_column(Float)
    duration_s: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    preview_id: Mapped[str | None] = mapped_column(ForeignKey("route_previews.id"), unique=True, nullable=True)


class PhotoRow(Base):
    __tablename__ = "photos"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String)
    content_type: Mapped[str] = mapped_column(String)
    path: Mapped[str] = mapped_column(String)
    sha256: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InspectionRow(Base):
    __tablename__ = "inspections"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    section_id: Mapped[str] = mapped_column(String)
    inspector_id: Mapped[str] = mapped_column(String)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String, default="active")
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    points: Mapped[list] = mapped_column(JSON, default=list)
    __table_args__ = (Index(
        "uq_inspections_one_active_per_inspector", "inspector_id", unique=True,
        sqlite_where=text("status = 'active'"), postgresql_where=text("status = 'active'"),
    ),)


class DefectRow(Base):
    __tablename__ = "defects"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    number: Mapped[str] = mapped_column(String, unique=True)
    section_id: Mapped[str] = mapped_column(String)
    inspection_id: Mapped[str | None] = mapped_column(String, nullable=True)
    type: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String, default="new")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    location_source: Mapped[str] = mapped_column(String)
    accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    inspector_id: Mapped[str] = mapped_column(String)
    contractor_id: Mapped[str | None] = mapped_column(String, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    photos: Mapped[list] = mapped_column(JSON, default=list)
    previous_defect_id: Mapped[str | None] = mapped_column(String, nullable=True)
    duplicate_of_id: Mapped[str | None] = mapped_column(String, nullable=True)
    history: Mapped[list] = mapped_column(JSON, default=list)
    repairs: Mapped[list] = mapped_column(JSON, default=list)
    __mapper_args__ = {"version_id_col": version}


class IdempotencyRow(Base):
    __tablename__ = "idempotency"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    actor_id: Mapped[str] = mapped_column(String)
    request_hash: Mapped[str] = mapped_column(String)
    defect_id: Mapped[str] = mapped_column(String)


class LoginBody(BaseModel):
    email: str
    password: str


class InspectionBody(BaseModel):
    section_id: str


class TrackPointBody(BaseModel):
    client_id: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    recorded_at: datetime
    accuracy_m: float | None = None


class PointsBody(BaseModel):
    points: list[TrackPointBody]


class FinishBody(BaseModel):
    confirmed: bool
    finished_at: datetime | None = None


class ReviewChecklistBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    surface_restored: StrictBool
    no_visible_damage: StrictBool
    area_safe: StrictBool


class ReviewEvidenceBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    photo_ids: list[str] = Field(min_length=1)
    checklist: ReviewChecklistBody
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(ge=0)
    recorded_at: datetime


class RoutePointBody(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class RoutePreviewBody(BaseModel):
    start: RoutePointBody
    end: RoutePointBody


class RoutePublishBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    notes: str = Field(default="", max_length=2000)
    inspector_id: str
    preview_id: str
    option_id: str | None = None


class DefectBody(BaseModel):
    section_id: str
    inspection_id: str | None = None
    type: str
    description: str
    lat: float
    lng: float
    location_source: str
    accuracy_m: float | None = None
    observed_at: datetime
    photo_ids: list[str]
    previous_defect_id: str | None = None


class ActionBody(BaseModel):
    model_config = ConfigDict(extra="allow")
    action: str
    version: int
    payload: dict[str, Any] = Field(default_factory=dict)


app = FastAPI(title="Roads Region demo API", version="1.0")
Base.metadata.create_all(engine)

# Preserve pre-route databases while safely extending the new route table if a
# local installation was started by an earlier build of this feature.
if "routes" in inspect(engine).get_table_names():
    existing_route_columns = {column["name"] for column in inspect(engine).get_columns("routes")}
    if "duration_s" not in existing_route_columns:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE routes ADD COLUMN duration_s FLOAT NOT NULL DEFAULT 0")
Index("uq_inspections_one_active_per_inspector", InspectionRow.inspector_id, unique=True,
      sqlite_where=text("status = 'active'"), postgresql_where=text("status = 'active'")).create(engine, checkfirst=True)


def db_dep():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 180_000)
    return f"pbkdf2_sha256${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        scheme, salt, digest = stored.split("$")
        return scheme == "pbkdf2_sha256" and hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 180_000).hex(), digest)
    except (ValueError, TypeError):
        return False


def user_data(user: UserRow) -> dict:
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role, "contractor_id": user.contractor_id}


def current_user(request: Request, db: Session = Depends(db_dep)) -> UserRow:
    token = request.cookies.get("roads_session")
    session = db.get(SessionRow, token) if token else None
    if not session or session.expires_at.replace(tzinfo=timezone.utc) <= utcnow():
        raise HTTPException(401, detail={"code": "UNAUTHENTICATED", "message": "Войдите в систему"})
    user = db.get(UserRow, session.user_id)
    if user is None:
        raise HTTPException(401, detail={"code": "UNAUTHENTICATED", "message": "Войдите в систему"})
    field_owner = request.headers.get("X-Field-Owner")
    if field_owner is not None and field_owner != user.id:
        raise HTTPException(403, detail={"code": "FIELD_OWNER_MISMATCH", "message": "Сессия принадлежит другому пользователю. Повторно войдите перед синхронизацией"})
    return user


def require_role(user: UserRow, *roles: str) -> None:
    if user.role not in roles:
        raise HTTPException(403, detail={"code": "FORBIDDEN", "message": "Недостаточно прав"})


def photo_data(photo_id: str) -> dict:
    return {"id": photo_id, "url": f"/api/photos/{photo_id}", "name": photo_name(photo_id)}


def photo_name(photo_id: str) -> str:
    with SessionLocal() as db:
        row = db.get(PhotoRow, photo_id)
        return row.name if row else "Фото"


def inspection_data(row: InspectionRow) -> dict:
    return {"id": row.id, "section_id": row.section_id, "inspector_id": row.inspector_id, "started_at": iso(row.started_at), "finished_at": iso(row.finished_at), "status": row.status, "confirmed": row.confirmed, "points": row.points or []}


LEGACY_GEOMETRY = {"type": "LineString", "coordinates": [[65.4970, 44.8470], [65.5080, 44.8510], [65.5200, 44.8570], [65.5330, 44.8640]]}
LEGACY_START = {"lat": 44.8470, "lng": 65.4970}
LEGACY_END = {"lat": 44.8640, "lng": 65.5330}


def route_data(row: RouteRow, db: Session) -> dict:
    inspector = db.get(UserRow, row.inspector_id)
    latest = db.scalar(select(InspectionRow).where(InspectionRow.section_id == row.id).order_by(InspectionRow.started_at.desc()).limit(1))
    if latest and latest.status == "active":
        state = "in_progress"
    elif latest and latest.status == "finished":
        state = "completed"
    else:
        state = "assigned"
    duration_min = max(0, int(round(float(row.duration_s or 0) / 60)))
    return {
        "id": row.id, "name": row.name, "code": row.code, "length_km": row.length_km,
        "geometry": row.geometry, "responsible": "Демо: Кызылординский областной филиал" if row.is_demo else (inspector.name if inspector else ""),
        "is_demo": row.is_demo, "inspector_id": row.inspector_id, "inspector_name": inspector.name if inspector else "",
        "notes": row.notes or "", "created_at": iso(row.created_at), "state": state, "duration_min": duration_min, "duration_s": float(row.duration_s or 0),
        "source": row.source, "start": row.start, "end": row.end,
    }


def routes_visible_to(user: UserRow, db: Session) -> list[RouteRow]:
    if user.role == "dispatcher":
        return db.scalars(select(RouteRow).order_by(RouteRow.created_at, RouteRow.code)).all()
    if user.role == "inspector":
        return db.scalars(select(RouteRow).where(RouteRow.inspector_id == user.id).order_by(RouteRow.created_at, RouteRow.code)).all()
    if user.role == "contractor":
        assigned_sections = select(DefectRow.section_id).where(DefectRow.contractor_id == user.contractor_id).distinct()
        return db.scalars(select(RouteRow).where(RouteRow.id.in_(assigned_sections)).order_by(RouteRow.created_at, RouteRow.code)).all()
    return []


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rad = math.pi / 180
    dlat, dlng = (lat2 - lat1) * rad, (lng2 - lng1) * rad
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin(dlng / 2) ** 2
    return 6_371_000 * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1 - a)))


def fetch_osrm_routes(start: dict, end: dict) -> dict:
    base = os.getenv("ROUTING_BASE_URL", "https://router.project-osrm.org").rstrip("/")
    url = f"{base}/route/v1/driving/{start['lng']},{start['lat']};{end['lng']},{end['lat']}"
    response = httpx.get(url, params={
        "alternatives": "true", "geometries": "geojson", "overview": "full", "steps": "true", "radiuses": "500;500",
    }, timeout=20.0)
    if response.is_error:
        try:
            payload = response.json()
        except ValueError:
            response.raise_for_status()
            raise
        if isinstance(payload, dict) and payload.get("code") in ("NoRoute", "NoSegment"):
            return payload
        response.raise_for_status()
        return payload
    return response.json()


def parse_osrm_preview(payload: Any, start: dict, end: dict) -> tuple[dict, dict, list[dict], list[dict]]:
    if not isinstance(payload, dict):
        raise ValueError("OSRM response must be an object")
    if payload.get("code") in ("NoRoute", "NoSegment") or payload.get("routes") == []:
        raise HTTPException(422, detail={"code": "NO_ROUTE", "message": "Дорожный маршрут между точками не найден"})
    if payload.get("code") != "Ok" or not isinstance(payload.get("routes"), list) or not payload["routes"]:
        raise ValueError("OSRM returned no usable routes")
    waypoints = payload.get("waypoints")
    if not isinstance(waypoints, list) or len(waypoints) != 2:
        raise ValueError("OSRM returned invalid snapped endpoints")

    snapped: list[dict] = []
    for requested, waypoint in zip((start, end), waypoints):
        location = waypoint.get("location") if isinstance(waypoint, dict) else None
        if not isinstance(location, list) or len(location) < 2:
            raise ValueError("OSRM returned malformed waypoint")
        lng, lat = float(location[0]), float(location[1])
        if not math.isfinite(lat) or not math.isfinite(lng) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("OSRM returned invalid waypoint coordinates")
        if haversine_m(requested["lat"], requested["lng"], lat, lng) > 500:
            raise HTTPException(422, detail={"code": "SNAP_TOO_FAR", "message": "Ближайшая дорога находится дальше 500 м от указанной точки"})
        snapped.append({"lat": lat, "lng": lng})

    options: list[dict] = []
    seen_geometries: set[tuple[tuple[float, float], ...]] = set()
    for index, candidate in enumerate(payload["routes"]):
        try:
            geometry = candidate["geometry"]
            coords = geometry["coordinates"]
            distance_m, duration_s = float(candidate["distance"]), float(candidate["duration"])
            if geometry.get("type") != "LineString" or not isinstance(coords, list) or len(coords) < 2:
                raise ValueError("invalid route geometry")
            if not math.isfinite(distance_m) or not math.isfinite(duration_s) or distance_m <= 0 or duration_s < 0:
                raise ValueError("invalid route metrics")
            normalized: list[list[float]] = []
            for coord in coords:
                if not isinstance(coord, list) or len(coord) < 2:
                    raise ValueError("invalid coordinate")
                lng, lat = float(coord[0]), float(coord[1])
                if not math.isfinite(lat) or not math.isfinite(lng) or not (-90 <= lat <= 90 and -180 <= lng <= 180):
                    raise ValueError("coordinate outside valid range")
                normalized.append([lng, lat])
            summary_names = []
            for leg in candidate.get("legs", []):
                for step in leg.get("steps", []):
                    road_name = step.get("name")
                    if road_name and road_name not in summary_names:
                        summary_names.append(road_name)
            summary = " · ".join(summary_names[:3]) or f"Вариант {index + 1}"
            geometry = {"type": "LineString", "coordinates": normalized}
            signature = tuple((round(lng, 5), round(lat, 5)) for lng, lat in normalized)
            if signature in seen_geometries:
                continue
            seen_geometries.add(signature)
            digest = hashlib.sha256(json.dumps(geometry, separators=(",", ":"), sort_keys=True).encode()).hexdigest()[:12]
            options.append({"id": f"option-{digest}", "geometry": geometry, "distance_m": distance_m, "duration_s": duration_s, "summary": summary})
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ValueError(f"OSRM returned malformed route: {exc}") from exc
    if not options:
        raise HTTPException(422, detail={"code": "NO_ROUTE", "message": "Дорожный маршрут между точками не найден"})

    def common_prefix_end(left: list[list[float]], right: list[list[float]]) -> tuple[float, float] | None:
        i = j = 0
        last_common = None
        tolerance_m = 20
        while i < len(left) and j < len(right):
            left_lng, left_lat = left[i]
            right_lng, right_lat = right[j]
            if haversine_m(left_lat, left_lng, right_lat, right_lng) <= tolerance_m:
                last_common = ((left_lat + right_lat) / 2, (left_lng + right_lng) / 2)
                i += 1
                j += 1
                continue
            if i + 1 < len(left) and haversine_m(left[i + 1][1], left[i + 1][0], right_lat, right_lng) <= tolerance_m:
                i += 1
                continue
            if j + 1 < len(right) and haversine_m(left_lat, left_lng, right[j + 1][1], right[j + 1][0]) <= tolerance_m:
                j += 1
                continue
            break
        return last_common

    decision_points: list[dict] = []
    for i in range(len(options)):
        for j in range(i + 1, len(options)):
            left = options[i]["geometry"]["coordinates"]
            right = options[j]["geometry"]["coordinates"]
            fork = common_prefix_end(left, right)
            if not fork:
                continue
            lat, lng = fork
            if any(haversine_m(lat, lng, point["lat"], point["lng"]) <= 50 for point in decision_points):
                continue
            decision_points.append({"lat": lat, "lng": lng, "label": f"Различие вариантов {i + 1} и {j + 1}"})
    return snapped[0], snapped[1], options, decision_points


def defect_data(row: DefectRow, db: Session, detail: bool = False) -> dict:
    contractor = db.scalar(select(UserRow).where(UserRow.contractor_id == row.contractor_id)) if row.contractor_id else None
    section = db.get(RouteRow, row.section_id)
    photos = [photo_data(pid) for pid in row.photos or []]
    due_at = row.due_at
    if due_at and due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)
    result = {"id": row.id, "number": row.number, "section_id": row.section_id, "section_name": section.name if section else None, "section_code": section.code if section else None, "inspection_id": row.inspection_id, "type": row.type, "description": row.description, "status": row.status, "lat": row.lat, "lng": row.lng, "location_source": row.location_source, "accuracy_m": row.accuracy_m, "observed_at": iso(row.observed_at), "received_at": iso(row.received_at), "inspector_id": row.inspector_id, "contractor_id": row.contractor_id, "contractor_name": contractor.name if contractor else None, "due_at": iso(due_at), "overdue": bool(due_at and due_at < utcnow() and row.status not in ("closed", "cancelled")), "version": row.version, "photos": photos, "previous_defect_id": row.previous_defect_id, "duplicate_of_id": row.duplicate_of_id}
    if detail:
        result["history"] = row.history or []
        repairs = []
        for repair in row.repairs or []:
            repair = dict(repair)
            repair["photos"] = [photo_data(pid) for pid in repair.get("photos", [])]
            evidence = repair.get("review_evidence")
            if isinstance(evidence, dict):
                evidence = dict(evidence)
                evidence_photo_ids = evidence.pop("photo_ids", evidence.get("photos", []))
                evidence["photos"] = [photo_data(pid) for pid in evidence_photo_ids]
                repair["review_evidence"] = evidence
            repairs.append(repair)
        result["repairs"] = repairs
        linked = list(db.scalars(select(DefectRow).where(DefectRow.previous_defect_id == row.id)))
        if linked:
            result["linked_observations"] = [defect_data(item, db) for item in linked]
    return result


def visible(row: DefectRow, user: UserRow) -> bool:
    return user.role != "contractor" or row.contractor_id == user.contractor_id


def get_defect(db: Session, defect_id: str, user: UserRow) -> DefectRow:
    row = db.get(DefectRow, defect_id)
    if not row or not visible(row, user):
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Запись не найдена"})
    return row


def validate_review_evidence(raw: Any, row: DefectRow, user: UserRow, db: Session) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("recorded_at"), str):
        raise HTTPException(422, detail={"code": "INVALID_REVIEW_EVIDENCE", "message": "Укажите фото, GPS-координаты, точность, время и все пункты проверки"})
    try:
        evidence = ReviewEvidenceBody.model_validate(raw)
    except ValidationError:
        raise HTTPException(422, detail={"code": "INVALID_REVIEW_EVIDENCE", "message": "Проверьте формат GPS-координат, времени, фото и контрольного списка"})
    checklist = evidence.checklist.model_dump()
    if not all(checklist.values()):
        raise HTTPException(422, detail={"code": "REVIEW_CHECKLIST_INCOMPLETE", "message": "Для приёмки подтвердите восстановление покрытия, отсутствие повреждений и безопасность участка"})
    values = (evidence.lat, evidence.lng, evidence.accuracy_m)
    if not all(math.isfinite(value) for value in values):
        raise HTTPException(422, detail={"code": "INVALID_REVIEW_EVIDENCE", "message": "GPS-координаты и точность должны быть конечными числами"})
    recorded_at = evidence.recorded_at
    if recorded_at.tzinfo is None:
        recorded_at = recorded_at.replace(tzinfo=timezone.utc)
    checked_at = utcnow()
    age_seconds = (checked_at - recorded_at).total_seconds()
    if age_seconds > 5 * 60 or age_seconds < -30:
        raise HTTPException(422, detail={"code": "REVIEW_EVIDENCE_STALE", "message": "GPS-проверка устарела или имеет время из будущего. Повторите проверку участка"})
    photo_ids = list(dict.fromkeys(evidence.photo_ids))
    photos = [db.get(PhotoRow, photo_id) for photo_id in photo_ids]
    if any(photo is None or photo.owner_id != user.id for photo in photos):
        raise HTTPException(403, detail={"code": "PHOTO_FORBIDDEN", "message": "Для приёмки используйте фото, загруженные вами"})
    return {
        "photo_ids": photo_ids,
        "checklist": checklist,
        "lat": evidence.lat,
        "lng": evidence.lng,
        "accuracy_m": evidence.accuracy_m,
        "recorded_at": iso(recorded_at),
        "inspector_id": user.id,
        "checked_at": iso(checked_at),
        "distance_m": round(haversine_m(row.lat, row.lng, evidence.lat, evidence.lng), 1),
    }


def audit(row: DefectRow, action: str, user: UserRow, comment: str | None, before: dict | None, after: dict | None):
    row.history = [*(row.history or []), {"id": str(uuid.uuid4()), "action": action, "actor_name": user.name, "created_at": iso(utcnow()), "comment": comment, **({"before": before} if before is not None else {}), **({"after": after} if after is not None else {})}]


def audit_state(row: DefectRow, db: Session) -> dict:
    with db.no_autoflush:
        contractor = db.scalar(select(UserRow).where(UserRow.contractor_id == row.contractor_id)) if row.contractor_id else None
    return {
        "status": row.status,
        "due_at": iso(row.due_at),
        "contractor_id": row.contractor_id,
        "contractor_name": contractor.name if contractor else None,
    }


def seed():
    with SessionLocal() as db:
        if db.get(UserRow, "u-inspector"):
            return
        contractors = [UserRow(id="u-contract-a", name="Кызылорда ЖолСервис", email="contractor@roads.local", role="contractor", contractor_id="c-1", password_hash=hash_password("RoadsDemo2026!")), UserRow(id="u-contract-b", name="ДорСтрой Сырдарья", email="contractor2@roads.local", role="contractor", contractor_id="c-2", password_hash=hash_password("RoadsDemo2026!"))]
        users = [UserRow(id="u-inspector", name="Айгуль Нуртаева", email="inspector@roads.local", role="inspector", password_hash=hash_password("RoadsDemo2026!")), UserRow(id="u-dispatcher", name="Ерлан Садыков", email="dispatcher@roads.local", role="dispatcher", password_hash=hash_password("RoadsDemo2026!")), *contractors]
        db.add_all(users)
        now = utcnow()
        examples = [
            ("ДЕМО-001", "Выбоина", "Демо: выбоина у обочины, требуется ремонт покрытия.", "new", 44.84895, 65.50210, None, None),
            ("ДЕМО-002", "Трещина", "Демо: продольная трещина на правой полосе.", "assigned", 44.85130, 65.50820, "c-1", now + timedelta(days=3)),
            ("ДЕМО-003", "Просадка", "Демо: просадка покрытия после водоотвода.", "in_progress", 44.85410, 65.51450, "c-1", now - timedelta(days=1)),
            ("ДЕМО-004", "Люк", "Демо: крышка люка ниже уровня дорожного полотна.", "review", 44.85735, 65.52020, "c-2", now + timedelta(days=2)),
        ]
        for index, (number, kind, desc, status, lat, lng, contractor_id, due) in enumerate(examples):
            fid = f"demo-defect-{index+1}"
            demo_repair = [{
                "id": "demo-repair-report-4", "created_at": iso(now - timedelta(hours=2)),
                "comment": "Демо: подрядчик сообщил о выполнении ремонта, требуется проверка инспектора.",
                "photos": ["demo-photo-repair"], "decision": None, "decision_comment": None,
            }] if status == "review" else []
            row = DefectRow(id=fid, number=number, section_id="r-01", inspection_id=None, type=kind, description=desc, status=status, lat=lat, lng=lng, location_source="gps", accuracy_m=8.5, observed_at=now-timedelta(days=index+1), received_at=now-timedelta(days=index+1), inspector_id="u-inspector", contractor_id=contractor_id, due_at=due, version=1, photos=[], previous_defect_id=None, duplicate_of_id=None, history=[], repairs=demo_repair)
            audit(row, "created", db.get(UserRow, "u-inspector") if index == 0 else users[0], "Демонстрационная запись", None, {"status": "new"})
            db.add(row)
        # Synthetic illustration assets are intentionally marked demo in their names.
        for pid, filename, defect_id in (("demo-photo-road", "ДЕМО — дорожный дефект.png", "demo-defect-1"), ("demo-photo-repair", "ДЕМО — выполненный ремонт.png", "demo-defect-3")):
            fixture = ROOT / "demo_photos" / ("demo-road-condition.png" if "road" in pid else "demo-repair.png")
            if fixture.exists():
                db.add(PhotoRow(id=pid, owner_id="u-inspector", name=filename, content_type="image/png", path=str(fixture), sha256=hashlib.sha256(fixture.read_bytes()).hexdigest()))
                sample = db.get(DefectRow, defect_id)
                # Pending rows are not visible through db.get until flushed.
                sample = next((item for item in db.new if isinstance(item, DefectRow) and item.id == defect_id), sample)
                if sample:
                    sample.photos = [pid]
        db.commit()


seed()


def ensure_legacy_route():
    """Add the legacy demo section to the new route table without rewriting observations."""
    with SessionLocal() as db:
        if db.get(RouteRow, "r-01"):
            return
        inspector = db.get(UserRow, "u-inspector")
        if not inspector:
            return
        db.add(RouteRow(
            id="r-01", code="R-01", name="Участок Кызылорда — Айтеке би",
            notes="Демо: существующий участок сохранён при миграции маршрутов.",
            inspector_id=inspector.id, source="demo", is_demo=True,
            start=LEGACY_START, end=LEGACY_END, geometry=LEGACY_GEOMETRY,
            length_km=18.4, created_at=utcnow(), preview_id=None,
        ))
        db.commit()


ensure_legacy_route()


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "ERROR", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={**detail, "request_id": request.headers.get("x-request-id", str(uuid.uuid4()))})


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"code": "VALIDATION_ERROR", "message": "Проверьте данные запроса", "details": exc.errors(), "request_id": request.headers.get("x-request-id", str(uuid.uuid4()))})


@app.get("/api/me")
def me(user: UserRow = Depends(current_user)):
    return user_data(user)


@app.post("/api/login")
def login(body: LoginBody, response: Response, db: Session = Depends(db_dep)):
    user = db.scalar(select(UserRow).where(UserRow.email == body.email.lower()))
    if not user or not check_password(body.password, user.password_hash):
        raise HTTPException(401, detail={"code": "INVALID_CREDENTIALS", "message": "Неверный email или пароль"})
    token = secrets.token_urlsafe(32)
    db.add(SessionRow(token=token, user_id=user.id, expires_at=utcnow()+timedelta(days=14)))
    db.commit()
    response.set_cookie("roads_session", token, httponly=True, samesite="lax", secure=False, max_age=14*86400, path="/")
    return user_data(user)


@app.post("/api/logout")
def logout(request: Request, response: Response, db: Session = Depends(db_dep)):
    token = request.cookies.get("roads_session")
    if token and (row := db.get(SessionRow, token)):
        db.delete(row)
        db.commit()
    response.delete_cookie("roads_session", path="/")
    return {"ok": True}


@app.get("/api/bootstrap")
def bootstrap(user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    inspectors = []
    if user.role == "dispatcher":
        inspectors = [user_data(item) for item in db.scalars(select(UserRow).where(UserRow.role == "inspector").order_by(UserRow.name)).all()]
    return {
        "user": user_data(user),
        "sections": [route_data(row, db) for row in routes_visible_to(user, db)],
        "inspectors": inspectors,
        "contractors": [{"id": "c-1", "name": "Кызылорда ЖолСервис"}, {"id": "c-2", "name": "ДорСтрой Сырдарья"}],
    }


@app.get("/api/defects")
def defects(user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    rows = db.scalars(select(DefectRow).order_by(DefectRow.received_at.desc())).all()
    return [defect_data(row, db) for row in rows if visible(row, user)]


@app.get("/api/defects/{defect_id}")
def defect_detail(defect_id: str, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    return defect_data(get_defect(db, defect_id, user), db, True)


@app.post("/api/files")
async def upload_file(
    file: UploadFile = File(...), user: UserRow = Depends(current_user), db: Session = Depends(db_dep),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, detail={"code": "FILE_TOO_LARGE", "message": "Максимальный размер фото — 10 МБ"})
    if not data:
        raise HTTPException(422, detail={"code": "EMPTY_FILE", "message": "Выбранный файл пуст. Выберите фотографию и повторите попытку"})
    ctype = (file.content_type or "").split(";", 1)[0].strip().lower()
    suffix = Path(file.filename or "").suffix.lower()
    heif_brands = (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1")
    is_heif = ctype in ("image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence") or suffix in (".heic", ".heif") or (
        len(data) >= 12 and data[4:8] == b"ftyp" and any(data[8:32].find(brand) >= 0 for brand in heif_brands)
    )
    if is_heif:
        raise HTTPException(415, detail={"code": "UNSUPPORTED_IMAGE_FORMAT", "message": "Формат HEIC/HEIF пока не поддерживается. Сохраните фото как JPEG или PNG и выберите его повторно"})
    try:
        with Image.open(BytesIO(data)) as image:
            actual_type = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}.get(image.format)
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        actual_type = None
    if actual_type is None:
        raise HTTPException(415, detail={"code": "INVALID_IMAGE", "message": "Файл повреждён или не является фотографией JPEG, PNG или WebP"})
    # Browsers can supply a missing or misleading file.type. Trust Pillow's
    # content sniff after verification, and use that detected type for storage
    # and downloads instead of rejecting an otherwise valid original.
    ctype = actual_type
    raw_key = (idempotency_key or "").strip()
    if len(raw_key) > 180:
        raise HTTPException(422, detail={"code": "INVALID_IDEMPOTENCY_KEY", "message": "Ключ повторной отправки слишком длинный"})
    upload_key = f"upload:{user.id}:{raw_key}" if raw_key else None
    content_hash = hashlib.sha256(data).hexdigest()
    if upload_key:
        existing = db.get(IdempotencyRow, upload_key)
        if existing:
            if existing.actor_id != user.id or existing.request_hash != content_hash:
                raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Этот ключ уже использован для другого содержимого фото"})
            photo = db.get(PhotoRow, existing.defect_id)
            if not photo or not Path(photo.path).is_file():
                raise HTTPException(409, detail={"code": "PHOTO_RETRY_UNAVAILABLE", "message": "Фото из первоначальной отправки недоступно. Загрузите его с новым ключом"})
            return photo_data(photo.id)
    pid = str(uuid.uuid4())
    extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[ctype]
    path = PHOTO_DIR / f"{pid}{extension}"
    path.write_bytes(data)
    db.add(PhotoRow(id=pid, owner_id=user.id, name=Path(file.filename or "Фото").name[:255], content_type=ctype, path=str(path), sha256=content_hash))
    if upload_key:
        db.add(IdempotencyRow(key=upload_key, actor_id=user.id, request_hash=content_hash, defect_id=pid))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if upload_key:
            winner = db.get(IdempotencyRow, upload_key)
            if winner and winner.actor_id == user.id and winner.request_hash == content_hash:
                photo = db.get(PhotoRow, winner.defect_id)
                if photo and Path(photo.path).is_file():
                    return photo_data(photo.id)
            if winner:
                raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Этот ключ уже использован для другого содержимого фото"})
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "Фото уже отправляется. Повторите запрос"})
    return photo_data(pid)


@app.get("/api/photos/{photo_id}")
def get_photo(photo_id: str, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    photo = db.get(PhotoRow, photo_id)
    if not photo:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Фото не найдено"})
    if photo.owner_id != user.id:
        rows = db.scalars(select(DefectRow)).all()
        attached = any(
            photo_id in (r.photos or []) or any(
                photo_id in repair.get("photos", []) or photo_id in (repair.get("review_evidence") or {}).get("photo_ids", [])
                for repair in (r.repairs or [])
            )
            for r in rows if visible(r, user)
        )
        if not attached:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Фото не найдено"})
    if not Path(photo.path).is_file():
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Файл фото не найден"})
    return FileResponse(photo.path, media_type=photo.content_type, filename=photo.name, content_disposition_type="inline")


@app.post("/api/inspections")
def create_inspection(body: InspectionBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "inspector")
    route = db.get(RouteRow, body.section_id)
    if not route or route.inspector_id != user.id:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Маршрут не назначен этому инспектору"})
    active = db.scalar(select(InspectionRow).where(
        InspectionRow.inspector_id == user.id,
        InspectionRow.status == "active",
    ).order_by(InspectionRow.started_at.desc()))
    if active:
        if active.section_id == body.section_id:
            return inspection_data(active)
        raise HTTPException(409, detail={"code": "ACTIVE_INSPECTION", "message": "Сначала завершите уже начатый маршрут"})
    row = InspectionRow(id=str(uuid.uuid4()), section_id=body.section_id, inspector_id=user.id, points=[])
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # The partial unique index is the cross-request guard when two starts
        # race. Resolve the winner to make same-route retries idempotent.
        db.rollback()
        active = db.scalar(select(InspectionRow).where(
            InspectionRow.inspector_id == user.id,
            InspectionRow.status == "active",
        ).order_by(InspectionRow.started_at.desc()))
        if active and active.section_id == body.section_id:
            return inspection_data(active)
        if active:
            raise HTTPException(409, detail={"code": "ACTIVE_INSPECTION", "message": "Сначала завершите уже начатый маршрут"})
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "Осмотр изменился одновременно. Повторите отправку"})
    db.refresh(row)
    return inspection_data(row)


@app.get("/api/inspections")
def inspections(user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "inspector")
    return [inspection_data(r) for r in db.scalars(select(InspectionRow).where(InspectionRow.inspector_id == user.id).order_by(InspectionRow.started_at.desc())).all()]


def owned_inspection(db: Session, iid: str, user: UserRow) -> InspectionRow:
    row = db.get(InspectionRow, iid)
    if not row or row.inspector_id != user.id:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Осмотр не найден"})
    return row


@app.get("/api/inspections/{inspection_id}")
def get_inspection(inspection_id: str, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "inspector")
    return inspection_data(owned_inspection(db, inspection_id, user))


@app.post("/api/inspections/{inspection_id}/points")
def add_points(inspection_id: str, body: PointsBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "inspector")
    row = owned_inspection(db, inspection_id, user)
    if row.status != "active": raise HTTPException(409, detail={"code": "CONFLICT", "message": "Осмотр уже завершён"})
    existing = {p["client_id"] for p in row.points or []}
    for point in body.points:
        p = point.model_dump()
        if p["client_id"] in existing: continue
        p["recorded_at"] = iso(p["recorded_at"])
        row.points = [*(row.points or []), p]
        existing.add(p["client_id"])
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "Запись уже изменена. Обновите страницу"})
    db.refresh(row)
    return inspection_data(row)


@app.post("/api/inspections/{inspection_id}/finish")
def finish_inspection(inspection_id: str, body: FinishBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "inspector")
    row = owned_inspection(db, inspection_id, user)
    if not body.confirmed: raise HTTPException(422, detail={"code": "CONFIRMATION_REQUIRED", "message": "Подтвердите завершение осмотра"})
    if row.status == "finished":
        return inspection_data(row)
    if row.status != "active": raise HTTPException(409, detail={"code": "CONFLICT", "message": "Осмотр уже завершён"})
    now = utcnow()
    finished_at = body.finished_at or now
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=timezone.utc)
    started_at = row.started_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    if finished_at < started_at or finished_at > now + timedelta(seconds=30):
        raise HTTPException(422, detail={"code": "INVALID_FINISH_TIME", "message": "Время завершения должно быть не раньше начала осмотра и не более чем на 30 секунд в будущем"})
    row.status = "finished"; row.confirmed = True; row.finished_at = finished_at
    db.commit(); db.refresh(row)
    return inspection_data(row)


@app.post("/api/defects")
def create_defect(body: DefectBody, request: Request, user: UserRow = Depends(current_user), db: Session = Depends(db_dep), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_role(user, "inspector")
    request_hash = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    if idempotency_key:
        old = db.get(IdempotencyRow, idempotency_key)
        if old:
            if old.actor_id != user.id or old.request_hash != request_hash: raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Ключ уже использован для другого запроса"})
            return defect_data(get_defect(db, old.defect_id, user), db, True)
    route = db.get(RouteRow, body.section_id)
    if not route or route.inspector_id != user.id: raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Маршрут не назначен этому инспектору"})
    if body.type not in ("Выбоина", "Трещина", "Просадка", "Люк"): raise HTTPException(422, detail={"code": "INVALID_TYPE", "message": "Неизвестный тип дефекта"})
    if body.location_source not in ("gps", "manual") or not (-90 <= body.lat <= 90 and -180 <= body.lng <= 180): raise HTTPException(422, detail={"code": "INVALID_LOCATION", "message": "Некорректное местоположение"})
    if not body.photo_ids: raise HTTPException(422, detail={"code": "PHOTO_REQUIRED", "message": "Добавьте хотя бы одно фото"})
    photo_rows = [db.get(PhotoRow, pid) for pid in body.photo_ids]
    if any(not p or p.owner_id != user.id for p in photo_rows): raise HTTPException(403, detail={"code": "PHOTO_FORBIDDEN", "message": "Можно использовать только собственные загруженные фото"})
    if body.inspection_id:
        inspection = owned_inspection(db, body.inspection_id, user)
        if inspection.section_id != body.section_id: raise HTTPException(422, detail={"code": "SECTION_MISMATCH", "message": "Осмотр относится к другому участку"})
        if inspection.status != "active": raise HTTPException(422, detail={"code": "INSPECTION_FINISHED", "message": "Нельзя связать новый дефект с завершённым осмотром"})
    if body.previous_defect_id:
        previous = db.get(DefectRow, body.previous_defect_id)
        if not previous or previous.section_id != body.section_id or previous.status != "closed": raise HTTPException(422, detail={"code": "INVALID_RECURRENCE", "message": "Повторная фиксация должна ссылаться на закрытый дефект этого участка"})
    row = DefectRow(id=str(uuid.uuid4()), number=f"KZO-{utcnow():%y%m%d}-{secrets.randbelow(9000)+1000}", section_id=body.section_id, inspection_id=body.inspection_id, type=body.type, description=body.description, status="new", lat=body.lat, lng=body.lng, location_source=body.location_source, accuracy_m=body.accuracy_m, observed_at=body.observed_at, received_at=utcnow(), inspector_id=user.id, contractor_id=None, due_at=None, version=1, photos=list(dict.fromkeys(body.photo_ids)), previous_defect_id=body.previous_defect_id, duplicate_of_id=None, history=[], repairs=[])
    audit(row, "created", user, None, None, {"status": "new"})
    db.add(row)
    if idempotency_key: db.add(IdempotencyRow(key=idempotency_key, actor_id=user.id, request_hash=request_hash, defect_id=row.id))
    db.commit(); db.refresh(row)
    return defect_data(row, db, True)


@app.get("/api/defects/{defect_id}/duplicates")
def duplicates(defect_id: str, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    row = get_defect(db, defect_id, user)
    found = []
    for candidate in db.scalars(select(DefectRow).where(DefectRow.section_id == row.section_id, DefectRow.type == row.type, DefectRow.id != row.id, DefectRow.status.not_in(["closed", "cancelled"]))).all():
        # Haversine distance in metres.
        from math import asin, cos, radians, sin, sqrt
        dlat, dlng = radians(candidate.lat-row.lat), radians(candidate.lng-row.lng)
        a = sin(dlat/2)**2 + cos(radians(row.lat))*cos(radians(candidate.lat))*sin(dlng/2)**2
        distance = 6371000 * 2 * asin(sqrt(a))
        if distance <= 30:
            data = defect_data(candidate, db); data["distance_m"] = round(distance, 1); found.append(data)
    return found


@app.post("/api/defects/{defect_id}/actions")
def defect_action(defect_id: str, body: ActionBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    row = get_defect(db, defect_id, user)
    p = {**(body.model_extra or {}), **body.payload}
    if row.version != body.version: raise HTTPException(409, detail={"code": "CONFLICT", "message": "Запись уже изменена. Обновите страницу", "details": {"version": row.version}})
    action = body.action
    before = audit_state(row, db)
    comment = p.get("comment") or p.get("reason")
    def require_text(key: str):
        value = p.get(key)
        if not isinstance(value, str) or not value.strip(): raise HTTPException(422, detail={"code": "REQUIRED", "message": f"Поле {key} обязательно"})
        return value.strip()
    def required_datetime(key: str) -> datetime:
        value = p.get(key)
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(422, detail={"code": "REQUIRED", "message": f"Поле {key} обязательно"})
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, detail={"code": "INVALID_DATETIME", "message": f"Поле {key} должно содержать дату и время"})
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    if action == "assign":
        require_role(user, "dispatcher")
        if row.status != "new": raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Назначить можно только новый дефект"})
        target = p.get("contractor_id")
        if target not in ("c-1", "c-2"): raise HTTPException(422, detail={"code": "INVALID_CONTRACTOR", "message": "Выберите подрядчика"})
        row.contractor_id = target; row.due_at = required_datetime("due_at"); row.status = "assigned"
    elif action == "request_info":
        require_role(user, "dispatcher"); require_text("comment")
        if row.status != "new": raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Запросить уточнение можно только для нового дефекта"})
        row.status = "needs_info"
    elif action == "clarify":
        require_role(user, "inspector"); require_text("comment")
        if row.status != "needs_info" or row.inspector_id != user.id: raise HTTPException(403, detail={"code": "FORBIDDEN", "message": "Уточнить может только автор запроса"})
        row.status = "new"
    elif action in ("accept", "start", "submit", "report_assignment"):
        require_role(user, "contractor")
        if row.contractor_id != user.contractor_id: raise HTTPException(403, detail={"code": "FORBIDDEN", "message": "Дефект назначен другой организации"})
        expected = {"accept": ("assigned", "accepted"), "start": (("accepted", "rework"), "in_progress"), "submit": ("in_progress", "review"), "report_assignment": ("assigned", "assigned")}[action]
        allowed, target = expected
        if row.status not in (allowed if isinstance(allowed, tuple) else (allowed,)): raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Недопустимый переход статуса"})
        if action == "submit":
            require_text("comment"); photo_ids = p.get("photo_ids") or []
            if not photo_ids: raise HTTPException(422, detail={"code": "PHOTO_REQUIRED", "message": "Добавьте фото выполненных работ"})
            pics = [db.get(PhotoRow, pid) for pid in photo_ids]
            if any(not x or x.owner_id != user.id for x in pics): raise HTTPException(403, detail={"code": "PHOTO_FORBIDDEN", "message": "Можно использовать только собственные загруженные фото"})
            row.repairs = [*(row.repairs or []), {"id": str(uuid.uuid4()), "created_at": iso(utcnow()), "comment": p["comment"].strip(), "photos": list(dict.fromkeys(photo_ids)), "decision": None, "decision_comment": None}]
        if action == "report_assignment": require_text("reason")
        row.status = target
    elif action in ("approve", "reject"):
        require_role(user, "inspector")
        if row.status != "review": raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Рассмотреть можно только отправленный ремонт"})
        repairs = row.repairs or []
        if not repairs or not isinstance(repairs[-1], dict):
            raise HTTPException(409, detail={"code": "MISSING_REPAIR_REPORT", "message": "Нельзя рассмотреть заявку: подрядчик ещё не приложил отчёт о ремонте"})
        repair = dict(repairs[-1])
        if action == "approve":
            raw_evidence = p.get("review_evidence")
            if raw_evidence is None:
                raise HTTPException(422, detail={"code": "REVIEW_EVIDENCE_REQUIRED", "message": "Для приёмки приложите GPS-проверку, фото и заполненный контрольный список"})
            repair["review_evidence"] = validate_review_evidence(raw_evidence, row, user, db)
            row.status = "closed"; repair["decision"] = "accepted"; repair["decision_comment"] = p.get("comment")
        else:
            decision_comment = require_text("comment")
            raw_evidence = p.get("review_evidence")
            if raw_evidence is not None:
                repair["review_evidence"] = validate_review_evidence(raw_evidence, row, user, db)
            row.status = "rework"; repair["decision"] = "rejected"; repair["decision_comment"] = decision_comment
        row.repairs = [*(row.repairs or [])[:-1], repair]
    elif action in ("reassign", "change_deadline"):
        require_role(user, "dispatcher")
        valid = {"reassign": ("assigned", "accepted", "in_progress", "rework"), "change_deadline": ("assigned", "accepted", "in_progress", "review", "rework")}[action]
        if row.status not in valid: raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Недопустимое изменение"})
        require_text("reason")
        if action == "reassign":
            target = p.get("contractor_id")
            if target not in ("c-1", "c-2"): raise HTTPException(422, detail={"code": "INVALID_CONTRACTOR", "message": "Выберите подрядчика"})
            row.contractor_id = target; row.status = "assigned"
        row.due_at = required_datetime("due_at")
    elif action == "cancel":
        require_role(user, "dispatcher"); require_text("reason")
        if row.status not in ("new", "needs_info", "assigned"): raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Отменить этот дефект нельзя"})
        row.status = "cancelled"
    elif action == "link_duplicate":
        require_role(user, "dispatcher")
        if row.status not in ("new", "needs_info"): raise HTTPException(409, detail={"code": "ILLEGAL_TRANSITION", "message": "Связать дубликат можно только до назначения"})
        target = db.get(DefectRow, p.get("target_id"))
        if not target or target.section_id != row.section_id or target.type != row.type or target.status in ("closed", "cancelled") or target.id == row.id: raise HTTPException(422, detail={"code": "INVALID_DUPLICATE", "message": "Выберите подходящий открытый дефект"})
        row.status = "cancelled"; row.duplicate_of_id = target.id
    else:
        raise HTTPException(422, detail={"code": "UNKNOWN_ACTION", "message": "Неизвестное действие"})
    row.version += 1
    after = audit_state(row, db)
    audit(row, action, user, comment, before, after)
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "Запись уже изменена. Обновите страницу"})
    db.refresh(row)
    return defect_data(row, db, True)


@app.get("/api/health")
def health():
    return {"ok": True, "database": "postgresql" if DATABASE_URL.startswith("postgres") else "sqlite", "demo": True}


@app.post("/api/routes/preview")
def create_route_preview(body: RoutePreviewBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "dispatcher")
    start, end = body.start.model_dump(), body.end.model_dump()
    if start == end:
        raise HTTPException(422, detail={"code": "IDENTICAL_POINTS", "message": "Начальная и конечная точки должны различаться"})
    try:
        provider_data = fetch_osrm_routes(start, end)
    except (httpx.TimeoutException, TimeoutError):
        raise HTTPException(503, detail={"code": "ROUTING_TIMEOUT", "message": "Сервис маршрутизации не ответил вовремя. Повторите запрос"})
    except httpx.HTTPError:
        raise HTTPException(503, detail={"code": "ROUTING_UNAVAILABLE", "message": "Сервис маршрутизации временно недоступен"})
    except (ValueError, json.JSONDecodeError):
        raise HTTPException(503, detail={"code": "INVALID_ROUTING_RESPONSE", "message": "Сервис маршрутизации вернул некорректный ответ"})
    try:
        snapped_start, snapped_end, options, decision_points = parse_osrm_preview(provider_data, start, end)
    except HTTPException:
        raise
    except (TypeError, ValueError, KeyError, AttributeError, OverflowError):
        raise HTTPException(503, detail={"code": "INVALID_ROUTING_RESPONSE", "message": "Сервис маршрутизации вернул некорректный ответ"})
    row = RoutePreviewRow(
        id=str(uuid.uuid4()), owner_id=user.id, expires_at=utcnow() + timedelta(minutes=60),
        start=snapped_start, end=snapped_end, options=options, decision_points=decision_points, provider="OSRM",
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "expires_at": iso(row.expires_at), "start": row.start, "end": row.end, "options": row.options, "decision_points": row.decision_points, "provider": row.provider}


@app.post("/api/routes")
def publish_route(body: RoutePublishBody, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "dispatcher")
    preview = db.scalar(select(RoutePreviewRow).where(RoutePreviewRow.id == body.preview_id).with_for_update())
    if not preview or preview.owner_id != user.id:
        raise HTTPException(404, detail={"code": "PREVIEW_NOT_FOUND", "message": "Предварительный маршрут не найден"})
    normalized_name = body.name.strip()
    normalized_notes = body.notes.strip()
    payload = {"name": normalized_name, "notes": normalized_notes, "inspector_id": body.inspector_id, "preview_id": body.preview_id, "option_id": body.option_id}
    payload_hash = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if preview.published_route_id:
        if preview.payload_hash == payload_hash:
            existing = db.get(RouteRow, preview.published_route_id)
            if existing:
                return route_data(existing, db)
        raise HTTPException(409, detail={"code": "PREVIEW_ALREADY_USED", "message": "Этот вариант уже опубликован с другими параметрами"})
    expires_at = preview.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= utcnow():
        raise HTTPException(410, detail={"code": "PREVIEW_EXPIRED", "message": "Предварительный маршрут истёк. Постройте его заново"})
    if not normalized_name:
        raise HTTPException(422, detail={"code": "NAME_REQUIRED", "message": "Укажите название маршрута"})
    inspector = db.get(UserRow, body.inspector_id)
    if not inspector or inspector.role != "inspector":
        raise HTTPException(422, detail={"code": "INVALID_INSPECTOR", "message": "Выберите инспектора"})
    options = preview.options or []
    option_id = body.option_id
    if not option_id:
        if len(options) > 1:
            raise HTTPException(422, detail={"code": "OPTION_REQUIRED", "message": "Выберите один из вариантов маршрута"})
        if len(options) == 1:
            option_id = options[0]["id"]
    option = next((item for item in options if item.get("id") == option_id), None)
    if not option:
        raise HTTPException(422, detail={"code": "OPTION_NOT_FOUND", "message": "Выбранный вариант отсутствует в предварительном маршруте"})

    codes = [code for code in db.scalars(select(RouteRow.code)).all() if code.startswith("R-") and code[2:].split("-", 1)[0].isdigit()]
    next_number = max([int(code[2:].split("-", 1)[0]) for code in codes], default=0) + 1
    # Keep route identifiers readable while avoiding a collision if two
    # dispatchers publish different previews at the same time.
    route_code = f"R-{next_number:02d}-{secrets.token_hex(2).upper()}"
    route = RouteRow(
        id=str(uuid.uuid4()), code=route_code, name=normalized_name, notes=normalized_notes,
        inspector_id=inspector.id, source="osrm", is_demo=False,
        start=preview.start, end=preview.end, geometry=option["geometry"],
        length_km=float(option["distance_m"]) / 1000.0, duration_s=float(option["duration_s"]),
        created_at=utcnow(), preview_id=preview.id,
    )
    preview.published_route_id = route.id
    preview.payload_hash = payload_hash
    db.add(route)
    try:
        db.commit()
    except IntegrityError:
        # The unique preview_id constraint is the final guard against a lost
        # publish race. Return the winner for an identical retry; reject a
        # different payload. The short random code suffix similarly prevents
        # concurrent route-number allocation from colliding.
        db.rollback()
        winner = db.get(RoutePreviewRow, body.preview_id)
        if winner and winner.owner_id == user.id and winner.published_route_id:
            if winner.payload_hash == payload_hash:
                existing = db.get(RouteRow, winner.published_route_id)
                if existing:
                    return route_data(existing, db)
            raise HTTPException(409, detail={"code": "PREVIEW_ALREADY_USED", "message": "Этот вариант уже опубликован с другими параметрами"})
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "Маршрут изменился одновременно. Повторите отправку"})
    db.refresh(route)
    return route_data(route, db)


@app.get("/api/routes")
def get_routes(user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    return [route_data(row, db) for row in routes_visible_to(user, db)]


@app.get("/api/routes/{route_id}/results")
def route_results(route_id: str, user: UserRow = Depends(current_user), db: Session = Depends(db_dep)):
    require_role(user, "dispatcher", "inspector")
    route = db.get(RouteRow, route_id)
    if not route or (user.role == "inspector" and route.inspector_id != user.id):
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Маршрут не найден"})
    inspection_rows = db.scalars(select(InspectionRow).where(InspectionRow.section_id == route_id).order_by(InspectionRow.started_at.desc())).all()
    defect_rows = db.scalars(select(DefectRow).where(DefectRow.section_id == route_id).order_by(DefectRow.received_at.desc())).all()
    return {
        "route": route_data(route, db),
        "inspections": [inspection_data(row) for row in inspection_rows],
        "defects": [defect_data(row, db, True) for row in defect_rows],
    }


@app.get("/{requested_path:path}", include_in_schema=False)
def frontend_fallback(requested_path: str, request: Request):
    """Serve a built SPA when available, while keeping API misses JSON-only."""
    if requested_path == "api" or requested_path.startswith("api/"):
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "API route not found"})
    dist = (ROOT.parent / "frontend" / "dist").resolve()
    if not dist.is_dir():
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Frontend build not found"})
    candidate = (dist / requested_path).resolve() if requested_path else dist / "index.html"
    try:
        candidate.relative_to(dist)
    except ValueError:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "File not found"})
    if candidate.is_file():
        return FileResponse(candidate)
    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index, media_type="text/html")
    raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Frontend page not found"})
