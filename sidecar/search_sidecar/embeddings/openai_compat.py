"""OpenAI-compatible cloud embedder.

Implements the :class:`Embedder` Protocol from
:mod:`..index.embedder` so the existing dispatcher / runner / lancedb
write paths don't need to change. The cloud runtime contract is:

- One ``POST {base_url}/embeddings`` per ``embed()`` call (one HTTP
  request per batch — providers handle batching internally).
- Request body: ``{"model": "<name>", "input": [...], "dimensions": 768}``.
  The ``dimensions`` parameter is OpenAI's Matryoshka reduction; with
  ``text-embedding-3-small`` this returns properly-normalized 768-dim
  vectors directly, matching the locked lancedb schema dimension.
- Response shape (OpenAI-compatible): ``{"data": [{"embedding": [...]}, ...]}``.
- API key is read lazily per ``embed()`` call from the injected
  ``api_key_provider`` callable, which resolves ``~/.cogios/.env``.
  Lazy resolution means a key rotation between sidecar boot and first
  embed picks up the new key without restart.
- Sync ``httpx.Client``; the indexing runner already runs on a worker
  thread, and lancedb downstream is sync, so async would buy nothing.
- Hard validation on response: vector count matches input batch size,
  every vector is exactly 768 floats. A wrong-shape response raises
  loudly — silent storage of incompatible-dim vectors would corrupt
  the search index (the brainstorm + plan reviews flagged this as
  the #1 mixed-provider risk).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Iterable

import httpx

from ..index.embedder import Embedder
from ..storage import EMBEDDING_DIMENSION

LOG = logging.getLogger("search_sidecar.embeddings.openai_compat")

# Generous outbound timeouts — embedding requests can be slow on
# cold caches or large batches. The runner is on a worker thread so
# blocking is fine.
_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=30.0)


class OpenAICompatEmbedder:
    """Cloud embedder hitting an OpenAI-compatible ``/embeddings`` endpoint.

    Implements :class:`Embedder` Protocol. Constructed by the embedder
    factory when settings.json binds ``semantic-search`` to a cloud
    provider (currently only ``openai`` in v1; Qwen/DeepSeek embedding
    are out of v1 scope per the brainstorm).
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key_provider: Callable[[], str],
        provider_label: str = "openai-compat",
        dimensions: int = EMBEDDING_DIMENSION,
        client: httpx.Client | None = None,
    ) -> None:
        # Store base_url with no trailing slash so we can ``f"{base}/embeddings"``
        # uniformly without double-slash bugs.
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key_provider = api_key_provider
        self._provider_label = provider_label
        self._dimensions = dimensions
        # Inject for tests; production passes None and we own the client.
        self._client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)

    @property
    def dimension(self) -> int:
        return self._dimensions

    @property
    def is_semantic(self) -> bool:
        """Cloud embedders always produce real semantic vectors."""
        return True

    def embed(self, texts: Iterable[str]) -> list[list[float]]:
        """Send one batched request, validate, return vectors.

        Empty input short-circuits without an HTTP call (matches the
        sentinel behavior of the existing :class:`StubEmbedder`).
        """
        items = list(texts)
        if not items:
            return []
        try:
            api_key = self._api_key_provider()
        except Exception as err:
            raise RuntimeError(
                f"{self._provider_label} embedder: failed to read API key — {err}"
            ) from err
        url = f"{self._base_url}/embeddings"
        payload: dict[str, Any] = {
            "model": self._model,
            "input": items,
            "dimensions": self._dimensions,
        }
        try:
            resp = self._client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        except httpx.HTTPError as err:
            raise RuntimeError(
                f"{self._provider_label} embedder: HTTP error against {url}: {err}"
            ) from err
        if resp.status_code == 401:
            raise RuntimeError(
                f"{self._provider_label} embedder: 401 from {url} — "
                "API key invalid or revoked. Update it in Settings."
            )
        if resp.status_code == 429:
            raise RuntimeError(
                f"{self._provider_label} embedder: 429 rate-limited at {url}. "
                "Reduce indexing throughput or upgrade your account."
            )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"{self._provider_label} embedder: HTTP {resp.status_code} "
                f"from {url}: {resp.text[:200]}"
            )
        return self._parse_and_validate(resp.json(), expected_count=len(items))

    def close(self) -> None:
        """Release the HTTP connection pool. Idempotent."""
        self._client.close()

    # ----- internals --------------------------------------------------------

    def _parse_and_validate(
        self, payload: Any, *, expected_count: int
    ) -> list[list[float]]:
        if not isinstance(payload, dict):
            raise RuntimeError(
                f"{self._provider_label} embedder: response is not a JSON object"
            )
        data = payload.get("data")
        if not isinstance(data, list):
            raise RuntimeError(
                f"{self._provider_label} embedder: response missing 'data' array"
            )
        if len(data) != expected_count:
            raise RuntimeError(
                f"{self._provider_label} embedder: response had "
                f"{len(data)} vectors, expected {expected_count}"
            )
        out: list[list[float]] = []
        for idx, entry in enumerate(data):
            if not isinstance(entry, dict):
                raise RuntimeError(
                    f"{self._provider_label} embedder: data[{idx}] is not an object"
                )
            vec = entry.get("embedding")
            if not isinstance(vec, list):
                raise RuntimeError(
                    f"{self._provider_label} embedder: data[{idx}].embedding "
                    "is not a list"
                )
            if len(vec) != self._dimensions:
                raise RuntimeError(
                    f"{self._provider_label} embedder: data[{idx}].embedding "
                    f"has length {len(vec)}, expected {self._dimensions}. "
                    "Provider ignored the `dimensions` parameter — refusing "
                    "to store wrong-dim vectors that would corrupt search."
                )
            # httpx returns floats already; coerce defensively in case a
            # provider sends ints or strings.
            try:
                out.append([float(x) for x in vec])
            except (TypeError, ValueError) as err:
                raise RuntimeError(
                    f"{self._provider_label} embedder: data[{idx}].embedding "
                    f"contained non-numeric values: {err}"
                ) from err
        return out
