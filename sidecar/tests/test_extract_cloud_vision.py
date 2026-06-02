"""OpenAI-compatible vision client — request shape, response parsing,
error mapping."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest

from search_sidecar.extract.cloud_vision import (
    MAX_IMAGE_BYTES,
    OpenAICompatVisionClient,
    _extract_message_text,
    _read_as_data_url,
)


def _png(tmp_path: Path, name: str = "x.png", content: bytes = b"fakepngbytes") -> Path:
    p = tmp_path / name
    p.write_bytes(content)
    return p


def _client(handler) -> OpenAICompatVisionClient:
    """Build a client with a fake httpx transport so requests don't hit
    the network — the handler receives the request and returns a Response."""
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)
    return OpenAICompatVisionClient(
        base_url="https://api.example.com/v1",
        model="vision-test",
        api_key_provider=lambda: "sk-test",
        provider_label="testcloud",
        client=http_client,
    )


# ---- request shape ----------------------------------------------------------


def test_extract_ocr_posts_chat_completions_with_image_and_ocr_prompt(tmp_path):
    img = _png(tmp_path)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "hello world"}}]},
        )

    client = _client(handler)
    out = client.extract_ocr(img)
    assert out == "hello world"
    assert captured["url"] == "https://api.example.com/v1/chat/completions"
    assert captured["headers"]["authorization"] == "Bearer sk-test"
    body = captured["body"]
    assert body["model"] == "vision-test"
    # Two-part content: text prompt + image_url with data URL.
    parts = body["messages"][0]["content"]
    assert len(parts) == 2
    assert parts[0]["type"] == "text"
    assert "extract" in parts[0]["text"].lower()
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
    # max_tokens for OCR is more generous than for captions.
    assert body["max_tokens"] >= 1000


def test_generate_caption_uses_caption_prompt_and_lower_max_tokens(tmp_path):
    img = _png(tmp_path)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "A red cat."}}]}
        )

    client = _client(handler)
    out = client.generate_caption(img)
    assert out == "A red cat."
    body = captured["body"]
    text_prompt = body["messages"][0]["content"][0]["text"].lower()
    assert "describ" in text_prompt or "caption" in text_prompt or "scene" in text_prompt
    assert body["max_tokens"] <= 500  # captions short on purpose


# ---- response parsing -------------------------------------------------------


def test_extract_message_text_handles_string_content():
    payload = {"choices": [{"message": {"content": "  hi  "}}]}
    assert _extract_message_text(payload, provider_label="t") == "hi"


def test_extract_message_text_handles_list_of_text_parts():
    """OpenAI sometimes returns content as typed parts; concat the text ones."""
    payload = {
        "choices": [
            {
                "message": {
                    "content": [
                        {"type": "text", "text": "line one"},
                        {"type": "text", "text": "line two"},
                    ]
                }
            }
        ]
    }
    assert _extract_message_text(payload, provider_label="t") == "line one\nline two"


def test_extract_message_text_returns_empty_on_unexpected_shape():
    """Resilient to provider quirks — empty string, not crash."""
    assert _extract_message_text({}, provider_label="t") == ""
    assert _extract_message_text({"choices": []}, provider_label="t") == ""
    assert _extract_message_text(
        {"choices": [{"message": {"content": None}}]}, provider_label="t"
    ) == ""


# ---- error mapping ----------------------------------------------------------


def test_401_response_raises_with_actionable_message(tmp_path):
    img = _png(tmp_path)

    def handler(_request):
        return httpx.Response(401, json={"error": "bad key"})

    client = _client(handler)
    with pytest.raises(RuntimeError, match="401"):
        client.extract_ocr(img)


def test_429_response_raises_rate_limit_message(tmp_path):
    img = _png(tmp_path)

    def handler(_request):
        return httpx.Response(429, json={"error": "slow down"})

    client = _client(handler)
    with pytest.raises(RuntimeError, match="429"):
        client.extract_ocr(img)


def test_5xx_response_raises_with_status_in_message(tmp_path):
    img = _png(tmp_path)

    def handler(_request):
        return httpx.Response(503, text="upstream down")

    client = _client(handler)
    with pytest.raises(RuntimeError, match="503"):
        client.extract_ocr(img)


def test_api_key_provider_failure_raises_clean_error(tmp_path):
    img = _png(tmp_path)

    def handler(_request):  # pragma: no cover — never reached
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)
    client = OpenAICompatVisionClient(
        base_url="https://api.example.com/v1",
        model="m",
        api_key_provider=lambda: (_ for _ in ()).throw(
            RuntimeError("secret store dead")
        ),
        provider_label="testcloud",
        client=httpx.Client(transport=transport),
    )
    with pytest.raises(RuntimeError, match="secret store dead"):
        client.extract_ocr(img)


# ---- size guard -------------------------------------------------------------


def test_oversize_image_refuses_locally(tmp_path):
    """Files past MAX_IMAGE_BYTES never reach the network."""
    big = _png(tmp_path, content=b"x" * (MAX_IMAGE_BYTES + 1))
    with pytest.raises(RuntimeError, match="too large"):
        _read_as_data_url(big)


def test_data_url_carries_correct_mime_for_jpeg(tmp_path):
    img = _png(tmp_path, name="photo.jpg", content=b"jpegbytes")
    url = _read_as_data_url(img)
    assert url.startswith("data:image/jpeg;base64,")
    encoded = url.split(",", 1)[1]
    assert base64.b64decode(encoded) == b"jpegbytes"
