import re
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from .config import settings

SCHEME = "{BLF-CRYPT}"  # understood natively by Dovecot
COOKIE_NAME = "ms_session"

DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
LOCAL_RE = re.compile(r"^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$")


COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop",
    "iloveyou", "admin123", "administrator", "welcome1", "welcome123", "letmein1", "11111111", "00000000",
    "abc12345", "passw0rd", "p@ssw0rd", "changeme", "football", "baseball", "sunshine", "princess",
}


def check_password_rules(password: str, admin: bool = False) -> str | None:
    minimum = 12 if admin else 8
    if len(password) < minimum:
        return f"Password must be at least {minimum} characters"
    if len(password.encode()) > 72:
        return "Password must be at most 72 bytes"
    if password.lower() in COMMON_PASSWORDS or len(set(password)) < 4:
        return "This password is too easy to guess"
    return None


def hash_password(password: str) -> str:
    return SCHEME + bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    if hashed.startswith(SCHEME):
        hashed = hashed[len(SCHEME):]
    try:
        return bcrypt.checkpw(password.encode()[:72], hashed.encode())
    except ValueError:
        return False


def make_token(kind: str, ident: int, version: int = 0) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.token_hours)
    return jwt.encode({"sub": f"{kind}:{ident}", "v": version, "exp": exp}, settings.secret_key, algorithm="HS256")


def read_token(token: str) -> tuple[str, int, int] | None:
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=["HS256"], options={"require": ["exp", "sub"]})
        kind, ident = data["sub"].split(":", 1)
        return kind, int(ident), int(data.get("v", 0))
    except Exception:
        return None


# ---------------------------------------------------------------- sign-in throttling
# Stored in the database so every API worker sees the same counts; fail2ban adds long bans.
IP_LIMIT, ACCOUNT_LIMIT, WINDOW_MINUTES = 10, 15, 15


def login_blocked(db, ip: str, identifier: str) -> bool:
    from .models import LoginFailure
    since = datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MINUTES)
    recent = db.query(LoginFailure).filter(LoginFailure.at >= since)
    return (recent.filter(LoginFailure.ip == ip).count() >= IP_LIMIT
            or recent.filter(LoginFailure.identifier == identifier).count() >= ACCOUNT_LIMIT)


def record_login_failure(db, ip: str, identifier: str) -> None:
    from .models import LoginFailure
    db.add(LoginFailure(ip=ip, identifier=identifier[:320]))
    db.query(LoginFailure).filter(LoginFailure.at < datetime.now(timezone.utc) - timedelta(days=2)).delete()
    db.commit()


def clear_login_failures(db, ip: str, identifier: str) -> None:
    from .models import LoginFailure
    db.query(LoginFailure).filter((LoginFailure.ip == ip) | (LoginFailure.identifier == identifier)).delete()
    db.commit()
