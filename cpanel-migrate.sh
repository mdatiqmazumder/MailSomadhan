#!/usr/bin/env bash
# ==============================================================================
# Standalone cPanel Email Backup Script (One-Click Ready for MailSomadhan)
# ==============================================================================
# Run directly:
#   bash cpanel-migrate.sh
#
# How it works:
#   1. Asks for cPanel Host/Domain/URL, cPanel Username, and cPanel Password.
#   2. Logs into cPanel and lists all domains & email accounts.
#   3. Without changing any password in cPanel:
#      - Reads the original encrypted password hashes from `etc/<domain>/shadow`
#        so users can log into MailSomadhan with their EXACT SAME password!
#      - Enters every mailbox (`mail/<domain>/<user>/`) and downloads all Sent,
#        Received (INBOX), Drafts, Junk, Trash, Archive & custom folder messages.
#   4. Packages everything into a single `.tar.gz` archive ready for One-Click
#      Import in the MailSomadhan Admin Panel (Mailboxes -> Import backup).
# ==============================================================================
set -euo pipefail

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python)"
else
  echo "Error: python3 is required to run this script." >&2
  exit 1
fi

PY_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/cpanel-backup.XXXXXX.py")"
trap 'rm -f "$PY_SCRIPT"' EXIT

cat > "$PY_SCRIPT" <<'PYEOF'
#!/usr/bin/env python3
"""Standalone cPanel Email Backup Tool (Preserves cPanel Passwords & All Messages in a One-Click Archive)."""
import argparse
import base64
import concurrent.futures
import datetime
import email
import email.policy
import email.utils
import getpass
import hashlib
import http.cookiejar
import json
import os
import re
import ssl
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

BOLD = "\033[1m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"
RESET = "\033[0m"


def info(msg: str) -> None:
    print(f"{CYAN}==>{RESET} {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"{GREEN}  [OK]{RESET} {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"{YELLOW}  [WARN]{RESET} {msg}", flush=True)


def err(msg: str) -> None:
    print(f"{RED}  [ERROR]{RESET} {msg}", file=sys.stderr, flush=True)


def ask_input(prompt_text: str, default: str = "", secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    full_prompt = f"{BOLD}{prompt_text}{suffix}: {RESET}"
    while True:
        try:
            if secret:
                try:
                    val = getpass.getpass(full_prompt)
                except Exception:
                    val = input(full_prompt)
            else:
                val = input(full_prompt)
        except EOFError as exc:
            raise RuntimeError(f"Input closed while waiting for: {prompt_text}") from exc
        val = val.strip()
        if not val and default:
            return default
        if val:
            return val
        print(f"{YELLOW}  Please enter a value.{RESET}", flush=True)


# ------------------------------------------------------------------------------
# Shadow Hash & Folder Helpers
# ------------------------------------------------------------------------------
def normalize_cpanel_shadow_hash(raw_hash: str) -> str:
    h = raw_hash.strip()
    if not h or h in ("*", "!", "!!", "x", "*LK*", "NP"):
        return ""
    if h.startswith("{"):
        return h
    if h.startswith("$6$"):
        return "{SHA512-CRYPT}" + h
    if h.startswith("$5$"):
        return "{SHA256-CRYPT}" + h
    if h.startswith("$1$"):
        return "{MD5-CRYPT}" + h
    if h.startswith(("$2a$", "$2b$", "$2y$")):
        return "{BLF-CRYPT}" + h
    if h.startswith("$"):
        return "{CRYPT}" + h
    return ""


def parse_shadow_text(content: str, domain: str) -> dict[str, str]:
    out: dict[str, str] = {}
    dom = domain.strip().lower()
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        parts = line.split(":")
        local_part = parts[0].strip().lower()
        raw_hash = parts[1].strip() if len(parts) > 1 else ""
        if not local_part:
            continue
        norm = normalize_cpanel_shadow_hash(raw_hash)
        if norm:
            email_key = local_part if "@" in local_part else f"{local_part}@{dom}"
            out[email_key] = norm
    return out


def map_folder_to_mailsomadhan(raw_folder_name: str, flags: list[str], delim: str = ".") -> tuple[str, str]:
    lower_flags = {f.lower() for f in flags}
    cleaned = raw_folder_name.strip()
    if cleaned.upper() == "INBOX":
        return "INBOX", "inbox"

    if cleaned.upper().startswith("INBOX.") or cleaned.upper().startswith("INBOX/"):
        stripped = cleaned[6:]
    elif cleaned.startswith(".") and len(cleaned) > 1:
        stripped = cleaned[1:]
    else:
        stripped = cleaned

    norm = stripped.replace(delim or ".", "/").strip("/")
    low = norm.lower()

    if "\\sent" in lower_flags or low in ("sent", "sent messages", "sent items", "sent mail"):
        return "Sent", "sent"
    if "\\drafts" in lower_flags or low in ("drafts", "draft"):
        return "Drafts", "drafts"
    if "\\junk" in lower_flags or "\\spam" in lower_flags or low in ("junk", "spam", "junk mail", "junk e-mail", "bulk mail"):
        return "Junk", "junk"
    if "\\trash" in lower_flags or low in ("trash", "deleted", "deleted items", "deleted messages", "bin"):
        return "Trash", "trash"
    if "\\archive" in lower_flags or low in ("archive", "archives"):
        return "Archive", "archive"

    safe_parts = [re.sub(r'[\x00-\x1f\x7f"\\*%]', "_", p).strip() for p in norm.split("/") if p.strip()]
    target = "/".join(safe_parts) if safe_parts else "Archive"
    return target[:80], "custom"


def safe_folder_slug(folder_name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", folder_name.replace("/", "__")).strip("_")
    return slug or "INBOX"


def clamp_timestamp(ts: float) -> float:
    min_ts = 946684800.0  # 2000-01-01
    max_ts = time.time() + 86400.0
    if ts < min_ts or ts > max_ts:
        return time.time()
    return ts


def parse_eml_metadata(
    raw_bytes: bytes,
    uid: int,
    flags: list[str],
    internal_ts: float,
    source_folder: str,
    target_folder: str,
    role: str,
    rel_path: str,
) -> dict[str, Any]:
    msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)

    def hdr(name: str) -> str:
        try:
            return str(msg.get(name) or "").strip()
        except Exception:
            return ""

    date_hdr = hdr("Date")
    if date_hdr:
        try:
            dt = email.utils.parsedate_to_datetime(date_hdr)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            internal_ts = clamp_timestamp(dt.timestamp())
        except Exception:
            internal_ts = clamp_timestamp(internal_ts)
    else:
        internal_ts = clamp_timestamp(internal_ts)

    message_id = hdr("Message-ID")
    if not message_id:
        digest = hashlib.sha256(raw_bytes).hexdigest()[:32]
        message_id = f"<sha256-{digest}@mailsomadhan.imported>"

    from_addrs = [addr.lower() for _, addr in email.utils.getaddresses([hdr("From")]) if "@" in addr]
    to_addrs = [
        addr.lower()
        for _, addr in email.utils.getaddresses([hdr("To"), hdr("Cc"), hdr("Delivered-To"), hdr("X-Original-To")])
        if "@" in addr
    ]
    has_attachment = False
    try:
        for part in msg.walk():
            if part.is_multipart():
                continue
            if part.get_content_disposition() == "attachment" or part.get_filename():
                has_attachment = True
                break
    except Exception:
        pass

    allowed_flags = {"\\seen": "\\Seen", "\\answered": "\\Answered", "\\flagged": "\\Flagged", "\\draft": "\\Draft"}
    clean_flags = []
    for f in flags:
        mapped = allowed_flags.get(f.lower())
        if mapped and mapped not in clean_flags:
            clean_flags.append(mapped)

    return {
        "uid": uid,
        "rel_path": rel_path,
        "source_folder": source_folder,
        "target_folder": target_folder,
        "role": role,
        "flags": clean_flags,
        "internal_ts": internal_ts,
        "internal_iso": datetime.datetime.fromtimestamp(internal_ts, tz=datetime.timezone.utc).isoformat(),
        "message_id": message_id[:500],
        "subject": hdr("Subject")[:500],
        "sender": (from_addrs[0] if from_addrs else "")[:320],
        "recipients": to_addrs[:50],
        "size": len(raw_bytes),
        "has_attachment": has_attachment,
    }


# ------------------------------------------------------------------------------
# cPanel Client (Reads shadow password hashes & Maildir files without password change)
# ------------------------------------------------------------------------------
class CPanelClient:
    def __init__(self, host_input: str, username: str, password: str):
        self.raw_host_input = host_input.strip()
        self.base_url, self.hostname, self.port = self._parse_host(self.raw_host_input)
        self.username = username.strip()
        self.password = password
        self.security_token = ""
        self.cookie_jar = http.cookiejar.CookieJar()
        self.ssl_ctx = ssl._create_unverified_context()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.ssl_ctx),
            urllib.request.HTTPCookieProcessor(self.cookie_jar),
        )
        basic_raw = f"{self.username}:{self.password}".encode("utf-8")
        self.basic_auth = "Basic " + base64.b64encode(basic_raw).decode("ascii")

    @staticmethod
    def _parse_host(raw: str) -> tuple[str, str, int]:
        val = raw.strip()
        if not re.match(r"^https?://", val, re.I):
            val = "https://" + val
        parsed = urllib.parse.urlparse(val)
        scheme = parsed.scheme.lower() or "https"
        hostname = (parsed.hostname or "").strip().lower()
        if not hostname:
            raise ValueError(f"Invalid cPanel host/URL: {raw}")
        port = parsed.port or (2083 if scheme == "https" else 2082)
        return f"{scheme}://{hostname}:{port}", hostname, port

    def _candidate_base_urls(self) -> list[tuple[str, str, int]]:
        candidates = [(self.base_url, self.hostname, self.port)]
        base_dom = self.hostname
        for prefix in ("cpanel.", "mail.", "webmail."):
            if base_dom.startswith(prefix):
                base_dom = base_dom[len(prefix) :]
                break
        for sub in (f"cpanel.{base_dom}", f"mail.{base_dom}", base_dom):
            cand = (f"https://{sub}:2083", sub, 2083)
            if cand not in candidates:
                candidates.append(cand)
        return candidates

    def _request(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        post_data: dict[str, Any] | None = None,
        use_basic_auth: bool = False,
        timeout: int = 35,
    ) -> bytes:
        url = f"{self.base_url}{path}"
        if params:
            qs = urllib.parse.urlencode(params, doseq=True)
            url = f"{url}{'&' if '?' in url else '?'}{qs}"
        data_bytes = None
        headers = {
            "User-Agent": "MailSomadhan-cPanel-Backup/1.0",
            "Accept": "application/json, text/plain, */*",
        }
        if use_basic_auth or not self.security_token:
            headers["Authorization"] = self.basic_auth
        if post_data is not None:
            data_bytes = urllib.parse.urlencode(post_data, doseq=True).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=data_bytes, headers=headers)
        with self.opener.open(req, timeout=timeout) as resp:
            return resp.read()

    def login(self) -> None:
        last_err: Exception | None = None
        for base_url, hostname, port in self._candidate_base_urls():
            self.base_url, self.hostname, self.port = base_url, hostname, port
            info(f"Logging into cPanel at {BOLD}{self.base_url}{RESET} as {BOLD}{self.username}{RESET}...")

            try:
                raw = self._request(
                    "/login/?login_only=1",
                    post_data={"user": self.username, "pass": self.password},
                    use_basic_auth=False,
                    timeout=20,
                )
                data = json.loads(raw.decode("utf-8", "replace"))
                if data.get("status") == 1 and data.get("security_token"):
                    self.security_token = str(data["security_token"])
                    ok(f"Logged into cPanel successfully ({self.base_url})")
                    return
                if data.get("status") == 0:
                    raise RuntimeError("Invalid cPanel username or password (or 2FA is active).")
            except RuntimeError:
                raise
            except Exception as exc:
                last_err = exc

            try:
                res = self.uapi("Email", "list_pops", use_basic_auth=True)
                if res.get("status") == 1:
                    ok(f"Logged into cPanel successfully via Basic Auth ({self.base_url})")
                    return
            except urllib.error.HTTPError as hexc:
                if hexc.code in (401, 403):
                    raise RuntimeError("Invalid cPanel username or password.") from hexc
                last_err = hexc
            except Exception as exc:
                last_err = exc

        raise RuntimeError(
            f"Could not connect or log into cPanel ({self.raw_host_input}). "
            f"Check the cPanel URL/IP, username, and password. Details: {last_err}"
        )

    def uapi(
        self,
        module: str,
        func: str,
        params: dict[str, Any] | None = None,
        post_data: dict[str, Any] | None = None,
        use_basic_auth: bool = False,
    ) -> dict[str, Any]:
        prefix = self.security_token if (self.security_token and not use_basic_auth) else ""
        path = f"{prefix}/execute/{module}/{func}"
        raw = self._request(path, params=params, post_data=post_data, use_basic_auth=use_basic_auth)
        data = json.loads(raw.decode("utf-8", "replace"))
        if "result" in data and isinstance(data["result"], dict) and "status" in data["result"]:
            return data["result"]
        return data

    def list_domains_and_accounts(self) -> tuple[list[str], list[dict[str, Any]]]:
        domains: set[str] = set()
        try:
            dom_res = self.uapi("DomainInfo", "list_domains")
            if dom_res.get("status") == 1 and isinstance(dom_res.get("data"), dict):
                ddata = dom_res["data"]
                if ddata.get("main_domain"):
                    domains.add(str(ddata["main_domain"]).lower())
                for key in ("addon_domains", "parked_domains", "sub_domains"):
                    for item in ddata.get(key) or []:
                        if isinstance(item, str) and item:
                            domains.add(item.lower())
        except Exception:
            pass

        accounts: list[dict[str, Any]] = []
        res = None
        for fn in ("list_pops_with_disk", "list_pops"):
            try:
                r = self.uapi("Email", fn)
                if r.get("status") == 1 and isinstance(r.get("data"), list):
                    res = r["data"]
                    break
            except Exception:
                continue

        if res is None:
            raise RuntimeError("Failed to list email accounts from cPanel UAPI (Email/list_pops).")

        for row in res:
            if not isinstance(row, dict):
                continue
            email_addr = str(row.get("email") or "").strip().lower()
            user_part = str(row.get("user") or "").strip().lower()
            dom_part = str(row.get("domain") or "").strip().lower()

            if "@" not in email_addr:
                if user_part and dom_part:
                    email_addr = f"{user_part}@{dom_part}"
                else:
                    continue
            if not user_part or not dom_part:
                user_part, _, dom_part = email_addr.partition("@")
            if not user_part or not dom_part:
                continue

            domains.add(dom_part)
            quota_mb = 1024
            raw_q = row.get("_diskquota") or row.get("diskquota")
            if raw_q is not None and str(raw_q).strip().lower() not in ("unlimited", "none", "0", ""):
                try:
                    q_num = float(str(raw_q).strip())
                    if q_num > 1024 * 1024:
                        quota_mb = max(250, int(round(q_num / (1024 * 1024))))
                    else:
                        quota_mb = max(250, int(round(q_num)))
                except ValueError:
                    quota_mb = 1024

            accounts.append(
                {
                    "email": email_addr,
                    "local_part": user_part,
                    "domain": dom_part,
                    "quota_mb": quota_mb,
                }
            )

        accounts.sort(key=lambda a: a["email"])
        return sorted(domains), accounts

    def download_raw_file(self, fullpath: str) -> bytes:
        prefix = self.security_token or ""
        try:
            return self._request(f"{prefix}/download", params={"skipencode": "1", "file": fullpath}, timeout=45)
        except Exception:
            parent_dir, _, filename = fullpath.rpartition("/")
            res = self.uapi("Fileman", "get_file_content", params={"dir": parent_dir, "file": filename})
            if res.get("status") == 1 and isinstance(res.get("data"), dict):
                content = res["data"].get("content") or ""
                return content.encode("utf-8", "surrogateescape")
            raise

    def fetch_domain_shadow(self, domain: str) -> tuple[str, dict[str, str]]:
        """Read `etc/<domain>/shadow` from cPanel so original password hashes are preserved."""
        # 1) Try Fileman/get_file_content on etc/<domain>/shadow
        try:
            res = self.uapi("Fileman", "get_file_content", params={"dir": f"etc/{domain}", "file": "shadow"})
            if res.get("status") == 1 and isinstance(res.get("data"), dict):
                content = str(res["data"].get("content") or "")
                if content.strip():
                    return content, parse_shadow_text(content, domain)
        except Exception:
            pass

        # 2) Try listing etc/<domain> to find fullpath of shadow and download via /download
        try:
            listing = self.uapi("Fileman", "list_files", params={"dir": f"etc/{domain}", "show_hidden": 1})
            if listing.get("status") == 1:
                for item in listing.get("data") or []:
                    if isinstance(item, dict) and str(item.get("file") or "") == "shadow":
                        fp = str(item.get("fullpath") or f"etc/{domain}/shadow")
                        raw = self.download_raw_file(fp)
                        text = raw.decode("utf-8", "replace")
                        if text.strip():
                            return text, parse_shadow_text(text, domain)
        except Exception:
            pass

        return "", {}

    def download_mailbox_without_password_change(
        self, domain: str, local_part: str, mailbox_dir: Path
    ) -> tuple[list[dict[str, Any]], dict[str, int]]:
        base_maildir = f"mail/{domain}/{local_part}"
        listing = self.uapi(
            "Fileman",
            "list_files",
            params={"dir": base_maildir, "include_mime": 0, "include_hash": 0, "show_hidden": 1},
        )
        if listing.get("status") != 1:
            return [], {}

        folders_to_scan: list[tuple[str, str, str]] = [
            (base_maildir, "INBOX", "inbox"),
        ]
        for item in listing.get("data") or []:
            if not isinstance(item, dict) or item.get("type") != "dir":
                continue
            fname = str(item.get("file") or "")
            if fname.startswith(".") and fname not in (".", "..") and not fname.startswith((".cpanel", ".trash")):
                target_folder, role = map_folder_to_mailsomadhan(fname, [], ".")
                folders_to_scan.append((f"{base_maildir}/{fname}", target_folder, role))

        download_jobs: list[dict[str, Any]] = []
        uid_counter = 1

        for maildir_path, target_folder, role in folders_to_scan:
            folder_slug = safe_folder_slug(target_folder)
            for subdir, default_seen in (("cur", True), ("new", False)):
                sub_path = f"{maildir_path}/{subdir}"
                try:
                    sub_list = self.uapi(
                        "Fileman",
                        "list_files",
                        params={"dir": sub_path, "types": "file", "show_hidden": 1},
                    )
                except Exception:
                    continue
                if sub_list.get("status") != 1:
                    continue
                for fentry in sub_list.get("data") or []:
                    if not isinstance(fentry, dict) or fentry.get("type") != "file":
                        continue
                    filename = str(fentry.get("file") or "")
                    fullpath = str(fentry.get("fullpath") or f"{sub_path}/{filename}")
                    if not filename or filename.startswith(("dovecot", "maildir")):
                        continue

                    flags = []
                    if ":2," in filename:
                        flag_chars = filename.rsplit(":2,", 1)[1]
                        if "S" in flag_chars:
                            flags.append("\\Seen")
                        if "F" in flag_chars:
                            flags.append("\\Flagged")
                        if "R" in flag_chars:
                            flags.append("\\Answered")
                        if "D" in flag_chars:
                            flags.append("\\Draft")
                    elif default_seen:
                        flags.append("\\Seen")

                    mtime = fentry.get("mtime")
                    internal_ts = float(mtime) if mtime else time.time()
                    download_jobs.append(
                        {
                            "uid": uid_counter,
                            "fullpath": fullpath,
                            "flags": flags,
                            "internal_ts": internal_ts,
                            "source_folder": maildir_path,
                            "target_folder": target_folder,
                            "folder_slug": folder_slug,
                            "role": role,
                        }
                    )
                    uid_counter += 1

        if not download_jobs:
            return [], {}

        saved_manifest: list[dict[str, Any]] = []
        folder_counts: dict[str, int] = {}

        def fetch_one(job: dict[str, Any]) -> dict[str, Any] | None:
            try:
                raw_bytes = self.download_raw_file(job["fullpath"])
            except Exception:
                return None
            if not raw_bytes:
                return None
            out_folder = mailbox_dir / job["folder_slug"]
            out_folder.mkdir(parents=True, exist_ok=True)
            uid = job["uid"]
            eml_file = out_folder / f"{uid}.eml"
            eml_file.write_bytes(raw_bytes)
            return parse_eml_metadata(
                raw_bytes=raw_bytes,
                uid=uid,
                flags=job["flags"],
                internal_ts=job["internal_ts"],
                source_folder=job["source_folder"],
                target_folder=job["target_folder"],
                role=job["role"],
                rel_path=f"{job['folder_slug']}/{uid}.eml",
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            for meta in pool.map(fetch_one, download_jobs):
                if meta is not None:
                    saved_manifest.append(meta)
                    tf = meta["target_folder"]
                    folder_counts[tf] = folder_counts.get(tf, 0) + 1

        return saved_manifest, folder_counts


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="cpanel-migrate.sh",
        description="Backup all email accounts, original password hashes, and messages from cPanel into a One-Click MailSomadhan archive.",
    )
    p.add_argument("--cpanel-host", default=os.environ.get("CPANEL_HOST", ""), help="cPanel URL or domain (e.g. example.com or https://example.com:2083)")
    p.add_argument("--cpanel-user", default=os.environ.get("CPANEL_USER", ""), help="cPanel username")
    p.add_argument("--cpanel-pass", default=os.environ.get("CPANEL_PASS", ""), help="cPanel password")
    p.add_argument("--domain", default=os.environ.get("CPANEL_DOMAIN", ""), help="Domain name to backup (or 'all')")
    p.add_argument("--output", default="", help="Output .tar.gz file path (default: ./cpanel-backup-<domain>-<timestamp>.tar.gz)")
    return p.parse_args()


def main() -> None:
    if not sys.stdin.isatty():
        try:
            sys.stdin = open("/dev/tty", "r", encoding="utf-8", errors="replace")
        except Exception:
            pass

    args = parse_args()
    print(f"\n{BOLD}======================================================================{RESET}")
    print(f"{BOLD}  cPanel Email Backup Tool (Same Password & Full Mail Backup){RESET}")
    print(f"{BOLD}======================================================================{RESET}\n")

    cpanel_host = args.cpanel_host.strip() or ask_input("1. cPanel Host / Domain / URL (e.g. example.com or https://example.com:2083)")
    cpanel_user = args.cpanel_user.strip() or ask_input("2. cPanel Username")
    cpanel_pass = args.cpanel_pass.strip() or ask_input("3. cPanel Password", secret=True)
    print()

    cp = CPanelClient(cpanel_host, cpanel_user, cpanel_pass)
    cp.login()

    all_domains, all_accounts = cp.list_domains_and_accounts()
    if not all_accounts:
        warn("No email accounts were found in this cPanel account.")
        sys.exit(0)

    counts_by_dom: dict[str, int] = {}
    for a in all_accounts:
        counts_by_dom[a["domain"]] = counts_by_dom.get(a["domain"], 0) + 1

    selected_domain = args.domain.strip().lower()
    if not selected_domain:
        dom_list = sorted(counts_by_dom.keys())
        print(f"\n{BOLD}Domains with email accounts found in cPanel:{RESET}")
        for idx, dname in enumerate(dom_list, 1):
            print(f"  {BOLD}{idx}){RESET} {dname} ({counts_by_dom[dname]} email accounts)")
        if len(dom_list) > 1:
            print(f"  {BOLD}all){RESET} All domains ({len(all_accounts)} email accounts total)")
        print()
        choice = ask_input("4. Select domain (enter number, domain name, or 'all')", default=dom_list[0]).lower()
        if choice == "all":
            selected_domain = "all"
        elif choice.isdigit() and 1 <= int(choice) <= len(dom_list):
            selected_domain = dom_list[int(choice) - 1]
        else:
            selected_domain = choice

    if selected_domain == "all":
        target_accounts = all_accounts
        label_domain = "all-domains"
    else:
        target_accounts = [a for a in all_accounts if a["domain"] == selected_domain]
        label_domain = selected_domain

    if not target_accounts:
        err(f"No email accounts found for domain '{selected_domain}'. Available domains: {', '.join(sorted(counts_by_dom.keys()))}")
        sys.exit(1)

    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_path = (
        Path(args.output).resolve()
        if args.output
        else Path.cwd() / f"cpanel-backup-{label_domain}-{timestamp}.tar.gz"
    )
    if not str(archive_path).endswith((".tar.gz", ".tgz")):
        archive_path = Path(str(archive_path) + ".tar.gz")

    info(
        f"Found {BOLD}{len(target_accounts)}{RESET} email account(s) for {BOLD}{selected_domain}{RESET}. "
        "Reading original password hashes and backing up all emails..."
    )

    with tempfile.TemporaryDirectory(prefix="cpanel-backup-work-") as tmpdir:
        work_dir = Path(tmpdir) / f"cpanel-backup-{label_domain}"
        shadow_dir = work_dir / "shadow"
        shadow_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = work_dir / "backup_manifest.json"

        # Fetch original shadow password hashes per domain
        shadow_by_email: dict[str, str] = {}
        for dom in sorted({a["domain"] for a in target_accounts}):
            raw_shadow, parsed_map = cp.fetch_domain_shadow(dom)
            if raw_shadow:
                (shadow_dir / f"{dom}.shadow").write_text(raw_shadow, encoding="utf-8")
                shadow_by_email.update(parsed_map)
                ok(f"Recovered {len(parsed_map)} password hash(es) from etc/{dom}/shadow (same passwords will work!)")
            else:
                warn(f"Could not read etc/{dom}/shadow; accounts on {dom} will get random passwords on import.")

        manifest: dict[str, Any] = {
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "cpanel_host": cp.base_url,
            "cpanel_user": cpanel_user,
            "selected_domain": selected_domain,
            "accounts": [],
        }

        total_msgs_all = 0
        for idx, acc in enumerate(target_accounts, 1):
            email_addr = acc["email"]
            print(f"\n{BOLD}[{idx}/{len(target_accounts)}] Backing up {email_addr}{RESET}")
            mailbox_dir = work_dir / "mailboxes" / email_addr
            mailbox_dir.mkdir(parents=True, exist_ok=True)

            messages_meta, folder_counts = cp.download_mailbox_without_password_change(
                domain=acc["domain"],
                local_part=acc["local_part"],
                mailbox_dir=mailbox_dir,
            )

            total_bytes = sum(int(m.get("size") or 0) for m in messages_meta)
            min_needed_mb = int(total_bytes / (1024 * 1024)) + 512
            quota_mb = max(int(acc.get("quota_mb") or 1024), min_needed_mb, 1024)

            (mailbox_dir / "messages.json").write_text(
                json.dumps(messages_meta, indent=2, ensure_ascii=False), encoding="utf-8"
            )

            pw_hash = shadow_by_email.get(email_addr, "")
            entry = {
                "email": email_addr,
                "local_part": acc["local_part"],
                "domain": acc["domain"],
                "quota_mb": quota_mb,
                "password_hash": pw_hash,
                "total_messages": len(messages_meta),
                "folder_counts": folder_counts,
            }
            manifest["accounts"].append(entry)
            total_msgs_all += len(messages_meta)

            folder_summary = ", ".join(f"{k}: {v}" for k, v in folder_counts.items()) if folder_counts else "0 messages"
            pw_note = " + original password hash" if pw_hash else ""
            ok(f"Saved {BOLD}{len(messages_meta)}{RESET} messages{pw_note} from {email_addr} ({folder_summary})")

        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

        info(f"Packaging backup into One-Click Archive: {BOLD}{archive_path.name}{RESET}...")
        with tarfile.open(archive_path, "w:gz") as tf:
            tf.add(work_dir, arcname=work_dir.name)

    size_mb = archive_path.stat().st_size / (1024 * 1024)
    print(f"\n{BOLD}======================================================================{RESET}")
    print(f"{GREEN}{BOLD}  Backup Completed Successfully!{RESET}")
    print(f"{BOLD}======================================================================{RESET}")
    print(f"  One-Click File : {BOLD}{archive_path}{RESET} ({size_mb:.2f} MB)")
    print(f"  Total Accounts : {len(manifest['accounts'])}")
    print(f"  Total Messages : {total_msgs_all}")
    print(f"\n  {BOLD}How to insert into MailSomadhan (One Click):{RESET}")
    print("  1. Open your MailSomadhan Admin Panel -> Mailboxes (or Backups)")
    print("  2. Click 'Import backup' and select the .tar.gz file above")
    print("  3. All mailboxes will be created with the EXACT SAME cPanel passwords & messages!")
    print(f"{BOLD}======================================================================{RESET}\n")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        err(str(exc))
        sys.exit(1)
PYEOF

exec "$PYTHON_BIN" "$PY_SCRIPT" "$@"
