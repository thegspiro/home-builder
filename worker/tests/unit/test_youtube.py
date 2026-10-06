import pytest

from homebuilder_worker.youtube import extract_video_id, is_playlist_id, playlist_url, thumbnail_url

ID = "dQw4w9WgXcQ"


@pytest.mark.parametrize(
    "text",
    [
        ID,
        f"  {ID}  ",
        f"https://www.youtube.com/watch?v={ID}",
        f"https://youtube.com/watch?v={ID}&t=42s&list=PLxyz",
        f"http://m.youtube.com/watch?feature=share&v={ID}",
        f"www.youtube.com/watch?v={ID}",
        f"https://youtu.be/{ID}",
        f"youtu.be/{ID}?si=abc",
        f"https://www.youtube.com/shorts/{ID}",
        f"https://www.youtube.com/embed/{ID}?rel=0",
        f"https://www.youtube-nocookie.com/embed/{ID}",
        f"https://www.youtube.com/live/{ID}",
        f"https://music.youtube.com/watch?v={ID}",
        f"HTTPS://WWW.YOUTUBE.COM/watch?v={ID}",
    ],
)
def test_extracts_video_ids(text: str) -> None:
    assert extract_video_id(text) == ID


@pytest.mark.parametrize(
    "text",
    [
        "",
        "hello world",
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "https://evil.youtube.com.example.com/watch?v=dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ%27--",
        "https://www.youtube.com/playlist?list=PL1234567890",
        "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
        "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
        "x" * 3000,
    ],
)
def test_rejects_non_video_text(text: str) -> None:
    assert extract_video_id(text) is None


def test_bare_ids_can_be_refused() -> None:
    assert extract_video_id(ID, allow_bare=False) is None
    assert extract_video_id(f"https://youtu.be/{ID}", allow_bare=False) == ID


def test_playlist_helpers() -> None:
    assert is_playlist_id("PLtest1234567890")
    assert not is_playlist_id("bad id!")
    assert not is_playlist_id("short")
    assert (
        playlist_url("PLtest1234567890") == "https://www.youtube.com/playlist?list=PLtest1234567890"
    )
    with pytest.raises(ValueError):
        playlist_url("x&y=1 --exec rm")


def test_thumbnail_url_is_on_ytimg() -> None:
    assert thumbnail_url(ID) == f"https://i.ytimg.com/vi/{ID}/hqdefault.jpg"
