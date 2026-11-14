from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

_kwargs = {"pool_pre_ping": True}
if settings.database_url.startswith("sqlite"):
    _kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(settings.database_url, **_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables() -> None:
    """create_all() that tolerates the API, collector and campaign worker starting at the same moment
    after an update: two processes creating the same new table race, and the loser retries."""
    import time

    from sqlalchemy.exc import IntegrityError, ProgrammingError

    from . import models  # noqa: F401 - registers every table on Base

    for attempt in range(5):
        try:
            Base.metadata.create_all(engine)
            return
        except (IntegrityError, ProgrammingError):
            if attempt == 4:
                raise
            time.sleep(1 + attempt)
