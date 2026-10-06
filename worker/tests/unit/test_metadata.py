import pytest
import requests

from homebuilder_worker.metadata import OEMBED_URL, OEmbedClient


class FakeResponse:
    def __init__(self, status_code: int, body=None, bad_json: bool = False) -> None:
        self.status_code = status_code
        self._body = body
        self._bad_json = bad_json

    def json(self):
        if self._bad_json:
            raise ValueError("bad json")
        return self._body


class FakeSession:
    def __init__(self, response=None, error: Exception | None = None) -> None:
        self.response = response
        self.error = error
        self.calls: list = []

    def get(self, url, params, timeout):
        self.calls.append((url, params, timeout))
        if self.error:
            raise self.error
        return self.response


def test_ok_cleans_and_truncates() -> None:
    session = FakeSession(
        FakeResponse(200, {"title": "  Fix  a\nleak " + "x" * 600, "author_name": "Pro"})
    )
    meta = OEmbedClient(session).fetch("aaaaaaaaaaa")
    assert meta.status == "ok"
    assert (
        meta.title is not None and meta.title.startswith("Fix a leak x") and len(meta.title) == 500
    )
    assert meta.channel == "Pro"
    url, params, timeout = session.calls[0]
    assert url == OEMBED_URL
    assert params == {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "format": "json"}
    assert timeout == 10.0


@pytest.mark.parametrize("status", [401, 403, 404])
def test_unavailable(status: int) -> None:
    assert (
        OEmbedClient(FakeSession(FakeResponse(status))).fetch("aaaaaaaaaaa").status == "unavailable"
    )


@pytest.mark.parametrize(
    "session",
    [
        FakeSession(FakeResponse(500)),
        FakeSession(FakeResponse(429)),
        FakeSession(FakeResponse(200, bad_json=True)),
        FakeSession(FakeResponse(200, ["not", "a", "dict"])),
        FakeSession(FakeResponse(200, {"author_name": "no title"})),
        FakeSession(error=requests.ConnectionError("down")),
        FakeSession(error=requests.Timeout("slow")),
    ],
)
def test_transient_failures_stay_pending(session: FakeSession) -> None:
    assert OEmbedClient(session).fetch("aaaaaaaaaaa").status == "pending"
