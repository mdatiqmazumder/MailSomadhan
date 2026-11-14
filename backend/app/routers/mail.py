import html as html_lib
import mimetypes
import re
import smtplib
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, getaddresses, make_msgid
from urllib.parse import quote as urlquote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..connection import connection_info
from ..db import get_db
from ..deps import require_user
from ..imap_client import FOLDER_NAME_RE, MailError, MailSession
from ..models import Mailbox
from ..security import EMAIL_RE
from ..system import get_setting

router = APIRouter()

# Content types that are safe to display inline in a browser tab; everything else downloads.
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"}


def _session(user: Mailbox) -> MailSession:
    try:
        return MailSession(user.email)
    except MailError as exc:
        raise HTTPException(502, str(exc)) from exc


def _fail(exc: MailError):
    raise HTTPException(400, str(exc)) from exc


@router.get("/contacts")
def contacts(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    """Addresses to suggest while composing: people this user wrote to (most often and most recently
    first), people who wrote to them, and the other mailboxes of their domain. Campaign recipients are
    left out so one large campaign does not flood the suggestions."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import func, select

    from ..models import CampaignRecipient, MailDelivery, MailMessage

    me = user.email.lower()
    since = datetime.now(timezone.utc) - timedelta(days=365)
    campaign_ids = select(CampaignRecipient.message_id).where(CampaignRecipient.message_id != "")
    score: dict[str, float] = {}
    last: dict[str, datetime] = {}

    sent = (db.query(MailDelivery.recipient, func.count(MailDelivery.id), func.max(MailMessage.created_at))
            .join(MailMessage, MailMessage.id == MailDelivery.message_pk)
            .filter(MailMessage.user_email == me, MailMessage.created_at >= since,
                    MailMessage.message_id.not_in(campaign_ids))
            .group_by(MailDelivery.recipient).order_by(func.count(MailDelivery.id).desc()).limit(500).all())
    for addr, count, when in sent:
        score[addr.lower()] = score.get(addr.lower(), 0) + 3 * count
        last[addr.lower()] = when
    received = (db.query(MailMessage.sender, func.count(MailMessage.id), func.max(MailMessage.created_at))
                .join(MailDelivery, MailDelivery.message_pk == MailMessage.id)
                .filter(MailDelivery.recipient == me, MailMessage.created_at >= since, MailMessage.sender != "",
                        MailMessage.spam_action.not_in(("reject", "add header", "rewrite subject")))
                .group_by(MailMessage.sender).order_by(func.count(MailMessage.id).desc()).limit(300).all())
    for addr, count, when in received:
        a = addr.lower()
        if a.startswith(("mailer-daemon@", "postmaster@", "no-reply", "noreply", "bounce")):
            continue
        score[a] = score.get(a, 0) + count
        last[a] = max(last.get(a, when), when) if when else last.get(a)
    names = {m.email: m.display_name for m in db.query(Mailbox).filter(Mailbox.domain_id == user.domain_id, Mailbox.active)}
    for addr in names:
        score.setdefault(addr, 0.5)
    score.pop(me, None)

    def recency(addr: str) -> float:
        when = last.get(addr)
        if not when:
            return 0
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return max(0.0, 30 - (datetime.now(timezone.utc) - when).days) / 10

    ranked = sorted((a for a in score if EMAIL_RE.match(a)), key=lambda a: -(score[a] + recency(a)))[:300]
    return [{"email": a, "name": names.get(a, "")} for a in ranked]


@router.get("/connection")
def connection(user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    return connection_info(db, user)


@router.get("/folders")
def folders(user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            return {"folders": s.folders(), "quota": s.quota()}
        except MailError as exc:
            _fail(exc)


class FolderIn(BaseModel):
    name: str = Field(max_length=80)


@router.post("/folders")
def create_folder(body: FolderIn, user: Mailbox = Depends(require_user)):
    name = body.name.strip()
    if not FOLDER_NAME_RE.match(name) or name.upper() == "INBOX":
        raise HTTPException(400, "Invalid folder name")
    with _session(user) as s:
        try:
            s.create_folder(name)
        except MailError as exc:
            _fail(exc)
    return {"ok": True}


@router.delete("/folders")
def delete_folder(name: str, user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            match = next((f for f in s.folders() if f["name"] == name), None)
            if not match:
                raise HTTPException(404, "Folder not found")
            if match["role"]:
                raise HTTPException(400, "System folders cannot be deleted")
            s.delete_folder(name)
        except MailError as exc:
            _fail(exc)
    return {"ok": True}


@router.post("/folders/empty")
def empty_folder(body: FolderIn, user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            match = next((f for f in s.folders() if f["name"] == body.name), None)
            if not match or match["role"] not in ("trash", "junk"):
                raise HTTPException(400, "Only Trash and Junk can be emptied")
            s.empty(body.name)
        except MailError as exc:
            _fail(exc)
    return {"ok": True}


@router.get("/messages")
def messages(folder: str = "INBOX", page: int = 1, size: int = 40, q: str = "",
             user: Mailbox = Depends(require_user)):
    page = max(page, 1)
    size = min(max(size, 1), 100)
    with _session(user) as s:
        try:
            return s.list_messages(folder, page, size, q.strip()[:200])
        except MailError as exc:
            _fail(exc)


@router.get("/message")
def message(folder: str, uid: int, user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            return s.get_message(folder, uid)
        except MailError as exc:
            _fail(exc)


@router.get("/attachment")
def attachment(folder: str, uid: int, index: int, user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            filename, content_type, data = s.get_attachment(folder, uid, index)
        except MailError as exc:
            _fail(exc)
    inline = content_type in INLINE_TYPES
    safe_name = re.sub(r'[\r\n"\\/]', "_", filename)[:200]
    return Response(
        content=data,
        media_type=content_type if inline else "application/octet-stream",
        headers={
            "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{urlquote(safe_name)}",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    )


class ActionIn(BaseModel):
    folder: str
    uids: list[int] = Field(min_length=1, max_length=500)
    action: str
    target: str | None = None


@router.post("/action")
def action(body: ActionIn, user: Mailbox = Depends(require_user)):
    with _session(user) as s:
        try:
            if body.action in ("read", "unread"):
                s.set_flags(body.folder, body.uids, "\\Seen", body.action == "read")
            elif body.action in ("star", "unstar"):
                s.set_flags(body.folder, body.uids, "\\Flagged", body.action == "star")
            elif body.action == "move":
                if not body.target:
                    raise HTTPException(400, "Target folder required")
                s.move(body.folder, body.uids, body.target)
            elif body.action == "spam":
                s.move(body.folder, body.uids, s.folder_by_role("junk", "Junk"))
            elif body.action == "notspam":
                s.move(body.folder, body.uids, "INBOX")
            elif body.action == "archive":
                s.move(body.folder, body.uids, s.folder_by_role("archive", "Archive"))
            elif body.action == "delete":
                trash = s.folder_by_role("trash", "Trash")
                if body.folder == trash:
                    s.delete_forever(body.folder, body.uids)
                else:
                    s.move(body.folder, body.uids, trash)
            else:
                raise HTTPException(400, "Unknown action")
        except MailError as exc:
            _fail(exc)
    return {"ok": True}


# ---------------------------------------------------------------- compose
def _parse_recipients(raw: str) -> list[str]:
    result = []
    for _name, addr in getaddresses([raw.replace(";", ",")]):
        addr = addr.strip()
        if not addr:
            continue
        if not EMAIL_RE.match(addr):
            raise HTTPException(400, f"Invalid address: {addr}")
        result.append(addr)
    return list(dict.fromkeys(result))


def _html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|tr|blockquote)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def _clean_header(value: str) -> str:
    return re.sub(r"[\r\n]+", " ", value).strip()


async def _build_message(user: Mailbox, db: Session, to: str, cc: str, bcc: str, subject: str, html: str,
                         in_reply_to: str, references: str, files: list[UploadFile],
                         forward: list[tuple[str, str, bytes]]) -> tuple[EmailMessage, list[str]]:
    to_list, cc_list, bcc_list = _parse_recipients(to), _parse_recipients(cc), _parse_recipients(bcc)
    max_bytes = int(get_setting(db, "max_attachment_mb") or 25) * 1024 * 1024

    msg = EmailMessage()
    local, _, domain = user.email.partition("@")
    msg["From"] = Address(display_name=_clean_header(user.display_name), username=local, domain=domain)
    if to_list:
        msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    if bcc_list:
        msg["Bcc"] = ", ".join(bcc_list)
    msg["Subject"] = _clean_header(subject)[:900]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain)
    if in_reply_to:
        msg["In-Reply-To"] = _clean_header(in_reply_to)[:900]
        msg["References"] = _clean_header(f"{references} {in_reply_to}")[-1800:]
    msg["X-Mailer"] = "MailSomadhan"

    msg.set_content(_html_to_text(html))
    msg.add_alternative(f"<!doctype html><html><body>{html}</body></html>", subtype="html")

    total = 0
    parts: list[tuple[str, str, bytes]] = list(forward)
    for upload in files:
        data = await upload.read()
        ctype = upload.content_type or mimetypes.guess_type(upload.filename or "")[0] or "application/octet-stream"
        parts.append((upload.filename or "attachment", ctype, data))
    for filename, ctype, data in parts:
        total += len(data)
        if total > max_bytes:
            raise HTTPException(413, f"Attachments exceed the {max_bytes // (1024 * 1024)} MB limit")
        maintype, _, subtype = ctype.partition("/")
        if not subtype or maintype in ("multipart", "message"):
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=_clean_header(filename)[:200])
    return msg, to_list + cc_list + bcc_list


def _forwarded(s: MailSession, folder: str, uid: int | None) -> list[tuple[str, str, bytes]]:
    if not folder or not uid:
        return []
    try:
        return s.attachments_of(folder, uid)
    except MailError:
        return []


@router.post("/send")
async def send(
    to: str = Form(""), cc: str = Form(""), bcc: str = Form(""), subject: str = Form(""),
    html: str = Form(""), in_reply_to: str = Form(""), references: str = Form(""),
    draft_uid: int | None = Form(None), forward_folder: str = Form(""), forward_uid: int | None = Form(None),
    reply_folder: str = Form(""), reply_uid: int | None = Form(None),
    files: list[UploadFile] = File(default=[]),
    user: Mailbox = Depends(require_user), db: Session = Depends(get_db),
):
    with _session(user) as s:
        msg, recipients = await _build_message(user, db, to, cc, bcc, subject, html, in_reply_to, references,
                                               files, _forwarded(s, forward_folder, forward_uid))
        if not recipients:
            raise HTTPException(400, "Add at least one recipient")
        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=60) as smtp:
                refused = smtp.send_message(msg, from_addr=user.email, to_addrs=recipients)
        except smtplib.SMTPRecipientsRefused as exc:
            detail = "; ".join(f"{addr}: {err[1].decode('utf-8', 'replace')}" for addr, err in exc.recipients.items())
            raise HTTPException(400, f"Recipients refused: {detail}") from exc
        except smtplib.SMTPResponseException as exc:
            raise HTTPException(400, f"Mail server rejected the message: "
                                     f"{exc.smtp_error.decode('utf-8', 'replace')}") from exc
        except (smtplib.SMTPException, OSError) as exc:
            raise HTTPException(502, f"Could not send: {exc}") from exc
        try:
            s.append(s.folder_by_role("sent", "Sent"), msg, "(\\Seen)")
            if draft_uid:
                s.delete_forever(s.folder_by_role("drafts", "Drafts"), [draft_uid])
            if reply_folder and reply_uid:
                s.set_flags(reply_folder, [reply_uid], "\\Answered", True)
        except MailError:
            pass  # the message is already on its way; bookkeeping failures are not fatal
    return {"ok": True, "refused": list(refused.keys()) if refused else []}


@router.post("/draft")
async def save_draft(
    to: str = Form(""), cc: str = Form(""), bcc: str = Form(""), subject: str = Form(""),
    html: str = Form(""), in_reply_to: str = Form(""), references: str = Form(""),
    draft_uid: int | None = Form(None), forward_folder: str = Form(""), forward_uid: int | None = Form(None),
    files: list[UploadFile] = File(default=[]),
    user: Mailbox = Depends(require_user), db: Session = Depends(get_db),
):
    with _session(user) as s:
        msg, _ = await _build_message(user, db, to, cc, bcc, subject, html, in_reply_to, references,
                                      files, _forwarded(s, forward_folder, forward_uid))
        try:
            drafts = s.folder_by_role("drafts", "Drafts")
            new_uid = s.append(drafts, msg, "(\\Draft \\Seen)")
            if draft_uid:
                s.delete_forever(drafts, [draft_uid])
        except MailError as exc:
            _fail(exc)
    return {"ok": True, "uid": new_uid}


# ---------------------------------------------------------------- the user's own dashboard
@router.get("/stats")
def my_stats(start: str | None = None, end: str | None = None, tz: str = "UTC",
             user: Mailbox = Depends(require_user), db: Session = Depends(get_db)):
    """The same sending/receiving numbers an admin sees for this mailbox, plus recent outgoing mail."""
    from sqlalchemy import select

    from ..models import MailMessage
    from .analytics import in_range, mailbox_report, parse_range
    from .campaigns import limits

    r = parse_range(start, end, tz)
    report = mailbox_report(db, user, r)
    m = MailMessage
    rows = db.execute(select(m).where(in_range(r), m.user_email == user.email)
                      .order_by(m.created_at.desc(), m.id.desc()).limit(25)).scalars().all()
    recent = []
    for msg in rows:
        problems = [dl for dl in msg.deliveries if dl.status in ("bounced", "deferred")]
        recent.append({
            "id": msg.id, "created_at": msg.created_at.isoformat(), "subject": msg.subject, "status": msg.status,
            "recipients": [dl.recipient for dl in msg.deliveries][:5],
            "recipient_count": len(msg.deliveries) or msg.nrcpt,
            "reason": (problems[0].response if problems else "") or (msg.reason if msg.status == "rejected" else ""),
        })
    report["recent"] = recent
    report["campaign"] = limits(db, user.id) if user.can_campaign else None
    return report


# ---------------------------------------------------------------- live inbox updates
async def _idle_events(user_email: str, request: Request):
    """Server-sent events: one IMAP connection per open webmail tab sits in IDLE on INBOX, and every
    change (new mail, flags, deletions) becomes a "mailbox" event so the page reloads its list at once.
    Plain asyncio, so a waiting tab costs no worker thread."""
    import asyncio

    def esc(value: str) -> str:
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    reader = writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(settings.imap_host, settings.imap_port), 10)

        async def line() -> bytes:
            return await asyncio.wait_for(reader.readline(), 30)

        async def command(tag: str, text: str) -> bool:
            writer.write(f"{tag} {text}\r\n".encode())
            await writer.drain()
            while True:
                resp = await line()
                if not resp:
                    return False
                if resp.startswith(tag.encode() + b" "):
                    return resp.split(b" ", 2)[1].upper() == b"OK"

        await line()  # greeting
        login = f"{user_email}*{settings.imap_master_user}"
        if not await command("a1", f"LOGIN {esc(login)} {esc(settings.imap_master_password)}"):
            yield "event: error\ndata: login\n\n"
            return
        if not await command("a2", "EXAMINE INBOX"):
            yield "event: error\ndata: inbox\n\n"
            return
        yield "event: ready\ndata: 1\n\n"
        n = 2
        while not await request.is_disconnected():
            n += 1
            tag = f"a{n}"
            writer.write(f"{tag} IDLE\r\n".encode())
            await writer.drain()
            resp = await line()
            if not resp.startswith(b"+"):
                break
            loop = asyncio.get_running_loop()
            restart_at = loop.time() + 25 * 60  # servers drop IDLE after ~30 minutes
            changed = False
            while loop.time() < restart_at and not await request.is_disconnected():
                try:
                    resp = await asyncio.wait_for(reader.readline(), 20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if not resp:
                    return
                if resp.startswith(b"* ") and any(k in resp.upper() for k in (b"EXISTS", b"EXPUNGE", b"FETCH")):
                    changed = True
                    # Let a burst of updates (several messages, flags) settle before telling the page.
                    try:
                        while True:
                            more = await asyncio.wait_for(reader.readline(), 0.4)
                            if not more:
                                return
                    except asyncio.TimeoutError:
                        pass
                    break
            writer.write(b"DONE\r\n")
            await writer.drain()
            while True:
                resp = await line()
                if not resp or resp.startswith(tag.encode() + b" "):
                    break
            if changed:
                yield "event: mailbox\ndata: 1\n\n"
    except (OSError, asyncio.TimeoutError):
        yield "event: error\ndata: imap\n\n"
    finally:
        if writer is not None:
            try:
                writer.write(b"z LOGOUT\r\n")
                writer.close()
            except Exception:  # noqa: BLE001
                pass


@router.get("/events")
async def events(request: Request):
    from fastapi.responses import StreamingResponse

    from ..db import SessionLocal
    from ..deps import get_principal

    # Resolve the session by hand: a Depends(get_db) session would stay checked out for the whole stream.
    db = SessionLocal()
    try:
        principal = get_principal(request, db)
        if principal.kind != "user":
            raise HTTPException(403, "Mailbox account required")
        email = principal.mailbox.email
    finally:
        db.close()
    return StreamingResponse(_idle_events(email, request), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
