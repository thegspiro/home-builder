"""Worker main loop: claim a job, run it, record the outcome; queue the nightly sync."""

from __future__ import annotations

import logging
import signal
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType

import pymysql

from . import playlist
from .config import ConfigError, WorkerConfig, load_config
from .db import connect
from .handlers import RETRYABLE, PermanentJobError, Services, run_job
from .jobs import claim_next_job, complete_job, fail_job, recover_stale_jobs
from .metadata import OEmbedClient
from .scheduler import run_nightly_if_due

log = logging.getLogger("homebuilder_worker")

RECOVER_EVERY_SECONDS = 600


class Worker:
    def __init__(self, config: WorkerConfig, services: Services) -> None:
        self.config = config
        self.services = services
        self.stopping = False
        self._conn: pymysql.connections.Connection | None = None
        self._last_recover = 0.0

    def stop(self, signum: int, _frame: FrameType | None) -> None:
        log.info("received signal %d; finishing the current job, then exiting", signum)
        self.stopping = True

    def _connection(self) -> pymysql.connections.Connection:
        """Returns a live connection, opening a new one if the old one was lost."""
        if self._conn is not None and self._conn.open:
            try:
                self._conn.ping()
                return self._conn
            except pymysql.err.Error:
                log.warning("database connection lost; reconnecting")
        self._conn = connect(self.config.database)
        return self._conn

    def _heartbeat(self) -> None:
        Path(self.config.heartbeat_file).touch()

    def tick(self) -> bool:
        """One iteration. Returns True if a job was processed."""
        conn = self._connection()
        if time.monotonic() - self._last_recover > RECOVER_EVERY_SECONDS:
            recover_stale_jobs(conn, self.config.job_stale_minutes, self.config.max_attempts)
            self._last_recover = time.monotonic()
        run_nightly_if_due(conn, datetime.now(UTC), self.config.timezone, self.config.sync_time)

        job = claim_next_job(conn)
        if job is None:
            return False
        log.info("job %d (%s) started, attempt %d", job.id, job.type, job.attempts)
        try:
            result = run_job(conn, job, self.services)
        except PermanentJobError as error:
            conn.rollback()
            fail_job(conn, job, str(error), retry=False, max_attempts=self.config.max_attempts)
            log.warning("job %d failed permanently: %s", job.id, error)
        except RETRYABLE as error:
            conn.rollback()
            status = fail_job(
                conn, job, str(error), retry=True, max_attempts=self.config.max_attempts
            )
            log.warning("job %d failed (%s): %s", job.id, status, error)
        except Exception:
            conn.rollback()
            log.exception("job %d crashed", job.id)
            fail_job(
                conn,
                job,
                "Internal error while running the job",
                retry=True,
                max_attempts=self.config.max_attempts,
            )
        else:
            complete_job(conn, job.id, result)
            log.info(
                "job %d succeeded: %s", job.id, {k: v for k, v in result.items() if k != "invalid"}
            )
        return True

    def run(self) -> None:
        backoff = 1.0
        while not self.stopping:
            self._heartbeat()
            try:
                busy = self.tick()
                backoff = 1.0
            except pymysql.err.OperationalError as error:
                log.error("database unavailable (%s); retrying in %.0fs", error, backoff)
                self._conn = None
                time.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            if not busy:
                time.sleep(self.config.poll_interval_seconds)
        if self._conn is not None and self._conn.open:
            self._conn.close()


def main() -> int:
    try:
        config = load_config()
    except ConfigError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2
    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    services = Services(
        fetch_metadata=OEmbedClient().fetch,
        run_playlist=lambda pid: playlist.run_ytdlp(pid, config.ytdlp_timeout_seconds),
        fetch_delay_seconds=config.oembed_delay_seconds,
    )
    worker = Worker(config, services)
    services.heartbeat = worker._heartbeat
    signal.signal(signal.SIGTERM, worker.stop)
    signal.signal(signal.SIGINT, worker.stop)
    log.info(
        "worker started (sync time %s %s)", config.sync_time.strftime("%H:%M"), config.timezone.key
    )
    worker.run()
    log.info("worker stopped")
    return 0
