"""Automatic DNS setup through Cloudflare.

The admin connects Cloudflare once with an API token (the same token is used for certificates
over DNS). Then each domain's MX, SPF, DKIM and DMARC records can be created with one click.
The token stays root-only: every Cloudflare call goes through the privileged helper, which
accepts nothing but the mail records of the domain in question.
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import require_admin
from ..dnsplan import plan
from ..models import Domain, Host
from ..system import run_helper

router = APIRouter(dependencies=[Depends(require_admin)])

PURPOSES = ("MX", "SPF", "DKIM", "DMARC")

# Local development has no helper and no Cloudflare: a small in-memory stand-in.
_DEV = {"configured": False, "zones": ["example.com"], "records": [], "next": 1}


def status() -> dict:
    if settings.dev_mode:
        return {"configured": _DEV["configured"], "hint": "…dev0" if _DEV["configured"] else "",
                "zones": _DEV["zones"] if _DEV["configured"] else []}
    try:
        cf = json.loads((Path(settings.status_dir) / "cloudflare.json").read_text())
    except (OSError, ValueError):
        cf = {}
    return {"configured": bool(cf.get("configured")), "hint": cf.get("hint", ""), "zones": cf.get("zones", [])}


def _helper_json(*args: str, stdin: str | None = None) -> dict:
    ok, out = run_helper(*args, stdin=stdin, timeout=90)
    if not ok:
        raise HTTPException(400, out.replace("error: ", "").strip()[-400:] or "Cloudflare request failed")
    try:
        return json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise HTTPException(502, "Unexpected answer from the Cloudflare helper")


def _lookup(domain: Domain) -> dict:
    if settings.dev_mode:
        if not _DEV["configured"]:
            raise HTTPException(400, "connect Cloudflare first")
        return {"zone": {"id": "dev", "name": domain.name}, "records": [dict(r) for r in _DEV["records"]]}
    return _helper_json("cf-dns-lookup", domain.name, domain.dkim_selector)


def _apply(domain: Domain, changes: list[dict]) -> dict:
    if settings.dev_mode:
        done = []
        for c in changes:
            if c["op"] == "delete":
                _DEV["records"] = [r for r in _DEV["records"] if r["id"] != c["id"]]
            elif c["op"] == "update":
                for r in _DEV["records"]:
                    if r["id"] == c["id"]:
                        r["content"] = c["content"]
            else:
                _DEV["records"].append({"id": f"{_DEV['next']:032x}", "type": c["type"], "name": c["name"],
                                        "content": c["content"], "priority": c.get("priority")})
                _DEV["next"] += 1
            done.append(f"{c['op']} {c.get('type', '')} {c.get('name', '')}".strip())
        return {"done": done}
    return _helper_json("cf-dns-apply", domain.name, domain.dkim_selector, stdin=json.dumps(changes))


def _primary_host(db: Session) -> str:
    host = db.query(Host).filter_by(is_primary=True).first()
    return host.hostname if host else "localhost"


def _domain(db: Session, domain_id: int) -> Domain:
    domain = db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    if not domain.dkim_selector or not domain.dkim_public:
        raise HTTPException(400, "This domain has no DKIM key yet")
    return domain


def domain_plan(db: Session, domain: Domain) -> dict:
    found = _lookup(domain)
    records = plan(domain.name, _primary_host(db), domain.dkim_selector, domain.dkim_public, found["records"])
    return {"zone": found["zone"]["name"], "records": records}


def publish_dkim(db: Session, domain: Domain) -> str:
    """After a DKIM key rotation: publish the new key right away when Cloudflare is connected.
    Returns '' when Cloudflare is not connected, otherwise a short result for the panel."""
    if not status()["configured"]:
        return ""
    try:
        entry = next(e for e in domain_plan(db, domain)["records"] if e["purpose"] == "DKIM")
        if entry["changes"]:
            _apply(domain, entry["changes"])
        return "published"
    except HTTPException as exc:
        return f"failed: {exc.detail}"


@router.get("/cloudflare")
def cloudflare_status():
    return status()


class TokenIn(BaseModel):
    token: str = Field(min_length=30, max_length=200)


@router.put("/cloudflare")
def save_token(body: TokenIn):
    if settings.dev_mode:
        _DEV["configured"] = True
        return status()
    ok, out = run_helper("tls-cloudflare-token", stdin=body.token.strip(), timeout=60)
    if not ok:
        raise HTTPException(400, out.replace("error: ", "").strip()[-300:])
    return status()


@router.delete("/cloudflare")
def remove_token():
    if settings.dev_mode:
        _DEV["configured"] = False
        return status()
    run_helper("tls-cloudflare-remove")
    return status()


@router.get("/domains/{domain_id}/cloudflare")
def get_plan(domain_id: int, db: Session = Depends(get_db)):
    return domain_plan(db, _domain(db, domain_id))


class ApplyIn(BaseModel):
    purposes: list[str] = Field(min_length=1, max_length=4)
    # Purposes whose existing records are all deleted and replaced by one fresh record.
    fresh: list[str] = Field(default_factory=list, max_length=4)


@router.post("/domains/{domain_id}/cloudflare")
def apply_plan(domain_id: int, body: ApplyIn, db: Session = Depends(get_db)):
    domain = _domain(db, domain_id)
    wanted = {p for p in body.purposes if p in PURPOSES}
    fresh = {p for p in body.fresh if p in wanted}
    # Recompute from the live zone so a stale page can never apply outdated changes.
    current = domain_plan(db, domain)
    changes = [c for e in current["records"] if e["purpose"] in wanted
               for c in (e["fresh"] if e["purpose"] in fresh and e.get("can_replace") else e["changes"])]
    if not changes:
        return {"done": [], **current}
    result = _apply(domain, changes)
    return {"done": result.get("done", []), **domain_plan(db, domain)}
