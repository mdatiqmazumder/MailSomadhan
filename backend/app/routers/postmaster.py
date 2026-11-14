"""postmaster@ for every domain (RFC 5321 requires it; DMARC reports and bounces go there).

Each domain gets a real postmaster@ mailbox. Administrators read it right in the admin panel through
Dovecot's master login (no password to share), and can also give it a password to use it in the
webmail or an email app, or forward it elsewhere. Reading a message is written to the audit log.
"""
import re
import secrets
from urllib.parse import quote as urlquote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AdminCtx, client_ip, get_admin_ctx, require_perm
from ..imap_client import MailError, MailSession
from ..models import Alias, AuditLog, Domain, Mailbox, Setting
from ..quota import UNLIMITED, check_mailbox_quota, smallest
from ..security import check_password_rules, hash_password
from ..system import get_setting
from .profile import clean_forwards

router = APIRouter()
PERM = "postmaster.manage"
LOCAL = "postmaster"
AUTO_SETTING = "postmaster_auto"
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}


def auto_enabled(db: Session) -> bool:
    return get_setting(db, AUTO_SETTING) != "0"


def ensure_postmaster(db: Session, domain: Domain) -> Mailbox:
    """Create postmaster@domain as a mailbox. It starts with a random password nobody knows: the admin
    panel reads it through the master login, and an administrator can set a real password later."""
    email = f"{LOCAL}@{domain.name}"
    box = db.query(Mailbox).filter_by(email=email).first()
    if box:
        return box
    if db.query(Alias).filter_by(source=email).first():
        raise HTTPException(409, f"{email} is an alias. Delete the alias first to make it a mailbox.")
    quota = smallest(1024, domain.default_quota_mb if domain.default_quota_mb != UNLIMITED else 1024)
    check_mailbox_quota(db, domain, quota)
    box = Mailbox(domain_id=domain.id, local_part=LOCAL, email=email, display_name="Postmaster",
                  password_hash=hash_password(secrets.token_urlsafe(32)), quota_mb=quota)
    db.add(box)
    db.commit()
    return box


def _status(db: Session, domain: Domain) -> dict:
    email = f"{LOCAL}@{domain.name}"
    box = db.query(Mailbox).filter_by(email=email).first()
    alias = None if box else db.query(Alias).filter_by(source=email).first()
    out = {"domain_id": domain.id, "domain": domain.name, "email": email,
           "status": "mailbox" if box else "alias" if alias else "missing"}
    if box:
        out.update({"mailbox_id": box.id, "active": box.active, "quota_mb": box.quota_mb,
                    "forward_to": box.forward_to, "forward_keep": box.forward_keep})
    if alias:
        out["alias_to"] = alias.destination
    return out


def _domains(db: Session, ctx: AdminCtx) -> list[Domain]:
    q = db.query(Domain).order_by(Domain.name)
    if ctx.domain_ids is not None:
        q = q.filter(Domain.id.in_(ctx.domain_ids or [-1]))
    return q.all()


def _domain(db: Session, ctx: AdminCtx, domain_id: int) -> Domain:
    domain = db.get(Domain, domain_id)
    if not domain or not ctx.can_domain(domain_id):
        raise HTTPException(404, "Domain not found")
    return domain


def _box(db: Session, ctx: AdminCtx, domain_id: int) -> Mailbox:
    domain = _domain(db, ctx, domain_id)
    box = db.query(Mailbox).filter_by(email=f"{LOCAL}@{domain.name}").first()
    if not box:
        raise HTTPException(404, f"postmaster@{domain.name} is not set up yet")
    return box


# ---------------------------------------------------------------- setup
@router.get("/postmaster")
def overview(db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    return {"auto": auto_enabled(db), "can_change_auto": ctx.is_super,
            "domains": [_status(db, d) for d in _domains(db, ctx)]}


@router.post("/postmaster/{domain_id}")
def create(domain_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    domain = _domain(db, ctx, domain_id)
    ensure_postmaster(db, domain)
    return _status(db, domain)


@router.post("/postmaster-all")
def create_all(db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    created, failed = [], []
    for domain in _domains(db, ctx):
        if _status(db, domain)["status"] != "missing":
            continue
        try:
            ensure_postmaster(db, domain)
            created.append(domain.name)
        except HTTPException as exc:
            db.rollback()
            failed.append(f"{domain.name}: {exc.detail}")
    return {"created": created, "failed": failed, **overview(db, ctx)}


class AutoIn(BaseModel):
    enabled: bool


@router.put("/postmaster-auto")
def set_auto(body: AutoIn, db: Session = Depends(get_db), ctx: AdminCtx = Depends(get_admin_ctx)):
    if not ctx.is_super:
        raise HTTPException(403, "Only super administrators can change this")
    row = db.get(Setting, AUTO_SETTING)
    value = "1" if body.enabled else "0"
    if row:
        row.value = value
    else:
        db.add(Setting(key=AUTO_SETTING, value=value))
    db.commit()
    return {"auto": body.enabled}


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


@router.put("/postmaster/{domain_id}/password")
def set_password(domain_id: int, body: PasswordIn, db: Session = Depends(get_db),
                 ctx: AdminCtx = Depends(require_perm(PERM))):
    box = _box(db, ctx, domain_id)
    problem = check_password_rules(body.password)
    if problem:
        raise HTTPException(400, problem)
    box.password_hash = hash_password(body.password)
    box.token_version += 1  # sign out sessions that used the old password
    db.commit()
    return {"ok": True}


class ForwardIn(BaseModel):
    forward_to: str = Field(default="", max_length=2000)
    forward_keep: bool = True


@router.put("/postmaster/{domain_id}/forward")
def set_forward(domain_id: int, body: ForwardIn, db: Session = Depends(get_db),
                ctx: AdminCtx = Depends(require_perm(PERM))):
    box = _box(db, ctx, domain_id)
    box.forward_to = clean_forwards(body.forward_to, box.email)
    box.forward_keep = body.forward_keep if box.forward_to else True
    db.commit()
    return _status(db, box.domain)


# ---------------------------------------------------------------- reading the mailbox in the panel
def _session(box: Mailbox) -> MailSession:
    try:
        return MailSession(box.email)
    except MailError as exc:
        raise HTTPException(502, str(exc)) from exc


def _audit(db: Session, request: Request, ctx: AdminCtx, what: str) -> None:
    db.add(AuditLog(actor=ctx.admin.username, actor_kind="admin", ip=client_ip(request), method="READ",
                    path=request.url.path[:300], status=200, details=what[:4000]))
    db.commit()


@router.get("/postmaster/{domain_id}/folders")
def folders(domain_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    with _session(_box(db, ctx, domain_id)) as s:
        try:
            return {"folders": s.folders(), "quota": s.quota()}
        except MailError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.get("/postmaster/{domain_id}/messages")
def messages(domain_id: int, folder: str = "INBOX", page: int = 1, size: int = 40, q: str = "",
             db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    with _session(_box(db, ctx, domain_id)) as s:
        try:
            return s.list_messages(folder, max(page, 1), min(max(size, 1), 100), q.strip()[:200])
        except MailError as exc:
            raise HTTPException(400, str(exc)) from exc


@router.get("/postmaster/{domain_id}/message")
def message(domain_id: int, folder: str, uid: int, request: Request, db: Session = Depends(get_db),
            ctx: AdminCtx = Depends(require_perm(PERM))):
    box = _box(db, ctx, domain_id)
    with _session(box) as s:
        try:
            msg = s.get_message(folder, uid)
        except MailError as exc:
            raise HTTPException(400, str(exc)) from exc
    _audit(db, request, ctx, f'Read {box.email} {folder}/{uid}: "{msg.get("subject", "")}"')
    return msg


@router.get("/postmaster/{domain_id}/attachment")
def attachment(domain_id: int, folder: str, uid: int, index: int, request: Request, db: Session = Depends(get_db),
               ctx: AdminCtx = Depends(require_perm(PERM))):
    box = _box(db, ctx, domain_id)
    with _session(box) as s:
        try:
            filename, content_type, data = s.get_attachment(folder, uid, index)
        except MailError as exc:
            raise HTTPException(400, str(exc)) from exc
    _audit(db, request, ctx, f"Downloaded attachment {index} of {box.email} {folder}/{uid}")
    inline = content_type in INLINE_TYPES
    safe_name = re.sub(r'[\r\n"\\/]', "_", filename)[:200]
    return Response(content=data, media_type=content_type if inline else "application/octet-stream", headers={
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{urlquote(safe_name)}",
        "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff"})


class ActionIn(BaseModel):
    folder: str
    uids: list[int] = Field(min_length=1, max_length=500)
    action: str  # read | unread | delete


@router.post("/postmaster/{domain_id}/action")
def action(domain_id: int, body: ActionIn, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm(PERM))):
    with _session(_box(db, ctx, domain_id)) as s:
        try:
            if body.action in ("read", "unread"):
                s.set_flags(body.folder, body.uids, "\\Seen", body.action == "read")
            elif body.action == "delete":
                trash = s.folder_by_role("trash", "Trash")
                if body.folder == trash:
                    s.delete_forever(body.folder, body.uids)
                else:
                    s.move(body.folder, body.uids, trash)
            else:
                raise HTTPException(400, "Unknown action")
        except MailError as exc:
            raise HTTPException(400, str(exc)) from exc
    return {"ok": True}
