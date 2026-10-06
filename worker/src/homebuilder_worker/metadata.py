"""Video titles and channels from YouTube's public oEmbed endpoint (no API key)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import requests

from .youtube import watch_url

OEMBED_URL = "https://www.youtube.com/oembed"


@dataclass(frozen=True)
class VideoMetadata:
    status: Literal["ok", "unavailable", "pending"]
    title: str | None = None
    channel: str | None = None


PENDING = VideoMetadata("pending")
UNAVAILABLE = VideoMetadata("unavailable")


def _clean(value: object, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split())
    return cleaned[:limit] or None


class OEmbedClient:
    def __init__(self, session: requests.Session | None = None, timeout: float = 10.0) -> None:
        self._session = session or requests.Session()
        self._timeout = timeout

    def fetch(self, video_id: str) -> VideoMetadata:
        """ok with title/channel; unavailable when YouTube says the video is private,
        deleted or not embeddable (401/403/404); pending on any transient failure so a
        later metadata refresh retries it."""
        try:
            response = self._session.get(
                OEMBED_URL,
                params={"url": watch_url(video_id), "format": "json"},
                timeout=self._timeout,
            )
        except requests.RequestException:
            return PENDING
        if response.status_code in (401, 403, 404):
            return UNAVAILABLE
        if response.status_code != 200:
            return PENDING
        try:
            body = response.json()
        except ValueError:
            return PENDING
        if not isinstance(body, dict):
            return PENDING
        title = _clean(body.get("title"), 500)
        if title is None:
            return PENDING
        return VideoMetadata("ok", title=title, channel=_clean(body.get("author_name"), 255))
