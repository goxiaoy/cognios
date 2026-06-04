"""Local OCR extractor — gating, output shape, confidence filtering.

The ``rapidocr-onnxruntime`` package is part of the optional ``image``
extra. Tests stub the import via ``sys.modules`` so they run without
installing rapidocr (CI default) AND verify the gating path that
returns a clean error when the extra is missing.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

import search_sidecar.extract.local_ocr as local_ocr_mod
from search_sidecar.extract.local_ocr import (
    RapidOcrExtractor,
    can_load_local_ocr,
)


def _png(tmp_path: Path, name: str = "shot.png") -> Path:
    p = tmp_path / name
    p.write_bytes(b"fakepngbytes")
    return p


def _install_fake_rapidocr(monkeypatch, fake_engine_factory):
    """Install a fake ``rapidocr_onnxruntime`` module with a ``RapidOCR``
    class produced by ``fake_engine_factory``."""
    fake_module = types.ModuleType("rapidocr_onnxruntime")
    fake_module.RapidOCR = fake_engine_factory  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "rapidocr_onnxruntime", fake_module)
    monkeypatch.setattr(local_ocr_mod, "can_load_local_ocr", lambda: True)


def test_can_load_local_ocr_returns_false_when_module_unimportable(monkeypatch):
    """When the rapidocr_onnxruntime spec isn't findable (broken
    venv, missing platform wheel), gating returns False —
    RapidOcrExtractor() should refuse to construct rather than
    surface a less obvious ImportError."""
    monkeypatch.setattr(local_ocr_mod, "can_load_local_ocr", lambda: False)
    with pytest.raises(RuntimeError, match="rapidocr-onnxruntime"):
        RapidOcrExtractor()


def test_extractor_returns_joined_text_above_confidence_threshold(
    monkeypatch, tmp_path
):
    img = _png(tmp_path)

    class FakeEngine:
        def __call__(self, _path):
            return (
                [
                    [None, "Hello", 0.95],
                    [None, "world", 0.80],
                ],
                0.01,
            )

    _install_fake_rapidocr(monkeypatch, lambda: FakeEngine())
    out = RapidOcrExtractor()(img)
    assert out == "Hello\nworld"


def test_extractor_constructs_engine_on_first_call(monkeypatch, tmp_path):
    img = _png(tmp_path)
    constructed = {"count": 0}

    class FakeEngine:
        def __call__(self, _path):
            return ([[None, "late", 0.95]], 0.01)

    def make_engine():
        constructed["count"] += 1
        return FakeEngine()

    _install_fake_rapidocr(monkeypatch, make_engine)
    extractor = RapidOcrExtractor()

    assert constructed["count"] == 0
    assert extractor(img) == "late"
    assert constructed["count"] == 1
    assert extractor(img) == "late"
    assert constructed["count"] == 1


def test_extractor_drops_low_confidence_lines(monkeypatch, tmp_path):
    img = _png(tmp_path)

    class FakeEngine:
        def __call__(self, _path):
            return (
                [
                    [None, "loud", 0.99],
                    [None, "garbled", 0.10],
                    [None, "clear", 0.85],
                ],
                0.01,
            )

    _install_fake_rapidocr(monkeypatch, lambda: FakeEngine())
    out = RapidOcrExtractor(min_confidence=0.5)(img)
    assert out == "loud\nclear"


def test_extractor_returns_empty_when_no_text_found(monkeypatch, tmp_path):
    img = _png(tmp_path)

    class FakeEngine:
        def __call__(self, _path):
            return (None, 0.01)

    _install_fake_rapidocr(monkeypatch, lambda: FakeEngine())
    assert RapidOcrExtractor()(img) == ""


def test_extractor_raises_runtime_error_when_engine_crashes(monkeypatch, tmp_path):
    img = _png(tmp_path)

    class FakeEngine:
        def __call__(self, _path):
            raise ValueError("model corrupt")

    _install_fake_rapidocr(monkeypatch, lambda: FakeEngine())
    with pytest.raises(RuntimeError, match="rapidocr raised"):
        RapidOcrExtractor()(img)


def test_extractor_raises_when_path_missing(monkeypatch, tmp_path):
    """File-system check happens BEFORE we hand the path to rapidocr —
    a missing file should fail loudly with a useful error."""

    class FakeEngine:
        def __call__(self, _path):  # pragma: no cover
            raise AssertionError("should not be called")

    _install_fake_rapidocr(monkeypatch, lambda: FakeEngine())
    with pytest.raises(RuntimeError, match="missing image"):
        RapidOcrExtractor()(tmp_path / "absent.png")
