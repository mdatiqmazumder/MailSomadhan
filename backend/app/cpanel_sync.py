"""Direct cPanel UAPI client and background import job runner for the Admin Panel."""
import base64
import concurrent.futures
import http.cookiejar
import json
import os
import re
import secrets
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from .config import settings
from .cpanel_import import (
    import_discovered_accounts,
    map_folder_name,
    parse_eml_bytes,
    parse_shadow_text,
)
from .db import SessionLocal
from .security import DOMAIN_RE, LOCAL_RE

JOB_ID_RE = re.compile(r"^[a-f0-9]{24,32}$")


class CPanelClient:
    """Connects to cPanel over HTTPS (port 2083/2082) using username & password."""

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
            raise ValueError(f"Invalid cPanel host or URL: {raw}")
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
            "User-Agent": "MailSomadhan-cPanel-Sync/1.0",
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
            try:
                raw = self._request(
                    "/login/?login_only=1",
                    post_data={"user": self.username, "pass": self.password},
                    use_basic_auth=False,
                    timeout=18,
                )
                data = json.loads(raw.decode("utf-8", "replace"))
                if data.get("status") == 1 and data.get("security_token"):
                    self.security_token = str(data["security_token"])
                    return
                if data.get("status") == 0:
                    raise HTTPException(401, "Invalid cPanel username or password (or 2FA is active).")
            except HTTPException:
                raise
            except Exception as exc:
                last_err = exc

            try:
                res = self.uapi("Email", "list_pops", use_basic_auth=True)
                if res.get("status") == 1:
                    return
            except urllib.error.HTTPError as hexc:
                if hexc.code in (401, 403):
                    raise HTTPException(401, "Invalid cPanel username or password.") from hexc
                last_err = hexc
            except Exception as exc:
                last_err = exc

        raise HTTPException(
            502,
            f"Could not connect to cPanel ({self.raw_host_input}). Check the URL/host, port 2083, and credentials. ({last_err})",
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
            raise HTTPException(502, "Failed to list email accounts from cPanel (Email/list_pops).")

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
            if not DOMAIN_RE.match(dom_part) or not LOCAL_RE.match(user_part):
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

            used_human = str(row.get("humandiskused") or "").strip()
            used_bytes = 0
            try:
                used_bytes = int(float(row.get("_diskused") or 0))
            except (ValueError, TypeError):
                used_bytes = 0

            accounts.append(
                {
                    "email": email_addr,
                    "local_part": user_part,
                    "domain": dom_part,
                    "quota_mb": quota_mb,
                    "used_human": used_human,
                    "used_bytes": used_bytes,
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

    def fetch_domain_shadow(self, domain: str) -> dict[str, str]:
        try:
            res = self.uapi("Fileman", "get_file_content", params={"dir": f"etc/{domain}", "file": "shadow"})
            if res.get("status") == 1 and isinstance(res.get("data"), dict):
                content = str(res["data"].get("content") or "")
                if content.strip():
                    return parse_shadow_text(content, domain)
        except Exception:
            pass

        try:
            listing = self.uapi("Fileman", "list_files", params={"dir": f"etc/{domain}", "show_hidden": 1})
            if listing.get("status") == 1:
                for item in listing.get("data") or []:
                    if isinstance(item, dict) and str(item.get("file") or "") == "shadow":
                        fp = str(item.get("fullpath") or f"etc/{domain}/shadow")
                        text = self.download_raw_file(fp).decode("utf-8", "replace")
                        if text.strip():
                            return parse_shadow_text(text, domain)
        except Exception:
            pass
        return {}

    def download_mailbox_to_dir(self, domain: str, local_part: str, out_dir: Path) -> list[dict[str, Any]]:
        base_maildir = f"mail/{domain}/{local_part}"
        try:
            listing = self.uapi(
                "Fileman",
                "list_files",
                params={"dir": base_maildir, "include_mime": 0, "include_hash": 0, "show_hidden": 1},
            )
        except Exception:
            return []
        if listing.get("status") != 1:
            return []

        folders_to_scan: list[tuple[str, str, str]] = [(base_maildir, "INBOX", "inbox")]
        for item in listing.get("data") or []:
            if not isinstance(item, dict) or item.get("type") != "dir":
                continue
            fname = str(item.get("file") or "")
            if fname.startswith(".") and fname not in (".", "..") and not fname.startswith((".cpanel", ".trash")):
                target_folder, role = map_folder_name(fname, [], ".")
                folders_to_scan.append((f"{base_maildir}/{fname}", target_folder, role))

        jobs: list[dict[str, Any]] = []
        uid_counter = 1
        for maildir_path, target_folder, role in folders_to_scan:
            for subdir, default_seen in (("cur", True), ("new", False)):
                sub_path = f"{maildir_path}/{subdir}"
                try:
                    sub_list = self.uapi("Fileman", "list_files", params={"dir": sub_path, "types": "file", "show_hidden": 1})
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
                        fchars = filename.rsplit(":2,", 1)[1]
                        if "S" in fchars:
                            flags.append("\\Seen")
                        if "F" in fchars:
                            flags.append("\\Flagged")
                        if "R" in fchars:
                            flags.append("\\Answered")
                        if "D" in fchars:
                            flags.append("\\Draft")
                    elif default_seen:
                        flags.append("\\Seen")
                    mtime = fentry.get("mtime")
                    jobs.append(
                        {
                            "uid": uid_counter,
                            "fullpath": fullpath,
                            "flags": flags,
                            "internal_ts": float(mtime) if mtime else time.time(),
                            "target_folder": target_folder,
                            "role": role,
                        }
                    )
                    uid_counter += 1

        if not jobs:
            return []

        messages: list[dict[str, Any]] = []

        def fetch_one(job: dict[str, Any]) -> dict[str, Any] | None:
            try:
                raw_bytes = self.download_raw_file(job["fullpath"])
            except Exception:
                return None
            if not raw_bytes:
                return None
            eml_path = out_dir / f"{job['uid']}.eml"
            eml_path.write_bytes(raw_bytes)
            return parse_eml_bytes(
                raw_bytes=raw_bytes,
                flags=job["flags"],
                internal_ts=job["internal_ts"],
                target_folder=job["target_folder"],
                role=job["role"],
                eml_path=eml_path,
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            for meta in pool.map(fetch_one, jobs):
                if meta is not None:
                    messages.append(meta)
        return messages


def inspect_cpanel(host: str, username: str, password: str) -> dict[str, Any]:
    """Connect to cPanel and return available domains and email accounts."""
    cp = CPanelClient(host, username, password)
    cp.login()
    domains, accounts = cp.list_domains_and_accounts()
    return {
        "cpanel_host": cp.base_url,
        "domains": domains,
        "accounts": accounts,
    }


def _jobs_dir() -> Path:
    d = Path(settings.state_dir) / "cpanel-jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_job(job_id: str, data: dict[str, Any]) -> None:
    path = _jobs_dir() / f"{job_id}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def _cleanup_old_jobs() -> None:
    cutoff = time.time() - 7200
    for p in _jobs_dir().glob("*.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except OSError:
            pass


def get_cpanel_import_job(job_id: str) -> dict[str, Any]:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(404, "Import job not found")
    path = _jobs_dir() / f"{job_id}.json"
    if not path.is_file():
        raise HTTPException(404, "Import job not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "Could not read import job status") from exc


def start_cpanel_import_job(
    host: str,
    username: str,
    password: str,
    selected_emails: list[str],
    allowed_domain_ids: set[int] | None,
    is_super: bool,
    use_cpanel_passwords: bool,
    reset_existing_passwords: bool,
) -> str:
    """Validate cPanel connection & selected accounts, then run backup + import in background."""
    wanted = {e.strip().lower() for e in selected_emails if e.strip()}
    if not wanted:
        raise HTTPException(400, "Select at least one email account to import")

    cp = CPanelClient(host, username, password)
    cp.login()
    _domains, all_accounts = cp.list_domains_and_accounts()
    selected_accounts = [a for a in all_accounts if a["email"] in wanted]
    if not selected_accounts:
        raise HTTPException(400, "None of the selected email accounts were found in cPanel")

    _cleanup_old_jobs()
    job_id = secrets.token_hex(16)
    total = len(selected_accounts)
    _write_job(
        job_id,
        {
            "job_id": job_id,
            "status": "running",
            "message": "Reading cPanel password hashes…",
            "current": 0,
            "total": total,
            "result": None,
            "error": "",
        },
    )

    def worker() -> None:
        try:
            selected_domains = sorted({a["domain"] for a in selected_accounts})
            shadow_map: dict[str, str] = {}
            for dom in selected_domains:
                shadow_map.update(cp.fetch_domain_shadow(dom))

            with tempfile.TemporaryDirectory(prefix="ms-cpanel-live-") as tmpdir:
                tmp_root = Path(tmpdir)
                discovered: list[dict[str, Any]] = []

                for idx, acc in enumerate(selected_accounts, 1):
                    email_addr = acc["email"]
                    _write_job(
                        job_id,
                        {
                            "job_id": job_id,
                            "status": "running",
                            "message": f"Downloading messages from {email_addr} ({idx}/{total})…",
                            "current": idx - 1,
                            "total": total,
                            "result": None,
                            "error": "",
                        },
                    )
                    mbox_tmp = tmp_root / email_addr
                    mbox_tmp.mkdir(parents=True, exist_ok=True)
                    messages = cp.download_mailbox_to_dir(acc["domain"], acc["local_part"], mbox_tmp)
                    discovered.append(
                        {
                            "email": email_addr,
                            "local_part": acc["local_part"],
                            "domain": acc["domain"],
                            "quota_mb": acc.get("quota_mb", 1024),
                            "password_hash": shadow_map.get(email_addr, ""),
                            "messages": messages,
                        }
                    )

                _write_job(
                    job_id,
                    {
                        "job_id": job_id,
                        "status": "running",
                        "message": "Inserting domains, mailboxes, and messages into MailSomadhan…",
                        "current": total,
                        "total": total,
                        "result": None,
                        "error": "",
                    },
                )

                with SessionLocal() as db:
                    res = import_discovered_accounts(
                        db=db,
                        accounts=discovered,
                        allowed_domain_ids=allowed_domain_ids,
                        is_super=is_super,
                        use_cpanel_passwords=use_cpanel_passwords,
                        reset_existing_passwords=reset_existing_passwords,
                    )

                _write_job(
                    job_id,
                    {
                        "job_id": job_id,
                        "status": "done",
                        "message": "Import completed",
                        "current": total,
                        "total": total,
                        "result": res,
                        "error": "",
                    },
                )
        except HTTPException as exc:
            _write_job(
                job_id,
                {
                    "job_id": job_id,
                    "status": "failed",
                    "message": exc.detail,
                    "current": 0,
                    "total": total,
                    "result": None,
                    "error": str(exc.detail),
                },
            )
        except Exception as exc:
            _write_job(
                job_id,
                {
                    "job_id": job_id,
                    "status": "failed",
                    "message": str(exc),
                    "current": 0,
                    "total": total,
                    "result": None,
                    "error": str(exc),
                },
            )

    threading.Thread(target=worker, daemon=True).start()
    return job_id
