from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

import pytest

from homebuilder_worker.config import load_config
from homebuilder_worker.db import connect
from homebuilder_worker.handlers import Services
from homebuilder_worker.jobs import enqueue_job
from homebuilder_worker.main import Worker
from homebuilder_worker.metadata import VideoMetadata
from homebuilder_worker.playlist import PlaylistError
from homebuilder_worker.scheduler import LOCK_NAME, NIGHTLY_ACTOR, run_nightly_if_due

from .conftest import rows

pytestmark = pytest.mark.integration

UTC_ZONE = ZoneInfo("UTC")


def add_playlists(conn, *ids: str) -> None:
    with conn.cursor() as cur:
        for pid in ids:
            cur.execute("INSERT INTO playlists (youtube_playlist_id) VALUES (%s)", (pid,))
    conn.commit()


def test_nightly_runs_once_after_the_sync_time(conn) -> None:
    add_playlists(conn, "PLaaaaaaaaaaaaaa", "PLbbbbbbbbbbbbbb")
    current = datetime.now(UTC)
    before = time(23, 59) if current.time() < time(23, 59) else None
    if before is not None:
        assert run_nightly_if_due(conn, current, UTC_ZONE, before) == []

    queued = run_nightly_if_due(conn, current, UTC_ZONE, time(0, 0))
    assert len(queued) == 3
    jobs = rows(conn, "SELECT type, created_by, payload FROM import_jobs ORDER BY id")
    assert [j["type"] for j in jobs] == ["playlist_sync", "playlist_sync", "metadata_refresh"]
    assert {j["created_by"] for j in jobs} == {NIGHTLY_ACTOR}

    assert run_nightly_if_due(conn, current, UTC_ZONE, time(0, 0)) == []


def test_nightly_skips_while_another_worker_holds_the_lock(conn, db_config) -> None:
    other = connect(db_config)
    try:
        with other.cursor() as cur:
            cur.execute("SELECT GET_LOCK(%s, 0)", (LOCK_NAME,))
        assert run_nightly_if_due(conn, datetime.now(UTC), UTC_ZONE, time(0, 0)) == []
    finally:
        with other.cursor() as cur:
            cur.execute("SELECT RELEASE_LOCK(%s)", (LOCK_NAME,))
        other.close()
    assert run_nightly_if_due(conn, datetime.now(UTC), UTC_ZONE, time(0, 0)) != []


@pytest.fixture(autouse=True)
def no_nightly(request, monkeypatch) -> None:
    """Worker tests exercise the job queue only; the scheduler has its own tests above."""
    if request.node.name.startswith("test_worker_"):
        monkeypatch.setattr("homebuilder_worker.main.run_nightly_if_due", lambda *a: [])


def make_worker(db_config, tmp_path, services: Services) -> Worker:
    config = load_config(
        {
            "DATABASE_HOST": db_config.host,
            "DATABASE_PORT": str(db_config.port),
            "DATABASE_NAME": db_config.database,
            "DATABASE_USER": db_config.user,
            "DATABASE_PASSWORD": db_config.password,
            "HEARTBEAT_FILE": str(tmp_path / "hb"),
        }
    )
    return Worker(config, services)


def ok_services(**overrides) -> Services:
    defaults = {
        "fetch_metadata": lambda vid: VideoMetadata("ok", f"Video {vid}", None),
        "run_playlist": lambda pid: {"entries": []},
    }
    return Services(**{**defaults, **overrides})


def test_worker_tick_runs_a_job_to_success(conn, db_config, tmp_path) -> None:
    job_id = enqueue_job(conn, "paste_import", {"text": "aaaaaaaaaaa"}, created_by="me@example.com")
    conn.commit()
    worker = make_worker(db_config, tmp_path, ok_services())
    assert worker.tick() is True
    [job] = rows(conn, "SELECT status, result FROM import_jobs WHERE id = %s", (job_id,))
    assert job["status"] == "succeeded" and '"added": 1' in job["result"]
    assert worker.tick() is False


def test_worker_marks_bad_input_failed_without_retry(conn, db_config, tmp_path) -> None:
    job_id = enqueue_job(conn, "csv_import", {"csv": "a,b\n1,2"}, created_by="me@example.com")
    conn.commit()
    make_worker(db_config, tmp_path, ok_services()).tick()
    [job] = rows(conn, "SELECT status, error FROM import_jobs WHERE id = %s", (job_id,))
    assert job["status"] == "failed" and "No YouTube" in job["error"]


def test_worker_requeues_retryable_failures(conn, db_config, tmp_path) -> None:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO playlists (youtube_playlist_id) VALUES ('PLcccccccccccccc')")
        playlist_id = cur.lastrowid
    job_id = enqueue_job(
        conn, "playlist_sync", {"playlistId": playlist_id}, created_by="me@example.com"
    )
    conn.commit()

    def broken(_pid):
        raise PlaylistError("yt-dlp exited with 1: HTTP Error 503")

    make_worker(db_config, tmp_path, ok_services(run_playlist=broken)).tick()
    [job] = rows(conn, "SELECT status, error, attempts FROM import_jobs WHERE id = %s", (job_id,))
    assert job == {
        "status": "queued",
        "error": "yt-dlp exited with 1: HTTP Error 503",
        "attempts": 1,
    }


def test_worker_contains_unexpected_crashes(conn, db_config, tmp_path) -> None:
    job_id = enqueue_job(conn, "paste_import", {"text": "aaaaaaaaaaa"}, created_by="me@example.com")
    conn.commit()

    def explode(_vid):
        raise RuntimeError("secret internal detail")

    make_worker(db_config, tmp_path, ok_services(fetch_metadata=explode)).tick()
    [job] = rows(conn, "SELECT status, error FROM import_jobs WHERE id = %s", (job_id,))
    assert job["status"] == "queued"
    assert job["error"] == "Internal error while running the job"


def test_worker_reconnects_after_losing_its_connection(conn, db_config, tmp_path) -> None:
    worker = make_worker(db_config, tmp_path, ok_services())
    assert worker.tick() is False
    first = worker._conn
    with conn.cursor() as cur:
        cur.execute("KILL %s", (first.thread_id(),))
    conn.rollback()
    job_id = enqueue_job(conn, "paste_import", {"text": "aaaaaaaaaaa"}, created_by="me@example.com")
    conn.commit()
    assert worker.tick() is True
    assert worker._conn is not first
    [job] = rows(conn, "SELECT status FROM import_jobs WHERE id = %s", (job_id,))
    assert job["status"] == "succeeded"
