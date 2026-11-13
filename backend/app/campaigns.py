"""Individual sending ("campaigns"): merge fields, unsubscribe tokens and message building.
Shared by the API (preview, validation) and the campaign worker (sending)."""
import base64
import hashlib
import hmac
import html as html_lib
import json
import mimetypes
import re
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from .config import settings

FIELD_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|([^}]*))?\}\}")
COLUMN_RE = re.compile(r"[^a-z0-9_]+")


def normalize_column(name: str) -> str:
    return COLUMN_RE.sub("_", name.strip().lower()).strip("_")[:40] or "field"


def recipient_fields(email: str, fields: dict) -> dict:
    data = {normalize_column(k): str(v).strip() for k, v in fields.items() if v is not None}
    data["email"] = email
    name = data.get("name", "")
    if name and not data.get("first_name"):
        data["first_name"] = name.split()[0]
    return data


def render(template: str, fields: dict, escape: bool) -> str:
    """Replace {{field}} or {{field|fallback}}. Values are HTML-escaped inside HTML bodies."""

    def sub(m: re.Match) -> str:
        value = fields.get(m.group(1).lower(), "") or (m.group(2) or "").strip()
        return html_lib.escape(value) if escape else value

    return FIELD_RE.sub(sub, template)


def used_fields(*templates: str) -> set[str]:
    return {m.group(1).lower() for t in templates for m in FIELD_RE.finditer(t) if not m.group(2)}


# ---------------------------------------------------------------- unsubscribe
def _sig(recipient_id: int) -> str:
    mac = hmac.new(settings.secret_key.encode(), f"unsub:{recipient_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")[:24]


def unsubscribe_token(recipient_id: int) -> str:
    return f"{recipient_id}.{_sig(recipient_id)}"


def read_unsubscribe_token(token: str) -> int | None:
    rid, _, sig = token.partition(".")
    if not rid.isdigit() or not hmac.compare_digest(sig, _sig(int(rid))):
        return None
    return int(rid)


def panel_base_url() -> str:
    port = "" if settings.web_port == 443 else f":{settings.web_port}"
    return f"https://{settings.primary_hostname}{port}"


def unsubscribe_url(recipient_id: int) -> str:
    return f"{panel_base_url()}/u/{unsubscribe_token(recipient_id)}"


def unsubscribe_footer(url: str) -> str:
    return (
        '<p style="margin-top:24px;font-size:12px;color:#888">If you would rather not receive emails like this, '
        f'<a href="{html_lib.escape(url)}" style="color:#888">unsubscribe here</a>.</p>'
    )


# ---------------------------------------------------------------- message
def html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", "", html)
    text = re.sub(r'(?is)<a\s[^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"\2 (\1)", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|tr|blockquote)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"


def build_message(*, sender_email: str, sender_name: str, to_email: str, subject: str, html: str,
                  attachments: list[tuple[str, str, bytes]], unsubscribe: str | None) -> EmailMessage:
    local, _, domain = sender_email.partition("@")
    msg = EmailMessage()
    msg["From"] = Address(display_name=re.sub(r"[\r\n]+", " ", sender_name).strip(), username=local, domain=domain)
    msg["To"] = to_email
    msg["Subject"] = re.sub(r"[\r\n]+", " ", subject).strip()[:900]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain)
    msg["X-Mailer"] = "MailSomadhan"
    if unsubscribe:
        # RFC 2369 + RFC 8058 one-click unsubscribe (required by Gmail/Yahoo for bulk senders).
        msg["List-Unsubscribe"] = f"<{unsubscribe.replace('/u/', '/api/public/unsubscribe/')}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        html = html + unsubscribe_footer(unsubscribe)
    msg.set_content(html_to_text(html))
    msg.add_alternative(f"<!doctype html><html><body>{html}</body></html>", subtype="html")
    for filename, ctype, data in attachments:
        maintype, _, subtype = (ctype or mimetypes.guess_type(filename)[0] or "application/octet-stream").partition("/")
        if not subtype or maintype in ("multipart", "message"):
            maintype, subtype = "application", "octet-stream"
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return msg


def load_attachments(spec: str) -> list[tuple[str, str, bytes]]:
    out = []
    for item in json.loads(spec or "[]"):
        try:
            with open(item["path"], "rb") as fh:
                out.append((item["name"], item.get("type", ""), fh.read()))
        except OSError:
            continue
    return out
