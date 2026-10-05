"""Integration tests need a disposable MySQL database whose schema was created by the app's
migrations (cd app && npm run build && npm run migrate), reached via DATABASE_* env vars.
They delete rows from it, so its name must contain "test"."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from pymysql.connections import Connection

from homebuilder_worker.config import DatabaseConfig
from homebuilder_worker.db import connect


def _config() -> DatabaseConfig:
    missing = [
        n
        for n in ("DATABASE_HOST", "DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD")
        if not os.environ.get(n)
    ]
    if missing:
        pytest.fail(f"integration tests need {', '.join(missing)}")
    name = os.environ["DATABASE_NAME"]
    if "test" not in name.lower():
        pytest.fail(f'refusing to use database "{name}": its name must contain "test"')
    return DatabaseConfig(
        host=os.environ["DATABASE_HOST"],
        port=int(os.environ.get("DATABASE_PORT", "3306")),
        database=name,
        user=os.environ["DATABASE_USER"],
        password=os.environ["DATABASE_PASSWORD"],
    )


CLEAN_TABLES = ["import_jobs", "keyword_rules", "playlists", "videos", "house_members", "houses"]


def _clean(conn: Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM tags WHERE house_id IS NOT NULL")
        for table in CLEAN_TABLES:
            cur.execute(f"DELETE FROM {table}")  # noqa: S608 - fixed table names
    conn.commit()


@pytest.fixture
def db_config() -> DatabaseConfig:
    return _config()


@pytest.fixture
def conn(db_config: DatabaseConfig) -> Iterator[Connection]:
    connection = connect(db_config)
    _clean(connection)
    try:
        yield connection
    finally:
        connection.rollback()
        _clean(connection)
        connection.close()


def lookup(conn: Connection, table: str, slug: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT id FROM {table} WHERE slug = %s", (slug,))  # noqa: S608
        row = cur.fetchone()
    conn.rollback()
    assert row is not None, f"{table}.{slug} missing; run the app migrations first"
    return int(row["id"])


def make_house(conn: Connection, name: str = "Test house") -> int:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO houses (name, created_by) VALUES (%s, 'x@example.com')", (name,))
        house_id = int(cur.lastrowid)
    conn.commit()
    return house_id


def add_rule(conn: Connection, phrase: str, **targets: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO keyword_rules (phrase, tag_id, area_type_id, item_id) "
            "VALUES (%s, %s, %s, %s)",
            (phrase, targets.get("tag_id"), targets.get("area_type_id"), targets.get("item_id")),
        )
    conn.commit()


def rows(conn: Connection, sql: str, params: tuple = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        result = list(cur.fetchall())
    conn.rollback()
    return result
