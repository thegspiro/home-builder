"""Reading a playlist's video list with yt-dlp (no API key, public/unlisted playlists)."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

from .youtube import VIDEO_ID_RE, playlist_url

# Placeholder titles yt-dlp reports for entries you can no longer watch.
_UNAVAILABLE_TITLES = {"[private video]", "[deleted video]", "[unavailable video]"}


class PlaylistError(RuntimeError):
    """yt-dlp could not read the playlist (network, removed, private, YouTube changes)."""


@dataclass(frozen=True)
class PlaylistEntry:
    video_id: str
    title: str | None
    channel: str | None
    unavailable: bool


@dataclass(frozen=True)
class Playlist:
    title: str | None
    entries: list[PlaylistEntry]


def run_ytdlp(playlist_id: str, timeout_seconds: int) -> dict[str, Any]:
    """Runs yt-dlp as a subprocess with an argument list (never a shell).

    --flat-playlist lists entries without visiting each video page; --ignore-config and
    --no-cache-dir keep it from reading or writing files outside the container's /tmp.
    """
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--flat-playlist",
        "--dump-single-json",
        "--skip-download",
        "--ignore-config",
        "--no-cache-dir",
        "--no-warnings",
        "--quiet",
        "--",
        playlist_url(playlist_id),
    ]
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, validated playlist ID
            command,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise PlaylistError(f"yt-dlp timed out after {timeout_seconds}s") from error
    if completed.returncode != 0:
        detail = " ".join(completed.stderr.split())[-500:]
        raise PlaylistError(f"yt-dlp exited with {completed.returncode}: {detail}")
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PlaylistError("yt-dlp returned output that is not JSON") from error
    if not isinstance(data, dict):
        raise PlaylistError("yt-dlp returned unexpected JSON")
    return data


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned[:limit] or None


def parse_flat_playlist(data: dict[str, Any]) -> Playlist:
    entries: list[PlaylistEntry] = []
    seen: set[str] = set()
    for raw in data.get("entries") or []:
        if not isinstance(raw, dict):
            continue
        video_id = raw.get("id")
        if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id) or video_id in seen:
            continue
        seen.add(video_id)
        title = _text(raw.get("title"), 500)
        unavailable = title is not None and title.lower() in _UNAVAILABLE_TITLES
        entries.append(
            PlaylistEntry(
                video_id=video_id,
                title=None if unavailable else title,
                channel=_text(raw.get("channel") or raw.get("uploader"), 255),
                unavailable=unavailable,
            )
        )
    return Playlist(title=_text(data.get("title"), 500), entries=entries)
