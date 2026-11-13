import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MAILSOMADHAN_",
        env_file=os.environ.get("MAILSOMADHAN_ENV_FILE", ".env"),
        extra="ignore",
    )

    database_url: str = "sqlite:///./dev.db"
    secret_key: str = "dev-insecure-secret-change-me-0123456789"
    cookie_secure: bool = True
    token_hours: int = 12

    primary_hostname: str = "localhost"
    web_port: int = 8443

    imap_host: str = "127.0.0.1"
    imap_port: int = 10143
    imap_master_user: str = "msmaster"
    imap_master_password: str = ""
    smtp_host: str = "127.0.0.1"
    smtp_port: int = 10025  # loopback-only listener reserved for the webmail

    dkim_dir: str = "/var/lib/rspamd/dkim"
    tls_dir: str = "/etc/mailsomadhan/tls"
    state_dir: str = "/var/lib/mailsomadhan"
    # Written only by root (installer/helper). Must not be writable by the panel user: root writing
    # into a directory the panel controls would allow symlink attacks.
    status_dir: str = "/var/lib/mailsomadhan-status"
    mail_dir: str = "/var/vmail"
    helper_path: str = "/usr/local/sbin/mailsomadhan-helper"
    features_file: str = "/etc/mailsomadhan/features.conf"
    update_log: str = "/var/log/mailsomadhan-update.log"

    # dev_mode: no privileged helper calls, relaxed paths (local development only)
    dev_mode: bool = False


settings = Settings()

# The default key is public (it is in the source code), so tokens signed with it could be forged.
if not settings.dev_mode and (settings.secret_key.startswith("dev-insecure") or len(settings.secret_key) < 32):
    raise RuntimeError("MAILSOMADHAN_SECRET_KEY must be set to a random value of at least 32 characters")
