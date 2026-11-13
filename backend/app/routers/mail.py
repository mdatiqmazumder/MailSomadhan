import html as html_lib
import mimetypes
import re
import smtplib
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, getaddresses, make_msgid
from urllib.parse import quote as urlquote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
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
