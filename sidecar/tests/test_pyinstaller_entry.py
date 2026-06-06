from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_pyinstaller_lancedb_stubs_cover_remote_table_imports() -> None:
    entry = (
        Path(__file__).resolve().parents[1]
        / "packaging"
        / "pyinstaller_entry.py"
    )
    script = f"""
import importlib.util
import sys

for name in list(sys.modules):
    if name.startswith(("lancedb.embeddings", "lancedb.rerankers")):
        del sys.modules[name]

spec = importlib.util.spec_from_file_location("pyinstaller_entry_test", {str(entry)!r})
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

from lancedb.embeddings.base import EmbeddingFunctionConfig
from lancedb.rerankers.rrf import RRFReranker
import lancedb.remote.table
import pyarrow as pa

assert EmbeddingFunctionConfig is not None
vector_results = pa.table({{
    "_rowid": [1, 2],
    "text": ["vector-a", "shared"],
    "_distance": [0.1, 0.2],
}})
fts_results = pa.table({{
    "_rowid": [2, 3],
    "text": ["shared", "fts-b"],
    "_score": [0.9, 0.8],
}})
reranked = RRFReranker().rerank_hybrid("query", vector_results, fts_results)

assert reranked.column_names == ["_rowid", "text", "_relevance_score"]
assert reranked["_rowid"].to_pylist() == [2, 1, 3]
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
