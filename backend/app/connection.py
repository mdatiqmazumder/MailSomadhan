"""Connection settings for a mailbox (webmail, IMAP, SMTP) and the welcome message sent to new mailboxes."""
import html
import logging
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from sqlalchemy.orm import Session

from .config import settings
from .imap_client import MailError, MailSession
from .models import Host, Mailbox
from .system import get_setting, tls_info

log = logging.getLogger("mailsomadhan.connection")

IMAP_PORT = 993
SMTP_PORTS = ((465, "SSL/TLS"), (587, "STARTTLS"))


def mail_host_for(db: Session, domain: str) -> tuple[str, str]:
    """The hostname mail apps should use for `domain`, and its certificate status.

    A host of the domain itself (for example mail.example.com for example.com) is used when it has a
    certificate; otherwise the primary host, which every service always answers on."""
    primary = db.query(Host).filter_by(is_primary=True).first()
    primary_name = primary.hostname if primary else settings.primary_hostname
    best: tuple[str, str] | None = None
    for h in db.query(Host).filter_by(is_primary=False).all():
        if h.hostname != domain and not h.hostname.endswith("." + domain):
            continue
        status = tls_info(h.hostname)["status"]
        if status == "trusted":
            return h.hostname, status
        if status == "self-signed" and best is None:
            best = (h.hostname, status)
    return best or (primary_name, tls_info(primary_name)["status"])


def connection_info(db: Session, mbox: Mailbox) -> dict:
    domain = mbox.email.split("@", 1)[1]
    host, cert = mail_host_for(db, domain)
    port = "" if settings.web_port == 443 else f":{settings.web_port}"
    return {
        "email": mbox.email,
        "username": mbox.email,
        "host": host,
        "certificate": cert,  # trusted | self-signed | none | error
        "webmail_url": f"https://{host}{port}/login",
        "imap": {"host": host, "port": IMAP_PORT, "security": "SSL/TLS"},
        "smtp": [{"host": host, "port": p, "security": s} for p, s in SMTP_PORTS],
    }


def _rows(info: dict) -> list[tuple[str, str]]:
    smtp = info["smtp"]
    return [
        ("Email address", info["email"]),
        ("Username", info["username"]),
        ("Password", "The password your administrator gave you"),
        ("Webmail", info["webmail_url"]),
        ("Incoming server (IMAP)", f"{info['imap']['host']}, port {info['imap']['port']}, {info['imap']['security']}"),
        ("Outgoing server (SMTP)", f"{smtp[0]['host']}, port {smtp[0]['port']}, {smtp[0]['security']}"),
        ("Outgoing server (alternative)", f"{smtp[1]['host']}, port {smtp[1]['port']}, {smtp[1]['security']}"),
        ("Outgoing authentication", "Required: same username and password"),
    ]


def welcome_message(db: Session, mbox: Mailbox) -> EmailMessage:
    info = connection_info(db, mbox)
    brand = get_setting(db, "brand_name").strip() or "MailSomadhan"
    domain = mbox.email.split("@", 1)[1]
    name = mbox.display_name.strip()
    greeting = f"Hello {name}," if name else "Hello,"
    rows = _rows(info)

    text = "\n".join([
        greeting, "",
        f"Your mailbox {mbox.email} is ready. You can read and send mail in the browser, or add the",
        "account to a mail app (Outlook, Thunderbird, Apple Mail, or the mail app on your phone).", "",
        *[f"{label}: {value}" for label, value in rows], "",
        "In a mail app, choose manual setup and use IMAP. Use your full email address as the username",
        "for both incoming and outgoing mail.", "",
        "You can change your password at any time in webmail under Account settings.",
        "Keep this message: it has everything you need to set up a new device.", "",
        f"{brand}",
    ])

    e = html.escape
    table = "".join(
        f'<tr><td style="padding:8px 12px;border-top:1px solid #e5e7eb;color:#6b7280;white-space:nowrap">{e(label)}</td>'
        f'<td style="padding:8px 12px;border-top:1px solid #e5e7eb;font-family:Consolas,Menlo,monospace;word-break:break-all">{e(value)}</td></tr>'
        for label, value in rows
    )
    body = f"""<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
<div style="padding:22px 24px 6px"><h1 style="margin:0 0 6px;font-size:20px">Welcome to your new mailbox</h1>
<p style="margin:0 0 14px;color:#374151">{e(greeting)}</p>
<p style="margin:0 0 14px;color:#374151;line-height:1.55">Your mailbox <b>{e(mbox.email)}</b> is ready. You can read and send mail in the browser, or add the account to a mail app such as Outlook, Thunderbird, Apple Mail, or the mail app on your phone.</p>
<p style="margin:0 0 18px"><a href="{e(info['webmail_url'])}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open webmail</a></p></div>
<table style="width:100%;border-collapse:collapse;font-size:14px">{table}</table>
<div style="padding:16px 24px 22px;color:#4b5563;font-size:13px;line-height:1.55">
<p style="margin:0 0 8px">In a mail app, choose <b>manual setup</b> and <b>IMAP</b>. Use your full email address as the username for both incoming and outgoing mail.</p>
<p style="margin:0 0 8px">You can change your password at any time in webmail under <b>Account settings</b>, where these settings are also shown.</p>
<p style="margin:0">Keep this message: it has everything you need to set up a new device.</p></div>
</div><p style="max-width:620px;margin:12px auto 0;color:#9ca3af;font-size:12px;text-align:center">{e(brand)}</p></body></html>"""

    msg = EmailMessage()
    msg["From"] = Address(brand, "postmaster", domain)
    msg["To"] = Address(name, *mbox.email.split("@", 1)) if name else mbox.email
    msg["Subject"] = f"Welcome: your mailbox {mbox.email} is ready"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=domain)
    msg.set_content(text)
    msg.add_alternative(body, subtype="html")
    return msg


def deliver_welcome(db: Session, mbox: Mailbox) -> bool:
    """Place the welcome message in the mailbox's inbox. Failure never blocks mailbox creation."""
    if settings.dev_mode:
        return False
    try:
        msg = welcome_message(db, mbox)
        with MailSession(mbox.email) as s:
            s.append("INBOX", msg, "")
        return True
    except (MailError, OSError, Exception) as exc:  # noqa: BLE001
        log.warning("welcome message for %s not delivered: %s", mbox.email, exc)
        return False
