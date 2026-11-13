from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .db import get_db
from .models import Admin, Mailbox
from .security import COOKIE_NAME, read_token


@dataclass
class Principal:
    kind: str  # "admin" | "user"
    admin: Admin | None = None
    mailbox: Mailbox | None = None


def client_ip(request: Request) -> str:
    # The API only listens on 127.0.0.1 behind nginx, which sets X-Real-IP.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")


def get_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    token = request.cookies.get(COOKIE_NAME)
    parsed = read_token(token) if token else None
    if not parsed:
        raise HTTPException(401, "Not authenticated")
    kind, ident = parsed
    if kind == "admin":
        admin = db.get(Admin, ident)
        if admin:
            return Principal("admin", admin=admin)
    elif kind == "user":
        mbox = db.get(Mailbox, ident)
        if mbox and mbox.active and mbox.domain.active:
            return Principal("user", mailbox=mbox)
    raise HTTPException(401, "Not authenticated")


def require_admin(p: Principal = Depends(get_principal)) -> Admin:
    if p.kind != "admin":
        raise HTTPException(403, "Admin access required")
    return p.admin


def require_user(p: Principal = Depends(get_principal)) -> Mailbox:
    if p.kind != "user":
        raise HTTPException(403, "Mailbox account required")
    return p.mailbox
