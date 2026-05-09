"""Subprocess-backed PP-StructureV3 wrapper tests."""

from __future__ import annotations

import base64
import sys
from pathlib import Path

from search_sidecar.extract.local_advanced_ocr_subprocess import (
    SubprocessPpStructureV3Extractor,
    deserialize_extracted_markdown,
    serialize_extracted_markdown,
)
from search_sidecar.extract.types import ExtractedMarkdown


def test_serialize_deserialize_extracted_markdown_preserves_assets():
    raw = b"png bytes"
    encoded = serialize_extracted_markdown(
        ExtractedMarkdown("table markdown", {"imgs/crop.png": raw})
    )

    decoded = deserialize_extracted_markdown(encoded)

    assert decoded.text == "table markdown"
    assert decoded.images == {"imgs/crop.png": raw}


def test_subprocess_extractor_round_trips_worker_response(tmp_path: Path):
    source = tmp_path / "invoice.png"
    source.write_bytes(b"image")
    payload = {
        "text": "advanced child text",
        "images": [
            {
                "key": "imgs/crop.png",
                "png_base64": base64.b64encode(b"crop").decode("ascii"),
            }
        ],
    }
    code = f"""
import json, sys
json.loads(sys.stdin.readline())
print(json.dumps({{"ok": True}}), flush=True)
request = json.loads(sys.stdin.readline())
assert request["type"] == "extract"
print(json.dumps({{"ok": True, "result": {payload!r}}}), flush=True)
"""
    extractor = SubprocessPpStructureV3Extractor(
        {},
        command=[sys.executable, "-c", code],
    )

    try:
        result = extractor(source)
    finally:
        extractor.close()

    assert result == ExtractedMarkdown("advanced child text", {"imgs/crop.png": b"crop"})
