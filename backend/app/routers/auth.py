from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import Principal, client_ip, get_principal
from ..models import Admin, Mailbox
from ..security import (COOKIE_NAME, check_password_rules, hash_password, login_limiter,
                        make_token, verify_password)
from ..system import get_setting

router = APIRouter()

# Dummy hash so unknown accounts take as long to reject as known ones.
_DUMMY_HASH = hash_password("mailsomadhan-dummy-password")


class LoginIn(BaseModel):
    identifier: str = Field(max_length=320)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


class ProfileIn(BaseModel):
    display_name: str = Field(default="", max_length=200)
    signature_html: str = Field(default="", max_length=20000)


def _me(p: Principal, db: Session) -> dict:
    brand = get_setting(db, "brand_name")
    if p.kind == "admin":
        return {"kind": "admin", "username": p.admin.username, "brand_name": brand}
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
    if login_limiter.blocked(ip):
        raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")
    ident = body.identifier.strip().lower()
    token = None
    if "@" in ident:
        mbox = db.query(Mailbox).filter_by(email=ident).first()
        ok = verify_password(body.password, mbox.password_hash if mbox else _DUMMY_HASH)
        if mbox and ok and mbox.active and mbox.domain.active:
            mbox.last_login = datetime.now(timezone.utc)
            db.commit()
            token = make_token("user", mbox.id)
    else:
        admin = db.query(Admin).filter_by(username=ident).first()
        ok = verify_password(body.password, admin.password_hash if admin else _DUMMY_HASH)
        if admin and ok:
            token = make_token("admin", admin.id)
    if not token:
        login_limiter.fail(ip)
        safe = "".join(ch for ch in ident if ch.isalnum() or ch in "@._-+")[:80]
        print(f"mailsomadhan-auth: login failed ip={ip} user={safe}", flush=True)  # parsed by fail2ban
        raise HTTPException(401, "Invalid email/username or password")
    login_limiter.reset(ip)
    response.set_cookie(
        COOKIE_NAME, token, max_age=settings.token_hours * 3600, httponly=True,
        secure=settings.cookie_secure, samesite="strict", path="/",
    )
    return {"ok": True, "kind": "user" if "@" in ident else "admin"}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    return _me(p, db)


@router.post("/account/password")
def change_password(body: PasswordIn, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    target: Admin | Mailbox = p.admin if p.kind == "admin" else p.mailbox
    if not verify_password(body.current_password, target.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    problem = check_password_rules(body.new_password)
    if problem:
        raise HTTPException(400, problem)
    target.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}


@router.put("/account/profile")
def update_profile(body: ProfileIn, p: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    if p.kind != "user":
        raise HTTPException(400, "Only mailbox accounts have a profile")
    p.mailbox.display_name = body.display_name.strip()
    p.mailbox.signature_html = body.signature_html
    db.commit()
    return _me(p, db)
