import ipaddress
import re
import smtplib
import ssl

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import AdminCtx, client_ip, parse_networks, require_admin, require_perm
from ..models import Admin, Alias, Domain, Host, Mailbox, Relay, Setting
from ..quota import allocated_mb, check_mailbox_quota, gb, max_mailbox_mb, usage_kb
from .cloudflare import publish_dkim
from ..connection import connection_info, deliver_welcome
from ..security import DOMAIN_RE, EMAIL_RE, LOCAL_RE, check_password_rules, hash_password
from ..system import (DEFAULT_SETTINGS, disk_usage, dns_records, generate_dkim, get_setting,
                      get_settings_map, mail_queue, remove_dkim, run_helper, service_status,
                      tls_info, write_hosts_file, write_selector_map)

# Super-admin-only endpoints.
router = APIRouter(dependencies=[Depends(require_admin)])
# Endpoints open to limited admins: each checks a permission and restricts data to ctx.domain_ids.
scoped = APIRouter()

RELAY_HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
QUEUE_ID_RE = re.compile(r"^[A-Za-z0-9]{5,20}$")


def _primary_host(db: Session) -> str:
    host = db.query(Host).filter_by(is_primary=True).first()
    return host.hostname if host else "localhost"


# ---------------------------------------------------------------- dashboard
@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    return {
        "domains": db.query(func.count(Domain.id)).scalar(),
        "mailboxes": db.query(func.count(Mailbox.id)).scalar(),
        "aliases": db.query(func.count(Alias.id)).scalar(),
        "relays": db.query(func.count(Relay.id)).scalar(),
        "hosts": db.query(func.count(Host.id)).scalar(),
        "queue": len(mail_queue()),
        "services": service_status(),
        "disk": disk_usage(),
        "primary_host": _primary_host(db),
    }


# ---------------------------------------------------------------- domains
class DomainIn(BaseModel):
    name: str = Field(max_length=253)


class DomainPatch(BaseModel):
    active: bool | None = None
    default_quota_mb: int | None = Field(default=None, ge=1, le=1024 * 1024)
    storage_limit_mb: int | None = Field(default=None, ge=1, le=100 * 1024 * 1024)
    relay_id: int | None = None
    clear_relay: bool = False


def _domain_out(d: Domain, counts: dict[int, int] | None = None, allocated: dict[int, int] | None = None,
                used: dict[int, int] | None = None) -> dict:
    return {
        "id": d.id, "name": d.name, "active": d.active, "default_quota_mb": d.default_quota_mb,
        "storage_limit_mb": d.storage_limit_mb,
        "allocated_mb": (allocated or {}).get(d.id, 0),
        "used_kb": (used or {}).get(d.id, 0),
        "relay_id": d.relay_id, "relay_name": d.relay.name if d.relay else None,
        "dkim_selector": d.dkim_selector,
        "mailboxes": (counts or {}).get(d.id, 0),
        "created_at": d.created_at.isoformat(),
    }


@scoped.get("/domains")
def list_domains(db: Session = Depends(get_db),
                 ctx: AdminCtx = Depends(require_perm("domains.view", "mailboxes.view", "aliases.manage", "analytics.view", "campaigns.manage"))):
    counts = dict(db.query(Mailbox.domain_id, func.count(Mailbox.id)).group_by(Mailbox.domain_id).all())
    allocated = {k: int(v) for k, v in db.query(Mailbox.domain_id, func.sum(Mailbox.quota_mb)).group_by(Mailbox.domain_id).all()}
    usage = usage_kb()
    used: dict[int, int] = {}
    for email, domain_id in db.query(Mailbox.email, Mailbox.domain_id).all():
        used[domain_id] = used.get(domain_id, 0) + usage.get(email, 0)
    query = db.query(Domain).order_by(Domain.name)
    if ctx.domain_ids is not None:
        query = query.filter(Domain.id.in_(ctx.domain_ids or [-1]))
    return [_domain_out(d, counts, allocated, used) for d in query.all()]


@router.post("/domains")
def create_domain(body: DomainIn, db: Session = Depends(get_db)):
    name = body.name.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(name):
        raise HTTPException(400, "Invalid domain name")
    if db.query(Domain).filter_by(name=name).first():
        raise HTTPException(409, "Domain already exists")
    limit = int(get_setting(db, "default_domain_storage_mb") or 102400)
    domain = Domain(name=name, default_quota_mb=min(int(get_setting(db, "default_quota_mb") or 1024), max_mailbox_mb(db), limit),
                    storage_limit_mb=limit)
    generate_dkim(domain)
    db.add(domain)
    db.commit()
    write_selector_map(db)
    return _domain_out(domain)


@router.patch("/domains/{domain_id}")
def update_domain(domain_id: int, body: DomainPatch, db: Session = Depends(get_db)):
    domain = db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    if body.active is not None:
        domain.active = body.active
    if body.storage_limit_mb is not None:
        used = allocated_mb(db, domain.id)
        if body.storage_limit_mb < used:
            raise HTTPException(400, f"{domain.name}'s mailboxes already have {gb(used)} assigned. "
                                     f"Lower their quotas first, or set at least {gb(used)}.")
        domain.storage_limit_mb = body.storage_limit_mb
    if body.default_quota_mb is not None:
        if body.default_quota_mb > max_mailbox_mb(db):
            raise HTTPException(400, f"The default quota cannot exceed the {gb(max_mailbox_mb(db))} mailbox maximum")
        if body.default_quota_mb > domain.storage_limit_mb:
            raise HTTPException(400, "The default quota cannot exceed the domain's storage limit")
        domain.default_quota_mb = body.default_quota_mb
    if body.clear_relay:
        domain.relay_id = None
    elif body.relay_id is not None:
        if not db.get(Relay, body.relay_id):
            raise HTTPException(400, "Relay not found")
        domain.relay_id = body.relay_id
    db.commit()
    db.refresh(domain)
    return _domain_out(domain)


@router.delete("/domains/{domain_id}")
def delete_domain(domain_id: int, db: Session = Depends(get_db)):
    domain = db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    name = domain.name
    remove_dkim(domain)
    db.delete(domain)
    db.commit()
    write_selector_map(db)
    run_helper("purge-domain", name)
    return {"ok": True}


@scoped.get("/domains/{domain_id}/dns")
def domain_dns(domain_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("domains.view"))):
    ctx.check_domain(domain_id)
    domain = db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    return {"domain": domain.name, "records": dns_records(domain, _primary_host(db))}


@router.post("/domains/{domain_id}/dkim/rotate")
def rotate_dkim(domain_id: int, db: Session = Depends(get_db)):
    domain = db.get(Domain, domain_id)
    if not domain:
        raise HTTPException(404, "Domain not found")
    generate_dkim(domain)
    db.commit()
    write_selector_map(db)
    # With Cloudflare connected, the new key is published right away.
    cloudflare = publish_dkim(db, domain)
    return {"domain": domain.name, "records": dns_records(domain, _primary_host(db), check=False), "cloudflare": cloudflare}


# ---------------------------------------------------------------- mailboxes
class MailboxIn(BaseModel):
    domain_id: int
    local_part: str = Field(max_length=64)
    password: str = Field(max_length=200)
    display_name: str = Field(default="", max_length=200)
    quota_mb: int | None = Field(default=None, ge=1, le=1024 * 1024)
    send_welcome: bool = True


class MailboxPatch(BaseModel):
    password: str | None = Field(default=None, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
    quota_mb: int | None = Field(default=None, ge=1, le=1024 * 1024)
    active: bool | None = None


def _mailbox_out(m: Mailbox, usage: dict[str, int] | None = None) -> dict:
    return {
        "id": m.id, "email": m.email, "domain_id": m.domain_id, "display_name": m.display_name,
        "quota_mb": m.quota_mb, "active": m.active, "used_kb": (usage or {}).get(m.email),
        "last_login": m.last_login.isoformat() if m.last_login else None,
        "created_at": m.created_at.isoformat(),
    }


@scoped.get("/mailboxes")
def list_mailboxes(domain_id: int | None = None, q: str = "", db: Session = Depends(get_db),
                   ctx: AdminCtx = Depends(require_perm("mailboxes.view"))):
    query = db.query(Mailbox)
    if ctx.domain_ids is not None:
        query = query.filter(Mailbox.domain_id.in_(ctx.domain_ids or [-1]))
    if domain_id:
        query = query.filter(Mailbox.domain_id == domain_id)
    if q:
        query = query.filter(Mailbox.email.contains(q.strip().lower()))
    usage = usage_kb()
    return [_mailbox_out(m, usage) for m in query.order_by(Mailbox.email).limit(2000).all()]


@scoped.post("/mailboxes")
def create_mailbox(body: MailboxIn, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("mailboxes.create"))):
    ctx.check_domain(body.domain_id)
    domain = db.get(Domain, body.domain_id)
    if not domain:
        raise HTTPException(400, "Domain not found")
    local = body.local_part.strip().lower()
    if not LOCAL_RE.match(local):
        raise HTTPException(400, "Invalid mailbox name")
    problem = check_password_rules(body.password)
    if problem:
        raise HTTPException(400, problem)
    email = f"{local}@{domain.name}"
    if db.query(Mailbox).filter_by(email=email).first() or db.query(Alias).filter_by(source=email).first():
        raise HTTPException(409, "Address already in use")
    check_mailbox_quota(db, domain, body.quota_mb or domain.default_quota_mb)
    mbox = Mailbox(
        domain_id=domain.id, local_part=local, email=email,
        password_hash=hash_password(body.password), display_name=body.display_name.strip(),
        quota_mb=body.quota_mb or domain.default_quota_mb,
    )
    db.add(mbox)
    db.commit()
    out = _mailbox_out(mbox)
    out["welcome_sent"] = deliver_welcome(db, mbox) if body.send_welcome else False
    return out


@scoped.get("/mailboxes/{mailbox_id}/connection")
def mailbox_connection(mailbox_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("mailboxes.view"))):
    mbox = db.get(Mailbox, mailbox_id)
    if not mbox or not ctx.can_domain(mbox.domain_id):
        raise HTTPException(404, "Mailbox not found")
    return connection_info(db, mbox)


@scoped.post("/mailboxes/{mailbox_id}/welcome")
def send_welcome(mailbox_id: int, db: Session = Depends(get_db),
                 ctx: AdminCtx = Depends(require_perm("mailboxes.create", "mailboxes.edit"))):
    mbox = db.get(Mailbox, mailbox_id)
    if not mbox or not ctx.can_domain(mbox.domain_id):
        raise HTTPException(404, "Mailbox not found")
    if not mbox.active:
        raise HTTPException(400, "The mailbox is disabled")
    if not deliver_welcome(db, mbox):
        raise HTTPException(502, "The welcome message could not be delivered to this mailbox")
    return {"ok": True}


@scoped.patch("/mailboxes/{mailbox_id}")
def update_mailbox(mailbox_id: int, body: MailboxPatch, db: Session = Depends(get_db),
                   ctx: AdminCtx = Depends(require_perm("mailboxes.edit", "mailboxes.password"))):
    mbox = db.get(Mailbox, mailbox_id)
    if not mbox or not ctx.can_domain(mbox.domain_id):
        raise HTTPException(404, "Mailbox not found")
    if body.password and not ctx.can("mailboxes.password"):
        raise HTTPException(403, "You may not reset passwords")
    if (body.display_name is not None or body.quota_mb is not None or body.active is not None) and not ctx.can("mailboxes.edit"):
        raise HTTPException(403, "You may only reset passwords")
    if body.password:
        problem = check_password_rules(body.password)
        if problem:
            raise HTTPException(400, problem)
        mbox.password_hash = hash_password(body.password)
        mbox.token_version += 1  # end the user's webmail sessions
    if body.display_name is not None:
        mbox.display_name = body.display_name.strip()
    if body.quota_mb is not None and body.quota_mb != mbox.quota_mb:
        check_mailbox_quota(db, mbox.domain, body.quota_mb, mbox.id)
        mbox.quota_mb = body.quota_mb
    if body.active is not None:
        mbox.active = body.active
        if not body.active:
            mbox.token_version += 1
    db.commit()
    return _mailbox_out(mbox)


@scoped.delete("/mailboxes/{mailbox_id}")
def delete_mailbox(mailbox_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("mailboxes.delete"))):
    mbox = db.get(Mailbox, mailbox_id)
    if not mbox or not ctx.can_domain(mbox.domain_id):
        raise HTTPException(404, "Mailbox not found")
    email = mbox.email
    db.delete(mbox)
    db.commit()
    run_helper("purge-mailbox", email)
    return {"ok": True}


# ---------------------------------------------------------------- aliases
class AliasIn(BaseModel):
    source: str = Field(max_length=320)
    destination: str = Field(max_length=4000)


class AliasPatch(BaseModel):
    destination: str | None = Field(default=None, max_length=4000)
    active: bool | None = None


def _clean_destinations(raw: str) -> str:
    parts = [p.strip().lower() for p in re.split(r"[,\s;]+", raw) if p.strip()]
    if not parts:
        raise HTTPException(400, "At least one destination is required")
    for part in parts:
        if not EMAIL_RE.match(part):
            raise HTTPException(400, f"Invalid destination address: {part}")
    return ",".join(dict.fromkeys(parts))


def _alias_out(a: Alias) -> dict:
    return {"id": a.id, "source": a.source, "destination": a.destination, "active": a.active,
            "domain_id": a.domain_id}


@scoped.get("/aliases")
def list_aliases(db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("aliases.manage"))):
    query = db.query(Alias).order_by(Alias.source)
    if ctx.domain_ids is not None:
        query = query.filter(Alias.domain_id.in_(ctx.domain_ids or [-1]))
    return [_alias_out(a) for a in query.all()]


@scoped.post("/aliases")
def create_alias(body: AliasIn, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("aliases.manage"))):
    source = body.source.strip().lower()
    local, _, domain_name = source.rpartition("@")
    domain = db.query(Domain).filter_by(name=domain_name).first()
    if not domain or not ctx.can_domain(domain.id):
        raise HTTPException(400, "The alias must belong to one of your domains")
    if local and not LOCAL_RE.match(local):  # empty local part = catch-all
        raise HTTPException(400, "Invalid alias address")
    if db.query(Alias).filter_by(source=source).first() or db.query(Mailbox).filter_by(email=source).first():
        raise HTTPException(409, "Address already in use")
    alias = Alias(domain_id=domain.id, source=source, destination=_clean_destinations(body.destination))
    db.add(alias)
    db.commit()
    return _alias_out(alias)


@scoped.patch("/aliases/{alias_id}")
def update_alias(alias_id: int, body: AliasPatch, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("aliases.manage"))):
    alias = db.get(Alias, alias_id)
    if not alias or not ctx.can_domain(alias.domain_id):
        raise HTTPException(404, "Alias not found")
    if body.destination is not None:
        alias.destination = _clean_destinations(body.destination)
    if body.active is not None:
        alias.active = body.active
    db.commit()
    return _alias_out(alias)


@scoped.delete("/aliases/{alias_id}")
def delete_alias(alias_id: int, db: Session = Depends(get_db), ctx: AdminCtx = Depends(require_perm("aliases.manage"))):
    alias = db.get(Alias, alias_id)
    if not alias or not ctx.can_domain(alias.domain_id):
        raise HTTPException(404, "Alias not found")
    db.delete(alias)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- hosts
class HostIn(BaseModel):
    hostname: str = Field(max_length=253)


def _host_out(h: Host) -> dict:
    return {"id": h.id, "hostname": h.hostname, "is_primary": h.is_primary,
            "last_error": h.last_error, "tls": tls_info(h.hostname)}


@router.get("/hosts")
def list_hosts(db: Session = Depends(get_db)):
    return [_host_out(h) for h in db.query(Host).order_by(Host.is_primary.desc(), Host.hostname).all()]


@router.post("/hosts")
def create_host(body: HostIn, db: Session = Depends(get_db)):
    hostname = body.hostname.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(hostname):
        raise HTTPException(400, "Invalid hostname")
    if db.query(Host).filter_by(hostname=hostname).first():
        raise HTTPException(409, "Host already exists")
    host = Host(hostname=hostname)
    db.add(host)
    db.commit()
    write_hosts_file(db)
    return _host_out(host)


@router.post("/hosts/{host_id}/issue-cert")
def issue_cert(host_id: int, db: Session = Depends(get_db)):
    host = db.get(Host, host_id)
    if not host:
        raise HTTPException(404, "Host not found")
    write_hosts_file(db)
    args = ["tls-issue", host.hostname]
    acme_email = get_setting(db, "acme_email").strip()
    if acme_email and EMAIL_RE.match(acme_email):
        args.append(acme_email)
    ok, output = run_helper(*args, timeout=240)
    host.last_error = "" if ok else output
    db.commit()
    if not ok:
        raise HTTPException(502, f"Certificate request failed: {output[-1500:]}")
    return _host_out(host)


@router.delete("/hosts/{host_id}")
def delete_host(host_id: int, db: Session = Depends(get_db)):
    host = db.get(Host, host_id)
    if not host:
        raise HTTPException(404, "Host not found")
    if host.is_primary:
        raise HTTPException(400, "The primary host cannot be removed")
    db.delete(host)
    db.commit()
    write_hosts_file(db)
    run_helper("tls-sync")
    return {"ok": True}


# ---------------------------------------------------------------- relays
class RelayIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    host: str = Field(max_length=253)
    port: int = Field(default=587, ge=1, le=65535)
    username: str = Field(default="", max_length=255)
    password: str = Field(default="", max_length=255)
    is_default: bool = False
    active: bool = True


class RelayPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    host: str | None = Field(default=None, max_length=253)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, max_length=255)  # None = keep current
    is_default: bool | None = None
    active: bool | None = None


def _relay_out(r: Relay) -> dict:
    return {"id": r.id, "name": r.name, "host": r.host, "port": r.port, "username": r.username,
            "has_password": bool(r.password), "is_default": r.is_default, "active": r.active}


def _check_relay_fields(host: str | None, username: str | None, password: str | None) -> None:
    if host is not None and not RELAY_HOST_RE.match(host):
        raise HTTPException(400, "Invalid relay host")
    # Postfix reads "user:password" from the database, so neither may contain a line break.
    for value in (username, password):
        if value and ("\n" in value or "\r" in value):
            raise HTTPException(400, "Credentials must not contain line breaks")
    if username and ":" in username:
        raise HTTPException(400, "The relay username must not contain ':'")


@router.get("/relays")
def list_relays(db: Session = Depends(get_db)):
    return [_relay_out(r) for r in db.query(Relay).order_by(Relay.name).all()]


@router.post("/relays")
def create_relay(body: RelayIn, db: Session = Depends(get_db)):
    host = body.host.strip().lower()
    _check_relay_fields(host, body.username, body.password)
    if body.is_default:
        db.query(Relay).update({Relay.is_default: False})
    relay = Relay(name=body.name.strip(), host=host, port=body.port, username=body.username.strip(),
                  password=body.password, is_default=body.is_default, active=body.active)
    db.add(relay)
    db.commit()
    return _relay_out(relay)


@router.patch("/relays/{relay_id}")
def update_relay(relay_id: int, body: RelayPatch, db: Session = Depends(get_db)):
    relay = db.get(Relay, relay_id)
    if not relay:
        raise HTTPException(404, "Relay not found")
    host = body.host.strip().lower() if body.host is not None else None
    _check_relay_fields(host, body.username, body.password)
    if body.name is not None:
        relay.name = body.name.strip()
    if host is not None:
        relay.host = host
    if body.port is not None:
        relay.port = body.port
    if body.username is not None:
        relay.username = body.username.strip()
    if body.password is not None:
        relay.password = body.password
    if body.active is not None:
        relay.active = body.active
    if body.is_default is not None:
        if body.is_default:
            db.query(Relay).filter(Relay.id != relay.id).update({Relay.is_default: False})
        relay.is_default = body.is_default
    db.commit()
    return _relay_out(relay)


@router.delete("/relays/{relay_id}")
def delete_relay(relay_id: int, db: Session = Depends(get_db)):
    relay = db.get(Relay, relay_id)
    if not relay:
        raise HTTPException(404, "Relay not found")
    db.query(Domain).filter(Domain.relay_id == relay.id).update({Domain.relay_id: None})
    db.delete(relay)
    db.commit()
    return {"ok": True}


@router.post("/relays/{relay_id}/test")
def test_relay(relay_id: int, db: Session = Depends(get_db)):
    relay = db.get(Relay, relay_id)
    if not relay:
        raise HTTPException(404, "Relay not found")
    steps = []
    try:
        with smtplib.SMTP(relay.host, relay.port, timeout=12) as smtp:
            smtp.ehlo()
            steps.append("connected")
            if smtp.has_extn("starttls"):
                smtp.starttls(context=ssl.create_default_context())
                smtp.ehlo()
                steps.append("TLS ok")
            else:
                steps.append("no STARTTLS offered")
            if relay.username:
                smtp.login(relay.username, relay.password)
                steps.append("authenticated")
        return {"ok": True, "detail": ", ".join(steps)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": f"{', '.join(steps) + ': ' if steps else ''}{exc}"}


# ---------------------------------------------------------------- settings
class SettingsIn(BaseModel):
    brand_name: str | None = Field(default=None, min_length=1, max_length=60)
    max_attachment_mb: int | None = Field(default=None, ge=1, le=200)
    default_quota_mb: int | None = Field(default=None, ge=1, le=1024 * 1024)
    acme_email: str | None = Field(default=None, max_length=320)
    max_mailbox_quota_mb: int | None = Field(default=None, ge=1, le=1024 * 1024)
    default_domain_storage_mb: int | None = Field(default=None, ge=1, le=100 * 1024 * 1024)
    require_admin_2fa: int | None = Field(default=None, ge=0, le=1)
    admin_allowed_networks: str | None = Field(default=None, max_length=4000)
    campaign_daily_limit: int | None = Field(default=None, ge=1, le=100000)
    campaign_max_recipients: int | None = Field(default=None, ge=1, le=100000)
    campaign_domain_hourly_limit: int | None = Field(default=None, ge=0, le=10000)
    campaign_approval_over: int | None = Field(default=None, ge=0, le=100000)


@router.get("/settings")
def read_settings(db: Session = Depends(get_db)):
    values = get_settings_map(db)
    values["primary_host"] = _primary_host(db)
    return values


@router.put("/settings")
def write_settings(body: SettingsIn, request: Request, db: Session = Depends(get_db), me: Admin = Depends(require_admin)):
    data = body.model_dump(exclude_none=True)
    if "admin_allowed_networks" in data:
        try:
            nets = parse_networks(data["admin_allowed_networks"])
        except ValueError as exc:
            raise HTTPException(400, f"Not a valid IP address or network: {exc}") from exc
        ip = ipaddress.ip_address(client_ip(request))
        if nets and not any(ip in n for n in nets):
            raise HTTPException(400, f"Your current address {ip} is not in the list; you would lock yourself out")
        data["admin_allowed_networks"] = ", ".join(str(n) for n in nets)
    if data.get("acme_email") and not EMAIL_RE.match(data["acme_email"]):
        raise HTTPException(400, "Invalid contact email")
    if data.get("require_admin_2fa") == 1 and not me.totp_enabled:
        raise HTTPException(400, "Turn on two-factor sign-in for your own account first (Account page)")
    cap = data.get("max_mailbox_quota_mb") or max_mailbox_mb(db)
    if (data.get("default_quota_mb") or int(get_setting(db, "default_quota_mb") or 1024)) > cap:
        raise HTTPException(400, f"The default mailbox quota cannot exceed the {gb(cap)} maximum")
    for key, value in data.items():
        if key not in DEFAULT_SETTINGS:
            continue
        row = db.get(Setting, key)
        if row:
            row.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))
    db.commit()
    warning = ""
    if "max_attachment_mb" in data:
        # base64 inflates attachments by ~37%; leave headroom for the body and headers.
        limit = int(data["max_attachment_mb"] * 1024 * 1024 * 1.4) + 2 * 1024 * 1024
        ok, output = run_helper("set-message-size", str(limit))
        if not ok:
            warning = f"Saved, but the mail server limit could not be updated: {output}"
    values = get_settings_map(db)
    values["primary_host"] = _primary_host(db)
    values["warning"] = warning
    return values


# ---------------------------------------------------------------- queue
@router.get("/queue")
def queue_list():
    return mail_queue()


@router.post("/queue/flush")
def queue_flush():
    ok, output = run_helper("queue-flush")
    if not ok:
        raise HTTPException(502, output or "Could not flush the queue")
    return {"ok": True}


@router.delete("/queue/{queue_id}")
def queue_delete(queue_id: str):
    if not QUEUE_ID_RE.match(queue_id):
        raise HTTPException(400, "Invalid queue id")
    ok, output = run_helper("queue-delete", queue_id)
    if not ok:
        raise HTTPException(502, output or "Could not delete the message")
    return {"ok": True}


# ---------------------------------------------------------------- storage overview
@router.get("/storage")
def storage_overview(db: Session = Depends(get_db)):
    from ..system import disk_usage
    usage = usage_kb()
    cap = max_mailbox_mb(db)
    boxes = db.query(Mailbox.email, Mailbox.quota_mb).all()
    allocated = sum(q for _, q in boxes)
    used_kb = sum(usage.get(e, 0) for e, _ in boxes)
    disk = disk_usage()
    return {
        "max_mailbox_mb": cap,
        "allocated_mb": allocated,
        "used_kb": used_kb,
        "domains_limit_mb": int(db.query(func.coalesce(func.sum(Domain.storage_limit_mb), 0)).scalar()),
        "over_max": [e for e, q in boxes if q > cap],
        "near_full": sorted([{"email": e, "used_kb": usage.get(e, 0), "quota_mb": q} for e, q in boxes
                             if usage.get(e, 0) >= q * 1024 * 0.9], key=lambda x: -x["used_kb"] / (x["quota_mb"] * 1024))[:20],
        "disk": disk,
        "overcommitted": allocated * 1024 * 1024 > disk["total"],
    }
