"""Reranker factory routing — parallel to test_embeddings_factory.py."""

from __future__ import annotations

import os
from pathlib import Path
from unittest import mock

import pytest

from search_sidecar.models.manager import ModelManager
from search_sidecar.models.manifest import FileSpec, ModelSpec
from search_sidecar.rerank.factory import select_reranker


@pytest.fixture
def manager(tmp_path: Path) -> ModelManager:
    spec = ModelSpec(
        role="reranker",
        repo="onnx-community/gte-multilingual-reranker-base",
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
        manifest={"reranker": spec},
    )


def _activate_role(manager: ModelManager, role: str = "reranker") -> Path:
    spec = manager.manifest[role]
    commit_dir = manager.commit_dir(role, spec.commit)
    commit_dir.mkdir(parents=True, exist_ok=True)
    for f in spec.files:
        target = commit_dir / f.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"")
    link = manager.role_dir(role) / "current"
    if link.exists() or link.is_symlink():
        link.unlink()
    os.symlink(spec.commit, link)
    return commit_dir


def test_returns_none_when_model_manager_is_none():
    assert select_reranker(model_manager=None) is None


def test_returns_none_when_role_is_not_ready(manager: ModelManager):
    assert select_reranker(model_manager=manager) is None


def test_returns_none_when_extra_not_installed(manager: ModelManager):
    _activate_role(manager)
    with mock.patch(
        "search_sidecar.rerank.factory.can_load_real_embedder",
        return_value=False,
    ):
        assert select_reranker(model_manager=manager) is None


def test_returns_none_when_construction_raises(manager: ModelManager):
    """A broken reranker must downgrade to ``None`` rather than
    surfacing as a fatal error in the lifecycle."""
    _activate_role(manager)
    with mock.patch(
        "search_sidecar.rerank.factory.can_load_real_embedder",
        return_value=True,
    ), mock.patch(
        "search_sidecar.rerank.factory.GteReranker",
        side_effect=RuntimeError("bad onnx file"),
    ):
        assert select_reranker(model_manager=manager) is None


def test_returns_real_reranker_when_extra_present_and_role_ready(
    manager: ModelManager,
):
    _activate_role(manager)
    fake = mock.Mock()

    def fake_ctor(config):
        # Sanity-check that the factory passes the activated commit
        # dir, not the role dir or some symlink artefact.
        assert config.model_dir.name == "testcommit"
        return fake

    with mock.patch(
        "search_sidecar.rerank.factory.can_load_real_embedder",
        return_value=True,
    ), mock.patch(
        "search_sidecar.rerank.factory.GteReranker", side_effect=fake_ctor
    ):
        reranker = select_reranker(model_manager=manager)
    assert reranker is fake
