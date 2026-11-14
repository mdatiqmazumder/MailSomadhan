"""Google Drive backups (admin only). The root helper does the work; see docs/BACKUP.md."""
import base64
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import require_admin
from ..models import Setting
from ..system import get_setting, run_helper, run_plain

router = APIRouter(dependencies=[Depends(require_admin)])
INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24, 168]
DEFAULTS = {"enabled": False, "interval_hours": 24, "hour": 2, "keep": 14, "include_mail": True,
            "folder": "MailSomadhan-Backups", "mode": "", "connected": False, "passphrase_set": False}


def _json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _state() -> Path:
    return Path(settings.status_dir)


def _helper(*args, stdin=None, timeout=60):
    ok, output = run_helper(*args, stdin=stdin, timeout=timeout)
    if not ok:
        msg = output.strip().splitlines()[-1] if output.strip() else "Operation failed"
        raise HTTPException(400, re.sub(r"^error: ", "", msg)[:500])
    return output


def _next_run() -> str | None:
    if settings.dev_mode:
        return None
    _c, out = run_plain(["systemctl", "show", "mailsomadhan-backup.timer", "-p", "NextElapseUSecRealtime", "--value"])
    return out.strip() or None


def _running() -> bool:
    if settings.dev_mode:
        return False
    _c, out = run_plain(["systemctl", "is-active", "mailsomadhan-backup.service"])
    return out.strip() in ("active", "activating")


def _put(db: Session, key: str, value: str) -> None:
    row = db.get(Setting, key)
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    db.commit()


def google_info(db: Session) -> dict:
    return {"client_id": get_setting(db, "google_client_id"),
            "secret_set": bool(get_setting(db, "google_client_secret")),
            "account": get_setting(db, "google_drive_account")}


@router.get("/backup")
def backup_info(db: Session = Depends(get_db)):
    return {
        "settings": {**DEFAULTS, **_json(_state() / "backup-settings.json", {})},
        "google": google_info(db),
        "status": _json(_state() / "backup-status.json", None),
        "running": _running(),
        "next_run": _next_run(),
        "intervals": INTERVALS,
    }


class SettingsIn(BaseModel):
    enabled: bool
    interval_hours: int
    hour: int = Field(ge=0, le=23)
    keep: int = Field(ge=1, le=999)
    include_mail: bool
    folder: str = Field(pattern=r"^[A-Za-z0-9._-]{1,100}$")


@router.put("/backup/settings")
def save_settings(body: SettingsIn, db: Session = Depends(get_db)):
    if body.interval_hours not in INTERVALS:
        raise HTTPException(400, "Unsupported interval")
    _helper("backup-configure", f"enabled={int(body.enabled)}", f"interval={body.interval_hours}",
            f"hour={body.hour}", f"keep={body.keep}", f"mail={int(body.include_mail)}", f"folder={body.folder}")
    return backup_info(db)


class CredentialsIn(BaseModel):
    mode: str = Field(pattern=r"^(oauth|service_account)$")
    token: str = Field(default="", max_length=20000)
    client_id: str = Field(default="", max_length=200)
    client_secret: str = Field(default="", max_length=200)
    service_account: str = Field(default="", max_length=20000)
    shared_drive_id: str = Field(default="", max_length=100)


@router.post("/backup/credentials")
def save_credentials(body: CredentialsIn, db: Session = Depends(get_db)):
    _helper("backup-credentials", stdin=json.dumps(body.model_dump()))
    _put(db, "google_drive_account", "")
    try:
        _helper("backup-test", timeout=90)
    except HTTPException as exc:
        raise HTTPException(400, f"Saved, but Google Drive could not be reached: {exc.detail}") from exc
    return backup_info(db)


@router.post("/backup/disconnect")
def disconnect(db: Session = Depends(get_db)):
    _helper("backup-disconnect")
    _put(db, "google_drive_account", "")
    return backup_info(db)


class PassphraseIn(BaseModel):
    passphrase: str = Field(min_length=12, max_length=500)


@router.post("/backup/passphrase")
def set_passphrase(body: PassphraseIn, db: Session = Depends(get_db)):
    _helper("backup-passphrase", stdin=body.passphrase)
    return backup_info(db)


@router.post("/backup/test")
def test_connection():
    _helper("backup-test", timeout=90)
    return {"ok": True}


@router.post("/backup/run")
def run_now():
    _helper("backup-start")
    return {"ok": True}


@router.get("/backup/files")
def list_files():
    out = _helper("backup-list", timeout=90)
    for line in reversed(out.splitlines()):
        if line.startswith("["):
            return json.loads(line)
    return []


@router.get("/backup/log")
def log():
    try:
        data = Path("/var/log/mailsomadhan-backup.log").read_bytes()[-32000:].decode("utf-8", "replace")
    except OSError:
        data = ""
    return {"log": data, "running": _running(), "status": _json(_state() / "backup-status.json", None)}


# ---------------------------------------------------------------- "Connect Google Drive" sign-in link
# The organisation creates its own OAuth client (type "Web application") in Google Cloud Console once
# and enters its ID and secret here. After that, connecting is a link: Google's consent screen sends the
# admin back to /admin/backups/google, which hands the code to /backup/google/finish. The refresh token
# goes straight into the root-only rclone.conf through the helper; the panel never shows it again.
GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
# drive.file: the server only sees files it created itself (its backups), not the rest of the Drive.
# It is a non-sensitive scope, so Google does not require app verification for it.
GOOGLE_SCOPES = f"{DRIVE_FILE} openid email"
CLIENT_ID_RE = re.compile(r"^[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$")
SECRET_RE = re.compile(r"^[A-Za-z0-9._-]{10,200}$")
REDIRECT_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]{1,300}/admin/backups/google$")
STATE_TTL = 15 * 60


class GoogleStartIn(BaseModel):
    redirect_uri: str = Field(max_length=400)
    client_id: str = Field(default="", max_length=200)
    client_secret: str = Field(default="", max_length=200)


@router.post("/backup/google/start")
def google_start(body: GoogleStartIn, db: Session = Depends(get_db)):
    if not REDIRECT_RE.match(body.redirect_uri):
        raise HTTPException(400, "Invalid redirect address")
    cid, sec = body.client_id.strip(), body.client_secret.strip()
    if cid:
        if not CLIENT_ID_RE.match(cid):
            raise HTTPException(400, "That does not look like a Google OAuth client ID (…apps.googleusercontent.com)")
        _put(db, "google_client_id", cid)
    if sec:
        if not SECRET_RE.match(sec):
            raise HTTPException(400, "That does not look like a Google OAuth client secret")
        _put(db, "google_client_secret", sec)
    info = google_info(db)
    if not info["client_id"] or not info["secret_set"]:
        raise HTTPException(400, "Enter the OAuth client ID and secret from Google Cloud Console first")
    state = secrets.token_urlsafe(32)
    _put(db, "google_oauth_state", json.dumps({"state": state, "redirect_uri": body.redirect_uri, "at": int(time.time())}))
    params = {
        "client_id": info["client_id"], "redirect_uri": body.redirect_uri, "response_type": "code",
        "scope": GOOGLE_SCOPES, "access_type": "offline", "prompt": "consent", "state": state,
    }
    return {"url": f"{GOOGLE_AUTH}?{urllib.parse.urlencode(params)}"}


class GoogleFinishIn(BaseModel):
    code: str = Field(min_length=10, max_length=2000)
    state: str = Field(min_length=10, max_length=200)


def _exchange(fields: dict) -> dict:
    req = urllib.request.Request(GOOGLE_TOKEN, data=urllib.parse.urlencode(fields).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read())
            detail = f'{err.get("error", "")}: {err.get("error_description", "")}'.strip(": ")
        except ValueError:
            detail = str(exc)
        if "redirect_uri_mismatch" in detail:
            detail = "the redirect address is not registered on the OAuth client (redirect_uri_mismatch)"
        elif "invalid_client" in detail or "unauthorized_client" in detail:
            detail = "Google rejected the client ID or secret"
        raise HTTPException(400, f"Google sign-in failed: {detail or exc}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise HTTPException(502, f"Could not reach Google: {exc}") from exc


def _id_token_email(id_token: str) -> str:
    """Email claim of the ID token. It came straight from Google over TLS, so the signature needs no check."""
    try:
        payload = id_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return str(claims.get("email", ""))[:200]
    except (IndexError, ValueError):
        return ""


@router.post("/backup/google/finish")
def google_finish(body: GoogleFinishIn, db: Session = Depends(get_db)):
    try:
        pending = json.loads(get_setting(db, "google_oauth_state") or "{}")
    except ValueError:
        pending = {}
    if not pending.get("state") or not secrets.compare_digest(str(pending["state"]), body.state):
        raise HTTPException(400, "This sign-in link has expired or was already used. Click Connect Google Drive again.")
    _put(db, "google_oauth_state", "")  # one use only
    if time.time() - int(pending.get("at", 0)) > STATE_TTL:
        raise HTTPException(400, "The sign-in took too long. Click Connect Google Drive again.")
    cid, sec = get_setting(db, "google_client_id"), get_setting(db, "google_client_secret")
    tok = _exchange({"code": body.code, "client_id": cid, "client_secret": sec,
                     "redirect_uri": pending["redirect_uri"], "grant_type": "authorization_code"})
    if not tok.get("refresh_token"):
        raise HTTPException(400, "Google did not return a refresh token. Remove this app's access at "
                                 "myaccount.google.com/permissions and connect again.")
    granted = set(str(tok.get("scope", "")).split())
    if DRIVE_FILE not in granted and "https://www.googleapis.com/auth/drive" not in granted:
        raise HTTPException(400, "Access to Google Drive was not granted. Connect again and tick the Google Drive box.")
    expiry = datetime.now(timezone.utc) + timedelta(seconds=int(tok.get("expires_in", 3600)))
    rclone_token = {"access_token": tok.get("access_token", ""), "token_type": tok.get("token_type", "Bearer"),
                    "refresh_token": tok["refresh_token"], "expiry": expiry.strftime("%Y-%m-%dT%H:%M:%SZ")}
    _helper("backup-credentials", stdin=json.dumps({
        "mode": "oauth", "token": json.dumps(rclone_token), "client_id": cid, "client_secret": sec,
        "scope": "drive.file",
    }))
    _put(db, "google_drive_account", _id_token_email(tok.get("id_token", "")))
    try:
        _helper("backup-test", timeout=90)
    except HTTPException as exc:
        raise HTTPException(400, f"Connected, but Google Drive could not be reached: {exc.detail}") from exc
    return backup_info(db)
