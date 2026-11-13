"""Thin IMAP layer for the webmail. Logs in through Dovecot's master-user feature
(only allowed from localhost), so user passwords never have to be stored reversibly."""
import base64
import email
import email.policy
import imaplib
import re
import time
from email.message import EmailMessage

import nh3

from .config import settings

SPECIAL_ORDER = ["inbox", "drafts", "sent", "junk", "trash", "archive"]
SPECIAL_FLAGS = {"\\drafts": "drafts", "\\sent": "sent", "\\junk": "junk", "\\trash": "trash",
                 "\\archive": "archive"}
FOLDER_NAME_RE = re.compile(r"^[^\x00-\x1f\x7f\"\\*%]{1,80}$")

_LIST_RE = re.compile(rb'^\((?P<flags>[^)]*)\) (?:"(?P<delim>[^"]*)"|NIL) (?P<name>.*)$')
_MSG_START_RE = re.compile(rb"^\d+ \(")

ALLOWED_TAGS = set(nh3.ALLOWED_TAGS) | {
    "style", "font", "center", "img", "span", "div", "table", "thead", "tbody", "tfoot", "tr",
    "td", "th", "caption", "colgroup", "col", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre",
    "u", "s", "small", "big", "sub", "sup", "figure", "figcaption",
}
GLOBAL_ATTRS = {"style", "class", "align", "valign", "width", "height", "bgcolor", "dir", "lang", "title"}
ALLOWED_ATTRS = {tag: set(GLOBAL_ATTRS) for tag in ALLOWED_TAGS}
ALLOWED_ATTRS["a"] |= {"href", "name"}
ALLOWED_ATTRS["img"] |= {"src", "alt", "border"}
ALLOWED_ATTRS["table"] |= {"border", "cellpadding", "cellspacing"}
ALLOWED_ATTRS["td"] |= {"colspan", "rowspan"}
ALLOWED_ATTRS["th"] |= {"colspan", "rowspan"}
ALLOWED_ATTRS["font"] |= {"color", "face", "size"}


def sanitize_html(html: str) -> str:
    """Strip scripts, event handlers, forms, iframes... The UI additionally renders the
    result inside a sandboxed iframe with a strict CSP."""
    return nh3.clean(
        html,
        tags=ALLOWED_TAGS,
        clean_content_tags={"script", "noscript", "iframe", "object", "embed", "title", "head"} - ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        url_schemes={"http", "https", "mailto", "data", "tel"},
        link_rel="noopener noreferrer nofollow",
    )


# ---- modified UTF-7 (RFC 3501 mailbox names) ----
def decode_mutf7(raw: bytes) -> str:
    text = raw.decode("ascii", "replace")
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if ch == "&":
            end = text.find("-", i)
            if end == -1:
                out.append(text[i:])
                break
            if end == i + 1:
                out.append("&")
            else:
                chunk = text[i + 1:end].replace(",", "/")
                chunk += "=" * (-len(chunk) % 4)
                try:
                    out.append(base64.b64decode(chunk).decode("utf-16-be"))
                except Exception:  # noqa: BLE001
                    out.append(text[i:end + 1])
            i = end + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def encode_mutf7(name: str) -> str:
    out, buf = [], []

    def flush():
        if buf:
            enc = base64.b64encode("".join(buf).encode("utf-16-be")).decode().rstrip("=").replace("/", ",")
            out.append("&" + enc + "-")
            buf.clear()

    for ch in name:
        if 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append("&-" if ch == "&" else ch)
        else:
            buf.append(ch)
    flush()
    return "".join(out)


CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")


def quote(name: str) -> str:
    # Folder names come from the browser: a CR/LF would let a request inject extra IMAP commands.
    if CONTROL_RE.search(name) or len(name) > 200:
        raise MailError("Invalid folder name")
    return '"' + encode_mutf7(name).replace("\\", "\\\\").replace('"', '\\"') + '"'


class MailError(Exception):
    pass


def _addresses(msg, header: str) -> list[dict]:
    try:
        value = msg[header]
        if value is None:
            return []
        return [{"name": a.display_name, "email": a.addr_spec} for a in value.addresses]
    except Exception:  # noqa: BLE001
        raw = msg.get(header, "")
        return [{"name": "", "email": str(raw)}] if raw else []


def _header(msg, name: str) -> str:
    try:
        return str(msg[name] or "")
    except Exception:  # noqa: BLE001
        return ""


class MailSession:
    def __init__(self, user_email: str):
        self.email = user_email
        try:
            self.c = imaplib.IMAP4(settings.imap_host, settings.imap_port, timeout=45)
            self.c.login(f"{user_email}*{settings.imap_master_user}", settings.imap_master_password)
        except (imaplib.IMAP4.error, OSError) as exc:
            raise MailError(f"Could not open mailbox: {exc}") from exc

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            self.c.logout()
        except Exception:  # noqa: BLE001
            pass

    def _ok(self, result, what: str):
        typ, data = result
        if typ != "OK":
            detail = data[0].decode("utf-8", "replace") if data and isinstance(data[0], bytes) else ""
            raise MailError(f"{what} failed: {detail}")
        return data

    # ---------------- folders ----------------
    def folders(self) -> list[dict]:
        data = self._ok(self.c.list('""', "*"), "LIST")
        result = []
        for item in data:
            if isinstance(item, tuple):  # literal name
                line, raw_name = item[0], item[1]
                m = _LIST_RE.match(line.rsplit(b" ", 1)[0] + b' ""')
            else:
                if not item:
                    continue
                m = _LIST_RE.match(item)
                raw_name = m.group("name") if m else b""
                if raw_name.startswith(b'"') and raw_name.endswith(b'"'):
                    raw_name = raw_name[1:-1].replace(b'\\"', b'"').replace(b"\\\\", b"\\")
            if not m:
                continue
            flags = m.group("flags").decode().lower().split()
            if "\\noselect" in flags or "\\nonexistent" in flags:
                continue
            name = decode_mutf7(raw_name)
            role = "inbox" if name.upper() == "INBOX" else next(
                (SPECIAL_FLAGS[f] for f in flags if f in SPECIAL_FLAGS), "")
            total = unseen = 0
            try:
                typ, st = self.c.status(quote(name), "(MESSAGES UNSEEN)")
                if typ == "OK" and st and st[0]:
                    text = st[-1] if isinstance(st[-1], bytes) else st[0]
                    if isinstance(text, tuple):
                        text = text[0]
                    mt = re.search(rb"MESSAGES (\d+)", text)
                    mu = re.search(rb"UNSEEN (\d+)", text)
                    total = int(mt.group(1)) if mt else 0
                    unseen = int(mu.group(1)) if mu else 0
            except imaplib.IMAP4.error:
                pass
            result.append({"name": name, "role": role, "total": total, "unseen": unseen})
        result.sort(key=lambda f: (SPECIAL_ORDER.index(f["role"]) if f["role"] in SPECIAL_ORDER else 99,
                                   f["name"].lower()))
        return result

    def folder_by_role(self, role: str, fallback: str) -> str:
        for f in self.folders():
            if f["role"] == role:
                return f["name"]
        return fallback

    def create_folder(self, name: str) -> None:
        self._ok(self.c.create(quote(name)), "Create folder")
        self.c.subscribe(quote(name))

    def delete_folder(self, name: str) -> None:
        self.c.unsubscribe(quote(name))
        self._ok(self.c.delete(quote(name)), "Delete folder")

    def select(self, folder: str, readonly: bool = False) -> None:
        self._ok(self.c.select(quote(folder), readonly=readonly), "Open folder")

    def quota(self) -> dict | None:
        try:
            typ, data = self.c.getquotaroot("INBOX")
            if typ != "OK":
                return None
            for group in data:
                for item in group or []:
                    if isinstance(item, bytes):
                        m = re.search(rb"STORAGE (\d+) (\d+)", item)
                        if m:
                            return {"used_kb": int(m.group(1)), "limit_kb": int(m.group(2))}
        except Exception:  # noqa: BLE001
            return None
        return None

    # ---------------- listing ----------------
    def list_messages(self, folder: str, page: int, size: int, query: str = "") -> dict:
        self.select(folder, readonly=True)
        try:
            if query:
                self.c.literal = query.encode("utf-8")
                data = self._ok(self.c.uid("SORT", "(REVERSE ARRIVAL)", "UTF-8", "TEXT"), "Search")
            else:
                data = self._ok(self.c.uid("SORT", "(REVERSE ARRIVAL)", "UTF-8", "ALL"), "List")
        except imaplib.IMAP4.error as exc:
            raise MailError(f"Search failed: {exc}") from exc
        uids = data[0].split() if data and data[0] else []
        total = len(uids)
        chunk = uids[(page - 1) * size: page * size]
        items = []
        if chunk:
            fetched = self._ok(self.c.uid(
                "FETCH", b",".join(chunk).decode(),
                "(UID FLAGS RFC822.SIZE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE)])",
            ), "Fetch")
            by_uid = {}
            current_meta, current_hdr = b"", b""

            def commit():
                m = re.search(rb"UID (\d+)", current_meta)
                if not m:
                    return
                flags_m = re.search(rb"FLAGS \(([^)]*)\)", current_meta)
                flags = flags_m.group(1).decode().lower().split() if flags_m else []
                size_m = re.search(rb"RFC822\.SIZE (\d+)", current_meta)
                msg = email.message_from_bytes(current_hdr, policy=email.policy.default)
                by_uid[int(m.group(1))] = {
                    "uid": int(m.group(1)),
                    "subject": _header(msg, "subject"),
                    "from": _addresses(msg, "from"),
                    "to": _addresses(msg, "to"),
                    "date": _iso_date(msg),
                    "seen": "\\seen" in flags,
                    "flagged": "\\flagged" in flags,
                    "answered": "\\answered" in flags,
                    "size": int(size_m.group(1)) if size_m else 0,
                    "has_attachments": bool(re.search(rb'\("attachment"', current_meta, re.I)),
                }

            for part in fetched:
                if isinstance(part, tuple):
                    if _MSG_START_RE.match(part[0]) and current_meta:
                        commit()
                        current_meta, current_hdr = b"", b""
                    current_meta += part[0]
                    current_hdr = part[1]
                elif isinstance(part, bytes):
                    if _MSG_START_RE.match(part) and current_meta:
                        commit()
                        current_meta, current_hdr = b"", b""
                    current_meta += b" " + part
            if current_meta:
                commit()
            items = [by_uid[int(u)] for u in chunk if int(u) in by_uid]
        return {"total": total, "page": page, "size": size, "items": items}

    # ---------------- single message ----------------
    def raw_message(self, folder: str, uid: int, peek: bool = True) -> bytes:
        self.select(folder, readonly=peek)
        spec = "(BODY.PEEK[])" if peek else "(BODY[])"
        data = self._ok(self.c.uid("FETCH", str(uid), spec), "Fetch")
        for part in data:
            if isinstance(part, tuple):
                return part[1]
        raise MailError("Message not found")

    def get_message(self, folder: str, uid: int) -> dict:
        raw = self.raw_message(folder, uid, peek=False)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        html_part = msg.get_body(preferencelist=("html",))
        text_part = msg.get_body(preferencelist=("plain",))
        html = _content(html_part) if html_part is not None else ""
        text = _content(text_part) if text_part is not None else ""
        body_parts = {id(p) for p in (html_part, text_part) if p is not None}

        attachments, cid_map = [], {}
        for index, part in enumerate(msg.walk()):
            if part.is_multipart() or id(part) in body_parts:
                continue
            filename = part.get_filename()
            disposition = part.get_content_disposition()
            cid = (part.get("Content-ID") or "").strip().strip("<>")
            payload = part.get_payload(decode=True) or b""
            if cid and html and f"cid:{cid}" in html and part.get_content_maintype() == "image":
                if len(payload) <= 4 * 1024 * 1024:
                    cid_map[cid] = f"data:{part.get_content_type()};base64,{base64.b64encode(payload).decode()}"
                    continue
            if disposition == "attachment" or filename:
                attachments.append({
                    "index": index,
                    "filename": filename or f"attachment-{index}",
                    "content_type": part.get_content_type(),
                    "size": len(payload),
                })
        for cid, uri in cid_map.items():
            html = html.replace(f"cid:{cid}", uri)

        return {
            "uid": uid, "folder": folder,
            "subject": _header(msg, "subject"),
            "from": _addresses(msg, "from"),
            "to": _addresses(msg, "to"),
            "cc": _addresses(msg, "cc"),
            "reply_to": _addresses(msg, "reply-to"),
            "date": _iso_date(msg),
            "message_id": _header(msg, "message-id"),
            "references": _header(msg, "references"),
            "html": sanitize_html(html) if html else "",
            "text": text,
            "attachments": attachments,
        }

    def get_attachment(self, folder: str, uid: int, index: int) -> tuple[str, str, bytes]:
        raw = self.raw_message(folder, uid)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        for i, part in enumerate(msg.walk()):
            if i == index and not part.is_multipart():
                return (part.get_filename() or f"attachment-{index}", part.get_content_type(),
                        part.get_payload(decode=True) or b"")
        raise MailError("Attachment not found")

    def attachments_of(self, folder: str, uid: int) -> list[tuple[str, str, bytes]]:
        raw = self.raw_message(folder, uid)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        result = []
        for part in msg.iter_attachments():
            if part.is_multipart():
                continue
            result.append((part.get_filename() or "attachment", part.get_content_type(),
                           part.get_payload(decode=True) or b""))
        return result

    # ---------------- changes ----------------
    def set_flags(self, folder: str, uids: list[int], flag: str, on: bool) -> None:
        self.select(folder)
        self._ok(self.c.uid("STORE", _uidset(uids), "+FLAGS" if on else "-FLAGS", f"({flag})"), "Update")

    def move(self, folder: str, uids: list[int], target: str) -> None:
        self.select(folder)
        typ, _ = self.c.uid("MOVE", _uidset(uids), quote(target))
        if typ != "OK":
            self._ok(self.c.uid("COPY", _uidset(uids), quote(target)), "Move")
            self.c.uid("STORE", _uidset(uids), "+FLAGS", "(\\Deleted)")
            self.c.expunge()

    def delete_forever(self, folder: str, uids: list[int]) -> None:
        self.select(folder)
        self._ok(self.c.uid("STORE", _uidset(uids), "+FLAGS", "(\\Deleted)"), "Delete")
        self.c.expunge()

    def empty(self, folder: str) -> None:
        self.select(folder)
        self.c.store("1:*", "+FLAGS", "(\\Deleted)")
        self.c.expunge()

    def append(self, folder: str, message: EmailMessage, flags: str) -> int | None:
        raw = message.as_bytes(policy=email.policy.SMTP)
        typ, data = self.c.append(quote(folder), flags, imaplib.Time2Internaldate(time.time()), raw)
        if typ != "OK":
            # The folder may simply not exist yet.
            self.c.create(quote(folder))
            self.c.subscribe(quote(folder))
            data = self._ok(self.c.append(quote(folder), flags, imaplib.Time2Internaldate(time.time()), raw),
                            "Save message")
        m = re.search(rb"APPENDUID \d+ (\d+)", data[0] if data and isinstance(data[0], bytes) else b"")
        return int(m.group(1)) if m else None


def _uidset(uids: list[int]) -> str:
    return ",".join(str(int(u)) for u in uids)


def _content(part) -> str:
    try:
        return part.get_content()
    except Exception:  # noqa: BLE001
        payload = part.get_payload(decode=True) or b""
        return payload.decode("utf-8", "replace")


def _iso_date(msg) -> str | None:
    try:
        value = msg["date"]
        return value.datetime.isoformat() if value is not None and value.datetime else None
    except Exception:  # noqa: BLE001
        return None
