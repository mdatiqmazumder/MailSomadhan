"""Campaign worker: sends campaign messages one at a time, at the pace each campaign asks for.

Rules applied before every message:
  * the recipient is not on the sending domain's suppression list (unsubscribed or bounced),
  * the sender stays under the daily limit (rolling 24 hours, all of their campaigns),
  * the sender stays under the hourly limit per recipient domain (e.g. at most 20 to gmail.com).
When a limit is reached the campaign waits and resumes automatically.

Run as:  python -m app.campaign_worker      (systemd unit mailsomadhan-campaigns)
"""
import json
import random
import smtplib
import sys
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from .campaigns import build_message, load_attachments, recipient_fields, render, unsubscribe_url
from .config import settings
from .db import Base, SessionLocal, create_tables, engine
from .models import Campaign, CampaignRecipient, Mailbox, MailMessage, Suppression
from .system import get_setting

INSTANT_GAP = 1.0  # seconds between messages in "instant" mode, to be gentle with receivers


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def int_setting(db, key: str, default: int) -> int:
    try:
        return int(get_setting(db, key))
    except (TypeError, ValueError):
        return default


def gap_seconds(c: Campaign) -> float:
    if c.mode == "instant":
        return INSTANT_GAP
    if c.mode == "random":
        lo, hi = sorted((max(1, c.random_min_seconds), max(1, c.random_max_seconds)))
        return random.uniform(lo, hi)
    return max(1, c.interval_seconds)


def sent_query(db, mailbox_id: int, since: datetime, domain: str | None = None):
    q = (select(CampaignRecipient.sent_at).join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
         .where(Campaign.mailbox_id == mailbox_id, CampaignRecipient.sent_at >= since))
    if domain:
        q = q.where(CampaignRecipient.email.like(f"%@{domain}"))
    return q


def daily_block(db, c: Campaign, now: datetime) -> datetime | None:
    """When the sender may send again, if the 24-hour limit is used up."""
    limit = int_setting(db, "campaign_daily_limit", 150)
    since = now - timedelta(hours=24)
    times = sorted(aware(t) for (t,) in db.execute(sent_query(db, c.mailbox_id, since)))
    if len(times) < limit:
        return None
    return times[len(times) - limit] + timedelta(hours=24, seconds=5)


def domain_block(db, c: Campaign, domain: str, now: datetime) -> datetime | None:
    limit = int_setting(db, "campaign_domain_hourly_limit", 20)
    if limit <= 0:
        return None
    since = now - timedelta(hours=1)
    times = sorted(aware(t) for (t,) in db.execute(sent_query(db, c.mailbox_id, since, domain)))
    if len(times) < limit:
        return None
    return times[len(times) - limit] + timedelta(hours=1, seconds=5)


def suppressed(db, domain_id: int, email: str) -> Suppression | None:
    return db.execute(select(Suppression).where(Suppression.domain_id == domain_id, Suppression.email == email)).scalars().first()


def send_one(db, c: Campaign, box: Mailbox, r: CampaignRecipient, attachments) -> None:
    fields = recipient_fields(r.email, json.loads(r.fields or "{}"))
    unsub = unsubscribe_url(r.id) if c.unsubscribe else None
    msg = build_message(
        sender_email=box.email, sender_name=box.display_name, to_email=r.email,
        subject=render(c.subject, fields, escape=False), html=render(c.html, fields, escape=True),
        attachments=attachments, unsubscribe=unsub,
    )
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=60) as smtp:
            smtp.send_message(msg, from_addr=box.email, to_addrs=[r.email])
        r.status, r.error = "sent", ""
        r.message_id = str(msg["Message-ID"]).strip("<>")
    except smtplib.SMTPRecipientsRefused as exc:
        r.status = "failed"
        r.error = "; ".join(f"{e[0]} {e[1].decode('utf-8', 'replace')}" for e in exc.recipients.values())[:1000]
    except smtplib.SMTPResponseException as exc:
        r.status = "failed"
        r.error = f"{exc.smtp_code} {exc.smtp_error.decode('utf-8', 'replace')}"[:1000]
    except (smtplib.SMTPException, OSError) as exc:
        # Our own mail server is unreachable: try this recipient again later instead of failing it.
        raise RuntimeError(f"mail server unavailable: {exc}") from exc
    r.sent_at = utcnow()


def process(db, c: Campaign, now: datetime) -> None:
    box = db.get(Mailbox, c.mailbox_id)
    if not box or not box.active or not box.domain.active:
        c.status, c.waiting_reason = "paused", "The mailbox is disabled"
        return
    if not box.can_campaign:
        c.status, c.waiting_reason = "paused", "Campaigns were turned off for this mailbox by an administrator"
        return
    until = daily_block(db, c, now)
    if until:
        c.next_send_at, c.waiting_reason = until, "Daily sending limit reached; continues automatically"
        return
    pending = db.execute(select(CampaignRecipient).where(CampaignRecipient.campaign_id == c.id,
                                                         CampaignRecipient.status == "pending")
                         .order_by(CampaignRecipient.position).limit(200)).scalars().all()
    if not pending:
        c.status, c.finished_at, c.waiting_reason = "completed", now, ""
        return
    blocked_until: list[datetime] = []
    for r in pending:
        sup = suppressed(db, box.domain_id, r.email)
        if sup:
            r.status, r.error = ("unsubscribed" if sup.reason == "unsubscribed" else "skipped"), f"On the suppression list ({sup.reason})"
            continue
        wait = domain_block(db, c, r.email.rpartition("@")[2], now)
        if wait:
            blocked_until.append(wait)
            continue
        attachments = load_attachments(c.attachments)
        try:
            send_one(db, c, box, r, attachments)
        except RuntimeError as exc:
            c.next_send_at, c.waiting_reason = now + timedelta(minutes=2), str(exc)[:200]
            return
        c.status, c.waiting_reason = "running", ""
        # Measure the gap from when this message actually went out, not from the start of the tick.
        c.next_send_at = utcnow() + timedelta(seconds=gap_seconds(c))
        return
    if blocked_until:
        c.next_send_at = min(blocked_until)
        c.waiting_reason = "Hourly limit per recipient domain reached; continues automatically"


def track_deliveries(db) -> None:
    """Mark sent recipients delivered/bounced from the mail log; suppress hard bounces."""
    since = utcnow() - timedelta(days=4)
    rows = db.execute(select(CampaignRecipient, Campaign).join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
                      .where(CampaignRecipient.status == "sent", CampaignRecipient.sent_at >= since,
                             CampaignRecipient.message_id != "").limit(500)).all()
    for r, c in rows:
        msg = db.execute(select(MailMessage).where(MailMessage.message_id == r.message_id)
                         .order_by(MailMessage.id.desc()).limit(1)).scalars().first()
        if not msg:
            continue
        if msg.status == "delivered":
            r.status = "delivered"
        elif msg.status in ("bounced", "partial"):
            r.status = "bounced"
            d = next((d for d in msg.deliveries if d.recipient == r.email), None)
            r.error = (d.response if d else msg.reason)[:1000]
            box = db.get(Mailbox, c.mailbox_id)
            if box and not suppressed(db, box.domain_id, r.email):
                db.add(Suppression(domain_id=box.domain_id, email=r.email, reason="bounced", note=r.error[:300]))


def run() -> None:
    create_tables()
    print("campaign worker started", flush=True)
    last_tracking = 0.0
    while True:
        with SessionLocal() as db:
            now = utcnow()
            try:
                for c in db.execute(select(Campaign).where(Campaign.status.in_(("scheduled", "running")),
                                                           Campaign.start_at <= now, Campaign.next_send_at <= now)
                                    .order_by(Campaign.next_send_at)).scalars().all():
                    process(db, c, now)
                    db.commit()
                if time.time() - last_tracking > 60:
                    track_deliveries(db)
                    db.commit()
                    last_tracking = time.time()
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                db.rollback()
                print(f"campaign worker error: {exc}", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(0)
