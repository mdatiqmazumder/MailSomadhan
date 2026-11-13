"""Dashboard numbers, per-user analytics, message log and CSV reports (admin only)."""
import csv
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, case, exists, func, literal, or_, select
from sqlalchemy.orm import Session

from ..db import engine, get_db
from ..deps import AdminCtx, require_perm
from ..models import Domain, MailDelivery, MailMessage, Mailbox

router = APIRouter()

PG = engine.dialect.name == "postgresql"
FLAGGED_ACTIONS = ("add header", "rewrite subject", "reject", "soft reject", "greylist")
DIRECTIONS = {"inbound", "outbound", "internal", "forward"}
STATUSES = {"queued", "delivered", "deferred", "bounced", "partial", "rejected"}


# ---------------------------------------------------------------- shared helpers
class Range:
    def __init__(self, start: datetime, end: datetime, tz: str):
        self.start, self.end, self.tz = start, end, tz
        span = end - start
        self.unit = "hour" if span <= timedelta(days=2) else "day"


def parse_range(start: str | None = None, end: str | None = None, tz: str = "UTC") -> Range:
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        tz = "UTC"
    now = datetime.now(timezone.utc)

    def parse(value: str | None, default: datetime) -> datetime:
        if not value:
            return default
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(400, f"Invalid date: {value}") from exc
        return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(tz))

    end_dt = parse(end, now)
    start_dt = parse(start, end_dt - timedelta(days=7))
    if start_dt >= end_dt:
        raise HTTPException(400, "The start of the range must be before the end")
    if end_dt - start_dt > timedelta(days=400):
        raise HTTPException(400, "The range can be at most 400 days")
    return Range(start_dt, end_dt, tz)


def range_dep(start: str | None = None, end: str | None = None, tz: str = "UTC") -> Range:
    return parse_range(start, end, tz)


def bucket(col, r: Range):
    if PG:
        return func.date_trunc(r.unit, func.timezone(r.tz, col))
    return func.strftime("%Y-%m-%d %H:00:00" if r.unit == "hour" else "%Y-%m-%d 00:00:00", col)


def bucket_key(value) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:00:00")
    return str(value).replace(" ", "T")[:19]


def all_buckets(r: Range) -> list[str]:
    tz = ZoneInfo(r.tz) if PG else timezone.utc
    cur = r.start.astimezone(tz).replace(minute=0, second=0, microsecond=0)
    if r.unit == "day":
        cur = cur.replace(hour=0)
    step = timedelta(hours=1) if r.unit == "hour" else timedelta(days=1)
    out = []
    end = r.end.astimezone(tz)
    while cur <= end and len(out) < 1000:
        out.append(cur.strftime("%Y-%m-%dT%H:00:00"))
        cur += step
    return out


def domain_scope(domain: str | None = None, db: Session = Depends(get_db),
                 ctx: AdminCtx = Depends(require_perm("analytics.view"))) -> list[str] | None:
    """Domains the caller may see: the requested one (if allowed), else all of theirs (None = all)."""
    if domain:
        d = db.query(Domain).filter_by(name=domain.strip().lower()).first()
        if not d or not ctx.can_domain(d.id):
            raise HTTPException(404, "Domain not found")
        return [d.name]
    if ctx.domain_ids is None:
        return None
    return [n for (n,) in db.query(Domain.name).filter(Domain.id.in_(ctx.domain_ids or [-1]))]


def domain_filter(names: list[str] | None):
    if names is None:
        return literal(True)
    if not names:
        return literal(False)
    return or_(
        MailMessage.sender_domain.in_(names),
        *[MailMessage.user_email.like(f"%@{n}") for n in names],
        exists().where(and_(MailDelivery.message_pk == MailMessage.id, MailDelivery.recipient_domain.in_(names))),
    )


def in_range(r: Range):
    return and_(MailMessage.created_at >= r.start, MailMessage.created_at < r.end)


def count_if(cond):
    return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)


def flagged_cond():
    return MailMessage.spam_action.in_(FLAGGED_ACTIONS)


# ---------------------------------------------------------------- overview
@router.get("/analytics/overview")
def overview(r: Range = Depends(range_dep), scope: list[str] | None = Depends(domain_scope), db: Session = Depends(get_db)):
    base = and_(in_range(r), domain_filter(scope))
    m = MailMessage
    totals = db.execute(select(
        func.count(m.id),
        count_if(m.direction == "outbound"),
        count_if(m.direction == "inbound"),
        count_if(m.direction == "internal"),
        count_if(m.direction == "forward"),
        count_if(m.status == "delivered"),
        count_if(m.status.in_(("bounced", "partial"))),
        count_if(m.status == "deferred"),
        count_if(m.status == "rejected"),
        count_if(and_(m.direction == "inbound", flagged_cond(), m.status != "rejected")),
        count_if(and_(m.direction == "inbound", m.status == "rejected")),
        count_if(and_(m.direction.in_(("outbound", "internal")), m.status.in_(("delivered", "bounced", "partial")))),
        count_if(and_(m.direction.in_(("outbound", "internal")), m.status == "delivered")),
        func.coalesce(func.sum(m.size), 0),
        count_if(m.has_attachment),
        func.count(func.distinct(case((m.user_email != "", m.user_email)))),
    ).where(base)).one()
    keys = ["total", "outbound", "inbound", "internal", "forward", "delivered", "bounced", "deferred", "rejected",
            "spam_junked", "spam_rejected", "out_finished", "out_delivered", "bytes", "attachments", "active_senders"]
    t = dict(zip(keys, (int(v or 0) for v in totals)))
    t["delivery_rate"] = round(t.pop("out_delivered") / t["out_finished"] * 100, 1) if t["out_finished"] else None
    t.pop("out_finished")

    b = bucket(m.created_at, r)
    series_rows = db.execute(select(
        b, count_if(m.direction.in_(("outbound", "internal"))), count_if(m.direction == "inbound"),
        count_if(m.status == "rejected"), count_if(m.status.in_(("bounced", "partial"))),
        count_if(flagged_cond()),
    ).where(base).group_by(b)).all()
    by_bucket = {bucket_key(row[0]): row[1:] for row in series_rows}
    series = []
    for key in all_buckets(r):
        sent, received, rejected, bounced, spam = by_bucket.get(key, (0, 0, 0, 0, 0))
        series.append({"t": key, "sent": int(sent), "received": int(received), "rejected": int(rejected),
                       "bounced": int(bounced), "spam": int(spam)})

    top_senders = [
        {"email": e, "sent": int(c), "bounced": int(bc), "external": int(ex or 0)}
        for e, c, bc, ex in db.execute(
            select(m.user_email, func.count(m.id), count_if(m.status.in_(("bounced", "partial"))), func.sum(m.external_rcpts))
            .where(base, m.user_email != "", m.status != "rejected")
            .group_by(m.user_email).order_by(func.count(m.id).desc()).limit(8)
        )
    ]
    d = MailDelivery
    top_destinations = [
        {"domain": dom, "count": int(c)}
        for dom, c in db.execute(
            select(d.recipient_domain, func.count(d.id)).join(m, m.id == d.message_pk)
            .where(base, m.direction.in_(("outbound", "forward")), d.is_local.is_(False), d.recipient_domain != "")
            .group_by(d.recipient_domain).order_by(func.count(d.id).desc()).limit(8)
        )
    ]
    top_inbound_sources = [
        {"domain": dom, "count": int(c)}
        for dom, c in db.execute(
            select(m.sender_domain, func.count(m.id)).where(base, m.direction == "inbound", m.sender_domain != "")
            .group_by(m.sender_domain).order_by(func.count(m.id).desc()).limit(8)
        )
    ]
    sources = {s: int(c) for s, c in db.execute(select(m.source, func.count(m.id)).where(base).group_by(m.source))}
    return {"range": {"start": r.start.isoformat(), "end": r.end.isoformat(), "unit": r.unit}, "totals": t,
            "series": series, "top_senders": top_senders, "top_destinations": top_destinations,
            "top_inbound_sources": top_inbound_sources, "sources": sources}


# ---------------------------------------------------------------- users
def user_metrics(db: Session, r: Range, emails: list[str] | None = None) -> dict[str, dict]:
    m, d = MailMessage, MailDelivery
    cond = [in_range(r), m.user_email != ""]
    if emails is not None:
        cond.append(m.user_email.in_(emails))
    out: dict[str, dict] = {}
    for row in db.execute(select(
        m.user_email,
        count_if(m.status != "rejected"),
        func.coalesce(func.sum(case((m.status != "rejected", m.nrcpt), else_=0)), 0),
        func.coalesce(func.sum(m.external_rcpts), 0),
        count_if(m.status.in_(("bounced", "partial"))),
        count_if(m.status == "deferred"),
        count_if(m.status == "rejected"),
        count_if(flagged_cond()),
        count_if(m.has_attachment),
        func.coalesce(func.sum(m.size), 0),
        func.max(m.created_at),
    ).where(*cond).group_by(m.user_email)):
        out[row[0]] = {
            "sent": int(row[1]), "recipients": int(row[2]), "external_recipients": int(row[3]),
            "bounced": int(row[4]), "deferred": int(row[5]), "blocked": int(row[6]), "flagged": int(row[7]),
            "with_attachments": int(row[8]), "bytes_sent": int(row[9]),
            "last_sent": row[10].isoformat() if row[10] else None,
        }
    rcond = [d.updated_at >= r.start, d.updated_at < r.end, d.is_local.is_(True), d.status == "sent"]
    if emails is not None:
        rcond.append(d.recipient.in_(emails))
    for email, received, spam in db.execute(
        select(d.recipient, func.count(d.id), count_if(flagged_cond())).join(m, m.id == d.message_pk)
        .where(*rcond).group_by(d.recipient)
    ):
        out.setdefault(email, {})
        out[email]["received"] = int(received)
        out[email]["spam_received"] = int(spam)
    return out


EMPTY_METRICS = {"sent": 0, "recipients": 0, "external_recipients": 0, "bounced": 0, "deferred": 0, "blocked": 0,
                 "flagged": 0, "with_attachments": 0, "bytes_sent": 0, "last_sent": None, "received": 0,
                 "spam_received": 0}
USER_SORTS = {"sent", "received", "recipients", "external_recipients", "bounced", "bounce_rate", "flagged", "blocked",
              "bytes_sent", "last_sent", "email"}


def with_rates(metrics: dict) -> dict:
    row = {**EMPTY_METRICS, **metrics}
    row["bounce_rate"] = round(row["bounced"] / row["sent"] * 100, 1) if row["sent"] else 0.0
    row["external_share"] = round(row["external_recipients"] / row["recipients"] * 100, 1) if row["recipients"] else 0.0
    return row


@router.get("/analytics/users")
def users(r: Range = Depends(range_dep), scope: list[str] | None = Depends(domain_scope), q: str = "", sort: str = "sent",
          order: str = "desc", page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500),
          db: Session = Depends(get_db)):
    if sort not in USER_SORTS:
        sort = "sent"
    mq = select(Mailbox.email, Mailbox.display_name, Mailbox.active, Domain.name).join(Domain)
    if scope is not None:
        mq = mq.where(Domain.name.in_(scope))
    if q:
        like = f"%{q.strip().lower()}%"
        mq = mq.where(or_(Mailbox.email.like(like), func.lower(Mailbox.display_name).like(like)))
    boxes = db.execute(mq).all()
    metrics = user_metrics(db, r)
    rows = [{"email": e, "display_name": n, "active": a, "domain": dn, **with_rates(metrics.get(e, {}))}
            for e, n, a, dn in boxes]
    reverse = order != "asc"
    rows.sort(key=lambda x: (x[sort] is not None, x[sort] or 0) if sort != "email" else x["email"], reverse=reverse)
    total = len(rows)
    totals = {k: sum(x[k] for x in rows) for k in ("sent", "received", "recipients", "external_recipients", "bounced",
                                                    "flagged", "blocked", "bytes_sent")}
    totals["active_senders"] = sum(1 for x in rows if x["sent"])
    return {"total": total, "page": page, "size": size, "totals": totals,
            "items": rows[(page - 1) * size: page * size]}


@router.get("/analytics/users/{email}")
def user_detail(email: str, r: Range = Depends(range_dep), scope: list[str] | None = Depends(domain_scope),
                db: Session = Depends(get_db)):
    email = email.strip().lower()
    box = db.query(Mailbox).filter_by(email=email).first()
    if not box or (scope is not None and box.domain.name not in scope):
        raise HTTPException(404, "Mailbox not found")
    m, d = MailMessage, MailDelivery
    metrics = with_rates(user_metrics(db, r, [email]).get(email, {}))

    b = bucket(m.created_at, r)
    sent_rows = {bucket_key(k): int(v) for k, v in db.execute(
        select(b, func.count(m.id)).where(in_range(r), m.user_email == email, m.status != "rejected").group_by(b))}
    db_ = bucket(d.updated_at, r)
    recv_rows = {bucket_key(k): int(v) for k, v in db.execute(
        select(db_, func.count(d.id)).where(d.updated_at >= r.start, d.updated_at < r.end, d.recipient == email,
                                             d.is_local.is_(True), d.status == "sent").group_by(db_))}
    series = [{"t": k, "sent": sent_rows.get(k, 0), "received": recv_rows.get(k, 0)} for k in all_buckets(r)]

    if PG:
        local_ts = func.timezone(r.tz, m.created_at)
        dow, hour = func.extract("dow", local_ts), func.extract("hour", local_ts)
    else:
        dow, hour = func.strftime("%w", m.created_at), func.strftime("%H", m.created_at)
    heat = [[0] * 24 for _ in range(7)]
    for dw, hr, c in db.execute(select(dow, hour, func.count(m.id))
                                .where(in_range(r), m.user_email == email, m.status != "rejected").group_by(dow, hour)):
        heat[int(dw)][int(hr)] = int(c)

    top_recipients = [{"recipient": rc, "count": int(c), "external": not loc} for rc, c, loc in db.execute(
        select(d.recipient, func.count(d.id), func.max(case((d.is_local, 1), else_=0)))
        .join(m, m.id == d.message_pk).where(in_range(r), m.user_email == email)
        .group_by(d.recipient).order_by(func.count(d.id).desc()).limit(10))]
    top_domains = [{"domain": dom, "count": int(c)} for dom, c in db.execute(
        select(d.recipient_domain, func.count(d.id)).join(m, m.id == d.message_pk)
        .where(in_range(r), m.user_email == email, d.is_local.is_(False))
        .group_by(d.recipient_domain).order_by(func.count(d.id).desc()).limit(10))]
    statuses = {s: int(c) for s, c in db.execute(
        select(m.status, func.count(m.id)).where(in_range(r), m.user_email == email).group_by(m.status))}
    size_buckets = {"< 100 KB": 0, "100 KB – 1 MB": 0, "1 – 10 MB": 0, "> 10 MB": 0}
    size_class = case((m.size < 100_000, "< 100 KB"), (m.size < 1_000_000, "100 KB – 1 MB"),
                      (m.size < 10_000_000, "1 – 10 MB"), else_="> 10 MB")
    for sz, c in db.execute(select(size_class, func.count(m.id))
                            .where(in_range(r), m.user_email == email, m.status != "rejected").group_by(size_class)):
        size_buckets[sz] = int(c)
    return {
        "mailbox": {"email": box.email, "display_name": box.display_name, "active": box.active,
                    "quota_mb": box.quota_mb, "last_login": box.last_login.isoformat() if box.last_login else None,
                    "created_at": box.created_at.isoformat()},
        "metrics": metrics, "series": series, "heatmap": heat, "top_recipients": top_recipients,
        "top_domains": top_domains, "statuses": statuses, "sizes": size_buckets,
        "range": {"start": r.start.isoformat(), "end": r.end.isoformat(), "unit": r.unit},
    }


# ---------------------------------------------------------------- message log
def message_query(r: Range, direction: str | None, status: str | None, q: str, sender: str, recipient: str,
                  scope: list[str] | None, user: str, spam: bool, attachment: bool):
    m, d = MailMessage, MailDelivery
    cond = [in_range(r), domain_filter(scope)]
    if direction in DIRECTIONS:
        cond.append(m.direction == direction)
    if status in STATUSES:
        cond.append(m.status.in_(("bounced", "partial")) if status == "bounced" else m.status == status)
    if sender:
        cond.append(m.sender.like(f"%{sender.strip().lower()}%"))
    if recipient:
        cond.append(exists().where(and_(d.message_pk == m.id, d.recipient.like(f"%{recipient.strip().lower()}%"))))
    if user:
        cond.append(m.user_email == user.strip().lower())
    if spam:
        cond.append(flagged_cond())
    if attachment:
        cond.append(m.has_attachment.is_(True))
    if q:
        like = f"%{q.strip()}%"
        cond.append(or_(m.subject.ilike(like), m.message_id.ilike(like), m.queue_id == q.strip().upper(),
                        m.client_ip == q.strip(), m.reason.ilike(like)))
    return select(m).where(*cond)


def message_row(msg: MailMessage, full: bool = False) -> dict:
    row = {
        "id": msg.id, "queue_id": msg.queue_id, "created_at": msg.created_at.isoformat(),
        "direction": msg.direction, "status": msg.status, "source": msg.source, "sender": msg.sender,
        "user": msg.user_email, "subject": msg.subject, "size": msg.size,
        "recipients": [dl.recipient for dl in msg.deliveries][:20], "recipient_count": len(msg.deliveries) or msg.nrcpt,
        "spam_score": msg.spam_score, "spam_action": msg.spam_action, "has_attachment": msg.has_attachment,
        "client_ip": msg.client_ip,
    }
    if full:
        row.update({
            "finished_at": msg.finished_at.isoformat() if msg.finished_at else None,
            "client_host": msg.client_host, "sasl_user": msg.sasl_user, "message_id": msg.message_id,
            "reason": msg.reason, "spam_symbols": [s for s in msg.spam_symbols.split(",") if s],
            "deliveries": [{"recipient": dl.recipient, "orig_recipient": dl.orig_recipient, "status": dl.status,
                            "dsn": dl.dsn, "relay": dl.relay, "delay": dl.delay, "response": dl.response,
                            "local": dl.is_local, "updated_at": dl.updated_at.isoformat()} for dl in msg.deliveries],
        })
    return row


@router.get("/messages")
def messages(r: Range = Depends(range_dep), direction: str | None = None, status: str | None = None, q: str = "",
             sender: str = "", recipient: str = "", scope: list[str] | None = Depends(domain_scope), user: str = "",
             spam: bool = False, attachment: bool = False, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
             db: Session = Depends(get_db)):
    query = message_query(r, direction, status, q, sender, recipient, scope, user, spam, attachment)
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar_one()
    rows = db.execute(query.order_by(MailMessage.created_at.desc(), MailMessage.id.desc())
                      .offset((page - 1) * size).limit(size)).scalars().all()
    return {"total": total, "page": page, "size": size, "items": [message_row(x) for x in rows]}


@router.get("/messages/{message_pk}")
def message_detail(message_pk: int, scope: list[str] | None = Depends(domain_scope), db: Session = Depends(get_db)):
    msg = db.execute(select(MailMessage).where(MailMessage.id == message_pk, domain_filter(scope))).scalars().first()
    if not msg:
        raise HTTPException(404, "Message not found")
    return message_row(msg, full=True)


# ---------------------------------------------------------------- CSV reports
def csv_cell(value):
    """Neutralise spreadsheet formulas (CSV injection): mail subjects and addresses come from strangers."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def csv_response(name: str, header: list[str], rows) -> StreamingResponse:
    def generate():
        buf = io.StringIO()
        writer = csv.writer(buf)
        buf.write("﻿")  # lets Excel detect UTF-8
        writer.writerow(header)
        yield buf.getvalue()
        for row in rows:
            buf.seek(0)
            buf.truncate()
            writer.writerow([csv_cell(v) for v in row])
            yield buf.getvalue()

    return StreamingResponse(generate(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/reports/{kind}.csv")
def report_csv(kind: str, r: Range = Depends(range_dep), scope: list[str] | None = Depends(domain_scope),
               db: Session = Depends(get_db)):
    stamp = f"{r.start:%Y%m%d}-{r.end:%Y%m%d}"
    if kind == "summary":
        data = overview(r, scope, db)
        return csv_response(f"mail-summary-{stamp}.csv", ["period", "sent", "received", "rejected", "bounced", "spam"],
                            ([s["t"], s["sent"], s["received"], s["rejected"], s["bounced"], s["spam"]] for s in data["series"]))
    if kind == "users":
        data = users(r, scope, "", "sent", "desc", 1, 1_000_000, db)
        cols = ["email", "display_name", "domain", "active", "sent", "received", "recipients", "external_recipients",
                "external_share", "bounced", "bounce_rate", "deferred", "blocked", "flagged", "with_attachments",
                "bytes_sent", "last_sent"]
        return csv_response(f"mail-users-{stamp}.csv", cols, ([row[c] for c in cols] for row in data["items"]))
    if kind == "domains":
        m = MailMessage
        rows = db.execute(select(
            m.sender_domain, func.count(m.id), count_if(m.direction == "outbound"), count_if(m.direction == "inbound"),
            count_if(m.status.in_(("bounced", "partial"))), count_if(m.status == "rejected"), count_if(flagged_cond()),
            func.coalesce(func.sum(m.size), 0),
        ).where(in_range(r), domain_filter(scope)).group_by(m.sender_domain).order_by(func.count(m.id).desc())).all()
        return csv_response(f"mail-sender-domains-{stamp}.csv",
                            ["sender_domain", "messages", "outbound", "inbound", "bounced", "rejected", "spam", "bytes"],
                            (list(row) for row in rows))
    if kind == "messages":
        query = message_query(r, None, None, "", "", "", scope, "", False, False)
        rows = db.execute(query.order_by(MailMessage.created_at).limit(200_000)).scalars()
        return csv_response(
            f"mail-log-{stamp}.csv",
            ["time", "queue_id", "direction", "status", "source", "user", "sender", "recipients", "subject", "size",
             "spam_score", "spam_action", "attachment", "client_ip", "reason"],
            ([x.created_at.isoformat(), x.queue_id or "", x.direction, x.status, x.source, x.user_email, x.sender,
              " ".join(dl.recipient for dl in x.deliveries), x.subject, x.size, x.spam_score, x.spam_action,
              x.has_attachment, x.client_ip, x.reason] for x in rows))
    raise HTTPException(404, "Unknown report")
