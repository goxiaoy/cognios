"""Subprocess wrapper for local PP-StructureV3 extraction.

PaddleOCR's native stack can hold the GIL for long stretches during
pipeline init/inference and can also crash the interpreter on native
faults. Running it in a child process keeps the sidecar HTTP control
plane responsive while enhancement work is active.
"""

from __future__ import annotations

import base64
import json
import logging
import subprocess
import sys
import threading
from io import BytesIO
from pathlib import Path
from typing import Any, Iterable, Mapping

from .types import ExtractedMarkdown

LOG = logging.getLogger("search_sidecar.extract.local_advanced_ocr_subprocess")


class SubprocessPpStructureV3Extractor:
    """Callable advanced-OCR extractor backed by a child Python process."""

    supports_pdf = True

    def __init__(
        self,
        model_dir_by_stage: Mapping[str, Path],
        model_name_by_stage: Mapping[str, str] | None = None,
        *,
        command: Iterable[str] | None = None,
    ) -> None:
        self._model_dir_by_stage = {
            key: str(value) for key, value in model_dir_by_stage.items()
        }
        self._model_name_by_stage = dict(model_name_by_stage or {})
        self._command = list(command) if command is not None else _worker_command()
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()

    def __call__(self, path: Path) -> ExtractedMarkdown:
        if not path.is_file():
            raise RuntimeError(f"local-advanced-ocr: missing document {path}")
        with self._lock:
            process = self._ensure_process()
            try:
                _write_request(process, {"type": "extract", "path": str(path)})
                response = _read_response(process)
            except Exception:
                if self._process is process:
                    self._process = None
                _terminate_process(process)
                raise
        if response.get("ok") is not True:
            raise RuntimeError(str(response.get("error") or "advanced OCR worker failed"))
        return deserialize_extracted_markdown(response.get("result"))

    def close(self) -> None:
        process = self._process
        self._process = None
        _terminate_process(process)

    def _ensure_process(self) -> subprocess.Popen[str]:
        process = self._process
        if process is not None and process.poll() is None:
            return process
        if process is not None:
            LOG.warning(
                "advanced OCR worker exited with code %s; restarting",
                process.returncode,
            )
        process = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._process = process
        _write_request(
            process,
            {
                "type": "init",
                "model_dirs": self._model_dir_by_stage,
                "model_names": self._model_name_by_stage,
            },
        )
        response = _read_response(process)
        if response.get("ok") is not True:
            self._process = None
            _terminate_process(process)
            raise RuntimeError(
                str(response.get("error") or "advanced OCR worker init failed")
            )
        return process


def _terminate_process(process: subprocess.Popen[str] | None) -> None:
    if process is None:
        return
    try:
        if process.stdin is not None:
            _write_request(process, {"type": "shutdown"})
    except Exception:
        pass
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1.0)


def serialize_extracted_markdown(output: str | ExtractedMarkdown) -> dict[str, Any]:
    if isinstance(output, ExtractedMarkdown):
        text = output.text
        images = output.images
    else:
        text = str(output)
        images = {}
    serialised_images: list[dict[str, str]] = []
    for key, value in images.items():
        try:
            serialised_images.append(
                {"key": str(key), "png_base64": _asset_to_base64(value)}
            )
        except Exception as err:
            LOG.warning("failed to serialise OCR asset %s: %s", key, err)
    return {"text": text, "images": serialised_images}


def deserialize_extracted_markdown(raw: Any) -> ExtractedMarkdown:
    if not isinstance(raw, dict):
        return ExtractedMarkdown("")
    text = raw.get("text")
    images: dict[str, bytes] = {}
    raw_images = raw.get("images")
    if isinstance(raw_images, list):
        for item in raw_images:
            if not isinstance(item, dict):
                continue
            key = item.get("key")
            encoded = item.get("png_base64")
            if not isinstance(key, str) or not isinstance(encoded, str):
                continue
            try:
                images[key] = base64.b64decode(encoded)
            except ValueError:
                continue
    return ExtractedMarkdown(text if isinstance(text, str) else "", images)


def _worker_command() -> list[str]:
    return [
        sys.executable,
        "-m",
        "search_sidecar.extract.local_advanced_ocr_worker",
    ]


def _write_request(process: subprocess.Popen[str], payload: Mapping[str, Any]) -> None:
    if process.stdin is None:
        raise RuntimeError("advanced OCR worker stdin is closed")
    process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
    process.stdin.flush()


def _read_response(process: subprocess.Popen[str]) -> dict[str, Any]:
    if process.stdout is None:
        raise RuntimeError("advanced OCR worker stdout is closed")
    line = process.stdout.readline()
    if not line:
        code = process.poll()
        raise RuntimeError(f"advanced OCR worker exited before response (code={code})")
    try:
        response = json.loads(line)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"advanced OCR worker returned invalid JSON: {err}") from err
    if not isinstance(response, dict):
        raise RuntimeError("advanced OCR worker returned non-object response")
    return response


def _asset_to_base64(value: Any) -> str:
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    save = getattr(value, "save", None)
    if not callable(save):
        raise TypeError(f"unsupported OCR asset value {type(value)!r}")
    buf = BytesIO()
    save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")
