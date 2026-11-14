"""Mail log collector.

Follows the Postfix journal and the Rspamd log and turns them into rows in mail_messages /
mail_deliveries, which power the dashboard, user analytics, message log and reports.

Run as:  python -m app.collector            (systemd unit mailsomadhan-collector)
         python -m app.collector --parse FILE  (offline: feed a saved "journalctl -o json" dump)
"""
import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header

from sqlalchemy import delete, select

from .db import Base, SessionLocal, create_tables, engine
from .models import Domain, MailDelivery, MailMessage, Setting
from .push import Notifier

RSPAMD_LOG = os.environ.get("MAILSOMADHAN_RSPAMD_LOG", "/var/log/rspamd/rspamd.log")
OPEN_TTL = timedelta(days=6)  # Postfix keeps deferred mail up to 5 days

SOURCES = {
    "postfix/smtpd": "smtp",
    "postfix/submission/smtpd": "submission",
    "postfix/smtps/smtpd": "submission",
    "postfix/webmail/smtpd": "webmail",
    "postfix/pickup": "local",
}
DELIVERY_AGENTS = ("postfix/smtp", "postfix/lmtp", "postfix/virtual", "postfix/local", "postfix/error",
                   "postfix/discard", "postfix/relay")

QID = r"(?P<qid>[0-9A-F]{6,20}|[0-9B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z]{10,20})"
RE_CLIENT = re.compile(QID + r": client=(?P<host>[^\[\s]*)\[(?P<ip>[^\]]*)\](?:.*?sasl_username=(?P<user>[^\s,]+))?")
RE_PICKUP = re.compile(QID + r": uid=\d+ from=<(?P<from>[^>]*)>")
RE_MSGID = re.compile(QID + r": message-id=<?(?P<mid>[^>\s]*)>?")
RE_SUBJECT = re.compile(QID + r": info: header Subject: (?P<subject>.*?) from [^;]*;")
RE_QMGR_FROM = re.compile(QID + r": from=<(?P<from>[^>]*)>, size=(?P<size>\d+), nrcpt=(?P<nrcpt>\d+)")
RE_REMOVED = re.compile(QID + r": removed")
RE_EXPIRED = re.compile(QID + r": from=<[^>]*>, status=expired")
RE_DELIVERY = re.compile(
    QID + r": to=<(?P<to>[^>]*)>,(?: orig_to=<(?P<orig>[^>]*)>,)? relay=(?P<relay>[^,]*), "
    r"(?:conn_use=\d+, )?delay=(?P<delay>[\d.]+), delays=[^,]*, dsn=(?P<dsn>[\d.]+), "
    r"status=(?P<status>\w+) \((?P<text>.*)\)$"
)
RE_MILTER_REJECT = re.compile(QID + r": milter-reject: \S+ from (?P<host>[^\[\s]*)\[(?P<ip>[^\]]*)\]: (?P<text>.*?); "
                              r"from=<(?P<from>[^>]*)> to=<(?P<to>[^>]*)>")
RE_NOQUEUE = re.compile(r"NOQUEUE: reject: \S+ from (?P<host>[^\[\s]*)\[(?P<ip>[^\]]*)\]: (?P<text>.*?); "
                        r"from=<(?P<from>[^>]*)> to=<(?P<to>[^>]*)>")
RE_RSPAMD = re.compile(
    r"rspamd_task_write_log: id: <(?P<mid>[^>]*)>, qid: <(?P<qid>[^>]*)>, ip: [^,]*, (?:user: (?P<user>[^,]*), )?"
    r"(?:mid: [^,]*, )?from: <(?P<from>[^>]*)>, \([^:]*: \w \((?P<action>[^)]*)\): \[(?P<score>-?[\d.]+)/[^\]]*\] "
    r"\[(?P<symbols>.*?)\]\)?, len:"
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def domain_of(address: str) -> str:
    return address.rpartition("@")[2].lower() if "@" in address else ""


def decode_subject(raw: str) -> str:
    try:
        return str(make_header(decode_header(raw)))[:500]
    except Exception:  # noqa: BLE001
        return raw[:500]


class Collector:
    def __init__(self):
        self.db = SessionLocal()
        self.open: dict[str, int] = {}  # queue id -> mail_messages.id
        self.spam_pending: dict[str, tuple[float, dict]] = {}  # rspamd result seen before the message row
        self.local_domains: set[str] = set()
        self.domains_loaded = 0.0
        self.last_purge = 0.0
        self.retention_days = 180
        self.notifier = None  # push.Notifier when running as the service (not for --parse)

    # ------------------------------------------------------------------ helpers
    def locals(self) -> set[str]:
        if time.time() - self.domains_loaded > 60:
            self.local_domains = {d for (d,) in self.db.execute(select(Domain.name))}
            row = self.db.get(Setting, "analytics_retention_days")
            try:
                self.retention_days = max(7, int(row.value)) if row else 180
            except ValueError:
                self.retention_days = 180
            self.domains_loaded = time.time()
        return self.local_domains

    def recent(self, qid: str) -> MailMessage | None:
        """Rspamd results may arrive after Postfix already finished the message."""
        return self.db.execute(
            select(MailMessage).where(MailMessage.queue_id == qid, MailMessage.created_at > utcnow() - timedelta(hours=6))
            .order_by(MailMessage.id.desc()).limit(1)
        ).scalar_one_or_none()

    def message(self, qid: str, when: datetime, create: bool = True) -> MailMessage | None:
        pk = self.open.get(qid)
        if pk:
            msg = self.db.get(MailMessage, pk)
            if msg:
                return msg
        # The collector may have restarted: look for a recent unfinished row.
        msg = self.db.execute(
            select(MailMessage).where(MailMessage.queue_id == qid, MailMessage.finished_at.is_(None),
                                      MailMessage.created_at > when - OPEN_TTL)
            .order_by(MailMessage.id.desc()).limit(1)
        ).scalar_one_or_none()
        if not msg and create:
            msg = MailMessage(queue_id=qid, created_at=when)
            self.db.add(msg)
            self.db.flush()
        if msg:
            self.open[qid] = msg.id
            pending = self.spam_pending.pop(qid, None)
            if pending:
                self.apply_spam(msg, pending[1])
        return msg

    def apply_spam(self, msg: MailMessage, info: dict) -> None:
        msg.spam_score = info["score"]
        msg.spam_action = info["action"]
        msg.spam_symbols = info["symbols"][:2000]
        msg.has_attachment = info["attachment"]
        if info.get("user") and not msg.sasl_user:
            msg.sasl_user = info["user"]

    def classify(self, msg: MailMessage) -> None:
        local = self.locals()
        sender_local = msg.sender_domain in local
        if msg.sasl_user:
            msg.user_email = msg.sasl_user.lower()
        elif msg.queue_id is None:
            pass  # rejected before acceptance: the envelope sender is unverified, attribute to nobody
        elif sender_local and msg.source in ("webmail", "local", "submission"):
            msg.user_email = msg.sender.lower()
        deliveries = msg.deliveries
        external = sum(1 for d in deliveries if not d.is_local)
        msg.external_rcpts = external
        if msg.status == "rejected":
            msg.direction = "outbound" if (msg.user_email or (sender_local and msg.source != "smtp")) else "inbound"
            return
        if msg.user_email or (sender_local and msg.source != "smtp"):
            msg.direction = "outbound" if external or not deliveries else "internal"
        elif external:
            msg.direction = "forward"  # outside mail forwarded by an alias
        else:
            msg.direction = "inbound"

    def recompute_status(self, msg: MailMessage) -> None:
        states = [d.status for d in msg.deliveries]
        if not states or msg.status == "rejected":
            return
        if all(s == "sent" for s in states):
            msg.status = "delivered"
        elif any(s in ("bounced", "expired") for s in states):
            msg.status = "bounced" if not any(s == "sent" for s in states) else "partial"
        elif any(s == "deferred" for s in states):
            msg.status = "deferred"

    # ------------------------------------------------------------------ postfix
    def postfix_line(self, ident: str, text: str, when: datetime) -> None:
        if ident in SOURCES:
            m = RE_CLIENT.match(text)
            if m:
                msg = self.message(m["qid"], when)
                msg.source = SOURCES[ident]
                msg.client_ip, msg.client_host = m["ip"], m["host"]
                if m["user"]:
                    msg.sasl_user = m["user"].lower()
                return
            m = RE_PICKUP.match(text)
            if m:
                msg = self.message(m["qid"], when)
                msg.source = "local"
                return
            m = RE_NOQUEUE.search(text)
            if m:
                sender = m["from"].lower()
                msg = MailMessage(
                    created_at=when, finished_at=when, source=SOURCES[ident], client_ip=m["ip"],
                    client_host=m["host"], sender=sender, sender_domain=domain_of(sender), status="rejected",
                    reason=m["text"][:1000], nrcpt=1,
                )
                rcpt = m["to"].lower()
                msg.deliveries.append(MailDelivery(
                    recipient=rcpt, recipient_domain=domain_of(rcpt), is_local=domain_of(rcpt) in self.locals(),
                    status="rejected", response=m["text"][:1000], updated_at=when))
                self.db.add(msg)
                self.classify(msg)
            return

        if ident == "postfix/cleanup":
            m = RE_MSGID.match(text)
            if m:
                self.message(m["qid"], when).message_id = m["mid"][:500]
                return
            m = RE_SUBJECT.match(text)
            if m:
                self.message(m["qid"], when).subject = decode_subject(m["subject"])
                return
            m = RE_MILTER_REJECT.match(text)
            if m:
                msg = self.message(m["qid"], when)
                msg.status, msg.reason, msg.finished_at = "rejected", m["text"][:1000], when
                sender = m["from"].lower()
                msg.sender, msg.sender_domain = sender, domain_of(sender)
                rcpt = m["to"].lower()
                msg.deliveries.append(MailDelivery(
                    recipient=rcpt, recipient_domain=domain_of(rcpt), is_local=domain_of(rcpt) in self.locals(),
                    status="rejected", response=m["text"][:1000], updated_at=when))
                self.classify(msg)
                self.open.pop(m["qid"], None)
            return

        if ident == "postfix/qmgr":
            m = RE_QMGR_FROM.match(text)
            if m:
                msg = self.message(m["qid"], when)
                sender = m["from"].lower()
                msg.sender, msg.sender_domain = sender, domain_of(sender)
                msg.size, msg.nrcpt = int(m["size"]), int(m["nrcpt"])
                self.classify(msg)
                return
            m = RE_REMOVED.match(text) or RE_EXPIRED.match(text)
            if m:
                msg = self.message(m["qid"], when, create=False)
                if msg:
                    msg.finished_at = when
                    self.recompute_status(msg)
                    self.classify(msg)
                self.open.pop(m["qid"], None)
            return

        if ident in DELIVERY_AGENTS:
            m = RE_DELIVERY.match(text)
            if not m:
                return
            msg = self.message(m["qid"], when)
            rcpt = m["to"].lower()
            delivery = next((d for d in msg.deliveries if d.recipient == rcpt), None)
            if not delivery:
                delivery = MailDelivery(recipient=rcpt, recipient_domain=domain_of(rcpt))
                msg.deliveries.append(delivery)
            delivery.orig_recipient = (m["orig"] or "").lower()
            delivery.is_local = ident in ("postfix/lmtp", "postfix/virtual", "postfix/local") or \
                delivery.recipient_domain in self.locals()
            newly_stored = m["status"] == "sent" and delivery.status != "sent" and ident in ("postfix/lmtp", "postfix/virtual")
            delivery.status = m["status"]
            delivery.dsn, delivery.relay = m["dsn"], m["relay"][:255]
            delivery.delay = float(m["delay"])
            delivery.response = m["text"][:1000]
            delivery.updated_at = when
            self.recompute_status(msg)
            self.classify(msg)
            # New mail reached a mailbox: tell its browsers (push notifications). Lines replayed after
            # a collector restart are old news, so only recent deliveries count.
            if newly_stored and self.notifier and utcnow() - when < timedelta(minutes=10):
                self.db.flush()
                self.notifier.delivered(rcpt, msg.id)

    # ------------------------------------------------------------------ rspamd
    def rspamd_line(self, text: str) -> None:
        m = RE_RSPAMD.search(text)
        if not m or not m["qid"] or m["qid"] == "undef":
            return
        symbols = re.findall(r"([A-Z][A-Z0-9_]+)\(", m["symbols"])
        info = {
            "score": float(m["score"]), "action": m["action"], "symbols": ",".join(symbols),
            "attachment": "HAS_ATTACHMENT" in symbols, "user": (m["user"] or "").lower(),
        }
        msg = self.message(m["qid"], utcnow(), create=False) or self.recent(m["qid"])
        if msg:
            self.apply_spam(msg, info)
            self.classify(msg)
        else:
            self.spam_pending[m["qid"]] = (time.time(), info)

    # ------------------------------------------------------------------ housekeeping
    def housekeeping(self) -> None:
        now = time.time()
        for qid, (seen, _info) in list(self.spam_pending.items()):
            if now - seen > 600:
                self.spam_pending.pop(qid, None)
        if len(self.open) > 50000:
            self.open.clear()
        if now - self.last_purge > 3600:
            self.last_purge = now
            cutoff = utcnow() - timedelta(days=self.retention_days)
            old = select(MailMessage.id).where(MailMessage.created_at < cutoff)
            self.db.execute(delete(MailDelivery).where(MailDelivery.message_pk.in_(old)))
            self.db.execute(delete(MailMessage).where(MailMessage.created_at < cutoff))

    def save_state(self, key: str, value: str) -> None:
        row = self.db.get(Setting, key)
        if row:
            row.value = value
        else:
            self.db.add(Setting(key=key, value=value))

    def state(self, key: str) -> str:
        row = self.db.get(Setting, key)
        return row.value if row else ""


# ---------------------------------------------------------------------- input threads
def follow_journal(out: queue.Queue, cursor: str) -> None:
    while True:
        args = ["journalctl", "-f", "-o", "json", "--no-pager",
                "--output-fields=MESSAGE,SYSLOG_IDENTIFIER,__REALTIME_TIMESTAMP,__CURSOR",
                "_SYSTEMD_UNIT=postfix@-.service", "+", "_SYSTEMD_UNIT=postfix.service"]
        args += ["--after-cursor", cursor] if cursor else ["--since", "-30d"]
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, text=True, errors="replace")
        for line in proc.stdout:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            ident = entry.get("SYSLOG_IDENTIFIER") or ""
            text = entry.get("MESSAGE")
            if not ident.startswith("postfix/") or not isinstance(text, str):
                continue
            when = datetime.fromtimestamp(int(entry["__REALTIME_TIMESTAMP"]) / 1e6, tz=timezone.utc)
            cursor = entry.get("__CURSOR", cursor)
            out.put(("postfix", ident, text, when, cursor))
        proc.wait()
        time.sleep(5)  # journalctl exited (e.g. journal rotated): start again from the last cursor


def follow_rspamd(out: queue.Queue, offset_state: str) -> None:
    inode, offset = 0, 0
    if offset_state:
        try:
            inode, offset = (int(x) for x in offset_state.split(":"))
        except ValueError:
            pass
    buf = b""
    while True:
        try:
            st = os.stat(RSPAMD_LOG)
        except OSError:
            time.sleep(10)
            continue
        if st.st_ino != inode or st.st_size < offset:
            inode, offset, buf = st.st_ino, (0 if inode else max(0, st.st_size - 20_000_000)), b""
        if st.st_size > offset:
            with open(RSPAMD_LOG, "rb") as fh:
                fh.seek(offset)
                chunk = fh.read(4 * 1024 * 1024)
            offset += len(chunk)
            buf += chunk
            lines = buf.split(b"\n")
            buf = lines.pop()
            for raw in lines:
                if b"rspamd_task_write_log" in raw:
                    out.put(("rspamd", raw.decode("utf-8", "replace"), f"{inode}:{offset}"))
            continue
        time.sleep(1)


def run() -> None:
    create_tables()
    col = Collector()
    col.notifier = Notifier(SessionLocal)
    col.notifier.start()
    events: queue.Queue = queue.Queue(maxsize=20000)
    threading.Thread(target=follow_journal, args=(events, col.state("collector_journal_cursor")), daemon=True).start()
    threading.Thread(target=follow_rspamd, args=(events, col.state("collector_rspamd_offset")), daemon=True).start()
    print("collector started", flush=True)
    pending, last_commit = 0, time.time()
    cursor = rspamd_offset = None
    while True:
        try:
            item = events.get(timeout=2)
        except queue.Empty:
            item = None
        if item:
            try:
                if item[0] == "postfix":
                    _, ident, text, when, cursor = item
                    col.postfix_line(ident, text, when)
                else:
                    _, text, rspamd_offset = item
                    col.rspamd_line(text)
                pending += 1
            except Exception as exc:  # noqa: BLE001 - one odd log line must never stop the collector
                print(f"collector: skipped line ({exc})", flush=True)
                col.db.rollback()
                col.open.clear()
        if pending and (pending >= 500 or time.time() - last_commit > 2):
            if cursor:
                col.save_state("collector_journal_cursor", cursor)
            if rspamd_offset:
                col.save_state("collector_rspamd_offset", rspamd_offset)
            col.housekeeping()
            col.db.commit()
            pending, last_commit = 0, time.time()


def parse_file(path: str) -> None:
    """Feed a 'journalctl -o json' dump (testing / back-filling)."""
    create_tables()
    col = Collector()
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            entry = json.loads(line)
            ident = entry.get("SYSLOG_IDENTIFIER") or ""
            if ident.startswith("postfix/") and isinstance(entry.get("MESSAGE"), str):
                when = datetime.fromtimestamp(int(entry["__REALTIME_TIMESTAMP"]) / 1e6, tz=timezone.utc)
                col.postfix_line(ident, entry["MESSAGE"], when)
    col.db.commit()
    print("parsed", path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--parse")
    a = parser.parse_args()
    if a.parse:
        parse_file(a.parse)
    else:
        try:
            run()
        except KeyboardInterrupt:
            sys.exit(0)
