import json
from pathlib import Path

import pytest

from homebuilder_worker.handlers import PermanentJobError, Services, run_job
from homebuilder_worker.jobs import Job
from homebuilder_worker.metadata import PENDING, UNAVAILABLE, VideoMetadata
from homebuilder_worker.playlist import PlaylistError

from .conftest import add_rule, lookup, make_house, rows

pytestmark = pytest.mark.integration

FIXTURE = Path(__file__).parent.parent / "fixtures" / "flat_playlist.json"

TITLES = {
    "aaaaaaaaaaa": VideoMetadata("ok", "Insulating a garage door", "DIY Dan"),
    "bbbbbbbbbbb": VideoMetadata("ok", "Fixing a running toilet", "Plumbing Pro"),
    "ccccccccccc": UNAVAILABLE,
    "ddddddddddd": PENDING,
}


class FakeServices(Services):
    def __init__(self, playlist_data=None, playlist_error=None) -> None:
        self.fetched: list[str] = []

        def fetch(video_id: str) -> VideoMetadata:
            self.fetched.append(video_id)
            return TITLES.get(video_id, VideoMetadata("ok", f"Video {video_id}", None))

        def run_playlist(playlist_id: str):
            if playlist_error:
                raise playlist_error
            return playlist_data

        super().__init__(fetch_metadata=fetch, run_playlist=run_playlist)


def job(job_type: str, payload: dict, house_id: int | None = None) -> Job:
    return Job(1, job_type, house_id, payload, 1, "me@example.com")


def videos(conn) -> dict[str, dict]:
    return {
        r["youtube_id"]: r
        for r in rows(
            conn,
            "SELECT youtube_id, house_id, title, channel_name, thumbnail_url, source, "
            "metadata_status, review_status, added_by FROM videos",
        )
    }


def test_paste_import_adds_videos_with_metadata_and_suggestions(conn) -> None:
    garage = lookup(conn, "area_types", "garage")
    insulation_tag = lookup(conn, "area_types", "insulation")
    garage_door = lookup(conn, "items", "garage-door")
    repair = lookup(conn, "tags", "repair")
    add_rule(conn, "garage door", area_type_id=garage)
    add_rule(conn, "garage door", item_id=garage_door)
    add_rule(conn, "insulating", area_type_id=insulation_tag)
    add_rule(conn, "fixing", tag_id=repair)

    text = "\n".join(
        [
            "https://youtu.be/aaaaaaaaaaa",
            "https://www.youtube.com/watch?v=bbbbbbbbbbb",
            "ccccccccccc",
            "ddddddddddd",
            "not a link",
        ]
    )
    result = run_job(conn, job("paste_import", {"text": text}), FakeServices())
    assert result == {
        "added": 4,
        "duplicates": 0,
        "alreadyShared": 0,
        "unavailable": 1,
        "pendingMetadata": 1,
        "suggested": 4,
        "invalidCount": 1,
        "invalid": ["not a link"],
    }

    stored = videos(conn)
    assert stored["aaaaaaaaaaa"] == {
        "youtube_id": "aaaaaaaaaaa",
        "house_id": None,
        "title": "Insulating a garage door",
        "channel_name": "DIY Dan",
        "thumbnail_url": "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
        "source": "paste",
        "metadata_status": "ok",
        "review_status": "inbox",
        "added_by": "me@example.com",
    }
    assert stored["ccccccccccc"]["metadata_status"] == "unavailable"
    assert stored["ddddddddddd"]["metadata_status"] == "pending"

    links = rows(
        conn,
        "SELECT 'area' AS kind, area_type_id AS target, suggested FROM video_area_types "
        "UNION ALL SELECT 'item', item_id, suggested FROM video_items "
        "UNION ALL SELECT 'tag', tag_id, suggested FROM video_tags ORDER BY kind, target",
    )
    assert sorted((r["kind"], r["target"], r["suggested"]) for r in links) == sorted(
        [
            ("area", garage, 1),
            ("area", insulation_tag, 1),
            ("item", garage_door, 1),
            ("tag", repair, 1),
        ]
    )


def test_reimport_counts_duplicates_without_refetching(conn) -> None:
    services = FakeServices()
    run_job(conn, job("paste_import", {"text": "aaaaaaaaaaa\nbbbbbbbbbbb"}), services)
    services.fetched.clear()
    result = run_job(conn, job("paste_import", {"text": "bbbbbbbbbbb\neeeeeeeeeee"}), services)
    assert (result["added"], result["duplicates"]) == (1, 1)
    assert services.fetched == ["eeeeeeeeeee"]


def test_house_import_skips_shared_videos_and_stays_private(conn) -> None:
    house = make_house(conn)
    other = make_house(conn, "Other")
    run_job(conn, job("paste_import", {"text": "aaaaaaaaaaa"}), FakeServices())

    result = run_job(
        conn, job("paste_import", {"text": "aaaaaaaaaaa\nbbbbbbbbbbb"}, house), FakeServices()
    )
    assert (result["added"], result["alreadyShared"]) == (1, 1)
    # The same private video may exist in another house.
    result = run_job(conn, job("paste_import", {"text": "bbbbbbbbbbb"}, other), FakeServices())
    assert result["added"] == 1

    scopes = sorted(
        (r["youtube_id"], r["house_id"] or 0)
        for r in rows(conn, "SELECT youtube_id, house_id FROM videos")
    )
    assert scopes == sorted([("aaaaaaaaaaa", 0), ("bbbbbbbbbbb", house), ("bbbbbbbbbbb", other)])


def test_csv_import(conn) -> None:
    csv_text = "Video ID,Playlist Video Creation Timestamp\naaaaaaaaaaa,2024-01-01\nnope,2024\n"
    result = run_job(conn, job("csv_import", {"csv": csv_text}), FakeServices())
    assert (result["added"], result["invalidCount"]) == (1, 1)
    assert videos(conn)["aaaaaaaaaaa"]["source"] == "csv"


@pytest.mark.parametrize(
    ("job_type", "payload", "message"),
    [
        ("paste_import", {}, "payload.text"),
        ("paste_import", {"text": "\n".join(["aaaaaaaaaaa"] * 501)}, "at most"),
        ("csv_import", {"csv": "a,b\n1,2"}, "No YouTube"),
        ("playlist_sync", {"playlistId": "x"}, "playlistId"),
        ("playlist_sync", {"playlistId": 999999}, "no longer exists"),
        ("metadata_refresh", {"videoIds": ["x"]}, "videoIds"),
        ("mystery", {}, "Unknown job type"),
    ],
)
def test_permanent_errors(conn, job_type, payload, message) -> None:
    with pytest.raises(PermanentJobError, match=message):
        run_job(conn, job(job_type, payload), FakeServices())


def add_playlist(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO playlists (youtube_playlist_id) VALUES ('PLtest1234567890abcdef')")
        playlist_id = int(cur.lastrowid)
    conn.commit()
    return playlist_id


def test_playlist_sync_uses_listing_metadata_and_fetches_the_rest(conn) -> None:
    playlist_id = add_playlist(conn)
    services = FakeServices(playlist_data=json.loads(FIXTURE.read_text()))
    result = run_job(conn, job("playlist_sync", {"playlistId": playlist_id}), services)

    assert result["playlistEntries"] == 5
    assert (result["added"], result["unavailable"]) == (5, 2)
    # Only the entry with no title in the listing needed an oEmbed call.
    assert services.fetched == ["eeeeeeeeeee"]
    stored = videos(conn)
    assert stored["aaaaaaaaaaa"]["title"] == "How to install a garage door opener"
    assert stored["aaaaaaaaaaa"]["source"] == "playlist"
    assert stored["bbbbbbbbbbb"]["metadata_status"] == "unavailable"
    [playlist] = rows(conn, "SELECT title, last_synced_at FROM playlists")
    assert playlist["title"] == "Home repair videos" and playlist["last_synced_at"] is not None

    again = run_job(conn, job("playlist_sync", {"playlistId": playlist_id}), services)
    assert (again["added"], again["duplicates"]) == (0, 5)


def test_playlist_sync_refuses_house_scope_and_surfaces_ytdlp_errors(conn) -> None:
    playlist_id = add_playlist(conn)
    with pytest.raises(PermanentJobError, match="shared library"):
        run_job(conn, job("playlist_sync", {"playlistId": playlist_id}, house_id=1), FakeServices())
    with pytest.raises(PlaylistError):
        run_job(
            conn,
            job("playlist_sync", {"playlistId": playlist_id}),
            FakeServices(playlist_error=PlaylistError("yt-dlp exited with 1")),
        )


def test_metadata_refresh_fills_pending_videos_and_suggests(conn) -> None:
    repair = lookup(conn, "tags", "repair")
    add_rule(conn, "repair", tag_id=repair)
    run_job(conn, job("paste_import", {"text": "ddddddddddd"}), FakeServices())
    assert videos(conn)["ddddddddddd"]["metadata_status"] == "pending"

    original = TITLES["ddddddddddd"]
    TITLES["ddddddddddd"] = VideoMetadata("ok", "Drywall repair basics", "Wall Guy")
    try:
        counts = run_job(conn, job("metadata_refresh", {}), FakeServices())
    finally:
        TITLES["ddddddddddd"] = original
    assert counts == {"checked": 1, "ok": 1, "unavailable": 0, "pending": 0, "suggested": 1}
    stored = videos(conn)["ddddddddddd"]
    assert (stored["title"], stored["metadata_status"]) == ("Drywall repair basics", "ok")
    assert rows(conn, "SELECT tag_id, suggested FROM video_tags") == [
        {"tag_id": repair, "suggested": 1}
    ]


def test_apply_rules_replaces_old_suggestions_and_keeps_confirmed_links(conn) -> None:
    roofing = lookup(conn, "tags", "roofing")
    repair = lookup(conn, "tags", "repair")
    install = lookup(conn, "tags", "install")
    run_job(conn, job("paste_import", {"text": "aaaaaaaaaaa\nbbbbbbbbbbb"}), FakeServices())
    ids = {r["youtube_id"]: r["id"] for r in rows(conn, "SELECT id, youtube_id FROM videos")}
    with conn.cursor() as cur:
        # A stale suggestion from a rule that no longer exists, and a confirmed tag.
        cur.execute(
            "INSERT INTO video_tags (video_id, tag_id, suggested) VALUES (%s, %s, TRUE)",
            (ids["aaaaaaaaaaa"], roofing),
        )
        cur.execute(
            "INSERT INTO video_tags (video_id, tag_id, suggested) VALUES (%s, %s, FALSE)",
            (ids["aaaaaaaaaaa"], install),
        )
        # Sorted videos are left alone.
        cur.execute(
            "UPDATE videos SET review_status = 'sorted' WHERE id = %s", (ids["bbbbbbbbbbb"],)
        )
    conn.commit()
    add_rule(conn, "garage door", tag_id=repair)
    add_rule(conn, "toilet", tag_id=repair)

    counts = run_job(conn, job("apply_rules", {}), FakeServices())
    assert counts == {"videos": 1, "suggested": 1}
    links = rows(conn, "SELECT video_id, tag_id, suggested FROM video_tags ORDER BY tag_id")
    assert sorted((r["tag_id"], r["suggested"]) for r in links) == sorted(
        [(install, 0), (repair, 1)]
    )
    assert {r["video_id"] for r in links} == {ids["aaaaaaaaaaa"]}

    with pytest.raises(PermanentJobError, match="whole library"):
        run_job(conn, job("apply_rules", {}, house_id=1), FakeServices())


def test_imports_report_progress_per_video(conn) -> None:
    beats: list[int] = []
    services = FakeServices()
    services.heartbeat = lambda: beats.append(1)
    run_job(conn, job("paste_import", {"text": "aaaaaaaaaaa\nbbbbbbbbbbb\nccccccccccc"}), services)
    assert len(beats) == 3
