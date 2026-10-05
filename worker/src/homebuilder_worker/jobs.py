"""The import_jobs queue: claiming, finishing, failing and recovering jobs.

Jobs are claimed with SELECT ... FOR UPDATE SKIP LOCKED, so several workers can run
against one database without taking the same job. Payload shapes per job type are
documented in docs/JOBS.md and must match app/src/jobs.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from pymysql.connections import Connection

log = logging.getLogger(__name__)

#: A retried job waits RETRY_BASE_MINUTES * RETRY_BACKOFF_FACTOR^(attempts-1) after its
#: last start (1, 5, 25 minutes), so a YouTube outage or rate limit isn't hammered.
RETRY_BASE_MINUTES = 1
RETRY_BACKOFF_FACTOR = 5

JOB_TYPES = {"playlist_sync", "csv_import", "paste_import", "metadata_refresh", "apply_rules"}


@dataclass(frozen=True)
class Job:
    id: int
    type: str
    house_id: int | None
    payload: dict[str, Any]
    attempts: int
    created_by: str


def claim_next_job(conn: Connection) -> Job | None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, type, house_id, payload, attempts, created_by FROM import_jobs "
                "WHERE status = 'queued' AND (attempts = 0 OR started_at < UTC_TIMESTAMP() "
                "- INTERVAL POW(%s, attempts - 1) * %s MINUTE) "
                "ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
                (RETRY_BACKOFF_FACTOR, RETRY_BASE_MINUTES),
            )
            row = cur.fetchone()
            if row is None:
                conn.rollback()
                return None
            cur.execute(
                "UPDATE import_jobs SET status = 'running', started_at = UTC_TIMESTAMP(), "
                "finished_at = NULL, attempts = attempts + 1 WHERE id = %s",
                (row["id"],),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    payload = row["payload"]
    if isinstance(payload, (str, bytes)):
        payload = json.loads(payload)
    return Job(
        id=int(row["id"]),
        type=row["type"],
        house_id=row["house_id"],
        payload=payload if isinstance(payload, dict) else {},
        attempts=int(row["attempts"]) + 1,
        created_by=row["created_by"],
    )


def complete_job(conn: Connection, job_id: int, result: dict[str, Any]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET status = 'succeeded', result = %s, error = NULL, "
            "finished_at = UTC_TIMESTAMP() WHERE id = %s",
            (json.dumps(result), job_id),
        )
    conn.commit()


def fail_job(conn: Connection, job: Job, error: str, *, retry: bool, max_attempts: int) -> str:
    """Re-queues a retryable failure until max_attempts; returns the new status."""
    status = "queued" if retry and job.attempts < max_attempts else "failed"
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET status = %s, error = %s, "
            "finished_at = IF(%s = 'failed', UTC_TIMESTAMP(), NULL) WHERE id = %s",
            (status, error[:2000], status, job.id),
        )
    conn.commit()
    return status


def recover_stale_jobs(conn: Connection, stale_minutes: int, max_attempts: int) -> int:
    """Jobs left 'running' by a worker that died are re-queued (or failed when out of
    attempts). Only jobs older than stale_minutes are touched, so a job another live
    worker is still running is left alone."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET "
            "status = IF(attempts >= %s, 'failed', 'queued'), "
            "error = 'Worker stopped while running this job', "
            "finished_at = IF(attempts >= %s, UTC_TIMESTAMP(), NULL) "
            "WHERE status = 'running' AND started_at < UTC_TIMESTAMP() - INTERVAL %s MINUTE",
            (max_attempts, max_attempts, stale_minutes),
        )
        count = cur.rowcount
    conn.commit()
    if count:
        log.warning("recovered %d stale job(s)", count)
    return count


def enqueue_job(
    conn: Connection,
    job_type: str,
    payload: dict[str, Any],
    *,
    created_by: str,
    house_id: int | None = None,
) -> int:
    if job_type not in JOB_TYPES:
        raise ValueError(f"unknown job type {job_type}")
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO import_jobs (type, house_id, payload, created_by) VALUES (%s, %s, %s, %s)",
            (job_type, house_id, json.dumps(payload), created_by),
        )
        return int(cur.lastrowid)
