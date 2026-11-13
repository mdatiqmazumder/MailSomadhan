"""Certificate requests with three validation methods.

  http        Let's Encrypt fetches a file from http://<host>/.well-known/acme-challenge/
              (our nginx on port 80, or another web server on port 80 serving the same folder)
  dns         the admin adds a TXT record by hand; the request waits until they press Verify
  cloudflare  the TXT record is created automatically through the Cloudflare API

Requests run in the background (systemd unit mailsomadhan-tls); the panel polls /tls/job.
"""
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import require_admin
from ..models import Host
from ..security import EMAIL_RE
from ..system import _resolve, get_setting, run_helper, write_hosts_file

router = APIRouter(dependencies=[Depends(require_admin)])

ACME_ROOT = "/var/www/mailsomadhan-acme"
HELPER_CONF = "/etc/mailsomadhan/helper.conf"


def _read_json(name: str) -> dict:
    try:
        return json.loads((Path(settings.status_dir) / name).read_text())
    except (OSError, ValueError):
        return {}


def http_port() -> int:
    try:
        m = re.search(r"^HTTP_PORT='?(\d+)'?", Path(HELPER_CONF).read_text(), re.M)
        return int(m.group(1)) if m else 80
    except OSError:
        return 80


def _log_tail(lines: int = 25) -> str:
    try:
        return "\n".join(Path("/var/log/mailsomadhan-tls.log").read_text(errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


@router.get("/tls/job")
def tls_job():
    job = _read_json("tls-job.json")
    if job.get("state") == "waiting_dns" and job.get("record"):
        job["dns_visible"] = job.get("value", "") in _resolve(job["record"], "TXT")
    if job.get("state") in ("failed", "running"):
        job["log"] = _log_tail()
    cf = _read_json("cloudflare.json")
    return {
        "job": job or None,
        "http_port": http_port(),
        "acme_root": ACME_ROOT,
        "cloudflare": {"configured": bool(cf.get("configured")), "hint": cf.get("hint", "")},
    }


class CertIn(BaseModel):
    method: str = Field(pattern="^(http|dns|cloudflare)$")


@router.post("/hosts/{host_id}/certificate")
def request_certificate(host_id: int, body: CertIn, db: Session = Depends(get_db)):
    host = db.get(Host, host_id)
    if not host:
        raise HTTPException(404, "Host not found")
    write_hosts_file(db)
    args = ["tls-start", body.method, host.hostname]
    email = get_setting(db, "acme_email").strip()
    if email and EMAIL_RE.match(email):
        args.append(email)
    ok, out = run_helper(*args, timeout=30)
    if not ok:
        raise HTTPException(400, out.replace("error: ", "")[-500:] or "Could not start the request")
    host.last_error = ""
    db.commit()
    return tls_job()


@router.post("/tls/continue")
def tls_continue():
    ok, out = run_helper("tls-continue")
    if not ok:
        raise HTTPException(400, out.replace("error: ", "")[-300:])
    return tls_job()


@router.post("/tls/cancel")
def tls_cancel():
    run_helper("tls-cancel")
    return tls_job()


class CloudflareIn(BaseModel):
    token: str = Field(min_length=30, max_length=200)


@router.put("/tls/cloudflare")
def set_cloudflare(body: CloudflareIn):
    ok, out = run_helper("tls-cloudflare-token", stdin=body.token)
    if not ok:
        raise HTTPException(400, out.replace("error: ", "")[-300:])
    return tls_job()


@router.delete("/tls/cloudflare")
def remove_cloudflare():
    run_helper("tls-cloudflare-remove")
    return tls_job()
