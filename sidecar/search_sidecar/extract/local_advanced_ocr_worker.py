"""Line-delimited JSON worker for local PP-StructureV3 OCR."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .local_advanced_ocr import PpStructureV3Extractor
from .local_advanced_ocr_subprocess import serialize_extracted_markdown

_PROTOCOL_OUT = sys.stdout
# Paddle/PaddleOCR may print progress or warnings to stdout. Keep the
# parent/child protocol on the original stdout pipe and redirect all
# library stdout noise to stderr so it cannot corrupt JSON responses.
sys.stdout = sys.stderr


def main() -> int:
    extractor: PpStructureV3Extractor | None = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise RuntimeError("request must be a JSON object")
            request_type = request.get("type")
            if request_type == "init":
                extractor = _init_extractor(request)
                _write_response({"ok": True})
            elif request_type == "extract":
                if extractor is None:
                    raise RuntimeError("worker not initialised")
                path = request.get("path")
                if not isinstance(path, str):
                    raise RuntimeError("extract request missing path")
                result = extractor(Path(path))
                _write_response(
                    {"ok": True, "result": serialize_extracted_markdown(result)}
                )
            elif request_type == "shutdown":
                _write_response({"ok": True})
                return 0
            else:
                raise RuntimeError(f"unknown request type {request_type!r}")
        except Exception as err:
            _write_response({"ok": False, "error": f"{type(err).__name__}: {err}"})
    return 0


def _init_extractor(request: dict[str, Any]) -> PpStructureV3Extractor:
    raw_dirs = request.get("model_dirs")
    raw_names = request.get("model_names")
    if not isinstance(raw_dirs, dict):
        raise RuntimeError("init request missing model_dirs")
    model_dirs = {
        str(key): Path(value)
        for key, value in raw_dirs.items()
        if isinstance(value, str)
    }
    model_names = (
        {str(key): value for key, value in raw_names.items() if isinstance(value, str)}
        if isinstance(raw_names, dict)
        else {}
    )
    return PpStructureV3Extractor(model_dirs, model_names)


def _write_response(payload: dict[str, Any]) -> None:
    _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


if __name__ == "__main__":
    raise SystemExit(main())
