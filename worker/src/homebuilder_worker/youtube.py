"""YouTube identifiers: parsing video and playlist IDs out of URLs, and derived URLs."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")

_YOUTUBE_HOSTS = {"youtube.com", "youtube-nocookie.com"}
_PATH_PREFIXES = ("/shorts/", "/embed/", "/live/", "/v/")


def _host(netloc: str) -> str:
    host = netloc.lower().split("@")[-1].split(":")[0]
    for prefix in ("www.", "m.", "music."):
        if host.startswith(prefix):
            return host[len(prefix) :]
    return host


def extract_video_id(text: str, *, allow_bare: bool = True) -> str | None:
    """Returns the 11-character video ID in a YouTube URL (or a bare ID), else None.

    Accepts watch, youtu.be, shorts, embed, live and /v/ links, with or without a scheme.
    """
    value = text.strip()
    if not value or len(value) > 2048:
        return None
    if VIDEO_ID_RE.match(value):
        return value if allow_bare else None

    if "://" not in value:
        value = "https://" + value
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None

    host = _host(parts.netloc)
    candidate: str | None = None
    if host == "youtu.be":
        candidate = parts.path.lstrip("/").split("/")[0]
    elif host in _YOUTUBE_HOSTS:
        if parts.path.rstrip("/") == "/watch":
            candidate = (parse_qs(parts.query).get("v") or [""])[0]
        else:
            for prefix in _PATH_PREFIXES:
                if parts.path.startswith(prefix):
                    candidate = parts.path[len(prefix) :].split("/")[0]
                    break
    if candidate and VIDEO_ID_RE.match(candidate):
        return candidate
    return None


def is_playlist_id(value: str) -> bool:
    return bool(PLAYLIST_ID_RE.match(value))


def playlist_url(playlist_id: str) -> str:
    if not is_playlist_id(playlist_id):
        raise ValueError("invalid playlist ID")
    return f"https://www.youtube.com/playlist?list={playlist_id}"


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def thumbnail_url(video_id: str) -> str:
    """Thumbnail served from i.ytimg.com (allowed by the app's Content-Security-Policy)."""
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
