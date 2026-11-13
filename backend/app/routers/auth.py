import json
from datetime import datetime, timezone

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import PERMISSIONS, Principal, admin_context, client_ip, console_ip_allowed, get_principal
from ..models import Admin, Domain, Mailbox
from ..security import (COOKIE_NAME, check_password_rules, clear_login_failures, hash_password, login_blocked,
                        make_token, record_login_failure, verify_password)
from ..quota import max_mailbox_mb
from ..system import get_setting

router = APIRouter()

# Dummy hash so unknown accounts take as long to reject as known ones.
_DUMMY_HASH = hash_password("mailsomadhan-dummy-password")


class LoginIn(BaseModel):
    identifier: str = Field(max_length=320)
    password: str = Field(max_length=200)
    otp: str = Field(default="", max_length=10)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


class ProfileIn(BaseModel):
    display_name: str = Field(default="", max_length=200)
    signature_html: str = Field(default="", max_length=20000)


class CodeIn(BaseModel):
    code: str = Field(max_length=10)
    password: str = Field(default="", max_length=200)


def set_session(response: Response, kind: str, ident: int, version: int) -> None:
    response.set_cookie(
        COOKIE_NAME, make_token(kind, ident, version), max_age=settings.token_hours * 3600, httponly=True,
        secure=settings.cookie_secure, samesite="strict", path="/",
    )


def totp_ok(secret: str, code: str) -> bool:
    code = code.strip().replace(" ", "")
    return bool(secret) and code.isdigit() and pyotp.TOTP(secret).verify(code, valid_window=1)


def _me(p: Principal, db: Session) -> dict:
    brand = get_setting(db, "brand_name")
    if p.kind == "admin":
        ctx = admin_context(db, p.admin)
        domains = None
        if ctx.domain_ids is not None:
            domains = [{"id": d.id, "name": d.name} for d in db.query(Domain).filter(Domain.id.in_(ctx.domain_ids or [-1])).order_by(Domain.name)]
        return {
            "kind": "admin", "username": p.admin.username, "brand_name": brand,
            "role": p.admin.role, "permissions": sorted(PERMISSIONS) if ctx.is_super else sorted(ctx.permissions),
            "domains": domains, "totp_enabled": p.admin.totp_enabled,
            "require_2fa": get_setting(db, "require_admin_2fa") == "1",
            "max_mailbox_mb": max_mailbox_mb(db),
        }
    m = p.mailbox
    return {
        "kind": "user", "email": m.email, "display_name": m.display_name,
        "signature_html": m.signature_html, "brand_name": brand,
        "max_attachment_mb": int(get_setting(db, "max_attachment_mb") or 25),
    }


@router.get("/public/info")
def public_info(db: Session = Depends(get_db)):
    return {"brand_name": get_setting(db, "brand_name")}


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    ip = client_ip(request)
    ident = body.identifier.strip().lower()
    if login_blocked(db, ip, ident):
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
    kind, account = None, None
    if "@" in ident:
        mbox = db.query(Mailbox).filter_by(email=ident).first()
        ok = verify_password(body.password, mbox.password_hash if mbox else _DUMMY_HASH)
        if mbox and ok and mbox.active and mbox.domain.active:
            kind, account = "user", mbox
    else:
        admin = db.query(Admin).filter_by(username=ident).first()
        ok = verify_password(body.password, admin.password_hash if admin else _DUMMY_HASH)
        if admin and ok and admin.active:
            kind, account = "admin", admin
    if not account:
        record_login_failure(db, ip, ident)
        safe = "".join(ch for ch in ident if ch.isalnum() or ch in "@._-+")[:80]
        print(f"mailsomadhan-auth: login failed ip={ip} user={safe}", flush=True)  # parsed by fail2ban
        raise HTTPException(401, "Invalid email/username or password")
    if kind == "admin" and not console_ip_allowed(db, ip):
        print(f"mailsomadhan-auth: console sign-in from a network that is not allowed ip={ip}", flush=True)
        raise HTTPException(403, "The console cannot be used from this network")
    if kind == "admin" and account.totp_enabled:
        if not body.otp:
            raise HTTPException(401, "otp_required")
        if not totp_ok(account.totp_secret, body.otp):
            record_login_failure(db, ip, ident)
            print(f"mailsomadhan-auth: login failed ip={ip} user={ident[:80]} reason=otp", flush=True)
            raise HTTPException(401, "The verification code is not correct")
    clear_login_failures(db, ip, ident)
    account.last_login = datetime.now(timezone.utc)
    db.commit()
    set_session(response, kind, account.id, account.token_version)
    return {"ok": True, "kind": kind}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    return _me(p, db)


@router.post("/account/password")
def change_password(body: PasswordIn, response: Response, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    target: Admin | Mailbox = p.admin if p.kind == "admin" else p.mailbox
    if not verify_password(body.current_password, target.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    problem = check_password_rules(body.new_password, admin=p.kind == "admin")
    if problem:
        raise HTTPException(400, problem)
    target.password_hash = hash_password(body.new_password)
    target.token_version += 1  # signs out every other session
    db.commit()
    set_session(response, p.kind, target.id, target.token_version)  # keep this one
    return {"ok": True}


@router.post("/account/sign-out-everywhere")
def sign_out_everywhere(response: Response, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    target: Admin | Mailbox = p.admin if p.kind == "admin" else p.mailbox
    target.token_version += 1
    db.commit()
    set_session(response, p.kind, target.id, target.token_version)
    return {"ok": True}


@router.put("/account/profile")
def update_profile(body: ProfileIn, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    if p.kind != "user":
        raise HTTPException(400, "Only mailbox accounts have a profile")
    p.mailbox.display_name = body.display_name.strip()
    p.mailbox.signature_html = body.signature_html
    db.commit()
    return _me(p, db)


# ---------------------------------------------------------------- two-factor (admins)
def _admin(p: Principal) -> Admin:
    if p.kind != "admin":
        raise HTTPException(403, "Two-factor sign-in is available for console accounts")
    return p.admin


@router.post("/account/2fa/setup")
def twofa_setup(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    admin = _admin(p)
    if admin.totp_enabled:
        raise HTTPException(400, "Two-factor sign-in is already on")
    admin.totp_pending = pyotp.random_base32()
    db.commit()
    issuer = get_setting(db, "brand_name") or "MailSomadhan"
    uri = pyotp.TOTP(admin.totp_pending).provisioning_uri(name=admin.username, issuer_name=issuer)
    return {"secret": admin.totp_pending, "uri": uri}


@router.post("/account/2fa/enable")
def twofa_enable(body: CodeIn, response: Response, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    admin = _admin(p)
    if not totp_ok(admin.totp_pending, body.code):
        raise HTTPException(400, "The code is not correct. Check the time on your phone and try again.")
    admin.totp_secret, admin.totp_pending, admin.totp_enabled = admin.totp_pending, "", True
    admin.token_version += 1
    db.commit()
    set_session(response, "admin", admin.id, admin.token_version)
    return _me(Principal("admin", admin=admin), db)


@router.post("/account/2fa/disable")
def twofa_disable(body: CodeIn, response: Response, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    admin = _admin(p)
    if get_setting(db, "require_admin_2fa") == "1":
        raise HTTPException(400, "Two-factor sign-in is required for all console accounts")
    if not verify_password(body.password, admin.password_hash) or not totp_ok(admin.totp_secret, body.code):
        raise HTTPException(400, "Password or code is not correct")
    admin.totp_secret, admin.totp_enabled = "", False
    admin.token_version += 1
    db.commit()
    set_session(response, "admin", admin.id, admin.token_version)
    return _me(Principal("admin", admin=admin), db)
