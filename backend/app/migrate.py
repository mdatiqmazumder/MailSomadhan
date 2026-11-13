"""Tiny schema migrations: add columns introduced after a table was first created.
create_all() only creates missing tables, never missing columns."""
from sqlalchemy import inspect, text

from .db import engine

COLUMNS = [
    # table, column, DDL type/default
    ("domains", "storage_limit_mb", "INTEGER NOT NULL DEFAULT 102400"),
]


def migrate() -> None:
    insp = inspect(engine)
    tables = set(insp.get_table_names())
    with engine.begin() as conn:
        for table, column, ddl in COLUMNS:
            if table in tables and column not in {c["name"] for c in insp.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
