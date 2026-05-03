"""Cloud vision client — OpenAI-compatible chat-completions backed
OCR + captioning.

Posts to ``{base_url}/chat/completions`` with a single
``user`` message holding two content parts: a text prompt and an
``image_url`` part containing the image bytes as a base64 data URL.
The same shape works against OpenAI proper and Qwen DashScope's
OpenAI-compatible endpoint, so one client serves both providers.

Two roles, two prompts. OCR asks the model to transcribe text only;
captioning asks for a one-or-two-sentence description. The methods
are sync (``httpx.Client``) because the indexing runner already runs
on a worker thread.

Hard ceilings — chosen to fail fast rather than hand a 50-MB image
to a remote endpoint that will charge for it and refuse anyway:

- ``MAX_IMAGE_BYTES = 20 MiB`` matches OpenAI's vision input cap.
- OCR caps response tokens at 4096 (longer text payloads); captions
  cap at 300 (one-or-two-sentence prose).
"""

from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any, Callable

import httpx

LOG = logging.getLogger("search_sidecar.extract.cloud_vision")

# 20 MiB — refuses to upload anything past this. Cloud providers reject
# larger payloads anyway; bail locally so we don't waste a round-trip
# (and so the user sees a clear error in the queue, not a generic 4xx).
MAX_IMAGE_BYTES = 20 * 1024 * 1024

# Generous read timeout — vision calls are slower than embeddings.
_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=180.0, write=60.0, pool=30.0)

# Lower-case suffix → IANA MIME type. Keep the table tiny — anything
# missing falls back to ``image/png`` which works for most providers
# (they peek the magic bytes anyway). The set must stay aligned with
# :data:`ImageProcessor.SUPPORTED_EXTENSIONS`.
_MIME_BY_SUFFIX: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".gif": "image/gif",
}

_OCR_PROMPT = (
    "Extract ALL visible text from this image. Output only the text, "
    "preserving line breaks where natural. Do not describe the image, "
    "do not add commentary, do not add a heading. If the image has no "
    "text, output an empty response."
)

_CAPTION_PROMPT = (
    "Describe this image in one or two short sentences for a search "
    "index. Mention the key objects, scene type, and any notable "
    "visible text. Be specific and concrete; no preamble like "
    '"This image shows".'
)


class OpenAICompatVisionClient:
    """OCR + captioning over an OpenAI-compatible vision endpoint.

    Constructed by :func:`select_ocr_extractor` / :func:`select_caption_extractor`
    when settings binds ``image-ocr`` or ``image-captioning`` to a
    cloud provider.
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key_provider: Callable[[], str],
        provider_label: str = "openai-compat",
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key_provider = api_key_provider
        self._provider_label = provider_label
        self._client = client or httpx.Client(timeout=_DEFAULT_TIMEOUT)

    def extract_ocr(self, path: Path) -> str:
        """Return all visible text in ``path`` as a single string."""
        return self._chat_with_image(
            path, prompt=_OCR_PROMPT, max_tokens=4096
        )

    def generate_caption(self, path: Path) -> str:
        """Return a one-or-two-sentence description of ``path``."""
        return self._chat_with_image(
            path, prompt=_CAPTION_PROMPT, max_tokens=300
        )

    def close(self) -> None:
        """Release the HTTP connection pool. Idempotent."""
        self._client.close()

    # ----- internals --------------------------------------------------------

    def _chat_with_image(
        self, path: Path, *, prompt: str, max_tokens: int
    ) -> str:
        data_url = _read_as_data_url(path)
        try:
            api_key = self._api_key_provider()
        except Exception as err:
            raise RuntimeError(
                f"{self._provider_label} vision: failed to read API key — {err}"
            ) from err
        url = f"{self._base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": self._model,
            "max_tokens": max_tokens,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        },
                    ],
                }
            ],
        }
        try:
            resp = self._client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        except httpx.HTTPError as err:
            raise RuntimeError(
                f"{self._provider_label} vision: HTTP error against {url}: {err}"
            ) from err
        if resp.status_code == 401:
            raise RuntimeError(
                f"{self._provider_label} vision: 401 from {url} — "
                "API key invalid or revoked. Update it in Settings."
            )
        if resp.status_code == 429:
            raise RuntimeError(
                f"{self._provider_label} vision: 429 rate-limited at {url}."
            )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"{self._provider_label} vision: HTTP {resp.status_code} "
                f"from {url}: {resp.text[:200]}"
            )
        return _extract_message_text(
            resp.json(), provider_label=self._provider_label
        )


def _read_as_data_url(path: Path) -> str:
    """Read ``path`` and return a base64 data URL.

    Refuses to read files past :data:`MAX_IMAGE_BYTES` so we don't
    blow out memory on something that's going to be rejected anyway.
    """
    size = path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        raise RuntimeError(
            f"image too large for cloud vision: {size} bytes "
            f"(limit {MAX_IMAGE_BYTES})"
        )
    suffix = path.suffix.lower()
    mime = _MIME_BY_SUFFIX.get(suffix, "image/png")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _extract_message_text(payload: Any, *, provider_label: str) -> str:
    """Pull the first assistant message text out of an OpenAI-style
    chat-completions response.

    Returns an empty string if the response shape is unexpected — the
    caller (ImageProcessor via ``_safe_extract``) treats empty as
    "extractor produced nothing", which is the right downgrade for
    a model that responded with an empty caption.
    """
    if not isinstance(payload, dict):
        LOG.warning("%s vision: response is not a JSON object", provider_label)
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        LOG.warning("%s vision: response missing 'choices' array", provider_label)
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    # OpenAI sometimes returns content as a list of typed parts;
    # concatenate the text-typed parts.
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts).strip()
    return ""
