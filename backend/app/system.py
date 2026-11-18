"""Integration with the host system: DKIM keys, TLS hosts, privileged helper, DNS checks."""
import base64
import json
import os
import shutil
import subprocess
import time
from datetime import timezone
from pathlib import Path

import dns.message
import dns.query
import dns.rdatatype
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
    "max_mailbox_quota_mb": "10240",        # largest quota any single mailbox may get
    "default_domain_storage_mb": "102400",  # storage pool for a newly added domain
    "acme_email": "",
    # Individual sending (campaigns)
    "campaign_daily_limit": "150",         # messages per user in any 24 hours
    "campaign_max_recipients": "1000",     # recipients per campaign
    "campaign_domain_hourly_limit": "20",  # messages per recipient domain per hour, per sender
    "campaign_approval_over": "0",
    "require_admin_2fa": "0",
    "admin_allowed_networks": "",           # comma separated CIDRs allowed to use the console; empty = any               # 1 = every console account must use two-factor sign-in         # campaigns larger than this need admin approval (0 = never)
}

SERVICES = ["postfix", "dovecot", "rspamd", "redis-server", "postgresql", "nginx", "fail2ban",
            "mailsomadhan-api", "mailsomadhan-web", "mailsomadhan-collector",
            "mailsomadhan-campaigns"]


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
def _format(rtype: str, rdatas) -> list[str]:
    if rtype == "TXT":
        return ["".join(part.decode(errors="replace") for part in r.strings) for r in rdatas]
    if rtype == "MX":
        return [str(r.exchange).rstrip(".").lower() for r in rdatas]
    return [str(r) for r in rdatas]


def _authoritative(name: str, rtype: str) -> list[str] | None:
    """Ask the domain's own nameservers. A caching resolver can keep an old answer for up to the
    zone's TTL (often 30 minutes after a record set changed), so a record just added at the DNS
    provider would show as missing. Returns None when no nameserver could be asked."""
    resolver = dns.resolver.Resolver()
    resolver.lifetime = 4
    try:
        zone = dns.resolver.zone_for_name(name, resolver=resolver)
        servers = [str(r.target) for r in resolver.resolve(zone, "NS")]
    except Exception:  # noqa: BLE001
        return None
    query = dns.message.make_query(name, rtype)
    for ns in servers[:4]:
        try:
            ips = [str(a) for a in resolver.resolve(ns, "A")][:2]
        except Exception:  # noqa: BLE001
            continue
        for ip in ips:
            try:
                answer, _ = dns.query.udp_with_fallback(query, ip, timeout=3)
            except Exception:  # noqa: BLE001
                continue
            if answer.rcode() not in (0, 3):  # NOERROR / NXDOMAIN are real answers
                continue
            wanted = dns.rdatatype.from_text(rtype)
            rdatas = [rd for rrset in answer.answer if rrset.rdtype == wanted
                      and rrset.name.to_text().rstrip(".").lower() == name.lower().rstrip(".") for rd in rrset]
            return _format(rtype, rdatas)
    return None


def _resolve(name: str, rtype: str) -> list[str]:
    fresh = _authoritative(name, rtype)
    if fresh is not None:
        return fresh
    try:
        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4
        return _format(rtype, resolver.resolve(name, rtype))
    except Exception:  # noqa: BLE001
        return []


def bimi_logo_url(domain_name: str, primary_host: str) -> str:
    port = "" if settings.web_port in (80, 443) else f":{settings.web_port}"
    return f"https://{primary_host}{port}/api/public/bimi/{domain_name}.svg"


def bimi_record_value(domain: Domain, primary_host: str) -> str:
    url = bimi_logo_url(domain.name, primary_host)
    vmc = (domain.bimi_vmc_url or "").strip()
    return f"v=BIMI1; l={url}; a={vmc}" if vmc else f"v=BIMI1; l={url}"


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
    if getattr(domain, "bimi_svg", ""):
        records.append({
            "purpose": "BIMI",
            "type": "TXT",
            "host": f"default._bimi.{name}",
            "value": bimi_record_value(domain, primary_host),
        })
    if not check:
        return records
    for rec in records:
        if rec["purpose"] == "MX":
            found = _resolve(name, "MX")
            rec["ok"] = primary_host.lower() in found
        elif rec["purpose"] == "SPF":
            from .dnsplan import spf_allows
            found = [t for t in _resolve(name, "TXT") if t.lower().startswith("v=spf1")]
            rec["ok"] = len(found) == 1 and spf_allows(found[0], primary_host)
            if len(found) > 1:
                rec["note"] = f"{len(found)} SPF records exist; receivers treat that as an error. Keep only one."
            elif found and not rec["ok"]:
                rec["note"] = "An SPF record exists but does not allow this server."
        elif rec["purpose"] == "DKIM":
            found = _resolve(rec["host"], "TXT")
            rec["ok"] = any(domain.dkim_public[:60] in t.replace(" ", "") for t in found)
        elif rec["purpose"] == "BIMI":
            found = [t for t in _resolve(rec["host"], "TXT") if t.lower().startswith("v=bimi1")]
            rec["ok"] = bool(found)
        else:
            found = [t for t in _resolve(rec["host"], "TXT") if t.lower().startswith("v=dmarc1")]
            rec["ok"] = bool(found)
        rec["found"] = found
    return records


# ---------- server identity (A / AAAA / reverse DNS) ----------
def server_ips() -> dict:
    """The public addresses this server sends mail from: the source address the kernel picks for
    an outbound connection. A UDP "connect" sends no packet. Private addresses (a server behind
    NAT) are not returned, because the public one cannot be known from inside; `ipv4_nat` is then
    True and the A record must be checked by the name alone."""
    import ipaddress
    import socket

    out: dict = {"ipv4": None, "ipv6": None, "ipv4_nat": False}
    for key, family, target in (("ipv4", socket.AF_INET, "192.0.2.1"), ("ipv6", socket.AF_INET6, "2001:db8::1")):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as s:
                s.connect((target, 53))
                ip = s.getsockname()[0].split("%")[0]
            if ipaddress.ip_address(ip).is_global:
                out[key] = ip
            elif key == "ipv4" and ipaddress.ip_address(ip).is_private:
                out["ipv4_nat"] = True
        except OSError:
            pass
    return out


def _ptr(ip: str) -> list[str]:
    import dns.reversename

    try:
        resolver = dns.resolver.Resolver()
        resolver.lifetime = 4
        return [str(r.target).rstrip(".").lower() for r in resolver.resolve(dns.reversename.from_address(ip), "PTR")]
    except Exception:  # noqa: BLE001
        return []


def host_identity(hostname: str, is_primary: bool) -> dict:
    """What a hostname needs in DNS to reach this server, and (for the primary host, the name
    every outgoing message is sent under) whether reverse DNS matches. Receivers such as Gmail
    reject mail whose sending IP has no PTR record or whose PTR name does not resolve back to it."""
    ips = server_ips()
    records = []
    for rtype, key in (("A", "ipv4"), ("AAAA", "ipv6")):
        found = [f.lower() for f in _resolve(hostname, rtype)]
        want = ips[key]
        rec = {"type": rtype, "name": hostname, "value": want, "found": found}
        if want:
            rec["ok"] = want.lower() in found
        elif key == "ipv4" and ips["ipv4_nat"]:
            # Behind NAT: the public IPv4 is not visible from here, so only check that a record exists.
            rec["ok"] = bool(found)
            rec["note"] = ("This server is behind NAT, so its public IPv4 address cannot be detected. "
                           + (f"{hostname} points to {', '.join(found)}; make sure that is this server's public address." if found
                              else f"Add an A record for {hostname} with the server's public IPv4 address."))
        else:
            # No public address of this family here: a record of that type must not exist either,
            # otherwise clients and receivers try an address that is not this server.
            rec["ok"] = not found
            if found:
                rec["note"] = f"This server has no public {'IPv4' if key == 'ipv4' else 'IPv6'} address, but the record exists; remove it."
        records.append(rec)
    ptr = []
    if is_primary:
        for key in ("ipv4", "ipv6"):
            ip = ips[key]
            if not ip and key == "ipv4" and ips["ipv4_nat"]:
                ip = next((r["found"][0] for r in records if r["type"] == "A" and r["found"]), None)
            if not ip:
                continue
            names = _ptr(ip)
            forward = next(r for r in records if r["type"] == ("A" if key == "ipv4" else "AAAA"))
            entry = {"ip": ip, "family": key, "found": names, "ok": hostname.lower() in names and forward["ok"]}
            if not names:
                entry["note"] = "No reverse DNS (PTR) record. Set it to the primary hostname in your hosting provider's control panel."
            elif hostname.lower() not in names:
                entry["note"] = f"Reverse DNS points to {names[0]}, not {hostname}. Change it at your hosting provider."
            elif not forward["ok"]:
                entry["note"] = (f"Reverse DNS is right, but {hostname} has no {forward['type']} record for {ip}. "
                                 "Receivers check both directions, so add that record.")
            ptr.append(entry)
    return {"host": hostname, "ips": ips, "records": records, "ptr": ptr}
