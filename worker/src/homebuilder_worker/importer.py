"""Adding videos to the library: de-duplication, metadata and keyword-rule suggestions."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import pymysql
from pymysql.connections import Connection

from .metadata import VideoMetadata
from .rules import CompiledRule, Suggestions, suggest
from .youtube import thumbnail_url

log = logging.getLogger(__name__)

ER_DUP_ENTRY = 1062
MAX_REPORTED_INVALID = 50

MetadataFetcher = Callable[[str], VideoMetadata]


@dataclass(frozen=True)
class Candidate:
    video_id: str
    #: Metadata already known (e.g. from the playlist listing); fetched when None.
    metadata: VideoMetadata | None = None


@dataclass
class ImportResult:
    added: int = 0
    duplicates: int = 0
    already_shared: int = 0
    unavailable: int = 0
    pending_metadata: int = 0
    suggested: int = 0
    invalid: list[str] = field(default_factory=list)

    def as_json(self) -> dict[str, Any]:
        return {
            "added": self.added,
            "duplicates": self.duplicates,
            "alreadyShared": self.already_shared,
            "unavailable": self.unavailable,
            "pendingMetadata": self.pending_metadata,
            "suggested": self.suggested,
            "invalidCount": len(self.invalid),
            "invalid": self.invalid[:MAX_REPORTED_INVALID],
        }


def _existing_scope(conn: Connection, video_id: str, house_id: int | None) -> str | None:
    """'own' if already in the target scope, 'shared' if a house import finds it in the
    shared library (already visible to the house), else None."""
    scopes = [0] if house_id is None else [0, house_id]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT house_scope FROM videos WHERE youtube_id = %s AND house_scope IN %s",
            (video_id, scopes),
        )
        found = {int(r["house_scope"]) for r in cur.fetchall()}
    if (house_id or 0) in found:
        return "own"
    if 0 in found:
        return "shared"
    return None


def write_suggestions(conn: Connection, video_id: int, found: Suggestions) -> int:
    """Records rule matches as suggested links. Existing links are left untouched."""
    with conn.cursor() as cur:
        for tag_id in sorted(found.tag_ids):
            cur.execute(
                "INSERT IGNORE INTO video_tags (video_id, tag_id, suggested) VALUES (%s, %s, TRUE)",
                (video_id, tag_id),
            )
        for area_type_id in sorted(found.area_type_ids):
            cur.execute(
                "INSERT IGNORE INTO video_area_types (video_id, area_type_id, suggested) "
                "VALUES (%s, %s, TRUE)",
                (video_id, area_type_id),
            )
        for item_id in sorted(found.item_ids):
            cur.execute(
                "INSERT IGNORE INTO video_items (video_id, item_id, suggested) "
                "VALUES (%s, %s, TRUE)",
                (video_id, item_id),
            )
    return len(found.tag_ids) + len(found.area_type_ids) + len(found.item_ids)


def import_videos(
    conn: Connection,
    candidates: Iterable[Candidate],
    *,
    house_id: int | None,
    source: str,
    added_by: str,
    rules: list[CompiledRule],
    fetch_metadata: MetadataFetcher,
    fetch_delay_seconds: float = 0.0,
    result: ImportResult | None = None,
    on_progress: Callable[[], None] | None = None,
) -> ImportResult:
    """Adds each new video in its own transaction, so a failure part-way keeps the
    videos already imported and a retry skips them as duplicates."""
    result = result or ImportResult()
    for candidate in candidates:
        if on_progress is not None:
            on_progress()
        scope = _existing_scope(conn, candidate.video_id, house_id)
        conn.rollback()  # end the read-only snapshot before doing network I/O
        if scope == "own":
            result.duplicates += 1
            continue
        if scope == "shared":
            result.already_shared += 1
            continue

        metadata = candidate.metadata
        if metadata is None:
            metadata = fetch_metadata(candidate.video_id)
            if fetch_delay_seconds:
                time.sleep(fetch_delay_seconds)

        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO videos (youtube_id, house_id, title, channel_name, "
                    "thumbnail_url, source, metadata_status, added_by) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        candidate.video_id,
                        house_id,
                        metadata.title,
                        metadata.channel,
                        thumbnail_url(candidate.video_id),
                        source,
                        metadata.status,
                        added_by,
                    ),
                )
                new_id = int(cur.lastrowid)
            result.suggested += write_suggestions(conn, new_id, suggest(rules, metadata.title))
            conn.commit()
        except pymysql.err.IntegrityError as error:
            conn.rollback()
            if error.args and error.args[0] == ER_DUP_ENTRY:
                # Another job added it between our check and insert.
                result.duplicates += 1
                continue
            raise
        except Exception:
            conn.rollback()
            raise

        result.added += 1
        if metadata.status == "unavailable":
            result.unavailable += 1
        elif metadata.status == "pending":
            result.pending_metadata += 1
    return result


def refresh_metadata(
    conn: Connection,
    *,
    rules: list[CompiledRule],
    fetch_metadata: MetadataFetcher,
    video_ids: list[int] | None = None,
    limit: int = 500,
    fetch_delay_seconds: float = 0.0,
) -> dict[str, int]:
    """Retries videos whose metadata is still pending. Newly titled videos that are still
    in the inbox get keyword-rule suggestions, as they would have on import."""
    with conn.cursor() as cur:
        if video_ids:
            cur.execute(
                "SELECT id, youtube_id, review_status FROM videos "
                "WHERE metadata_status = 'pending' AND id IN %s ORDER BY id LIMIT %s",
                (video_ids, limit),
            )
        else:
            cur.execute(
                "SELECT id, youtube_id, review_status FROM videos "
                "WHERE metadata_status = 'pending' ORDER BY id LIMIT %s",
                (limit,),
            )
        rows = cur.fetchall()
    conn.rollback()

    counts = {"checked": 0, "ok": 0, "unavailable": 0, "pending": 0, "suggested": 0}
    for row in rows:
        metadata = fetch_metadata(row["youtube_id"])
        counts["checked"] += 1
        counts[metadata.status] += 1
        if metadata.status == "pending":
            continue
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE videos SET title = COALESCE(%s, title), "
                "channel_name = COALESCE(%s, channel_name), metadata_status = %s "
                "WHERE id = %s AND metadata_status = 'pending'",
                (metadata.title, metadata.channel, metadata.status, row["id"]),
            )
        if metadata.status == "ok" and row["review_status"] == "inbox":
            found = suggest(rules, metadata.title)
            counts["suggested"] += write_suggestions(conn, row["id"], found)
        conn.commit()
        if fetch_delay_seconds:
            time.sleep(fetch_delay_seconds)
    return counts


def reapply_rules(
    conn: Connection, *, rules: list[CompiledRule], batch: int = 200
) -> dict[str, int]:
    """Re-runs keyword rules over every titled video still in the inbox.

    Suggestions from earlier runs are replaced, so a deleted or edited rule stops
    suggesting things; confirmed links (suggested = FALSE) are never touched.
    """
    counts = {"videos": 0, "suggested": 0}
    last_id = 0
    while True:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, title FROM videos WHERE review_status = 'inbox' "
                "AND title IS NOT NULL AND id > %s ORDER BY id LIMIT %s",
                (last_id, batch),
            )
            page = cur.fetchall()
        if not page:
            conn.rollback()
            return counts
        for row in page:
            with conn.cursor() as cur:
                for table in ("video_tags", "video_area_types", "video_items"):
                    cur.execute(
                        f"DELETE FROM {table} WHERE video_id = %s AND suggested = TRUE",  # noqa: S608
                        (row["id"],),
                    )
            counts["suggested"] += write_suggestions(conn, row["id"], suggest(rules, row["title"]))
            counts["videos"] += 1
            last_id = row["id"]
        conn.commit()
