"""Admin mail filters: blocked/allowed senders, blocked IP ranges and attachment types.

Rules live in the database and are exported to plain map files that Rspamd's multimap module
watches and reloads on its own, so changes apply within seconds without restarting anything.
"""
import ipaddress
import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import require_admin
from ..models import FilterRule
from ..security import DOMAIN_RE
from ..system import run_helper

router = APIRouter(dependencies=[Depends(require_admin)])

KINDS = {"block_sender", "allow_sender", "block_ip", "block_ext"}
ADDR_RE = re.compile(r"^[a-z0-9._%+-]{1,64}@([a-z0-9-]+\.)+[a-z]{2,63}$")
EXT_RE = re.compile(r"^[a-z0-9]{1,10}$")
SUGGESTED_EXTENSIONS = ["exe", "bat", "cmd", "com", "scr", "pif", "vbs", "js", "jse", "wsf", "msi", "ps1", "hta",
                        "jar", "lnk", "iso", "img"]


def maps_dir() -> Path:
    return Path(settings.state_dir) / "maps"


def normalize(kind: str, value: str) -> str:
    v = value.strip().lower()
    if kind in ("block_sender", "allow_sender"):
        v = v.lstrip("@")
        if not (ADDR_RE.match(v) or DOMAIN_RE.match(v)):
            raise HTTPException(400, "Enter an email address (user@example.com) or a domain (example.com)")
        return v
    if kind == "block_ip":
        try:
            return str(ipaddress.ip_network(v, strict=False))
        except ValueError as exc:
            raise HTTPException(400, "Enter an IP address or network such as 203.0.113.0/24") from exc
    v = v.lstrip(".")
    if not EXT_RE.match(v):
        raise HTTPException(400, "Enter a file extension such as exe")
    return v


def export_maps(db: Session) -> None:
    rules = db.query(FilterRule).all()
    files: dict[str, list[str]] = {name: [] for name in (
        "block_from.map", "block_from_domain.map", "allow_from.map", "allow_from_domain.map", "block_ip.map",
        "block_ext.map")}
    for r in rules:
        if r.kind in ("block_sender", "allow_sender"):
            prefix = "block" if r.kind == "block_sender" else "allow"
            files[f"{prefix}_from{'' if '@' in r.value else '_domain'}.map"].append(r.value)
        elif r.kind == "block_ip":
            files["block_ip.map"].append(r.value)
        else:
            files["block_ext.map"].append(r.value)
    target = maps_dir()
    target.mkdir(parents=True, exist_ok=True)
    for name, values in files.items():
        tmp = target / f".{name}.tmp"
        tmp.write_text("".join(f"{v}\n" for v in sorted(set(values))))
        os.chmod(tmp, 0o644)
        os.replace(tmp, target / name)
    # Inbound scanning must stay on while rules exist, even with the spam filter switched off.
    run_helper("sync-milter")


class RuleIn(BaseModel):
    kind: str
    value: str = Field(max_length=320)
    note: str = Field(default="", max_length=200)


def out(r: FilterRule) -> dict:
    return {"id": r.id, "kind": r.kind, "value": r.value, "note": r.note, "created_at": r.created_at.isoformat()}


@router.get("/filters")
def list_rules(db: Session = Depends(get_db)):
    return {"rules": [out(r) for r in db.query(FilterRule).order_by(FilterRule.kind, FilterRule.value).all()],
            "suggested_extensions": SUGGESTED_EXTENSIONS}


@router.post("/filters")
def add_rule(body: RuleIn, db: Session = Depends(get_db)):
    if body.kind not in KINDS:
        raise HTTPException(400, "Unknown rule type")
    value = normalize(body.kind, body.value)
    if db.query(FilterRule).filter_by(kind=body.kind, value=value).first():
        raise HTTPException(409, "This rule already exists")
    opposite = {"block_sender": "allow_sender", "allow_sender": "block_sender"}.get(body.kind)
    if opposite and db.query(FilterRule).filter_by(kind=opposite, value=value).first():
        raise HTTPException(409, "The same sender is already on the other list")
    rule = FilterRule(kind=body.kind, value=value, note=body.note.strip())
    db.add(rule)
    db.commit()
    export_maps(db)
    return out(rule)


@router.post("/filters/bulk")
def add_bulk(body: RuleIn, db: Session = Depends(get_db)):
    """Add many values at once (one per line or comma separated). Invalid ones are reported."""
    if body.kind not in KINDS:
        raise HTTPException(400, "Unknown rule type")
    added, skipped = [], []
    for raw in re.split(r"[\s,;]+", body.value):
        if not raw:
            continue
        try:
            value = normalize(body.kind, raw)
        except HTTPException:
            skipped.append(raw)
            continue
        if db.query(FilterRule).filter_by(kind=body.kind, value=value).first():
            continue
        db.add(FilterRule(kind=body.kind, value=value, note=body.note.strip()))
        added.append(value)
    db.commit()
    export_maps(db)
    return {"added": added, "skipped": skipped}


@router.delete("/filters/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    rule = db.get(FilterRule, rule_id)
    if not rule:
        raise HTTPException(404, "Rule not found")
    db.delete(rule)
    db.commit()
    export_maps(db)
    return {"ok": True}
