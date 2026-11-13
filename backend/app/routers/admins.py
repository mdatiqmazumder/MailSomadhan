"""Console accounts and the audit log (super administrators only)."""
import json
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import PERMISSIONS, require_admin
from ..models import Admin, AdminDomain, AuditLog, Domain
from ..security import check_password_rules, hash_password

router = APIRouter(dependencies=[Depends(require_admin)])

USERNAME_RE = re.compile(r"^[a-z][a-z0-9._-]{2,63}$")
ROLES = {"super_admin", "admin"}

# Ready-made permission sets offered in the console.
TEMPLATES = {
    "domain_admin": {"label": "Domain administrator", "permissions": sorted(PERMISSIONS)},
    "user_manager": {"label": "User manager", "permissions": ["domains.view", "mailboxes.view", "mailboxes.create", "mailboxes.edit", "mailboxes.password"]},
    "helpdesk": {"label": "Help desk", "permissions": ["mailboxes.view", "mailboxes.password"]},
    "auditor": {"label": "Read-only auditor", "permissions": ["domains.view", "mailboxes.view", "analytics.view"]},
}


def admin_out(db: Session, a: Admin) -> dict:
    domains = [{"id": d.id, "name": d.name} for d in db.query(Domain).join(AdminDomain, AdminDomain.domain_id == Domain.id)
               .filter(AdminDomain.admin_id == a.id).order_by(Domain.name)]
    try:
        perms = json.loads(a.permissions or "[]")
    except ValueError:
        perms = []
    return {
        "id": a.id, "username": a.username, "email": a.email, "role": a.role, "active": a.active,
        "permissions": perms if a.role != "super_admin" else sorted(PERMISSIONS),
        "domains": domains if a.role != "super_admin" else None,
        "totp_enabled": a.totp_enabled, "last_login": a.last_login.isoformat() if a.last_login else None,
        "created_at": a.created_at.isoformat(),
    }


def active_supers(db: Session, exclude: int | None = None) -> int:
    q = db.query(Admin).filter(Admin.role == "super_admin", Admin.active.is_(True))
    if exclude:
        q = q.filter(Admin.id != exclude)
    return q.count()


@router.get("/admins")
def list_admins(db: Session = Depends(get_db)):
    return {
        "items": [admin_out(db, a) for a in db.query(Admin).order_by(Admin.role.desc(), Admin.username)],
        "permissions": PERMISSIONS,
        "templates": TEMPLATES,
    }


class AdminIn(BaseModel):
    username: str = Field(max_length=64)
    email: str = Field(default="", max_length=320)
    password: str = Field(max_length=200)
    role: str = "admin"
    permissions: list[str] = []
    domain_ids: list[int] = []


class AdminPatch(BaseModel):
    email: str | None = Field(default=None, max_length=320)
    password: str | None = Field(default=None, max_length=200)
    role: str | None = None
    permissions: list[str] | None = None
    domain_ids: list[int] | None = None
    active: bool | None = None
    reset_2fa: bool = False


def clean_permissions(perms: list[str]) -> str:
    unknown = [p for p in perms if p not in PERMISSIONS]
    if unknown:
        raise HTTPException(400, f"Unknown permission: {unknown[0]}")
    return json.dumps(sorted(set(perms)))


def set_domains(db: Session, admin: Admin, domain_ids: list[int]) -> None:
    ids = set(domain_ids)
    if ids and db.query(Domain).filter(Domain.id.in_(ids)).count() != len(ids):
        raise HTTPException(400, "Unknown domain")
    db.query(AdminDomain).filter(AdminDomain.admin_id == admin.id).delete()
    db.add_all(AdminDomain(admin_id=admin.id, domain_id=d) for d in ids)


@router.post("/admins")
def create_admin(body: AdminIn, db: Session = Depends(get_db)):
    username = body.username.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Usernames are 3–64 characters: letters, digits, dot, dash or underscore, starting with a letter")
    if "@" in username or db.query(Admin).filter_by(username=username).first():
        raise HTTPException(409, "This username is taken")
    if body.role not in ROLES:
        raise HTTPException(400, "Unknown role")
    problem = check_password_rules(body.password, admin=True)
    if problem:
        raise HTTPException(400, problem)
    if body.role == "admin" and not body.domain_ids:
        raise HTTPException(400, "Choose at least one domain for a limited administrator")
    if body.role == "admin" and not body.permissions:
        raise HTTPException(400, "Choose at least one permission")
    a = Admin(username=username, email=body.email.strip(), password_hash=hash_password(body.password), role=body.role,
              permissions=clean_permissions(body.permissions) if body.role == "admin" else "[]")
    db.add(a)
    db.flush()
    if body.role == "admin":
        set_domains(db, a, body.domain_ids)
    db.commit()
    return admin_out(db, a)


@router.patch("/admins/{admin_id}")
def update_admin(admin_id: int, body: AdminPatch, me: Admin = Depends(require_admin), db: Session = Depends(get_db)):
    a = db.get(Admin, admin_id)
    if not a:
        raise HTTPException(404, "Account not found")
    self_edit = a.id == me.id
    if self_edit and (body.role not in (None, a.role) or body.active is False):
        raise HTTPException(400, "You cannot change your own role or disable yourself")
    demoting = a.role == "super_admin" and ((body.role and body.role != "super_admin") or body.active is False)
    if demoting and active_supers(db, exclude=a.id) == 0:
        raise HTTPException(400, "There must always be at least one active super administrator")
    if body.role is not None:
        if body.role not in ROLES:
            raise HTTPException(400, "Unknown role")
        a.role = body.role
    if body.email is not None:
        a.email = body.email.strip()
    if body.permissions is not None:
        a.permissions = clean_permissions(body.permissions)
    if body.domain_ids is not None:
        set_domains(db, a, body.domain_ids)
    if a.role == "admin":
        has_domains = db.query(AdminDomain).filter(AdminDomain.admin_id == a.id).count() > 0 if body.domain_ids is None else bool(body.domain_ids)
        if not has_domains:
            raise HTTPException(400, "A limited administrator needs at least one domain")
    if body.password:
        problem = check_password_rules(body.password, admin=True)
        if problem:
            raise HTTPException(400, problem)
        a.password_hash = hash_password(body.password)
        a.token_version += 1
    if body.active is not None:
        a.active = body.active
        if not body.active:
            a.token_version += 1
    if body.reset_2fa:
        a.totp_secret, a.totp_pending, a.totp_enabled = "", "", False
        a.token_version += 1
    if body.role is not None or body.permissions is not None or body.domain_ids is not None:
        a.token_version += 1  # new rights take effect on next sign-in; old sessions end now
    db.commit()
    return admin_out(db, a)


@router.delete("/admins/{admin_id}")
def delete_admin(admin_id: int, me: Admin = Depends(require_admin), db: Session = Depends(get_db)):
    a = db.get(Admin, admin_id)
    if not a:
        raise HTTPException(404, "Account not found")
    if a.id == me.id:
        raise HTTPException(400, "You cannot delete your own account")
    if a.role == "super_admin" and active_supers(db, exclude=a.id) == 0:
        raise HTTPException(400, "There must always be at least one active super administrator")
    db.delete(a)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- audit log
@router.get("/audit")
def audit_log(q: str = "", actor: str = "", days: int = Query(30, ge=1, le=3650), page: int = Query(1, ge=1),
              size: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    query = db.query(AuditLog).filter(AuditLog.at >= datetime.now(timezone.utc) - timedelta(days=days))
    if actor:
        query = query.filter(AuditLog.actor == actor)
    if q:
        like = f"%{q}%"
        query = query.filter(or_(AuditLog.path.ilike(like), AuditLog.details.ilike(like), AuditLog.ip == q.strip()))
    total = query.count()
    rows = query.order_by(AuditLog.id.desc()).offset((page - 1) * size).limit(size).all()
    return {"total": total, "items": [{"id": r.id, "at": r.at.isoformat(), "actor": r.actor, "kind": r.actor_kind, "ip": r.ip,
                                       "method": r.method, "path": r.path, "status": r.status, "details": r.details} for r in rows]}
