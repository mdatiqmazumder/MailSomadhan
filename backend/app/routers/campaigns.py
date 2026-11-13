"""Individual sending (campaigns): webmail users create them, admins oversee them,
recipients can unsubscribe through a public link."""
import json
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..campaigns import read_unsubscribe_token, recipient_fields, render, used_fields
from ..config import settings
from ..db import get_db
from ..deps import AdminCtx, require_perm, require_user
from ..models import Campaign, CampaignRecipient, Domain, Mailbox, Suppression
from ..security import EMAIL_RE
from ..system import get_setting

user_router = APIRouter()
admin_router = APIRouter()  # every endpoint checks campaigns.manage and the domain scope
public_router = APIRouter()

MODES = {"instant", "fixed", "random"}
STATUSES = ("pending", "sent", "delivered", "bounced", "failed", "skipped", "unsubscribed")


def now() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def int_setting(db: Session, key: str, default: int) -> int:
    try:
        return int(get_setting(db, key))
    except (TypeError, ValueError):
        return default


def limits(db: Session, mailbox_id: int) -> dict:
    used = db.execute(select(func.count(CampaignRecipient.id)).join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
                      .where(Campaign.mailbox_id == mailbox_id, CampaignRecipient.sent_at >= now() - timedelta(hours=24))).scalar_one()
    return {
        "daily_limit": int_setting(db, "campaign_daily_limit", 150),
        "used_24h": int(used),
        "max_recipients": int_setting(db, "campaign_max_recipients", 1000),
        "domain_hourly_limit": int_setting(db, "campaign_domain_hourly_limit", 20),
        "approval_over": int_setting(db, "campaign_approval_over", 0),
        "max_attachment_mb": int_setting(db, "max_attachment_mb", 25),
    }


def counts(db: Session, campaign_ids: list[int]) -> dict[int, dict[str, int]]:
    out: dict[int, dict[str, int]] = {cid: {s: 0 for s in STATUSES} for cid in campaign_ids}
    if campaign_ids:
        for cid, status, n in db.execute(select(CampaignRecipient.campaign_id, CampaignRecipient.status, func.count())
                                         .where(CampaignRecipient.campaign_id.in_(campaign_ids))
                                         .group_by(CampaignRecipient.campaign_id, CampaignRecipient.status)):
            out[cid][status] = int(n)
    return out


def campaign_out(c: Campaign, cnt: dict[str, int], owner: bool = False) -> dict:
    data = {
        "id": c.id, "name": c.name, "subject": c.subject, "status": c.status, "mode": c.mode,
        "interval_seconds": c.interval_seconds, "random_min_seconds": c.random_min_seconds,
        "random_max_seconds": c.random_max_seconds, "unsubscribe": c.unsubscribe, "total": c.total,
        "start_at": c.start_at.isoformat(), "next_send_at": c.next_send_at.isoformat(),
        "waiting_reason": c.waiting_reason, "created_at": c.created_at.isoformat(),
        "finished_at": c.finished_at.isoformat() if c.finished_at else None,
        "attachments": [{"name": a["name"], "size": a["size"]} for a in json.loads(c.attachments or "[]")],
        "counts": cnt,
    }
    if owner:
        data["owner"] = c.mailbox.email if c.mailbox else ""
    return data


def recipient_out(r: CampaignRecipient) -> dict:
    return {"id": r.id, "email": r.email, "fields": json.loads(r.fields or "{}"), "status": r.status,
            "sent_at": r.sent_at.isoformat() if r.sent_at else None, "error": r.error}


def change_state(db: Session, c: Campaign, action: str, admin: bool = False) -> None:
    if action == "pause" and c.status in ("scheduled", "running", "pending_approval"):
        c.status = "paused"
    elif action == "resume" and c.status == "paused":
        c.status = "running" if aware(c.start_at) <= now() else "scheduled"
        c.next_send_at, c.waiting_reason = max(now(), aware(c.start_at)), ""
    elif action == "approve" and admin and c.status == "pending_approval":
        c.status = "scheduled"
        c.next_send_at, c.waiting_reason = max(now(), aware(c.start_at)), ""
    elif action == "cancel" and c.status not in ("completed", "cancelled"):
        c.status, c.finished_at, c.waiting_reason = "cancelled", now(), ""
        db.query(CampaignRecipient).filter(CampaignRecipient.campaign_id == c.id, CampaignRecipient.status == "pending") \
            .update({CampaignRecipient.status: "skipped", CampaignRecipient.error: "Campaign cancelled"})
    else:
        raise HTTPException(400, f"Cannot {action} a campaign that is {c.status.replace('_', ' ')}")
    db.commit()


# ================================================================ user (webmail)
class RecipientIn(BaseModel):
    email: str = Field(max_length=320)
    fields: dict[str, str] = {}


class PreviewIn(BaseModel):
    subject: str = Field(max_length=900)
    html: str = Field(max_length=500_000)
    unsubscribe: bool = True
    recipients: list[RecipientIn] = Field(default=[], max_length=10_000)


def require_campaigns(user: Mailbox = Depends(require_user)) -> Mailbox:
    if not user.can_campaign:
        raise HTTPException(403, "Campaigns are not enabled for your mailbox. Ask your administrator.")
    return user


@user_router.get("/campaigns/limits")
def get_limits(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    return limits(db, user.id)


def check_recipients(db: Session, user: Mailbox, recipients: list[RecipientIn]) -> tuple[list[RecipientIn], list[str], list[str], int]:
    seen, valid, invalid, duplicates = set(), [], [], []
    for r in recipients:
        email = r.email.strip().lower()
        if not EMAIL_RE.match(email):
            invalid.append(r.email[:100])
            continue
        if email in seen:
            duplicates.append(email)
            continue
        seen.add(email)
        valid.append(RecipientIn(email=email, fields={k[:40]: str(v)[:500] for k, v in list(r.fields.items())[:30]}))
    suppressed = 0
    if valid:
        sup = {e for (e,) in db.execute(select(Suppression.email).where(Suppression.domain_id == user.domain_id,
                                                                         Suppression.email.in_([v.email for v in valid])))}
        suppressed = len(sup)
    return valid, invalid, duplicates, suppressed


@user_router.post("/campaigns/preview")
def preview(body: PreviewIn, user: Mailbox = Depends(require_campaigns), db: Session = Depends(get_db)):
    valid, invalid, duplicates, suppressed = check_recipients(db, user, body.recipients)
    sample = valid[0] if valid else RecipientIn(email="recipient@example.com", fields={"name": "Sample Recipient", "company": "Example Ltd"})
    fields = recipient_fields(sample.email, sample.fields)
    html = render(body.html, fields, escape=True)
    needed = used_fields(body.subject, body.html) - {"email"}
    missing = {f: sum(1 for v in valid if not recipient_fields(v.email, v.fields).get(f)) for f in needed}
    return {
        "subject": render(body.subject, fields, escape=False),
        "html": html + (f'<p style="margin-top:24px;font-size:12px;color:#888">If you would rather not receive emails like this, <a href="#">unsubscribe here</a>.</p>' if body.unsubscribe else ""),
        "to": sample.email,
        "valid": len(valid), "invalid": invalid[:50], "invalid_count": len(invalid),
        "duplicates": len(duplicates), "suppressed": suppressed,
        "missing_fields": {k: v for k, v in missing.items() if v},
        "limits": limits(db, user.id),
    }


@user_router.post("/campaigns")
async def create_campaign(data: str = Form(...), files: list[UploadFile] = File(default=[]),
                          user: Mailbox = Depends(require_campaigns), db: Session = Depends(get_db)):
    try:
        raw = json.loads(data)
    except ValueError as exc:
        raise HTTPException(400, "Invalid request") from exc
    name = str(raw.get("name") or "")[:200].strip()
    subject = str(raw.get("subject") or "").strip()
    html = str(raw.get("html") or "")
    mode = raw.get("mode", "fixed")
    if not subject:
        raise HTTPException(400, "Add a subject")
    if not re.sub(r"<[^>]+>|&nbsp;|\s", "", html):
        raise HTTPException(400, "Write a message")
    if mode not in MODES:
        raise HTTPException(400, "Unknown sending mode")
    try:
        interval = int(raw.get("interval_seconds", 60))
        rmin, rmax = int(raw.get("random_min_seconds", 60)), int(raw.get("random_max_seconds", 300))
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Invalid timing") from exc
    if mode == "fixed" and not 10 <= interval <= 86400:
        raise HTTPException(400, "The interval must be between 10 seconds and 24 hours")
    if mode == "random" and not (10 <= rmin <= rmax <= 86400):
        raise HTTPException(400, "The random range must be between 10 seconds and 24 hours, minimum first")
    start_at = now()
    if raw.get("start_at"):
        try:
            start_at = datetime.fromisoformat(str(raw["start_at"]).replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(400, "Invalid start time") from exc
        if start_at.tzinfo is None:
            start_at = start_at.replace(tzinfo=timezone.utc)
        if start_at > now() + timedelta(days=60):
            raise HTTPException(400, "The start time can be at most 60 days ahead")
        start_at = max(start_at, now())

    recipients = [RecipientIn(**r) for r in raw.get("recipients", [])[:20000]]
    valid, _invalid, _dup, _sup = check_recipients(db, user, recipients)
    lim = limits(db, user.id)
    if not valid:
        raise HTTPException(400, "Add at least one valid recipient")
    if len(valid) > lim["max_recipients"]:
        raise HTTPException(400, f"A campaign can have at most {lim['max_recipients']} recipients")

    status = "pending_approval" if lim["approval_over"] and len(valid) > lim["approval_over"] else "scheduled"
    c = Campaign(mailbox_id=user.id, name=name or subject[:200], subject=subject, html=html, mode=mode,
                 interval_seconds=interval, random_min_seconds=rmin, random_max_seconds=rmax,
                 unsubscribe=bool(raw.get("unsubscribe", True)), status=status, start_at=start_at,
                 next_send_at=start_at, total=len(valid),
                 waiting_reason="Waiting for administrator approval" if status == "pending_approval" else "")
    db.add(c)
    db.flush()

    # attachments are stored once and attached to every message
    max_bytes = lim["max_attachment_mb"] * 1024 * 1024
    folder = Path(settings.state_dir) / "campaigns" / str(c.id)
    stored, total = [], 0
    try:
        for i, f in enumerate(files):
            content = await f.read()
            total += len(content)
            if total > max_bytes:
                raise HTTPException(413, f"Attachments exceed the {lim['max_attachment_mb']} MB limit")
            folder.mkdir(parents=True, exist_ok=True)
            safe = re.sub(r"[^\w.\- ]+", "_", f.filename or f"file{i}")[:120]
            path = folder / f"{i}-{safe}"
            path.write_bytes(content)
            stored.append({"name": (f.filename or safe)[:200], "type": f.content_type or "", "size": len(content), "path": str(path)})
    except HTTPException:
        db.rollback()
        shutil.rmtree(folder, ignore_errors=True)
        raise
    c.attachments = json.dumps(stored)
    db.add_all(CampaignRecipient(campaign_id=c.id, position=i, email=r.email, fields=json.dumps(r.fields))
               for i, r in enumerate(valid))
    db.commit()
    return campaign_out(c, counts(db, [c.id])[c.id])


@user_router.get("/campaigns")
def list_campaigns(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    items = db.execute(select(Campaign).where(Campaign.mailbox_id == user.id).order_by(Campaign.id.desc()).limit(200)).scalars().all()
    cnt = counts(db, [c.id for c in items])
    return {"items": [campaign_out(c, cnt[c.id]) for c in items], "limits": limits(db, user.id)}


def own(db: Session, user: Mailbox, campaign_id: int) -> Campaign:
    c = db.get(Campaign, campaign_id)
    if not c or c.mailbox_id != user.id:
        raise HTTPException(404, "Campaign not found")
    return c


@user_router.get("/campaigns/{campaign_id}")
def get_campaign(campaign_id: int, status: str = "", page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
                 user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    c = own(db, user, campaign_id)
    return campaign_detail(db, c, status, page, size)


def campaign_detail(db: Session, c: Campaign, status: str, page: int, size: int, owner: bool = False) -> dict:
    q = select(CampaignRecipient).where(CampaignRecipient.campaign_id == c.id)
    if status in STATUSES:
        q = q.where(CampaignRecipient.status == status)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    rows = db.execute(q.order_by(CampaignRecipient.position).offset((page - 1) * size).limit(size)).scalars().all()
    return {**campaign_out(c, counts(db, [c.id])[c.id], owner), "html": c.html,
            "recipients": {"total": total, "page": page, "size": size, "items": [recipient_out(r) for r in rows]}}


@user_router.post("/campaigns/{campaign_id}/{action}")
def campaign_action(campaign_id: int, action: str, user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    if action not in ("pause", "resume", "cancel"):
        raise HTTPException(404, "Unknown action")
    c = own(db, user, campaign_id)
    if action == "resume" and not user.can_campaign:
        raise HTTPException(403, "Campaigns are not enabled for your mailbox. Ask your administrator.")
    change_state(db, c, action)
    return campaign_out(c, counts(db, [c.id])[c.id])


# ================================================================ admin
CAMPAIGNS = require_perm("campaigns.manage")


def scoped_campaign(db: Session, ctx: AdminCtx, campaign_id: int) -> Campaign:
    c = db.get(Campaign, campaign_id)
    if not c or not c.mailbox or not ctx.can_domain(c.mailbox.domain_id):
        raise HTTPException(404, "Campaign not found")
    return c


@admin_router.get("/campaigns")
def admin_campaigns(status: str = "", db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    q = select(Campaign).order_by(Campaign.id.desc()).limit(500)
    if ctx.domain_ids is not None:
        q = q.join(Mailbox, Mailbox.id == Campaign.mailbox_id).where(Mailbox.domain_id.in_(ctx.domain_ids or [-1]))
    if status:
        q = q.where(Campaign.status == status)
    items = db.execute(q).scalars().all()
    cnt = counts(db, [c.id for c in items])
    return {"items": [campaign_out(c, cnt[c.id], owner=True) for c in items]}


@admin_router.get("/campaigns/{campaign_id}")
def admin_campaign(campaign_id: int, status: str = "", page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
                   db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    c = scoped_campaign(db, ctx, campaign_id)
    return campaign_detail(db, c, status, page, size, owner=True)


@admin_router.post("/campaigns/{campaign_id}/{action}")
def admin_campaign_action(campaign_id: int, action: str, db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    if action not in ("approve", "pause", "resume", "cancel"):
        raise HTTPException(404, "Unknown action")
    c = scoped_campaign(db, ctx, campaign_id)
    change_state(db, c, action, admin=True)
    return campaign_out(c, counts(db, [c.id])[c.id], owner=True)


class SuppressionIn(BaseModel):
    domain_id: int
    emails: str = Field(max_length=200_000)
    note: str = Field(default="", max_length=300)


@admin_router.get("/suppressions")
def list_suppressions(q: str = "", reason: str = "", page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
                      db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    query = select(Suppression, Domain.name).join(Domain, Domain.id == Suppression.domain_id)
    if ctx.domain_ids is not None:
        query = query.where(Suppression.domain_id.in_(ctx.domain_ids or [-1]))
    if q:
        query = query.where(Suppression.email.like(f"%{q.strip().lower()}%"))
    if reason:
        query = query.where(Suppression.reason == reason)
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar_one()
    rows = db.execute(query.order_by(Suppression.id.desc()).offset((page - 1) * size).limit(size)).all()
    return {"total": total, "items": [{"id": s.id, "email": s.email, "domain": d, "reason": s.reason, "note": s.note,
                                       "created_at": s.created_at.isoformat()} for s, d in rows]}


@admin_router.post("/suppressions")
def add_suppressions(body: SuppressionIn, db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    if not db.get(Domain, body.domain_id) or not ctx.can_domain(body.domain_id):
        raise HTTPException(400, "Domain not found")
    added, skipped = 0, []
    for raw in re.split(r"[\s,;]+", body.emails):
        email = raw.strip().lower()
        if not email:
            continue
        if not EMAIL_RE.match(email):
            skipped.append(raw[:100])
            continue
        if db.query(Suppression).filter_by(domain_id=body.domain_id, email=email).first():
            continue
        db.add(Suppression(domain_id=body.domain_id, email=email, reason="manual", note=body.note))
        added += 1
    db.commit()
    return {"added": added, "skipped": skipped}


@admin_router.delete("/suppressions/{sid}")
def delete_suppression(sid: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(CAMPAIGNS)):
    s = db.get(Suppression, sid)
    if not s or not ctx.can_domain(s.domain_id):
        raise HTTPException(404, "Not found")
    db.delete(s)
    db.commit()
    return {"ok": True}


# ================================================================ public unsubscribe
def unsubscribe_target(db: Session, token: str) -> tuple[CampaignRecipient, Campaign, Mailbox]:
    rid = read_unsubscribe_token(token)
    r = db.get(CampaignRecipient, rid) if rid else None
    c = db.get(Campaign, r.campaign_id) if r else None
    box = db.get(Mailbox, c.mailbox_id) if c else None
    if not (r and c and box):
        raise HTTPException(404, "This unsubscribe link is not valid")
    return r, c, box


@public_router.get("/public/unsubscribe/{token}")
def unsubscribe_info(token: str, db: Session = Depends(get_db)):
    r, _c, box = unsubscribe_target(db, token)
    done = db.query(Suppression).filter_by(domain_id=box.domain_id, email=r.email).first() is not None
    return {"email": r.email, "sender": box.domain.name, "unsubscribed": done}


@public_router.post("/public/unsubscribe/{token}")
def unsubscribe(token: str, db: Session = Depends(get_db)):
    """Works both from the landing page and as RFC 8058 one-click (POST from the mail provider)."""
    r, _c, box = unsubscribe_target(db, token)
    if not db.query(Suppression).filter_by(domain_id=box.domain_id, email=r.email).first():
        db.add(Suppression(domain_id=box.domain_id, email=r.email, reason="unsubscribed", note=f"campaign {r.campaign_id}"))
    # Also drop the address from campaigns of the same domain that are still sending.
    same_domain = select(Campaign.id).join(Mailbox, Mailbox.id == Campaign.mailbox_id).where(Mailbox.domain_id == box.domain_id)
    db.query(CampaignRecipient).filter(CampaignRecipient.email == r.email, CampaignRecipient.status == "pending",
                                       CampaignRecipient.campaign_id.in_(same_domain)) \
        .update({CampaignRecipient.status: "unsubscribed", CampaignRecipient.error: "Unsubscribed"}, synchronize_session=False)
    db.commit()
    return {"email": r.email, "sender": box.domain.name, "unsubscribed": True}
