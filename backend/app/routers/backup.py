"""Google Drive backups (admin only). The root helper does the work; see docs/BACKUP.md."""
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..config import settings
from ..deps import require_admin
from ..system import run_helper, run_plain

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


@router.get("/backup")
def backup_info():
    return {
        "settings": {**DEFAULTS, **_json(_state() / "backup-settings.json", {})},
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
def save_settings(body: SettingsIn):
    if body.interval_hours not in INTERVALS:
        raise HTTPException(400, "Unsupported interval")
    _helper("backup-configure", f"enabled={int(body.enabled)}", f"interval={body.interval_hours}",
            f"hour={body.hour}", f"keep={body.keep}", f"mail={int(body.include_mail)}", f"folder={body.folder}")
    return backup_info()


class CredentialsIn(BaseModel):
    mode: str = Field(pattern=r"^(oauth|service_account)$")
    token: str = Field(default="", max_length=20000)
    client_id: str = Field(default="", max_length=200)
    client_secret: str = Field(default="", max_length=200)
    service_account: str = Field(default="", max_length=20000)
    shared_drive_id: str = Field(default="", max_length=100)


@router.post("/backup/credentials")
def save_credentials(body: CredentialsIn):
    _helper("backup-credentials", stdin=json.dumps(body.model_dump()))
    try:
        _helper("backup-test", timeout=90)
    except HTTPException as exc:
        raise HTTPException(400, f"Saved, but Google Drive could not be reached: {exc.detail}") from exc
    return backup_info()


@router.post("/backup/disconnect")
def disconnect():
    _helper("backup-disconnect")
    return backup_info()


class PassphraseIn(BaseModel):
    passphrase: str = Field(min_length=12, max_length=500)


@router.post("/backup/passphrase")
def set_passphrase(body: PassphraseIn):
    _helper("backup-passphrase", stdin=body.passphrase)
    return backup_info()


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
