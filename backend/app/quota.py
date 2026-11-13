"""Mailbox storage rules: no mailbox above the server-wide maximum, and the quotas of a
domain's mailboxes together never above the domain's storage limit.

0 means unlimited everywhere (mailbox quota, domain storage limit, server maximum); Dovecot
treats a 0 storage rule as no limit. A mailbox can only be unlimited when nothing above it
limits it: an unlimited mailbox inside a finite domain pool would break the pool."""
import time

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .config import settings
from .models import Domain, Mailbox
from .system import get_setting, run_helper

_usage_cache: tuple[float, dict[str, int]] = (0.0, {})


UNLIMITED = 0


def gb(mb: int) -> str:
    if mb == UNLIMITED:
        return "unlimited"
    return f"{mb / 1024:g} GB" if mb >= 1024 else f"{mb} MB"


def fits(value: int, limit: int) -> bool:
    """True when `value` (0 = unlimited) is allowed under `limit` (0 = unlimited)."""
    return limit == UNLIMITED or (value != UNLIMITED and value <= limit)


def smallest(*limits: int) -> int:
    """The tightest of several limits, where 0 means unlimited."""
    finite = [x for x in limits if x != UNLIMITED]
    return min(finite) if finite else UNLIMITED


def max_mailbox_mb(db: Session) -> int:
    try:
        return max(0, int(get_setting(db, "max_mailbox_quota_mb")))
    except (TypeError, ValueError):
        return 10240


def allocated_mb(db: Session, domain_id: int, exclude_mailbox: int | None = None) -> int:
    q = db.query(func.coalesce(func.sum(Mailbox.quota_mb), 0)).filter(Mailbox.domain_id == domain_id)
    if exclude_mailbox:
        q = q.filter(Mailbox.id != exclude_mailbox)
    return int(q.scalar())


def check_mailbox_quota(db: Session, domain: Domain, quota_mb: int, mailbox_id: int | None = None) -> None:
    cap = max_mailbox_mb(db)
    if not fits(quota_mb, cap):
        if quota_mb == UNLIMITED:
            raise HTTPException(400, f"Unlimited storage is not possible while the server limit per mailbox is {gb(cap)} "
                                     "(Settings, Mailbox storage)")
        raise HTTPException(400, f"A mailbox can have at most {gb(cap)} (server limit set under Settings)")
    if domain.storage_limit_mb == UNLIMITED:
        return
    if quota_mb == UNLIMITED:
        raise HTTPException(400, f"Unlimited storage is not possible while {domain.name} has a {gb(domain.storage_limit_mb)} "
                                 "storage limit. Make the domain's storage unlimited first.")
    others = allocated_mb(db, domain.id, mailbox_id)
    if others + quota_mb > domain.storage_limit_mb:
        free = max(0, domain.storage_limit_mb - others)
        raise HTTPException(400, f"{domain.name} has {gb(free)} of its {gb(domain.storage_limit_mb)} storage left "
                                 f"to assign. Lower the quota or raise the domain's storage limit.")


def usage_kb() -> dict[str, int]:
    """Actual storage used per mailbox (KiB), from Dovecot. Cached for a minute."""
    global _usage_cache
    stamp, data = _usage_cache
    if time.time() - stamp < 60:
        return data
    if settings.dev_mode:
        return {}
    ok, out = run_helper("quota-usage", timeout=60)
    usage: dict[str, int] = {}
    if ok:
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) >= 4 and parts[2] == "STORAGE" and parts[3].isdigit():
                usage[parts[0].lower()] = int(parts[3])
    _usage_cache = (time.time(), usage)
    return usage
