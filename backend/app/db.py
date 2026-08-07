from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

# SQLModel's AsyncSession, not SQLAlchemy's — it adds `.exec()`, which returns
# properly typed rows for `select(Model)` instead of tuples.
from sqlmodel.ext.asyncio.session import AsyncSession

# Importing the models module registers the tables on SQLModel.metadata, which
# `create_all` below reads. Without it, startup creates an empty schema.
from app import models  # noqa: F401  (imported for its side effect)
from app.config import get_settings

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


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency — one session per request."""
    async with SessionLocal() as session:
        yield session
