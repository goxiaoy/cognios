"""Embedder factory routing tests.

The factory's job: hand back a ``StubEmbedder`` whenever a real
embedder cannot be loaded, with no fatal exceptions. These tests
exercise every fallback path (no optional extras, model not ready,
missing files, broken constructor) without depending on the actual
ONNX model file.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest import mock

import pytest

from search_sidecar.embeddings.factory import (
    can_load_real_embedder,
    select_embedder,
)
from search_sidecar.index.embedder import StubEmbedder
from search_sidecar.models.manager import ModelManager
from search_sidecar.models.manifest import FileSpec, ModelSpec


@pytest.fixture
def manager(tmp_path: Path) -> ModelManager:
    """A ModelManager rooted at a fresh tmp dir with one synthetic
    embedding role. Tests activate (or don't) the role to exercise
    the factory's branches."""
    spec = ModelSpec(
        role="embedding",
        repo="onnx-community/gte-multilingual-base",
        commit="testcommit",
        files=(
            FileSpec("onnx/model_int8.onnx", "0" * 64),
            FileSpec("tokenizer.json", "0" * 64),
            FileSpec("config.json", "0" * 64),
            FileSpec("tokenizer_config.json", "0" * 64),
        ),
    )
    return ModelManager(
        storage_dir=tmp_path,
        manifest={"embedding": spec},
    )


def _activate_role(manager: ModelManager, role: str = "embedding") -> Path:
    """Pretend the role finished downloading: create the commit dir +
    files and the ``current`` symlink ``ModelManager`` checks for."""
    spec = manager.manifest[role]
    commit_dir = manager.commit_dir(role, spec.commit)
    commit_dir.mkdir(parents=True, exist_ok=True)
    for f in spec.files:
        target = commit_dir / f.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"")
    # ``ModelManager._activate`` writes a relative symlink; mirror that.
    link = manager.role_dir(role) / "current"
    if link.exists() or link.is_symlink():
        link.unlink()
    os.symlink(spec.commit, link)
    return commit_dir


def test_falls_back_to_stub_when_model_manager_is_none():
    embedder = select_embedder(model_manager=None)
    assert isinstance(embedder, StubEmbedder)
    assert embedder.is_semantic is False


def test_falls_back_to_stub_when_role_is_not_ready(manager: ModelManager):
    embedder = select_embedder(model_manager=manager)
    assert isinstance(embedder, StubEmbedder)


def test_falls_back_to_stub_when_extra_not_installed(manager: ModelManager):
    """Even with the role activated, if optimum/transformers are not
    importable the factory must use the stub. We simulate that with a
    monkeypatch on ``can_load_real_embedder``."""
    _activate_role(manager)
    with mock.patch(
        "search_sidecar.embeddings.factory.can_load_real_embedder",
        return_value=False,
    ):
        embedder = select_embedder(model_manager=manager)
    assert isinstance(embedder, StubEmbedder)


def test_falls_back_to_stub_when_gte_init_raises(manager: ModelManager):
    """When the extra is present but loading the real model crashes
    (corrupt files, version mismatch, etc.) the factory logs and
    falls back rather than killing search."""
    _activate_role(manager)
    with mock.patch(
        "search_sidecar.embeddings.factory.can_load_real_embedder",
        return_value=True,
    ), mock.patch(
        "search_sidecar.embeddings.factory.GteEmbedder",
        side_effect=RuntimeError("bad onnx file"),
    ):
        embedder = select_embedder(model_manager=manager)
    assert isinstance(embedder, StubEmbedder)


def test_returns_real_embedder_when_extra_present_and_role_ready(
    manager: ModelManager,
):
    """Happy path: extra installed + role ready → real embedder."""
    _activate_role(manager)
    fake = mock.Mock()
    fake.is_semantic = True

    def fake_ctor(config):
        # Sanity-check that the factory passes the activated commit
        # dir, not the role dir or some symlink artefact.
        assert config.model_dir.name == "testcommit"
        return fake

    with mock.patch(
        "search_sidecar.embeddings.factory.can_load_real_embedder",
        return_value=True,
    ), mock.patch(
        "search_sidecar.embeddings.factory.GteEmbedder", side_effect=fake_ctor
    ):
        embedder = select_embedder(model_manager=manager)
    assert embedder is fake


def test_can_load_real_embedder_reflects_actual_environment():
    """``can_load_real_embedder`` is just a thin importlib check;
    we assert that result matches whatever the test environment has."""
    import importlib.util

    expected = (
        importlib.util.find_spec("optimum") is not None
        and importlib.util.find_spec("transformers") is not None
    )
    assert can_load_real_embedder() == expected
