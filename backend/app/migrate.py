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
]


def migrate() -> None:
    insp = inspect(engine)
    tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table, column, ddl in COLUMNS:
            if table in tables and column not in {c["name"] for c in insp.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
