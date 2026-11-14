"""Browser push notifications for new mail through Firebase Cloud Messaging (HTTP v1 API).

The administrator stores the Firebase project's credentials once in the panel (encrypted, see
secretbox.py). Each browser that turns notifications on registers an FCM token (PushToken). The
collector, which already sees every local delivery in the Postfix log, hands new-mail events to the
Notifier thread here, which sends one message per browser.
"""
import json
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt
from sqlalchemy.orm import Session

from . import secretbox
from .models import Mailbox, MailMessage, PushToken, Setting

SETTING = "push_credentials"
PREVIEW_SETTING = "push_show_preview"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
SPAM_ACTIONS = ("add header", "rewrite subject", "reject", "soft reject")


class PushError(Exception):
    pass


# ---------------------------------------------------------------- credentials
def load_credentials(db: Session) -> dict | None:
    row = db.get(Setting, SETTING)
    if not row or not row.value:
        return None
    try:
        return json.loads(secretbox.decrypt(row.value))
    except ValueError:
        return None


def save_credentials(db: Session, creds: dict | None) -> None:
    row = db.get(Setting, SETTING)
    value = secretbox.encrypt(json.dumps(creds)) if creds else ""
    if row:
        row.value = value
    else:
        db.add(Setting(key=SETTING, value=value))
    db.commit()
    _token_cache.clear()


def show_preview(db: Session) -> bool:
    row = db.get(Setting, PREVIEW_SETTING)
    return not row or row.value != "0"


# ---------------------------------------------------------------- Google OAuth for the service account
_token_cache: dict[str, tuple[str, float]] = {}
_cache_lock = threading.Lock()


def _post(url: str, data: bytes, headers: dict, timeout: int = 15) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise PushError(f"Could not reach Google: {exc}") from exc


def access_token(sa: dict) -> str:
    key = sa["client_email"]
    with _cache_lock:
        cached = _token_cache.get(key)
        if cached and cached[1] > time.time() + 60:
            return cached[0]
    now = int(time.time())
    token_uri = sa.get("token_uri") or "https://oauth2.googleapis.com/token"
    try:
        assertion = jwt.encode({"iss": sa["client_email"], "scope": FCM_SCOPE, "aud": token_uri,
                                "iat": now, "exp": now + 3600}, sa["private_key"], algorithm="RS256")
    except Exception as exc:  # noqa: BLE001 - malformed key
        raise PushError("The service account's private key is not valid. Paste the whole JSON file.") from exc
    status, body = _post(token_uri, urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}).encode(),
        {"Content-Type": "application/x-www-form-urlencoded"})
    if status != 200 or "access_token" not in body:
        detail = body.get("error_description") or body.get("error") or f"HTTP {status}"
        raise PushError(f"Google refused the service account: {detail}")
    with _cache_lock:
        _token_cache[key] = (body["access_token"], now + int(body.get("expires_in", 3600)))
    return body["access_token"]


# ---------------------------------------------------------------- sending
def send(creds: dict, token: str, data: dict[str, str]) -> str:
    """Send one data message. Returns "ok", "gone" (token no longer valid: delete it) or "error"."""
    sa = creds["service_account"]
    body = {"message": {"token": token, "data": data,
                        "webpush": {"headers": {"Urgency": "high", "TTL": "86400"}}}}
    status, resp = _post(
        f"https://fcm.googleapis.com/v1/projects/{sa['project_id']}/messages:send",
        json.dumps(body).encode(),
        {"Authorization": f"Bearer {access_token(sa)}", "Content-Type": "application/json"})
    if status == 200:
        return "ok"
    err = resp.get("error", {})
    codes = {d.get("errorCode") for d in err.get("details", []) if isinstance(d, dict)}
    if status == 404 or codes & {"UNREGISTERED", "SENDER_ID_MISMATCH"} or (
            status == 400 and "registration token" in str(err.get("message", "")).lower()):
        return "gone"
    if status == 401:
        _token_cache.clear()
    print(f"push: FCM answered {status}: {err.get('message', '')[:200]}", flush=True)
    return "error"


def notify_mailbox(db: Session, email: str, data: dict[str, str]) -> int:
    """Send to every browser of a mailbox; drops tokens Google says are dead. Returns messages sent."""
    creds = load_credentials(db)
    if not creds:
        return 0
    box = db.query(Mailbox).filter_by(email=email).first()
    if not box or not box.active:
        return 0
    sent = 0
    for t in db.query(PushToken).filter_by(mailbox_id=box.id).all():
        if t.token_version != box.token_version:  # signed out everywhere / password reset since then
            db.delete(t)
            continue
        try:
            result = send(creds, t.token, data)
        except PushError as exc:
            print(f"push: {exc}", flush=True)
            break
        if result == "gone":
            db.delete(t)
        elif result == "ok":
            sent += 1
    db.commit()
    return sent


def new_mail_payload(db: Session, email: str, messages: list[MailMessage]) -> dict[str, str]:
    data = {"url": "/mail", "tag": f"mail:{email}", "kind": "mail"}
    if len(messages) > 1:
        data["title"] = f"{len(messages)} new messages"
        data["body"] = email
    elif show_preview(db):
        m = messages[0]
        data["title"] = m.sender or "New message"
        data["body"] = m.subject or "(no subject)"
    else:
        data["title"] = "New message"
        data["body"] = email
    return {k: v[:300] for k, v in data.items()}


class Notifier(threading.Thread):
    """Runs inside the collector. Waits a few seconds after each delivery so the spam verdict (logged
    separately by Rspamd) is known, groups bursts per mailbox, then sends."""

    DELAY = 3.0

    def __init__(self, session_factory):
        super().__init__(daemon=True)
        self.session_factory = session_factory
        self.jobs: queue.Queue = queue.Queue(maxsize=5000)

    def delivered(self, recipient: str, message_pk: int | None) -> None:
        if message_pk is None:
            return
        try:
            self.jobs.put_nowait((time.time(), recipient, message_pk))
        except queue.Full:
            pass

    def run(self) -> None:
        pending: dict[str, list[tuple[float, int]]] = {}
        while True:
            try:
                at, rcpt, pk = self.jobs.get(timeout=1)
                pending.setdefault(rcpt, []).append((at, pk))
                continue
            except queue.Empty:
                pass
            now = time.time()
            for rcpt in [r for r, items in pending.items() if now - items[0][0] >= self.DELAY]:
                items = pending.pop(rcpt)
                try:
                    self.flush(rcpt, [pk for _at, pk in items])
                except Exception as exc:  # noqa: BLE001 - notifications must never stop the collector
                    print(f"push: notification for {rcpt} failed: {exc}", flush=True)

    def flush(self, rcpt: str, pks: list[int]) -> None:
        with self.session_factory() as db:
            if db.get(Setting, SETTING) is None:
                return
            msgs = [m for m in db.query(MailMessage).filter(MailMessage.id.in_(pks)).all()
                    if m.spam_action not in SPAM_ACTIONS and m.direction != "outbound"]
            if msgs:
                notify_mailbox(db, rcpt, new_mail_payload(db, rcpt, msgs))
