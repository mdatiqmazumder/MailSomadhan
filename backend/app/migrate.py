"""Tiny schema migrations: add columns introduced after a table was first created.
create_all() only creates missing tables, never missing columns."""
from sqlalchemy import inspect, text

from .db import engine

COLUMNS = [
    # table, column, DDL type/default
    ("domains", "storage_limit_mb", "INTEGER NOT NULL DEFAULT 102400"),
    # 1.5.0 role-based access + session revocation + 2FA. Existing admins become super admins.
    ("admins", "role", "VARCHAR(20) NOT NULL DEFAULT 'super_admin'"),
    ("admins", "permissions", "TEXT NOT NULL DEFAULT '[]'"),
    ("admins", "email", "VARCHAR(320) NOT NULL DEFAULT ''"),
    ("admins", "active", "BOOLEAN NOT NULL DEFAULT true"),
    ("admins", "token_version", "INTEGER NOT NULL DEFAULT 0"),
    ("admins", "totp_secret", "VARCHAR(64) NOT NULL DEFAULT ''"),
    ("admins", "totp_pending", "VARCHAR(64) NOT NULL DEFAULT ''"),
    ("admins", "totp_enabled", "BOOLEAN NOT NULL DEFAULT false"),
    ("admins", "last_login", "TIMESTAMP WITH TIME ZONE"),
    ("mailboxes", "token_version", "INTEGER NOT NULL DEFAULT 0"),
    # 1.6: campaign permission per mailbox, forwarding, profile picture
    ("mailboxes", "can_campaign", "BOOLEAN NOT NULL DEFAULT false"),
    ("mailboxes", "forward_to", "TEXT NOT NULL DEFAULT ''"),
    ("mailboxes", "forward_keep", "BOOLEAN NOT NULL DEFAULT true"),
    ("mailboxes", "avatar_version", "INTEGER NOT NULL DEFAULT 0"),
]


def migrate() -> None:
    insp = inspect(engine)
    tables = set(insp.get_table_names())
    added = set()
    with engine.begin() as conn:
        for table, column, ddl in COLUMNS:
            if table in tables and column not in {c["name"] for c in insp.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
                added.add((table, column))
        # Campaigns became a per-mailbox permission: mailboxes that already ran campaigns keep it.
        if ("mailboxes", "can_campaign") in added and "campaigns" in tables:
            conn.execute(text("UPDATE mailboxes SET can_campaign = :t WHERE id IN (SELECT mailbox_id FROM campaigns)"), {"t": True})
        # Repair: there must always be an active super administrator. Installs of 1.5.0 created
        # the first account with the limited role, which locked everyone out of the console.
        if "admins" in tables:
            has_super = conn.execute(text("SELECT 1 FROM admins WHERE role = 'super_admin' AND active = :t"), {"t": True}).first()
            if not has_super:
                first = conn.execute(text("SELECT id FROM admins ORDER BY id LIMIT 1")).first()
                if first:
                    conn.execute(text("UPDATE admins SET role = 'super_admin', active = :t WHERE id = :id"),
                                 {"t": True, "id": first[0]})
