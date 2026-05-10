"""Privacy-safe in-process observability aggregates.

The Home dashboard needs recent operational signals without turning
prompts, source text, file paths, or provider payloads into analytics
data. This module keeps only bounded durations, counts, provider/model
ids, and numeric token usage.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
import threading
from typing import Any


MAX_DURATION_SAMPLES = 256


@dataclass(frozen=True)
class DurationSample:
    elapsed_ms: int
    ok: bool = True


@dataclass
class UsageTotals:
    provider_id: str
    model: str
    requests: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def to_dict(self) -> dict:
        return {
            "provider_id": self.provider_id,
            "model": self.model,
            "requests": self.requests,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }


class ObservabilityStore:
    def __init__(self, *, max_duration_samples: int = MAX_DURATION_SAMPLES) -> None:
        self._lock = threading.RLock()
        self._durations: dict[str, deque[DurationSample]] = defaultdict(
            lambda: deque(maxlen=max_duration_samples)
        )
        self._usage: dict[tuple[str, str], UsageTotals] = {}

    def record_duration(self, kind: str, elapsed_ms: int, *, ok: bool = True) -> None:
        if elapsed_ms < 0:
            return
        with self._lock:
            self._durations[kind].append(
                DurationSample(elapsed_ms=int(elapsed_ms), ok=ok)
            )

    def record_usage(
        self,
        *,
        provider_id: str | None,
        model: str | None,
        usage: dict[str, Any] | None,
    ) -> None:
        if not provider_id or not model or not usage:
            return
        prompt = _int_value(
            usage,
            "prompt_tokens",
            "prompt_eval_count",
            "input_tokens",
            "inputTokenCount",
        )
        completion = _int_value(
            usage,
            "completion_tokens",
            "completion_eval_count",
            "eval_count",
            "output_tokens",
            "outputTokenCount",
        )
        total = _int_value(usage, "total_tokens", "totalTokenCount")
        if total == 0 and (prompt or completion):
            total = prompt + completion
        if prompt == 0 and completion == 0 and total == 0:
            return

        key = (provider_id, model)
        with self._lock:
            current = self._usage.get(key)
            if current is None:
                current = UsageTotals(provider_id=provider_id, model=model)
                self._usage[key] = current
            current.requests += 1
            current.prompt_tokens += prompt
            current.completion_tokens += completion
            current.total_tokens += total

    def summary(self, *, recent_indexed_nodes: list[dict] | None = None) -> dict:
        with self._lock:
            latency = {
                "search": self._duration_summary("search"),
                "indexing": self._duration_summary("indexing"),
                "enhancement": self._duration_summary("enhancement"),
                "model_download": self._duration_summary("model_download"),
            }
            token_usage = [
                totals.to_dict()
                for totals in sorted(
                    self._usage.values(),
                    key=lambda item: item.total_tokens,
                    reverse=True,
                )
            ]
        return {
            "recent_indexed_nodes": recent_indexed_nodes or [],
            "latency": latency,
            "token_usage": token_usage,
        }

    def _duration_summary(self, kind: str) -> dict:
        samples = list(self._durations.get(kind, ()))
        values = sorted(sample.elapsed_ms for sample in samples)
        failures = sum(1 for sample in samples if not sample.ok)
        return {
            "sample_count": len(values),
            "failure_count": failures,
            "latest_ms": samples[-1].elapsed_ms if samples else None,
            "p50_ms": _percentile(values, 50),
            "p90_ms": _percentile(values, 90),
            "p99_ms": _percentile(values, 99),
        }


def _percentile(values: list[int], percentile: int) -> int | None:
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    rank = (percentile / 100) * (len(values) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(values) - 1)
    if lower == upper:
        return values[lower]
    fraction = rank - lower
    return round(values[lower] + (values[upper] - values[lower]) * fraction)


def _int_value(usage: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return max(value, 0)
        if isinstance(value, float):
            return max(int(value), 0)
    return 0
