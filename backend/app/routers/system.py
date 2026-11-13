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
    installed = _read_json(Path(settings.state_dir) / "version.json") or {}
    return {
        "version": installed.get("version", "unknown"),
        "commit": installed.get("commit", ""),
        "installed_at": installed.get("installed_at"),
        "update_running": _update_running(),
        "last_result": _read_json(Path(settings.state_dir) / "update-result.json"),
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
        "result": _read_json(Path(settings.state_dir) / "update-result.json"),
        "log": _log_tail(),
    }
