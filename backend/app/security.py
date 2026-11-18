import ctypes
import hashlib
import hmac
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
_SCHEME_PREFIX_RE = re.compile(r"^\{[A-Za-z0-9._-]+\}")
_B64_CRYPT = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwerty123", "qwertyuiop",
    "iloveyou", "admin123", "administrator", "welcome1", "welcome123", "letmein1", "11111111", "00000000",
    "abc12345", "passw0rd", "123456", "1234567", "654321", "123123", "111111", "000000",
    "qwerty", "abc123", "admin1", "admin12", "pass123", "secret", "mailsomadhan", "p@ssw0rd", "changeme", "football", "baseball", "sunshine", "princess",
}


def check_password_rules(password: str, admin: bool = False) -> str | None:
    minimum = 6
    if len(password) < minimum:
        return f"Password must be at least {minimum} characters"
    if len(password.encode()) > 72:
        return "Password must be at most 72 bytes"
    if password.lower() in COMMON_PASSWORDS or len(set(password)) < 4:
        return "This password is too easy to guess"
    return None


def hash_password(password: str) -> str:
    return SCHEME + bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()


def _b64_encode_triplet(b2: int, b1: int, b0: int, n: int) -> str:
    w = (b2 << 16) | (b1 << 8) | b0
    out = []
    for _ in range(n):
        out.append(_B64_CRYPT[w & 0x3F])
        w >>= 6
    return "".join(out)


def _sha2_crypt(password: str, full_hash: str) -> str:
    """Pure-Python implementation of Ulrich Drepper's SHA-512 ($6$) and SHA-256 ($5$) crypt
    (used by cPanel /etc/<domain>/shadow and Dovecot)."""
    is_512 = full_hash.startswith("$6$")
    algo = hashlib.sha512 if is_512 else hashlib.sha256
    digest_size = 64 if is_512 else 32
    prefix = "$6$" if is_512 else "$5$"
    rest = full_hash[3:]

    rounds = 5000
    explicit_rounds = False
    if rest.startswith("rounds="):
        explicit_rounds = True
        r_str, _, rest = rest.partition("$")
        try:
            rounds = max(1000, min(999_999_999, int(r_str.split("=", 1)[1])))
        except ValueError:
            rounds = 5000

    salt_str, _, _ = rest.partition("$")
    salt_str = salt_str[:16]
    key = password.encode("utf-8")
    salt = salt_str.encode("utf-8")
    key_len = len(key)
    salt_len = len(salt)

    b_digest = algo(key + salt + key).digest()

    a_ctx = algo(key + salt)
    full_blocks, rem = divmod(key_len, digest_size)
    a_ctx.update(b_digest * full_blocks + b_digest[:rem])

    cnt = key_len
    while cnt > 0:
        a_ctx.update(b_digest if (cnt & 1) else key)
        cnt >>= 1
    a_digest = a_ctx.digest()

    dp_ctx = algo()
    for _ in range(key_len):
        dp_ctx.update(key)
    dp_digest = dp_ctx.digest()
    p_bytes = dp_digest * full_blocks + dp_digest[:rem]

    ds_ctx = algo()
    for _ in range(16 + a_digest[0]):
        ds_ctx.update(salt)
    ds_digest = ds_ctx.digest()
    s_blocks, s_rem = divmod(salt_len, digest_size)
    s_bytes = ds_digest * s_blocks + ds_digest[:s_rem]

    c_digest = a_digest
    for i in range(rounds):
        c_ctx = algo()
        c_ctx.update(p_bytes if (i & 1) else c_digest)
        if i % 3:
            c_ctx.update(s_bytes)
        if i % 7:
            c_ctx.update(p_bytes)
        c_ctx.update(c_digest if (i & 1) else p_bytes)
        c_digest = c_ctx.digest()

    if is_512:
        pairs: list[tuple[int | None, int | None, int, int]] = [
            (0, 21, 42, 4), (22, 43, 1, 4), (44, 2, 23, 4), (3, 24, 45, 4),
            (25, 46, 4, 4), (47, 5, 26, 4), (6, 27, 48, 4), (28, 49, 7, 4),
            (50, 8, 29, 4), (9, 30, 51, 4), (31, 52, 10, 4), (53, 11, 32, 4),
            (12, 33, 54, 4), (34, 55, 13, 4), (56, 14, 35, 4), (15, 36, 57, 4),
            (37, 58, 16, 4), (59, 17, 38, 4), (18, 39, 60, 4), (40, 61, 19, 4),
            (62, 20, 41, 4), (None, None, 63, 2),
        ]
    else:
        pairs = [
            (0, 10, 20, 4), (21, 1, 11, 4), (12, 22, 2, 4), (3, 13, 23, 4),
            (24, 4, 14, 4), (15, 25, 5, 4), (6, 16, 26, 4), (27, 7, 17, 4),
            (18, 28, 8, 4), (9, 19, 29, 4), (None, 31, 30, 3),
        ]

    chk = "".join(
        _b64_encode_triplet(
            0 if a is None else c_digest[a],
            0 if b is None else c_digest[b],
            c_digest[c],
            n,
        )
        for a, b, c, n in pairs
    )
    rounds_part = f"rounds={rounds}$" if explicit_rounds else ""
    return f"{prefix}{rounds_part}{salt_str}${chk}"


def _md5_crypt(password: str, full_hash: str) -> str:
    """Pure-Python MD5-crypt ($1$) implementation for older cPanel shadow hashes."""
    rest = full_hash[3:]
    salt_str, _, _ = rest.partition("$")
    salt_str = salt_str[:8]
    key = password.encode("utf-8")
    salt = salt_str.encode("utf-8")
    key_len = len(key)

    alt = hashlib.md5(key + salt + key).digest()
    ctx = hashlib.md5(key + b"$1$" + salt)
    full_blocks, rem = divmod(key_len, 16)
    ctx.update(alt * full_blocks + alt[:rem])

    cnt = key_len
    while cnt > 0:
        ctx.update(b"\x00" if (cnt & 1) else key[:1])
        cnt >>= 1
    final = ctx.digest()

    for i in range(1000):
        c_ctx = hashlib.md5()
        c_ctx.update(key if (i & 1) else final)
        if i % 3:
            c_ctx.update(salt)
        if i % 7:
            c_ctx.update(key)
        c_ctx.update(final if (i & 1) else key)
        final = c_ctx.digest()

    pairs: list[tuple[int | None, int | None, int, int]] = [
        (0, 6, 12, 4), (1, 7, 13, 4), (2, 8, 14, 4), (3, 9, 15, 4), (4, 10, 5, 4), (None, None, 11, 2)
    ]
    chk = "".join(
        _b64_encode_triplet(
            0 if a is None else final[a],
            0 if b is None else final[b],
            final[c],
            n,
        )
        for a, b, c, n in pairs
    )
    return f"$1${salt_str}${chk}"


def _libcrypt_verify(password: str, raw_hash: str) -> bool | None:
    """Use system libcrypt.so.1 when available on Linux for any crypt(3) format."""
    for libname in ("libcrypt.so.1", "libcrypt.so.2", "libcrypt.so"):
        try:
            lib = ctypes.CDLL(libname)
            lib.crypt.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
            lib.crypt.restype = ctypes.c_char_p
            res = lib.crypt(password.encode("utf-8"), raw_hash.encode("utf-8"))
            if res:
                return hmac.compare_digest(res.decode("utf-8", "replace"), raw_hash)
        except Exception:
            continue
    return None


def verify_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    raw = _SCHEME_PREFIX_RE.sub("", hashed.strip())
    if raw.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            norm = "$2b$" + raw[4:] if raw.startswith("$2y$") else raw
            return bcrypt.checkpw(password.encode("utf-8")[:72], norm.encode("ascii"))
        except ValueError:
            return False
    if raw.startswith(("$6$", "$5$")):
        try:
            return hmac.compare_digest(_sha2_crypt(password, raw), raw)
        except Exception:
            return False
    if raw.startswith("$1$"):
        try:
            return hmac.compare_digest(_md5_crypt(password, raw), raw)
        except Exception:
            return False
    res = _libcrypt_verify(password, raw)
    return bool(res)


def session_hours(kind: str) -> int:
    return settings.user_token_hours if kind == "user" else settings.token_hours


def make_token(kind: str, ident: int, version: int = 0) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=session_hours(kind))
    return jwt.encode({"sub": f"{kind}:{ident}", "v": version, "exp": exp}, settings.secret_key, algorithm="HS256")


ACCESS_MINUTES = 60


def make_access_token(admin_id: int, admin_version: int, mailbox_id: int, mailbox_version: int) -> str:
    """Lets an administrator open one mailbox in the webmail for a limited time. Only valid together with
    that administrator's own signed-in session (checked in deps.mailbox_access)."""
    exp = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_MINUTES)
    return jwt.encode({"sub": f"access:{mailbox_id}", "adm": admin_id, "av": admin_version, "mv": mailbox_version,
                       "exp": exp}, settings.secret_key, algorithm="HS256")


def read_access_token(token: str) -> dict | None:
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=["HS256"], options={"require": ["exp", "sub"]})
        kind, ident = data["sub"].split(":", 1)
        if kind != "access":
            return None
        return {"mailbox_id": int(ident), "admin_id": int(data["adm"]), "av": int(data["av"]), "mv": int(data["mv"])}
    except Exception:
        return None


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
# Once an account is under attack (ACCOUNT_LIMIT failures from anywhere), each address only gets this many
# tries for it. The account is never locked for everyone: otherwise anyone could keep a user (or the admin)
# out by typing wrong passwords from a few addresses.
UNDER_ATTACK_PER_IP = 3


def login_blocked(db, ip: str, identifier: str) -> bool:
    from .models import LoginFailure
    since = datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MINUTES)
    recent = db.query(LoginFailure).filter(LoginFailure.at >= since)
    if recent.filter(LoginFailure.ip == ip).count() >= IP_LIMIT:
        return True
    if recent.filter(LoginFailure.identifier == identifier).count() < ACCOUNT_LIMIT:
        return False
    return recent.filter(LoginFailure.identifier == identifier, LoginFailure.ip == ip).count() >= UNDER_ATTACK_PER_IP


def record_login_failure(db, ip: str, identifier: str) -> None:
    from .models import LoginFailure
    db.add(LoginFailure(ip=ip, identifier=identifier[:320]))
    db.query(LoginFailure).filter(LoginFailure.at < datetime.now(timezone.utc) - timedelta(days=2)).delete()
    db.commit()


def clear_login_failures(db, ip: str, identifier: str) -> None:
    from .models import LoginFailure
    db.query(LoginFailure).filter((LoginFailure.ip == ip) | (LoginFailure.identifier == identifier)).delete()
    db.commit()
