from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import pytest

from homebuilder_worker.config import ConfigError, load_config, parse_sync_time
from homebuilder_worker.scheduler import todays_run_time

ENV = {
    "DATABASE_HOST": "db",
    "DATABASE_NAME": "homebuilder",
    "DATABASE_USER": "homebuilder",
    "DATABASE_PASSWORD": "secret",
}


def test_defaults() -> None:
    config = load_config(ENV)
    assert config.database.port == 3306
    assert config.sync_time == time(3, 0)
    assert config.timezone.key == "UTC"
    assert config.max_attempts == 3


@pytest.mark.parametrize(
    "name", ["DATABASE_HOST", "DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD"]
)
def test_required(name: str) -> None:
    with pytest.raises(ConfigError, match=name):
        load_config({k: v for k, v in ENV.items() if k != name})


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("TZ", "Mars/Olympus"),
        ("SYNC_TIME", "3am"),
        ("SYNC_TIME", "24:00"),
        ("POLL_INTERVAL_SECONDS", "0"),
        ("DATABASE_PORT", "x"),
        ("LOG_LEVEL", "loud"),
    ],
)
def test_invalid(name: str, value: str) -> None:
    with pytest.raises(ConfigError):
        load_config({**ENV, name: value})


def test_parse_sync_time() -> None:
    assert parse_sync_time("23:59") == time(23, 59)


def test_run_time_respects_local_time_zone() -> None:
    ny = ZoneInfo("America/New_York")
    # 06:59 UTC = 02:59 EDT: not yet due.
    assert todays_run_time(datetime(2026, 7, 1, 6, 59, tzinfo=UTC), ny, time(3, 0)) is None
    # 07:00 UTC = 03:00 EDT: due, and reported in UTC.
    assert todays_run_time(datetime(2026, 7, 1, 7, 0, tzinfo=UTC), ny, time(3, 0)) == datetime(
        2026, 7, 1, 7, 0, tzinfo=UTC
    )
    # Winter (EST) shifts the UTC instant by an hour.
    assert todays_run_time(datetime(2026, 1, 15, 9, 0, tzinfo=UTC), ny, time(3, 0)) == datetime(
        2026, 1, 15, 8, 0, tzinfo=UTC
    )
