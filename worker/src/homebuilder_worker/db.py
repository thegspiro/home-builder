"""MySQL connection. All queries in the worker use %s parameters, never string formatting."""

from __future__ import annotations

import pymysql
import pymysql.cursors
from pymysql.connections import Connection

from .config import DatabaseConfig


def connect(config: DatabaseConfig) -> Connection:
    return pymysql.connect(
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        database=config.database,
        charset="utf8mb4",
        autocommit=False,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
        # TIMESTAMP columns are compared and written in UTC everywhere.
        init_command="SET time_zone = '+00:00'",
    )
