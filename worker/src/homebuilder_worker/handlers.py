"""Runs one claimed job. See docs/JOBS.md for each job type's payload."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pymysql.connections import Connection

from .importer import (
    Candidate,
    ImportResult,
    MetadataFetcher,
    import_videos,
    reapply_rules,
    refresh_metadata,
)
from .jobs import Job
from .metadata import UNAVAILABLE, VideoMetadata
from .playlist import PlaylistError, parse_flat_playlist
from .rules import load_rules
from .sources import InputError, parse_csv, parse_paste
from .youtube import is_playlist_id

log = logging.getLogger(__name__)


class PermanentJobError(Exception):
    """The job can never succeed as given; it is failed without a retry."""


@dataclass
class Services:
    fetch_metadata: MetadataFetcher
    #: Takes a playlist ID and returns yt-dlp's --dump-single-json output.
    run_playlist: Any
    fetch_delay_seconds: float = 0.0
    #: Called while a long job makes progress, so the container health check stays green.
    heartbeat: Callable[[], None] = lambda: None


def _payload_str(job: Job, key: str) -> str:
    value = job.payload.get(key)
    if not isinstance(value, str):
        raise PermanentJobError(f"payload.{key} must be a string")
    return value


def _import_parsed(
    conn: Connection,
    job: Job,
    services: Services,
    video_ids: list[str],
    invalid: list[str],
    source: str,
) -> dict[str, Any]:
    result = ImportResult(invalid=list(invalid))
    import_videos(
        conn,
        (Candidate(v) for v in video_ids),
        house_id=job.house_id,
        source=source,
        added_by=job.created_by,
        rules=load_rules(conn),
        fetch_metadata=services.fetch_metadata,
        fetch_delay_seconds=services.fetch_delay_seconds,
        result=result,
        on_progress=services.heartbeat,
    )
    return result.as_json()


def handle_paste(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    try:
        parsed = parse_paste(_payload_str(job, "text"))
    except InputError as error:
        raise PermanentJobError(str(error)) from error
    return _import_parsed(conn, job, services, parsed.video_ids, parsed.invalid, "paste")


def handle_csv(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    try:
        parsed = parse_csv(_payload_str(job, "csv"))
    except InputError as error:
        raise PermanentJobError(str(error)) from error
    return _import_parsed(conn, job, services, parsed.video_ids, parsed.invalid, "csv")


def handle_playlist_sync(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    if job.house_id is not None:
        raise PermanentJobError("Playlist sync only feeds the shared library")
    playlist_pk = job.payload.get("playlistId")
    if not isinstance(playlist_pk, int):
        raise PermanentJobError("payload.playlistId must be an integer")
    with conn.cursor() as cur:
        cur.execute("SELECT youtube_playlist_id FROM playlists WHERE id = %s", (playlist_pk,))
        row = cur.fetchone()
    conn.rollback()
    if row is None:
        raise PermanentJobError("Playlist no longer exists")
    youtube_playlist_id = row["youtube_playlist_id"]
    if not is_playlist_id(youtube_playlist_id):
        raise PermanentJobError("Stored playlist ID is invalid")

    playlist = parse_flat_playlist(services.run_playlist(youtube_playlist_id))
    candidates = [
        Candidate(
            e.video_id,
            UNAVAILABLE
            if e.unavailable
            else (VideoMetadata("ok", e.title, e.channel) if e.title else None),
        )
        for e in playlist.entries
    ]
    result = import_videos(
        conn,
        candidates,
        house_id=None,
        source="playlist",
        added_by=job.created_by,
        rules=load_rules(conn),
        fetch_metadata=services.fetch_metadata,
        fetch_delay_seconds=services.fetch_delay_seconds,
        on_progress=services.heartbeat,
    )
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE playlists SET title = COALESCE(%s, title), last_synced_at = UTC_TIMESTAMP() "
            "WHERE id = %s",
            (playlist.title, playlist_pk),
        )
    conn.commit()
    return {**result.as_json(), "playlistEntries": len(playlist.entries)}


def handle_metadata_refresh(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    raw_ids = job.payload.get("videoIds")
    video_ids: list[int] | None = None
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or not all(isinstance(i, int) for i in raw_ids):
            raise PermanentJobError("payload.videoIds must be a list of integers")
        video_ids = raw_ids or None
    return refresh_metadata(
        conn,
        rules=load_rules(conn),
        fetch_metadata=services.fetch_metadata,
        video_ids=video_ids,
        fetch_delay_seconds=services.fetch_delay_seconds,
    )


def handle_apply_rules(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    if job.house_id is not None:
        raise PermanentJobError("Keyword rules apply to the whole library")
    return reapply_rules(conn, rules=load_rules(conn))


HANDLERS = {
    "paste_import": handle_paste,
    "csv_import": handle_csv,
    "playlist_sync": handle_playlist_sync,
    "metadata_refresh": handle_metadata_refresh,
    "apply_rules": handle_apply_rules,
}


def run_job(conn: Connection, job: Job, services: Services) -> dict[str, Any]:
    handler = HANDLERS.get(job.type)
    if handler is None:
        raise PermanentJobError(f"Unknown job type {job.type!r}")
    return handler(conn, job, services)


#: Failures worth retrying: the network or YouTube may recover.
RETRYABLE = (PlaylistError, OSError)
