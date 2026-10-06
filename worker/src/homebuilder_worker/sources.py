"""Parsing pasted URL lists and Google Takeout playlist CSVs into video IDs."""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field

from .youtube import extract_video_id

MAX_PASTE_LINES = 500
MAX_CSV_ROWS = 20_000
MAX_INPUT_CHARS = 2_000_000
_VIDEO_ID_HEADERS = {"video id", "video_id", "videoid"}


class InputError(ValueError):
    """The input can never succeed as given; the job fails without a retry."""


@dataclass
class ParseResult:
    video_ids: list[str] = field(default_factory=list)
    invalid: list[str] = field(default_factory=list)

    def add(self, video_id: str, seen: set[str]) -> None:
        if video_id not in seen:
            seen.add(video_id)
            self.video_ids.append(video_id)


def _check_size(text: str) -> None:
    if len(text) > MAX_INPUT_CHARS:
        raise InputError(f"Input is larger than {MAX_INPUT_CHARS} characters")


def parse_paste(text: str) -> ParseResult:
    """One URL or bare video ID per line. Blank lines and lines starting with # are skipped."""
    _check_size(text)
    lines = [line.strip() for line in text.splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    if len(lines) > MAX_PASTE_LINES:
        raise InputError(f"Paste at most {MAX_PASTE_LINES} lines at a time (got {len(lines)})")
    result = ParseResult()
    seen: set[str] = set()
    for line in lines:
        video_id = extract_video_id(line)
        if video_id:
            result.add(video_id, seen)
        else:
            result.invalid.append(line[:200])
    return result


def parse_csv(text: str) -> ParseResult:
    """Google Takeout playlist CSV, or any CSV containing YouTube URLs.

    Takeout files have a header row with a "Video ID" column (older exports put a few
    playlist-metadata rows above it). When that column exists, its cells may be bare IDs.
    Without it, only full YouTube URLs are taken from any cell, so ordinary words that
    happen to be 11 characters long are never mistaken for IDs.
    """
    _check_size(text)
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if len(rows) > MAX_CSV_ROWS:
        raise InputError(f"CSV has more than {MAX_CSV_ROWS} rows")

    result = ParseResult()
    seen: set[str] = set()
    id_column: int | None = None
    for row in rows:
        if id_column is None:
            for index, cell in enumerate(row):
                if cell.strip().lower() in _VIDEO_ID_HEADERS:
                    id_column = index
                    break
            if id_column is not None:
                continue
            for cell in row:
                video_id = extract_video_id(cell, allow_bare=False)
                if video_id:
                    result.add(video_id, seen)
            continue

        cell = row[id_column].strip() if id_column < len(row) else ""
        if not cell:
            continue
        video_id = extract_video_id(cell)
        if video_id:
            result.add(video_id, seen)
        else:
            result.invalid.append(cell[:200])

    if not result.video_ids and not result.invalid:
        raise InputError("No YouTube video IDs or URLs found in the CSV")
    return result
