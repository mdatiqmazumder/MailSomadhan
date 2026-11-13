"""Integration with the host system: DKIM keys, TLS hosts, privileged helper, DNS checks."""
import base64
import json
import os
import shutil
import subprocess
import time
from datetime import timezone
from pathlib import Path

import dns.resolver
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy.orm import Session

from .config import settings
from .models import Domain, Host, Setting

DEFAULT_SETTINGS = {
    "brand_name": "MailSomadhan",
    "max_attachment_mb": "25",
    "default_quota_mb": "1024",
    "acme_email": "",
}

SERVICES = ["postfix", "dovecot", "rspamd", "redis-server", "postgresql", "nginx", "fail2ban",
            "mailsomadhan-api", "mailsomadhan-web", "mailsomadhan-collector"]


# ---------- settings ----------
def get_settings_map(db: Session) -> dict[str, str]:
    values = dict(DEFAULT_SETTINGS)
    for row in db.query(Setting).all():
        values[row.key] = row.value
    return values


def get_setting(db: Session, key: str) -> str:
    row = db.get(Setting, key)
    return row.value if row else DEFAULT_SETTINGS.get(key, "")


# ---------- privileged helper ----------
def run_helper(*args: str, timeout: int = 60, stdin: str | None = None) -> tuple[bool, str]:
    """Run the root helper through sudo. It only accepts a fixed set of validated subcommands.
    Secrets are passed on stdin so they never appear in the process list."""
    if settings.dev_mode:
        return True, "dev mode: skipped " + " ".join(args)
    try:
        proc = subprocess.run(
            ["sudo", "-n", settings.helper_path, *args],
            capture_output=True, text=True, timeout=timeout, input=stdin if stdin is not None else "",
        )
        out = (proc.stdout + proc.stderr).strip()
        return proc.returncode == 0, out[-4000:]
    except subprocess.TimeoutExpired:
        return False, "Operation timed out"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def run_plain(args: list[str], timeout: int = 15) -> tuple[int, str]:
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout
    except Exception:  # noqa: BLE001
        return 1, ""


# ---------- DKIM ----------
def _dkim_dir() -> Path:
    path = Path(settings.dkim_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def generate_dkim(domain: Domain) -> None:
    """Create a fresh 2048-bit DKIM key for the domain and store the public half on the row."""
    selector = f"ms{int(time.time())}"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    target = _dkim_dir() / f"{domain.name}.{selector}.key"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "wb") as fh:
        fh.write(pem)
    try:
        os.chmod(target, 0o640)
    except OSError:
        pass
    pub = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    old = domain.dkim_selector
    domain.dkim_selector = selector
    domain.dkim_public = base64.b64encode(pub).decode()
    if old:
        (_dkim_dir() / f"{domain.name}.{old}.key").unlink(missing_ok=True)


def remove_dkim(domain: Domain) -> None:
    if domain.dkim_selector:
        (_dkim_dir() / f"{domain.name}.{domain.dkim_selector}.key").unlink(missing_ok=True)


def write_selector_map(db: Session) -> None:
    """Rspamd reads this map (auto-reloaded) to know which selector signs which domain."""
    lines = [f"{d.name} {d.dkim_selector}" for d in db.query(Domain).all() if d.dkim_selector]
    path = _dkim_dir() / "selectors.map"
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(tmp, 0o640)
    except OSError:
        pass
    os.replace(tmp, path)


# ---------- hosts / TLS ----------
def write_hosts_file(db: Session) -> None:
    state = Path(settings.state_dir)
    state.mkdir(parents=True, exist_ok=True)
    hosts = db.query(Host).order_by(Host.is_primary.desc(), Host.id).all()
    (state / "hosts.txt").write_text("\n".join(h.hostname for h in hosts) + "\n")


def tls_info(hostname: str) -> dict:
    cert_path = Path(settings.tls_dir) / hostname / "fullchain.pem"
    if not cert_path.is_file():
        return {"status": "none", "expires": None, "issuer": ""}
    try:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        expires = cert.not_valid_after_utc.astimezone(timezone.utc)
        self_signed = cert.issuer == cert.subject
        org = cert.issuer.get_attributes_for_oid(x509.NameOID.ORGANIZATION_NAME)
        return {
            "status": "self-signed" if self_signed else "trusted",
            "expires": expires.isoformat(),
            "issuer": org[0].value if org else "",
        }
    except Exception:  # noqa: BLE001
        return {"status": "error", "expires": None, "issuer": ""}


# ---------- status ----------
def service_status() -> list[dict]:
    if settings.dev_mode:
        return [{"name": s, "active": True} for s in SERVICES]  # development: no system services to query
    try:
        redis_off = "REDIS=0" in Path(settings.features_file).read_text()
    except OSError:
        redis_off = False
    result = []
    for name in SERVICES:
        _code, out = run_plain(["systemctl", "is-active", name])
        result.append({"name": name, "active": out.strip() == "active",
                       "disabled": name == "redis-server" and redis_off})
    return result


def disk_usage() -> dict:
    path = settings.mail_dir if os.path.isdir(settings.mail_dir) else "."
    usage = shutil.disk_usage(path)
    return {"total": usage.total, "used": usage.used, "free": usage.free}


def mail_queue() -> list[dict]:
    code, out = run_plain(["postqueue", "-j"])
    items = []
    if code != 0:
        return items
    for line in out.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        items.append({
            "id": row.get("queue_id"),
            "queue": row.get("queue_name"),
            "arrival": row.get("arrival_time"),
            "size": row.get("message_size"),
            "sender": row.get("sender"),
            "recipients": [
                {"address": r.get("address"), "reason": r.get("delay_reason", "")}
                for r in row.get("recipients", [])
            ],
        })
    return items


# ---------- DNS ----------
def _resolve(name: str, rtype: str) -> list[str]:
    try:
        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4
        answers = resolver.resolve(name, rtype)
        if rtype == "TXT":
            return ["".join(part.decode() for part in r.strings) for r in answers]
        if rtype == "MX":
            return [str(r.exchange).rstrip(".").lower() for r in answers]
        return [str(r) for r in answers]
    except Exception:  # noqa: BLE001
        return []


def dns_records(domain: Domain, primary_host: str, check: bool = True) -> list[dict]:
    name = domain.name
    dkim_value = f"v=DKIM1; k=rsa; p={domain.dkim_public}"
    records = [
        {"purpose": "MX", "type": "MX", "host": name, "value": f"10 {primary_host}."},
        {"purpose": "SPF", "type": "TXT", "host": name, "value": f"v=spf1 mx a:{primary_host} ~all"},
        {"purpose": "DKIM", "type": "TXT", "host": f"{domain.dkim_selector}._domainkey.{name}", "value": dkim_value},
        {"purpose": "DMARC", "type": "TXT", "host": f"_dmarc.{name}",
         "value": f"v=DMARC1; p=quarantine; rua=mailto:postmaster@{name}"},
    ]
    if not check:
        return records
    for rec in records:
        if rec["purpose"] == "MX":
            found = _resolve(name, "MX")
            rec["ok"] = primary_host.lower() in found
        elif rec["purpose"] == "SPF":
            found = [t for t in _resolve(name, "TXT") if t.lower().startswith("v=spf1")]
            rec["ok"] = any(primary_host.lower() in t.lower() or " mx" in t.lower() for t in found)
        elif rec["purpose"] == "DKIM":
            found = _resolve(rec["host"], "TXT")
            rec["ok"] = any(domain.dkim_public[:60] in t.replace(" ", "") for t in found)
        else:
            found = [t for t in _resolve(rec["host"], "TXT") if t.lower().startswith("v=dmarc1")]
            rec["ok"] = bool(found)
        rec["found"] = found
    return records
