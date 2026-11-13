"""Admin endpoints for one-click updates and the spam filter / Redis switches."""
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..config import settings
from ..deps import require_admin
from ..system import run_helper, run_plain

router = APIRouter(dependencies=[Depends(require_admin)])

FEATURE_DEFAULTS = {"SPAM_FILTER": "1", "REDIS": "1", "GREYLIST": "1", "JUNK_SCORE": "6", "REJECT_SCORE": "15",
                    "TRACK_SUBJECTS": "0"}


# ---------------------------------------------------------------- spam filter / Redis
def _features_path() -> Path:
    if settings.dev_mode:
        return Path(settings.state_dir) / "features.conf"
    return Path(settings.features_file)


def read_features() -> dict:
    values = dict(FEATURE_DEFAULTS)
    try:
        for line in _features_path().read_text().splitlines():
            m = re.match(r"^([A-Z_]+)=([0-9.]+)$", line.strip())
            if m and m.group(1) in values:
                values[m.group(1)] = m.group(2)
    except OSError:
        pass
    return {
        "spam_filter": values["SPAM_FILTER"] == "1",
        "redis": values["REDIS"] == "1",
        "greylist": values["GREYLIST"] == "1",
        "junk_score": float(values["JUNK_SCORE"]),
        "reject_score": float(values["REJECT_SCORE"]),
        "track_subjects": values["TRACK_SUBJECTS"] == "1",
    }


class FeaturesIn(BaseModel):
    spam_filter: bool
    redis: bool
    greylist: bool
    junk_score: float = Field(ge=1, le=199)
    reject_score: float = Field(ge=2, le=200)
    track_subjects: bool = False


def _num(value: float) -> str:
    return f"{round(value, 2):g}"


@router.get("/features")
def get_features():
    return read_features()


@router.put("/features")
def put_features(body: FeaturesIn):
    if body.reject_score <= body.junk_score:
        raise HTTPException(400, "The reject score must be higher than the junk score")
    args = {
        "spam": "1" if body.spam_filter else "0",
        "redis": "1" if body.redis else "0",
        "greylist": "1" if body.greylist and body.redis else "0",
        "junk": _num(body.junk_score),
        "reject": _num(body.reject_score),
        "subjects": "1" if body.track_subjects else "0",
    }
    if settings.dev_mode:
        path = _features_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        keys = {"spam": "SPAM_FILTER", "redis": "REDIS", "greylist": "GREYLIST", "junk": "JUNK_SCORE",
                "reject": "REJECT_SCORE", "subjects": "TRACK_SUBJECTS"}
        path.write_text("".join(f"{keys[k]}={v}\n" for k, v in args.items()))
    else:
        ok, output = run_helper("set-features", *(f"{k}={v}" for k, v in args.items()), timeout=120)
        if not ok:
            raise HTTPException(502, f"Could not apply the change: {output[-1500:]}")
    return read_features()


# ---------------------------------------------------------------- updates
def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _update_running() -> bool:
    if settings.dev_mode:
        return False
    _code, out = run_plain(["systemctl", "is-active", "mailsomadhan-update"])
    return out.strip() in ("active", "activating")


def _log_tail(lines: int = 200) -> str:
    try:
        with open(settings.update_log, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 64 * 1024))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    data = re.sub(r"\x1b\[[0-9;]*m", "", data)  # strip terminal colours
    return "\n".join(data.splitlines()[-lines:])


@router.get("/system")
def system_info():
    installed = _read_json(Path(settings.status_dir) / "version.json") or {}
    return {
        "version": installed.get("version", "unknown"),
        "commit": installed.get("commit", ""),
        "installed_at": installed.get("installed_at"),
        "update_running": _update_running(),
        "last_result": _read_json(Path(settings.status_dir) / "update-result.json"),
    }


@router.post("/system/check")
def check_updates():
    if settings.dev_mode:
        raise HTTPException(400, "Update checks are not available in development mode")
    ok, output = run_helper("update-check", timeout=180)
    if not ok:
        raise HTTPException(502, f"Could not check for updates: {output[-800:]}")
    for line in reversed(output.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    raise HTTPException(502, "Unexpected answer from the update check")


@router.post("/system/update")
def start_update():
    if settings.dev_mode:
        raise HTTPException(400, "Updates are not available in development mode")
    ok, output = run_helper("update-start", timeout=30)
    if not ok:
        raise HTTPException(409 if "already running" in output else 502, output[-800:])
    return {"ok": True}


@router.get("/system/update-status")
def update_status():
    return {
        "running": _update_running(),
        "result": _read_json(Path(settings.status_dir) / "update-result.json"),
        "log": _log_tail(),
    }


@router.get("/system/update-notice")
def update_notice():
    """For the header: is a newer version known? Read from the last automatic or manual check
    (mailsomadhan-update-check.timer runs one every 6 hours); never contacts GitHub itself."""
    installed = _read_json(Path(settings.status_dir) / "version.json") or {}
    check = _read_json(Path(settings.status_dir) / "update-check.json") or {}
    latest = check.get("latest_commit", "")
    return {
        "update_available": bool(latest) and latest != installed.get("commit", "") and not _update_running(),
        "current_version": installed.get("version", ""),
        "latest_version": check.get("latest_version", ""),
        "checked_at": check.get("checked_at"),
        "update_running": _update_running(),
    }


# ---------------------------------------------------------------- services and scheduled jobs
SERVICES_INFO = [
    # name, label, what it does, can be restarted from the panel
    ("postfix", "Mail transfer (Postfix)", "Receives mail from the internet and sends your users' mail out. Holds the mail queue.", True),
    ("dovecot", "Mailbox access (Dovecot)", "Stores mail and serves IMAP for webmail and mail apps; enforces storage quotas.", True),
    ("rspamd", "Spam filter (Rspamd)", "Checks every message for spam and viruses and signs outgoing mail with DKIM.", True),
    ("redis-server", "Redis", "Memory for the spam filter: greylisting and learned spam data.", True),
    ("postgresql", "Database (PostgreSQL)", "Domains, mailboxes, settings and the message log.", False),
    ("nginx", "Web server (nginx)", "Serves the panel and webmail over HTTPS and answers certificate checks.", True),
    ("fail2ban", "Brute-force protection (fail2ban)", "Blocks addresses that keep failing to sign in.", True),
    ("mailsomadhan-api", "Panel API", "The back end of this panel and of webmail.", True),
    ("mailsomadhan-web", "Panel web app", "The pages of this panel and of webmail.", True),
    ("mailsomadhan-collector", "Mail log collector (job)", "Reads the mail log continuously and fills the message log, analytics and campaign delivery status.", True),
    ("mailsomadhan-campaigns", "Campaign sender (queue worker)", "Sends queued campaign messages one by one with the chosen pacing and limits.", True),
]
TIMERS_INFO = [
    ("mailsomadhan-backup.timer", "Scheduled backup", "Encrypted backup to Google Drive on the schedule set under Backups."),
    ("mailsomadhan-update-check.timer", "Update check", "Looks for a new MailSomadhan version every 6 hours."),
    ("certbot.timer", "Certificate renewal", "Renews Let's Encrypt certificates before they expire."),
]


def _unit(name: str) -> dict:
    import os
    import subprocess

    try:
        # TZ=UTC: systemctl prints every timestamp in the time zone of its environment.
        out = subprocess.run(["systemctl", "show", name, "--property=ActiveState,SubState,UnitFileState,"
                              "ActiveEnterTimestamp,NextElapseUSecRealtime,LastTriggerUSec,LoadState"],
                             capture_output=True, text=True, timeout=15, env={**os.environ, "TZ": "UTC"}).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)

    def stamp(key: str) -> str | None:
        # "Fri 2026-11-14 01:02:03 UTC" -> ISO 8601
        m = re.search(r"(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC", props.get(key, ""))
        return f"{m.group(1)}T{m.group(2)}Z" if m else None

    return {"state": props.get("ActiveState", "unknown"), "sub": props.get("SubState", ""),
            "enabled": props.get("UnitFileState", ""), "installed": props.get("LoadState") == "loaded",
            "since": stamp("ActiveEnterTimestamp"), "next": stamp("NextElapseUSecRealtime"), "last": stamp("LastTriggerUSec")}


@router.get("/system/services")
def services():
    if settings.dev_mode:
        fake = {"state": "active", "sub": "running", "enabled": "enabled", "installed": True, "since": None, "next": None, "last": None}
        return {"services": [{"name": n, "label": l, "description": d, "restartable": r, **fake} for n, l, d, r in SERVICES_INFO],
                "timers": [{"name": n, "label": l, "description": d, **fake, "sub": "waiting"} for n, l, d in TIMERS_INFO]}
    return {
        "services": [{"name": n, "label": l, "description": d, "restartable": r, **_unit(n)} for n, l, d, r in SERVICES_INFO],
        "timers": [{"name": n, "label": l, "description": d, **_unit(n)} for n, l, d in TIMERS_INFO],
    }


@router.post("/system/services/{name}/restart")
def restart_service(name: str):
    if name not in {n for n, _l, _d, r in SERVICES_INFO if r}:
        raise HTTPException(400, "This service cannot be restarted from the panel")
    if settings.dev_mode:
        return {"ok": True}
    ok, output = run_helper("service-restart", name, timeout=90)
    if not ok:
        raise HTTPException(502, output[-600:] or "Restart failed")
    return {"ok": True}
