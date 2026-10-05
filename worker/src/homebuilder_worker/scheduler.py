"""Nightly playlist sync and metadata retry, exactly once per day across all workers."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

from pymysql.connections import Connection

from .jobs import enqueue_job

log = logging.getLogger(__name__)

NIGHTLY_ACTOR = "system:nightly"
LOCK_NAME = "homebuilder.nightly-sync"


def todays_run_time(now_utc: datetime, tz: ZoneInfo, sync_time: time) -> datetime | None:
    """The UTC instant of today's scheduled run, or None if it is not due yet today."""
    local_now = now_utc.astimezone(tz)
    target = datetime.combine(local_now.date(), sync_time, tzinfo=tz)
    if local_now < target:
        return None
    return target.astimezone(UTC)


def run_nightly_if_due(
    conn: Connection, now_utc: datetime, tz: ZoneInfo, sync_time: time
) -> list[int]:
    """Enqueues today's jobs if the sync time has passed and nobody has yet.

    A MySQL named lock makes the check-and-enqueue atomic across workers; the marker is
    the jobs themselves (created by system:nightly after today's run time), so a restart
    after the sync time doesn't run it twice, and a worker that was down at the sync time
    catches up when it starts.
    """
    run_at = todays_run_time(now_utc, tz, sync_time)
    if run_at is None:
        return []
    run_at_naive = run_at.replace(tzinfo=None)

    with conn.cursor() as cur:
        cur.execute("SELECT GET_LOCK(%s, 0) AS got", (LOCK_NAME,))
        got = cur.fetchone()["got"] == 1
    if not got:
        conn.rollback()
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM import_jobs WHERE created_by = %s AND created_at >= %s LIMIT 1",
                (NIGHTLY_ACTOR, run_at_naive),
            )
            if cur.fetchone() is not None:
                conn.rollback()
                return []
            cur.execute("SELECT id FROM playlists ORDER BY id")
            playlist_ids = [int(r["id"]) for r in cur.fetchall()]
        job_ids = [
            enqueue_job(conn, "playlist_sync", {"playlistId": pid}, created_by=NIGHTLY_ACTOR)
            for pid in playlist_ids
        ]
        # Always enqueued: it doubles as today's marker and retries pending metadata.
        job_ids.append(enqueue_job(conn, "metadata_refresh", {}, created_by=NIGHTLY_ACTOR))
        conn.commit()
        log.info("nightly sync queued %d job(s)", len(job_ids))
        return job_ids
    except Exception:
        conn.rollback()
        raise
    finally:
        with conn.cursor() as cur:
            cur.execute("SELECT RELEASE_LOCK(%s)", (LOCK_NAME,))
        conn.rollback()
