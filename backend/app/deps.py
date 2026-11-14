"""Authentication and role-based access control.

Admin roles
  super_admin  everything, on every domain
  admin        only the permissions listed on the account, only on its assigned domains

Every admin endpoint is super-admin-only unless it explicitly asks for a permission with
`require_perm(...)`; those endpoints must also restrict their data with `ctx.domain_ids`.
"""
import ipaddress
import json
from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .models import Admin, AdminDomain, Mailbox
from .security import COOKIE_NAME, read_access_token, read_token
from .system import get_setting

# permission -> human description (shown in the console)
PERMISSIONS: dict[str, str] = {
    "domains.view": "See the domain and its DNS records",
    "mailboxes.view": "See mailboxes and their details",
    "mailboxes.create": "Create mailboxes",
    "mailboxes.edit": "Change name, storage and enable/disable mailboxes",
    "mailboxes.password": "Reset mailbox passwords",
    "mailboxes.delete": "Delete mailboxes and their mail",
    "aliases.manage": "See and manage aliases",
    "analytics.view": "Dashboard traffic, user analytics, message log and reports",
    "campaigns.manage": "See, pause and approve campaigns of the domain's users",
    "mailboxes.access": "Open users' mailboxes: read and send mail as them, and set up forwarding (everything opened or sent is audit-logged)",
    "postmaster.manage": "Read and manage the domain's postmaster@ mailbox (each message opened is audit-logged)",
}

# Endpoints an admin may use while their mandatory 2FA is not set up yet.
TWO_FA_EXEMPT = ("/api/auth/", "/api/account/")


@dataclass
class Principal:
    kind: str  # "admin" | "user"
    admin: Admin | None = None
    mailbox: Mailbox | None = None
    acting_admin: Admin | None = None  # an administrator who opened this mailbox from the admin panel


@dataclass
class AdminCtx:
    admin: Admin
    is_super: bool
    permissions: set[str] = field(default_factory=set)
    domain_ids: set[int] | None = None  # None = all domains

    def can(self, perm: str) -> bool:
        return self.is_super or perm in self.permissions

    def can_domain(self, domain_id: int) -> bool:
        return self.domain_ids is None or domain_id in self.domain_ids

    def check_domain(self, domain_id: int) -> None:
        # 404 rather than 403, so a limited admin cannot even confirm other domains exist.
        if not self.can_domain(domain_id):
            raise HTTPException(404, "Not found")


def client_ip(request: Request) -> str:
    # The API only listens on 127.0.0.1 behind nginx, which sets X-Real-IP.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")


def parse_networks(value: str) -> list:
    nets = []
    for part in value.replace("\n", ",").split(","):
        part = part.strip()
        if part:
            nets.append(ipaddress.ip_network(part, strict=False))
    return nets


def console_ip_allowed(db: Session, ip: str) -> bool:
    """Optional allowlist for console (admin) access. Mailbox users are not affected."""
    raw = get_setting(db, "admin_allowed_networks").strip()
    if not raw:
        return True
    try:
        addr = ipaddress.ip_address(ip)
        return any(addr in net for net in parse_networks(raw))
    except ValueError:
        return False


ACCESS_HEADER = "x-mailbox-access"
# EventSource and download links cannot send headers; only these GETs accept the token as ?access=.
ACCESS_QUERY_PATHS = ("/api/mail/events", "/api/mail/attachment", "/api/mail/print")
EXPIRED = "Access to this mailbox has ended. Open it again from the admin panel."


def access_token_of(request: Request) -> str:
    token = request.headers.get(ACCESS_HEADER, "")
    if not token and request.method == "GET" and request.url.path in ACCESS_QUERY_PATHS:
        token = request.query_params.get("access", "")
    return token


def mailbox_access(request: Request, db: Session, raw: str) -> Principal:
    """An administrator working in a user's mailbox (one browser tab). Webmail endpoints only: never the
    user's account settings, password or push notifications."""
    path = request.url.path
    if not (path.startswith("/api/mail/") or path == "/api/auth/me") or path.startswith("/api/mail/push/"):
        raise HTTPException(403, "Not available while you are in another user's mailbox")
    data = read_access_token(raw)
    if not data:
        raise HTTPException(401, EXPIRED)
    session = read_token(request.cookies.get(COOKIE_NAME) or "")
    admin = db.get(Admin, data["admin_id"])
    # The token is bound to the administrator's own session in this browser and to both accounts' versions:
    # signing out, "sign out everywhere" or a password reset ends the access.
    if (not session or session[:2] != ("admin", data["admin_id"]) or not admin or not admin.active
            or session[2] != admin.token_version or data["av"] != admin.token_version):
        raise HTTPException(401, EXPIRED)
    if not console_ip_allowed(db, client_ip(request)):
        raise HTTPException(403, "The console cannot be used from this network")
    mbox = db.get(Mailbox, data["mailbox_id"])
    ctx = admin_context(db, admin)
    if not mbox or mbox.token_version != data["mv"] or not ctx.can("mailboxes.access") or not ctx.can_domain(mbox.domain_id):
        raise HTTPException(401, EXPIRED)
    return Principal("user", mailbox=mbox, acting_admin=admin)


def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    raw = access_token_of(request)
    if raw:
        return mailbox_access(request, db, raw)
    token = request.cookies.get(COOKIE_NAME)
    parsed = read_token(token) if token else None
    if not parsed:
        raise HTTPException(401, "Not authenticated")
    kind, ident, version = parsed
    if kind == "admin":
        admin = db.get(Admin, ident)
        if admin and admin.active and admin.token_version == version:
            return Principal("admin", admin=admin)
    elif kind == "user":
        mbox = db.get(Mailbox, ident)
        if mbox and mbox.active and mbox.domain.active and mbox.token_version == version:
            return Principal("user", mailbox=mbox)
    raise HTTPException(401, "Not authenticated")


def admin_context(db: Session, admin: Admin) -> AdminCtx:
    if admin.role == "super_admin":
        return AdminCtx(admin=admin, is_super=True)
    try:
        perms = {p for p in json.loads(admin.permissions or "[]") if p in PERMISSIONS}
    except ValueError:
        perms = set()
    domains = {d for (d,) in db.query(AdminDomain.domain_id).filter(AdminDomain.admin_id == admin.id)}
    return AdminCtx(admin=admin, is_super=False, permissions=perms, domain_ids=domains)


def get_admin_ctx(request: Request, p: Principal = Depends(get_principal), db: Session = Depends(get_db)) -> AdminCtx:
    if p.kind != "admin":
        raise HTTPException(403, "Admin access required")
    if not console_ip_allowed(db, client_ip(request)):
        raise HTTPException(403, "The console cannot be used from this network")
    if (get_setting(db, "require_admin_2fa") == "1" and not p.admin.totp_enabled
            and not request.url.path.startswith(TWO_FA_EXEMPT)):
        raise HTTPException(403, "two_factor_setup_required")
    return admin_context(db, p.admin)


def require_admin(ctx: AdminCtx = Depends(get_admin_ctx)) -> Admin:
    """Super admin only (the default for every admin endpoint)."""
    if not ctx.is_super:
        raise HTTPException(403, "This needs a super administrator")
    return ctx.admin


def require_perm(*perms: str):
    """Allow super admins, and limited admins holding at least one of `perms`."""

    def dep(ctx: AdminCtx = Depends(get_admin_ctx)) -> AdminCtx:
        if not ctx.is_super and not any(p in ctx.permissions for p in perms):
            raise HTTPException(403, "You do not have permission for this")
        return ctx

    return dep


def require_user(p: Principal = Depends(get_principal)) -> Mailbox:
    if p.kind != "user":
        raise HTTPException(403, "Mailbox account required")
    return p.mailbox
