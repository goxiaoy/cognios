"""Lifecycle startup hooks."""

from __future__ import annotations

from pathlib import Path

from search_sidecar.index.dispatch import Dispatcher
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.index.queue import open_queue
from search_sidecar.lifecycle import (
    _run_advanced_ocr_backfill_on_boot,
    advanced_ocr_autorun_enabled,
)
from search_sidecar.storage import open_store

UUID_A = "11111111-1111-1111-1111-111111111111"


def _index_image(queue, node_id: str = UUID_A) -> None:
    queue.enqueue(node_id=node_id, kind="file", name="x.png")
    queue.claim_next()
    queue.mark_indexed(node_id)


def test_advanced_ocr_backfill_on_boot_flags_when_available(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    try:
        _index_image(queue)
        dispatcher = Dispatcher(
            store=store,
            embedder=StubEmbedder(),
            queue=queue,
            advanced_ocr_extract=lambda _p: "advanced",
        )
        _run_advanced_ocr_backfill_on_boot(queue, dispatcher)
        assert queue.claim_next_enhancement() is not None
    finally:
        queue.close()


def test_advanced_ocr_backfill_on_boot_skips_completed_images(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    try:
        _index_image(queue)
        queue.set_enhancement_pending(UUID_A)
        queue.clear_enhancement_pending(UUID_A)
        dispatcher = Dispatcher(
            store=store,
            embedder=StubEmbedder(),
            queue=queue,
            advanced_ocr_extract=lambda _p: "advanced",
        )
        _run_advanced_ocr_backfill_on_boot(queue, dispatcher)
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_advanced_ocr_backfill_on_boot_skips_when_autorun_disabled(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    try:
        _index_image(queue)
        dispatcher = Dispatcher(
            store=store,
            embedder=StubEmbedder(),
            queue=queue,
            advanced_ocr_extract=lambda _p: "advanced",
        )
        _run_advanced_ocr_backfill_on_boot(queue, dispatcher, enabled=False)
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_advanced_ocr_backfill_on_boot_skips_when_unavailable(tmp_path: Path):
    store = open_store(tmp_path / "index.lance")
    queue = open_queue(tmp_path / "queue.db")
    try:
        _index_image(queue)
        dispatcher = Dispatcher(store=store, embedder=StubEmbedder(), queue=queue)
        _run_advanced_ocr_backfill_on_boot(queue, dispatcher)
        assert queue.claim_next_enhancement() is None
    finally:
        queue.close()


def test_advanced_ocr_backfill_on_boot_logs_and_continues(caplog):
    class RaisingQueue:
        def backfill_enhancement_pending(self, _extensions):
            raise RuntimeError("db locked")

    class DispatcherWithAdvanced:
        class image_processor:
            @staticmethod
            def has_advanced_ocr() -> bool:
                return True

    _run_advanced_ocr_backfill_on_boot(RaisingQueue(), DispatcherWithAdvanced())
    assert "advanced-OCR boot backfill failed" in caplog.text


def test_advanced_ocr_autorun_env_defaults_enabled(monkeypatch):
    monkeypatch.delenv("COGNIOS_ADVANCED_OCR_AUTORUN", raising=False)
    assert advanced_ocr_autorun_enabled() is True


def test_advanced_ocr_autorun_env_accepts_false_values(monkeypatch):
    for value in ("0", "false", "no", "off"):
        monkeypatch.setenv("COGNIOS_ADVANCED_OCR_AUTORUN", value)
        assert advanced_ocr_autorun_enabled() is False
