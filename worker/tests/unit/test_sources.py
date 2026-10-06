import pytest

from homebuilder_worker.sources import (
    MAX_INPUT_CHARS,
    MAX_PASTE_LINES,
    InputError,
    parse_csv,
    parse_paste,
)


def test_paste_keeps_order_dedupes_and_reports_invalid() -> None:
    text = """
    # my garage videos
    https://youtu.be/aaaaaaaaaaa
    bbbbbbbbbbb
    https://www.youtube.com/watch?v=aaaaaaaaaaa

    not a video
    """
    result = parse_paste(text)
    assert result.video_ids == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
    assert result.invalid == ["not a video"]


def test_paste_limits_line_count() -> None:
    lines = "\n".join(f"https://youtu.be/{i:011d}" for i in range(MAX_PASTE_LINES + 1))
    with pytest.raises(InputError, match="at most"):
        parse_paste(lines)


def test_paste_limits_size() -> None:
    with pytest.raises(InputError):
        parse_paste("a" * (MAX_INPUT_CHARS + 1))


def test_takeout_csv_current_format() -> None:
    csv_text = (
        "Video ID,Playlist Video Creation Timestamp\n"
        "aaaaaaaaaaa,2024-01-01T00:00:00+00:00\n"
        "bbbbbbbbbbb,2024-01-02T00:00:00+00:00\n"
        "aaaaaaaaaaa,2024-01-03T00:00:00+00:00\n"
        "bad,2024-01-04T00:00:00+00:00\n"
        ",\n"
    )
    result = parse_csv(csv_text)
    assert result.video_ids == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
    assert result.invalid == ["bad"]


def test_takeout_csv_older_format_with_metadata_rows_and_bom() -> None:
    csv_text = (
        "﻿Playlist Id,Channel Id,Time Created,Title,Description\n"
        "PLabc,UCxyz,2020-01-01,Home repair,Stuff I shared\n"
        "\n"
        "Video Id,Time Added\n"
        "aaaaaaaaaaa,2020-01-01 00:00:00 UTC\n"
    )
    assert parse_csv(csv_text).video_ids == ["aaaaaaaaaaa"]


def test_csv_without_id_column_only_takes_full_urls() -> None:
    csv_text = (
        "Title,Link,Description\n"
        "Garage,https://youtu.be/aaaaaaaaaaa,Description\n"
        "Kitchen,https://www.youtube.com/watch?v=bbbbbbbbbbb,Whitespaces\n"
    )
    # "Description" and "Whitespaces" are 11 characters but must not become IDs.
    assert parse_csv(csv_text).video_ids == ["aaaaaaaaaaa", "bbbbbbbbbbb"]


def test_csv_with_nothing_usable_is_an_error() -> None:
    with pytest.raises(InputError, match="No YouTube"):
        parse_csv("a,b,c\n1,2,3\n")
