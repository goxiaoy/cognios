from __future__ import annotations

import numpy as np

from search_sidecar.embeddings.gte import _encode_batch


class _Encoding:
    def __init__(self, ids: list[int], attention_mask: list[int]) -> None:
        self.ids = ids
        self.attention_mask = attention_mask


class _Tokenizer:
    def encode_batch(self, batch: list[str]) -> list[_Encoding]:
        assert batch == ["short", "longer"]
        return [
            _Encoding([0, 10, 2, 1], [1, 1, 1, 0]),
            _Encoding([0, 20, 21, 2], [1, 1, 1, 1]),
        ]


def test_encode_batch_builds_onnx_inputs_without_transformers() -> None:
    encoded = _encode_batch(np, _Tokenizer(), ["short", "longer"])

    assert set(encoded) == {"input_ids", "attention_mask"}
    assert encoded["input_ids"].dtype == np.int64
    assert encoded["attention_mask"].dtype == np.int64
    assert encoded["input_ids"].tolist() == [[0, 10, 2, 1], [0, 20, 21, 2]]
    assert encoded["attention_mask"].tolist() == [[1, 1, 1, 0], [1, 1, 1, 1]]
