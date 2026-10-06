import pytest

from homebuilder_worker.db import connect
from homebuilder_worker.jobs import (
    claim_next_job,
    complete_job,
    enqueue_job,
    fail_job,
    recover_stale_jobs,
)

from .conftest import rows

pytestmark = pytest.mark.integration


def test_claims_oldest_queued_job_once(conn) -> None:
    first = enqueue_job(conn, "paste_import", {"text": "a"}, created_by="u@example.com")
    second = enqueue_job(conn, "paste_import", {"text": "b"}, created_by="u@example.com")
    conn.commit()

    job = claim_next_job(conn)
    assert job is not None and job.id == first
    assert job.payload == {"text": "a"} and job.attempts == 1
    assert claim_next_job(conn).id == second
    assert claim_next_job(conn) is None
    statuses = rows(conn, "SELECT status, attempts FROM import_jobs ORDER BY id")
    assert statuses == [{"status": "running", "attempts": 1}] * 2


def test_skip_locked_lets_two_workers_take_different_jobs(conn, db_config) -> None:
    first = enqueue_job(conn, "paste_import", {"text": "a"}, created_by="u@example.com")
    second = enqueue_job(conn, "paste_import", {"text": "b"}, created_by="u@example.com")
    conn.commit()

    other = connect(db_config)
    try:
        # Worker A is mid-claim: it holds the row lock on the first job.
        with other.cursor() as cur:
            cur.execute("SELECT id FROM import_jobs WHERE id = %s FOR UPDATE", (first,))
        job = claim_next_job(conn)
        assert job is not None and job.id == second
    finally:
        other.rollback()
        other.close()


def backdate(conn, job_id: int, minutes: int) -> None:
    """Pretends the job's last attempt started `minutes` ago."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET started_at = UTC_TIMESTAMP() - INTERVAL %s MINUTE "
            "WHERE id = %s",
            (minutes, job_id),
        )
    conn.commit()


def test_retries_wait_with_exponential_backoff(conn) -> None:
    job_id = enqueue_job(conn, "csv_import", {"csv": "x"}, created_by="u@example.com")
    conn.commit()
    job = claim_next_job(conn)
    fail_job(conn, job, "network down", retry=True, max_attempts=5)
    assert claim_next_job(conn) is None  # first retry waits 1 minute
    backdate(conn, job_id, 2)
    job = claim_next_job(conn)
    assert job is not None and job.attempts == 2
    fail_job(conn, job, "network down", retry=True, max_attempts=5)
    backdate(conn, job_id, 4)
    assert claim_next_job(conn) is None  # second retry waits 5 minutes
    backdate(conn, job_id, 6)
    assert claim_next_job(conn).attempts == 3


def test_complete_and_fail(conn) -> None:
    job_id = enqueue_job(conn, "csv_import", {"csv": "x"}, created_by="u@example.com")
    conn.commit()
    job = claim_next_job(conn)
    assert fail_job(conn, job, "network down", retry=True, max_attempts=3) == "queued"
    backdate(conn, job_id, 2)
    job = claim_next_job(conn)
    assert job.attempts == 2
    assert fail_job(conn, job, "bad input", retry=False, max_attempts=3) == "failed"
    [row] = rows(
        conn, "SELECT status, error, finished_at FROM import_jobs WHERE id = %s", (job_id,)
    )
    assert row["status"] == "failed" and row["error"] == "bad input" and row["finished_at"]

    other_id = enqueue_job(conn, "csv_import", {"csv": "y"}, created_by="u@example.com")
    conn.commit()
    complete_job(conn, claim_next_job(conn).id, {"added": 2})
    [row] = rows(conn, "SELECT status, result FROM import_jobs WHERE id = %s", (other_id,))
    assert row["status"] == "succeeded" and '"added": 2' in row["result"]


def test_retry_stops_after_max_attempts(conn) -> None:
    enqueue_job(conn, "csv_import", {"csv": "x"}, created_by="u@example.com")
    conn.commit()
    statuses = []
    for _ in range(3):
        job = claim_next_job(conn)
        statuses.append(fail_job(conn, job, "flaky", retry=True, max_attempts=3))
        backdate(conn, job.id, 60)
    assert statuses == ["queued", "queued", "failed"]
    assert claim_next_job(conn) is None


def test_recovers_only_stale_running_jobs(conn) -> None:
    stale = enqueue_job(conn, "csv_import", {}, created_by="u@example.com")
    exhausted = enqueue_job(conn, "csv_import", {}, created_by="u@example.com")
    fresh = enqueue_job(conn, "csv_import", {}, created_by="u@example.com")
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE import_jobs SET status = 'running', attempts = 1, "
            "started_at = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE id = %s",
            (stale,),
        )
        cur.execute(
            "UPDATE import_jobs SET status = 'running', attempts = 3, "
            "started_at = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE id = %s",
            (exhausted,),
        )
        cur.execute(
            "UPDATE import_jobs SET status = 'running', attempts = 1, "
            "started_at = UTC_TIMESTAMP() WHERE id = %s",
            (fresh,),
        )
    conn.commit()
    assert recover_stale_jobs(conn, stale_minutes=30, max_attempts=3) == 2
    status = {r["id"]: r["status"] for r in rows(conn, "SELECT id, status FROM import_jobs")}
    assert status == {stale: "queued", exhausted: "failed", fresh: "running"}
