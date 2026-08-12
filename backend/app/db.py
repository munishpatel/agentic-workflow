import logging
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

# SQLModel's AsyncSession, not SQLAlchemy's — it adds `.exec()`, which returns
# properly typed rows for `select(Model)` instead of tuples.
from sqlmodel.ext.asyncio.session import AsyncSession

# Importing the models module registers the tables on SQLModel.metadata, which
# `create_all` below reads. Without it, startup creates an empty schema.
from app import models  # noqa: F401  (imported for its side effect)
from app.config import get_settings

logger = logging.getLogger("app.db")

_settings = get_settings()

engine = create_async_engine(_settings.database_url, echo=False, future=True)

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def create_tables() -> None:
    """
    `create_all` on startup rather than Alembic.

    An honest choice for a local-first app, and called out in the README rather
    than hidden: Alembic is the production path, and adopting it later is a
    contained change because the schema lives in one module.
    """
    async with engine.begin() as connection:
        await connection.run_sync(SQLModel.metadata.create_all)
        await connection.run_sync(_add_missing_columns)


def _add_missing_columns(connection: Any) -> None:
    """
    The one thing `create_all` cannot do: add a column to a table that already
    exists.

    Without this, a developer with a `workflows.db` from before a column was
    added gets `OperationalError: no such column` on every run — a confusing
    failure a long way from its cause. Additive only, and deliberately so: this
    is a stopgap for new nullable columns, not a migration tool. Anything that
    drops, renames or backfills is the point where Alembic stops being optional.
    """
    inspector = inspect(connection)
    for table in SQLModel.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue
        existing = {column["name"] for column in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing or not column.nullable:
                continue
            type_sql = column.type.compile(dialect=connection.dialect)
            connection.exec_driver_sql(
                f"ALTER TABLE {table.name} ADD COLUMN {column.name} {type_sql}"
            )
            logger.info("Added missing column %s.%s", table.name, column.name)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency — one session per request."""
    async with SessionLocal() as session:
        yield session
