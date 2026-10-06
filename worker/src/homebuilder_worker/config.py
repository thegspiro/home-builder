"""Worker configuration from environment variables; invalid values fail at startup."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    database: str
    user: str
    password: str


@dataclass(frozen=True)
class WorkerConfig:
    database: DatabaseConfig
    timezone: ZoneInfo
    sync_time: time
    poll_interval_seconds: float
    job_stale_minutes: int
    max_attempts: int
    oembed_delay_seconds: float
    ytdlp_timeout_seconds: int
    heartbeat_file: str
    log_level: str


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name, "").strip()
    if not value:
        raise ConfigError(f"Missing required environment variable {name}")
    return value


def _number(env: Mapping[str, str], name: str, default: str, lo: float, hi: float) -> float:
    raw = env.get(name, "").strip() or default
    try:
        value = float(raw)
    except ValueError as error:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from error
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}, got {value}")
    return value


def parse_sync_time(raw: str) -> time:
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", raw.strip())
    if not match:
        raise ConfigError(f"SYNC_TIME must be HH:MM (24-hour), got {raw!r}")
    return time(int(match.group(1)), int(match.group(2)))


def load_config(env: Mapping[str, str] | None = None) -> WorkerConfig:
    env = os.environ if env is None else env
    tz_name = env.get("TZ", "").strip() or "UTC"
    try:
        timezone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ConfigError(f"TZ is not a known time zone: {tz_name!r}") from error
    log_level = (env.get("LOG_LEVEL", "").strip() or "info").upper()
    if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError(f"LOG_LEVEL is not valid: {log_level!r}")

    return WorkerConfig(
        database=DatabaseConfig(
            host=_required(env, "DATABASE_HOST"),
            port=int(_number(env, "DATABASE_PORT", "3306", 1, 65535)),
            database=_required(env, "DATABASE_NAME"),
            user=_required(env, "DATABASE_USER"),
            password=_required(env, "DATABASE_PASSWORD"),
        ),
        timezone=timezone,
        sync_time=parse_sync_time(env.get("SYNC_TIME", "").strip() or "03:00"),
        poll_interval_seconds=_number(env, "POLL_INTERVAL_SECONDS", "5", 0.1, 300),
        job_stale_minutes=int(_number(env, "JOB_STALE_MINUTES", "30", 1, 1440)),
        max_attempts=int(_number(env, "JOB_MAX_ATTEMPTS", "3", 1, 20)),
        oembed_delay_seconds=_number(env, "OEMBED_DELAY_SECONDS", "0.2", 0, 10),
        ytdlp_timeout_seconds=int(_number(env, "YTDLP_TIMEOUT_SECONDS", "300", 10, 3600)),
        heartbeat_file=env.get("HEARTBEAT_FILE", "").strip() or "/tmp/worker-heartbeat",  # noqa: S108
        log_level=log_level,
    )
