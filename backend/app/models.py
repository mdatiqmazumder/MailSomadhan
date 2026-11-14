from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class Admin(Base):
    """Console account. "super_admin" can do everything; "admin" only what `permissions` allow,
    and only on the domains linked through admin_domains."""

    __tablename__ = "admins"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="admin", server_default="super_admin")
    permissions: Mapped[str] = mapped_column(Text, default="[]", server_default="[]")  # JSON list
    email: Mapped[str] = mapped_column(String(320), default="", server_default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    totp_secret: Mapped[str] = mapped_column(String(64), default="", server_default="")
    totp_pending: Mapped[str] = mapped_column(String(64), default="", server_default="")
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AdminDomain(Base):
    __tablename__ = "admin_domains"
    admin_id: Mapped[int] = mapped_column(ForeignKey("admins.id", ondelete="CASCADE"), primary_key=True)
    domain_id: Mapped[int] = mapped_column(ForeignKey("domains.id", ondelete="CASCADE"), primary_key=True)


class AuditLog(Base):
    """Who changed what in the admin console (request bodies are stored without secrets)."""

    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    actor: Mapped[str] = mapped_column(String(320), default="", index=True)
    actor_kind: Mapped[str] = mapped_column(String(16), default="admin")
    ip: Mapped[str] = mapped_column(String(64), default="")
    method: Mapped[str] = mapped_column(String(8), default="")
    path: Mapped[str] = mapped_column(String(300), default="")
    status: Mapped[int] = mapped_column(Integer, default=0)
    details: Mapped[str] = mapped_column(Text, default="")


class LoginFailure(Base):
    """Failed sign-ins, shared by all API workers (per-IP and per-account throttling)."""

    __tablename__ = "login_failures"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    ip: Mapped[str] = mapped_column(String(64), index=True)
    identifier: Mapped[str] = mapped_column(String(320), index=True)


class Relay(Base):
    """Outbound SMTP relay (smarthost). Read directly by Postfix."""

    __tablename__ = "relays"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=587)
    username: Mapped[str] = mapped_column(String(255), default="")
    password: Mapped[str] = mapped_column(String(255), default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Domain(Base):
    __tablename__ = "domains"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(253), unique=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    dkim_selector: Mapped[str] = mapped_column(String(63), default="")
    dkim_public: Mapped[str] = mapped_column(Text, default="")
    default_quota_mb: Mapped[int] = mapped_column(Integer, default=1024)
    # Total storage the domain's mailboxes may be given together (sum of their quotas).
    storage_limit_mb: Mapped[int] = mapped_column(Integer, default=102400, server_default="102400")
    relay_id: Mapped[int | None] = mapped_column(ForeignKey("relays.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    relay: Mapped[Relay | None] = relationship()
    mailboxes: Mapped[list["Mailbox"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    aliases: Mapped[list["Alias"]] = relationship(back_populates="domain", cascade="all, delete-orphan")


class Mailbox(Base):
    """A mail user. Read directly by Postfix and Dovecot."""

    __tablename__ = "mailboxes"
    id: Mapped[int] = mapped_column(primary_key=True)
    domain_id: Mapped[int] = mapped_column(ForeignKey("domains.id", ondelete="CASCADE"))
    local_part: Mapped[str] = mapped_column(String(64))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(200), default="")
    quota_mb: Mapped[int] = mapped_column(Integer, default=1024)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    signature_html: Mapped[str] = mapped_column(Text, default="")
    token_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Campaigns are off unless an administrator allows them for this mailbox.
    can_campaign: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Comma separated addresses incoming mail is forwarded to ('' = off); forward_keep keeps a copy here.
    forward_to: Mapped[str] = mapped_column(Text, default="", server_default="")
    forward_keep: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    avatar_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # 0 = no picture
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    domain: Mapped[Domain] = relationship(back_populates="mailboxes")


class Alias(Base):
    __tablename__ = "aliases"
    id: Mapped[int] = mapped_column(primary_key=True)
    domain_id: Mapped[int] = mapped_column(ForeignKey("domains.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(String(320), unique=True, index=True)  # user@domain or @domain
    destination: Mapped[str] = mapped_column(Text)  # comma separated addresses
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    domain: Mapped[Domain] = relationship(back_populates="aliases")


class Host(Base):
    """A hostname this server answers on (web panel, SMTP, IMAP) with its own TLS cert."""

    __tablename__ = "hosts"
    id: Mapped[int] = mapped_column(primary_key=True)
    hostname: Mapped[str] = mapped_column(String(253), unique=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class MailMessage(Base):
    """One message seen by Postfix (filled in by the log collector)."""

    __tablename__ = "mail_messages"
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    queue_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="smtp")  # smtp|submission|webmail|local
    client_ip: Mapped[str] = mapped_column(String(64), default="")
    client_host: Mapped[str] = mapped_column(String(255), default="")
    sasl_user: Mapped[str] = mapped_column(String(320), default="")
    user_email: Mapped[str] = mapped_column(String(320), default="", index=True)  # local sending user
    sender: Mapped[str] = mapped_column(String(320), default="", index=True)
    sender_domain: Mapped[str] = mapped_column(String(253), default="", index=True)
    message_id: Mapped[str] = mapped_column(String(500), default="")
    subject: Mapped[str] = mapped_column(String(500), default="")
    size: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), default=0)
    nrcpt: Mapped[int] = mapped_column(Integer, default=0)
    direction: Mapped[str] = mapped_column(String(16), default="inbound", index=True)  # inbound|outbound|internal|forward
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)  # queued|delivered|deferred|bounced|partial|rejected
    reason: Mapped[str] = mapped_column(Text, default="")
    spam_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    spam_action: Mapped[str] = mapped_column(String(32), default="")
    spam_symbols: Mapped[str] = mapped_column(Text, default="")
    has_attachment: Mapped[bool] = mapped_column(Boolean, default=False)
    external_rcpts: Mapped[int] = mapped_column(Integer, default=0)

    deliveries: Mapped[list["MailDelivery"]] = relationship(back_populates="message", cascade="all, delete-orphan")

    __table_args__ = (Index("ix_mail_messages_user_created", "user_email", "created_at"),)


class MailDelivery(Base):
    __tablename__ = "mail_deliveries"
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    message_pk: Mapped[int] = mapped_column(ForeignKey("mail_messages.id", ondelete="CASCADE"), index=True)
    recipient: Mapped[str] = mapped_column(String(320), index=True)
    recipient_domain: Mapped[str] = mapped_column(String(253), default="")
    orig_recipient: Mapped[str] = mapped_column(String(320), default="")
    is_local: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    dsn: Mapped[str] = mapped_column(String(16), default="")
    relay: Mapped[str] = mapped_column(String(255), default="")
    delay: Mapped[float] = mapped_column(Float, default=0)
    response: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)

    message: Mapped[MailMessage] = relationship(back_populates="deliveries")


class FilterRule(Base):
    """Admin mail filter rule, exported to Rspamd multimap files."""

    __tablename__ = "filter_rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)  # block_sender|allow_sender|block_ip|block_ext
    value: Mapped[str] = mapped_column(String(320))
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Campaign(Base):
    """A message sent individually to many recipients, paced by the campaign worker."""

    __tablename__ = "campaigns"
    id: Mapped[int] = mapped_column(primary_key=True)
    mailbox_id: Mapped[int] = mapped_column(ForeignKey("mailboxes.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    subject: Mapped[str] = mapped_column(String(900))
    html: Mapped[str] = mapped_column(Text)
    attachments: Mapped[str] = mapped_column(Text, default="[]")  # JSON list of {name, type, size, path}
    mode: Mapped[str] = mapped_column(String(16), default="fixed")  # instant|fixed|random
    interval_seconds: Mapped[int] = mapped_column(Integer, default=60)
    random_min_seconds: Mapped[int] = mapped_column(Integer, default=60)
    random_max_seconds: Mapped[int] = mapped_column(Integer, default=300)
    unsubscribe: Mapped[bool] = mapped_column(Boolean, default=True)
    # draft|pending_approval|scheduled|running|paused|completed|cancelled
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    next_send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    waiting_reason: Mapped[str] = mapped_column(String(200), default="")
    total: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    mailbox: Mapped[Mailbox] = relationship()


class CampaignRecipient(Base):
    __tablename__ = "campaign_recipients"
    id: Mapped[int] = mapped_column(primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    email: Mapped[str] = mapped_column(String(320), index=True)
    fields: Mapped[str] = mapped_column(Text, default="{}")  # JSON merge fields
    # pending|sent|delivered|bounced|failed|skipped|unsubscribed
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    message_id: Mapped[str] = mapped_column(String(500), default="")
    error: Mapped[str] = mapped_column(Text, default="")


class Suppression(Base):
    """Addresses that must not receive campaign mail from a domain (unsubscribed or bounced)."""

    __tablename__ = "suppressions"
    id: Mapped[int] = mapped_column(primary_key=True)
    domain_id: Mapped[int] = mapped_column(ForeignKey("domains.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    reason: Mapped[str] = mapped_column(String(32), default="manual")  # unsubscribed|bounced|manual
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PushToken(Base):
    """One browser that receives new-mail notifications (a Firebase Cloud Messaging registration token)."""

    __tablename__ = "push_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    mailbox_id: Mapped[int] = mapped_column(ForeignKey("mailboxes.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(500), unique=True)
    # Mailbox.token_version when registered: "sign out everywhere" or a password reset stops notifications.
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    user_agent: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
