import re
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from .config import settings

SCHEME = "{BLF-CRYPT}"  # understood natively by Dovecot
COOKIE_NAME = "ms_session"

DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
LOCAL_RE = re.compile(r"^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$")


def check_password_rules(password: str) -> str | None:
    if len(password) < 8:
        return "Password must be at least 8 characters"
    if len(password.encode()) > 72:
        return "Password must be at most 72 bytes"
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


def make_token(kind: str, ident: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.token_hours)
    return jwt.encode({"sub": f"{kind}:{ident}", "exp": exp}, settings.secret_key, algorithm="HS256")


def read_token(token: str) -> tuple[str, int] | None:
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        kind, ident = data["sub"].split(":", 1)
        return kind, int(ident)
    except Exception:
        return None


class LoginLimiter:
    """In-memory failed-login limiter (per client IP). fail2ban handles long bans."""

    def __init__(self, max_failures: int = 8, window: int = 900):
        self.max = max_failures
        self.window = window
        self.failures: dict[str, deque] = defaultdict(deque)

    def _trim(self, ip: str) -> deque:
        q = self.failures[ip]
        cutoff = time.time() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def blocked(self, ip: str) -> bool:
        return len(self._trim(ip)) >= self.max

    def fail(self, ip: str) -> None:
        self._trim(ip).append(time.time())

    def reset(self, ip: str) -> None:
        self.failures.pop(ip, None)


login_limiter = LoginLimiter()
