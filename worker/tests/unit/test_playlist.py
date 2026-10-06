import json
import subprocess
from pathlib import Path

import pytest

from homebuilder_worker import playlist
from homebuilder_worker.playlist import PlaylistError, parse_flat_playlist, run_ytdlp

FIXTURE = Path(__file__).parent.parent / "fixtures" / "flat_playlist.json"


def test_parses_flat_playlist_entries() -> None:
    parsed = parse_flat_playlist(json.loads(FIXTURE.read_text()))
    assert parsed.title == "Home repair videos"
    assert [e.video_id for e in parsed.entries] == [
        "aaaaaaaaaaa",
        "bbbbbbbbbbb",
        "ccccccccccc",
        "ddddddddddd",
        "eeeeeeeeeee",
    ]
    by_id = {e.video_id: e for e in parsed.entries}
    assert by_id["aaaaaaaaaaa"].title == "How to install a garage door opener"
    assert by_id["aaaaaaaaaaa"].channel == "This Old Garage"
    assert by_id["bbbbbbbbbbb"].unavailable and by_id["bbbbbbbbbbb"].title is None
    assert by_id["ccccccccccc"].unavailable
    assert by_id["ddddddddddd"].channel == "Plumbing Pro"
    assert by_id["eeeeeeeeeee"].title is None and not by_id["eeeeeeeeeee"].unavailable


def test_handles_missing_entries() -> None:
    assert parse_flat_playlist({}).entries == []


class FakeCompleted:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_run_ytdlp_uses_an_argument_list_and_parses_json(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["kwargs"] = kwargs
        return FakeCompleted(0, stdout=FIXTURE.read_text())

    monkeypatch.setattr(playlist.subprocess, "run", fake_run)
    data = run_ytdlp("PLtest1234567890", timeout_seconds=30)
    assert data["id"] == "PLtest1234567890abcdef"
    command = seen["command"]
    assert isinstance(command, list)
    assert command[-2:] == ["--", "https://www.youtube.com/playlist?list=PLtest1234567890"]
    assert "--flat-playlist" in command and "--ignore-config" in command
    assert "shell" not in seen["kwargs"]
    assert seen["kwargs"]["timeout"] == 30


def test_run_ytdlp_rejects_unsafe_ids_before_running(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(playlist.subprocess, "run", lambda *a, **k: pytest.fail("ran yt-dlp"))
    with pytest.raises(ValueError):
        run_ytdlp("--exec=rm -rf /", timeout_seconds=30)


@pytest.mark.parametrize(
    ("completed", "message"),
    [
        (FakeCompleted(1, stderr="ERROR: The playlist does not exist."), "exited with 1"),
        (FakeCompleted(0, stdout="not json"), "not JSON"),
        (FakeCompleted(0, stdout="[1, 2]"), "unexpected JSON"),
    ],
)
def test_run_ytdlp_failures(monkeypatch: pytest.MonkeyPatch, completed, message) -> None:
    monkeypatch.setattr(playlist.subprocess, "run", lambda *a, **k: completed)
    with pytest.raises(PlaylistError, match=message):
        run_ytdlp("PLtest1234567890", timeout_seconds=30)


def test_run_ytdlp_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="yt-dlp", timeout=30)

    monkeypatch.setattr(playlist.subprocess, "run", fake_run)
    with pytest.raises(PlaylistError, match="timed out"):
        run_ytdlp("PLtest1234567890", timeout_seconds=30)
