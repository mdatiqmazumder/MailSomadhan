"""Encryption at rest for credentials stored in the database (for example the Firebase service account).

Values are encrypted with Fernet (AES-128-CBC + HMAC-SHA256). The key is derived from the server's
MAILSOMADHAN_SECRET_KEY, which lives only in /etc/mailsomadhan (mode 640), never in the database. So a
database dump or a backup of the database alone does not reveal the credentials.
"""
import base64

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .config import settings

PREFIX = "enc:v1:"


def _fernet() -> Fernet:
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"mailsomadhan-secretbox",
               info=b"settings-encryption-v1").derive(settings.secret_key.encode())
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(plain: str) -> str:
    return PREFIX + _fernet().encrypt(plain.encode()).decode()


def decrypt(value: str) -> str:
    """Raises ValueError when the value is not ours or the secret key changed."""
    if not value.startswith(PREFIX):
        raise ValueError("not an encrypted value")
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode()).decode()
    except InvalidToken as exc:
        raise ValueError("cannot decrypt (was the server's secret key changed?)") from exc
