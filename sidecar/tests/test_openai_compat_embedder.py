"""Cloud embedder tests using ``httpx.MockTransport``.

No network. No respx. The Embedder is sync; ``MockTransport`` lets
us hand a ``Client`` with a deterministic in-process responder so
every behavior — happy path, dimension mismatch, 401, 429, malformed
JSON — is exercised against real httpx machinery.
"""

from __future__ import annotations

import json
from typing import Callable

import httpx
import pytest

from search_sidecar.embeddings.openai_compat import OpenAICompatEmbedder
from search_sidecar.storage import EMBEDDING_DIMENSION


def _client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _ok_embeddings(vectors: list[list[float]]) -> httpx.Response:
    body = {"data": [{"embedding": vec} for vec in vectors], "model": "x"}
    return httpx.Response(200, json=body)


def _make_embedder(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    api_key_provider: Callable[[], str] = lambda: "sk-test",
    model: str = "text-embedding-3-small",
    dimensions: int = EMBEDDING_DIMENSION,
) -> OpenAICompatEmbedder:
    return OpenAICompatEmbedder(
        base_url="https://api.openai.com/v1",
        model=model,
        api_key_provider=api_key_provider,
        provider_label="test-provider",
        dimensions=dimensions,
        client=_client(handler),
    )


def test_embed_empty_input_returns_empty_no_http_call():
    """No network round-trip for empty batches — matches StubEmbedder semantics."""

    def boom(_req):
        raise AssertionError("HTTP must not be called for empty input")

    embedder = _make_embedder(boom)
    assert embedder.embed([]) == []


def test_embed_happy_path_returns_vectors():
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["body"] = json.loads(req.content)
        captured["auth"] = req.headers.get("Authorization")
        return _ok_embeddings(
            [[0.1] * EMBEDDING_DIMENSION, [0.2] * EMBEDDING_DIMENSION]
        )

    embedder = _make_embedder(handler)
    out = embedder.embed(["hello", "world"])

    assert len(out) == 2
    assert all(len(v) == EMBEDDING_DIMENSION for v in out)
    # Request shape: model + input list + dimensions=768.
    assert captured["url"] == "https://api.openai.com/v1/embeddings"
    assert captured["body"]["model"] == "text-embedding-3-small"
    assert captured["body"]["input"] == ["hello", "world"]
    assert captured["body"]["dimensions"] == EMBEDDING_DIMENSION
    assert captured["auth"] == "Bearer sk-test"


def test_embed_passes_dimensions_param_to_force_768():
    """The whole point of using text-embedding-3-small with the
    dimensions parameter is to coerce the natively-1536-dim model
    into 768-dim Matryoshka output that fits the lancedb schema."""
    seen_body: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen_body.update(json.loads(req.content))
        return _ok_embeddings([[0.0] * EMBEDDING_DIMENSION])

    _make_embedder(handler).embed(["x"])
    assert seen_body["dimensions"] == EMBEDDING_DIMENSION


def test_embed_lazy_api_key_resolution_per_call():
    """``api_key_provider`` is called fresh on every embed() so a key
    rotation between sidecar boot and the next call is picked up
    without restart."""
    call_count = {"n": 0}

    def provider() -> str:
        call_count["n"] += 1
        return f"sk-rotation-{call_count['n']}"

    keys: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        keys.append(req.headers["Authorization"])
        return _ok_embeddings([[0.0] * EMBEDDING_DIMENSION])

    embedder = _make_embedder(handler, api_key_provider=provider)
    embedder.embed(["a"])
    embedder.embed(["b"])
    embedder.embed(["c"])
    assert call_count["n"] == 3
    assert keys == [
        "Bearer sk-rotation-1",
        "Bearer sk-rotation-2",
        "Bearer sk-rotation-3",
    ]


def test_embed_raises_on_wrong_dimension_response():
    """The most important error path: provider returned 1536-dim
    instead of the requested 768. Hard error — silently storing
    wrong-dim vectors would corrupt search."""

    def handler(req: httpx.Request) -> httpx.Response:
        return _ok_embeddings([[0.1] * 1536])  # wrong dim

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="length 1536, expected 768"):
        embedder.embed(["x"])


def test_embed_raises_on_count_mismatch():
    """Provider returned fewer vectors than inputs — reject loudly
    rather than silently truncate the batch."""

    def handler(req: httpx.Request) -> httpx.Response:
        return _ok_embeddings([[0.1] * EMBEDDING_DIMENSION])  # 1, expected 2

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="had 1 vectors, expected 2"):
        embedder.embed(["a", "b"])


def test_embed_surfaces_401_with_clear_message():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "Invalid key"}})

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="401"):
        embedder.embed(["x"])


def test_embed_surfaces_429_with_clear_message():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="429"):
        embedder.embed(["x"])


def test_embed_surfaces_5xx_with_response_excerpt():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal server error blob")

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="500"):
        embedder.embed(["x"])


def test_embed_raises_when_response_missing_data_array():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"not_data": []})

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="missing 'data' array"):
        embedder.embed(["x"])


def test_embed_raises_when_response_is_not_object():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["array", "not", "object"])

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="not a JSON object"):
        embedder.embed(["x"])


def test_embed_raises_when_embedding_field_missing():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"not_embedding": []}]})

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="embedding"):
        embedder.embed(["x"])


def test_embed_raises_when_api_key_provider_fails():
    def boom() -> str:
        raise RuntimeError("secret store unreachable")

    embedder = _make_embedder(
        lambda req: _ok_embeddings([[0.0] * EMBEDDING_DIMENSION]),
        api_key_provider=boom,
    )
    with pytest.raises(RuntimeError, match="secret store unreachable"):
        embedder.embed(["x"])


def test_embed_handles_network_error_gracefully():
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated connection error")

    embedder = _make_embedder(handler)
    with pytest.raises(RuntimeError, match="HTTP error"):
        embedder.embed(["x"])


def test_dimension_property_exposes_configured_value():
    embedder = _make_embedder(lambda r: httpx.Response(500))
    assert embedder.dimension == EMBEDDING_DIMENSION


def test_is_semantic_returns_true():
    """Cloud embedders always produce real semantic vectors —
    orchestrator routes to hybrid retrieval for them."""
    embedder = _make_embedder(lambda r: httpx.Response(500))
    assert embedder.is_semantic is True


def test_base_url_trailing_slash_is_stripped():
    """``base_url`` from preset may or may not have a trailing slash;
    embedder must produce a clean URL either way."""
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        return _ok_embeddings([[0.0] * EMBEDDING_DIMENSION])

    embedder = OpenAICompatEmbedder(
        base_url="https://api.openai.com/v1/",  # trailing slash
        model="text-embedding-3-small",
        api_key_provider=lambda: "sk",
        client=_client(handler),
    )
    embedder.embed(["x"])
    # No double slash.
    assert captured["url"] == "https://api.openai.com/v1/embeddings"
