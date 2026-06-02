"""Persisted search-subsystem settings — single source of truth for
which providers exist, which features are bound to which providers,
and what the user has already consented to.

Schema v1 lives in ``~/.cogios/search/settings.json`` (mode 0600).
The sidecar is the only writer; the frontend reads/writes via the
``/settings`` HTTP routes; the Rust app may also read the file
directly when the sidecar is unreachable (degraded read-only mode).

Three layers of state:

- **Provider** — an upstream source of capability (Local GTE, OpenAI,
  Qwen). Carries any per-instance config the user supplied (API key
  reference, custom base URL, model overrides). Does not carry the
  capability declarations or default models — those live in the
  static preset table (`providers/presets.py`, Unit 2).
- **Feature** — a user-facing setting (Semantic search, Image OCR,
  ...). Each feature carries an `enabled` flag and an optional
  `provider_id` binding. A feature whose `provider_id` is ``None``
  is unconfigured.
- **Workspace state** — `cloud_consent_acked` (list of provider ids
  the user has consented to send data to) and `first_run_skipped`
  (whether the user dismissed the first-run download banner so we
  don't re-prompt on every launch).

Schema versioning: every load checks the `version` field. Files
written by a future sidecar (``version > CURRENT_VERSION``) are
refused — the user is asked to upgrade the app rather than risk
silent downgrade-corruption. Forward-compat for adding new fields:
unknown fields in the on-disk file are silently dropped (see
``model_config`` extras setting); future sidecars that add fields
inherit a clean shape on first write.

API key references use the format ``env-file://cogios/.env#<provider_id>``.
The reference is informational; consumers resolve provider secrets
from ``~/.cogios/.env`` using the ``COGNIOS_PROVIDER_<ID>_KEY`` naming
convention, not by parsing the URL.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path

from typing import Any

from pydantic import BaseModel, Field, model_validator

LOG = logging.getLogger("search_sidecar.settings")

# Wire-format tolerance: Rust + the frontend talk to ``/settings``
# in camelCase (TS idiom + the tauri webview bridge). On disk we
# keep snake_case so settings.json stays grep-friendly.
#
# Pydantic 2.13's alias machinery throws a noisy
# ``UnsupportedFieldAttributeWarning`` on every model load even
# when the alias is applied correctly, so we sidestep it: a
# pre-validator on each model translates the known camelCase keys
# into their snake_case Python names before the rest of pydantic
# runs. ``model_dump(mode="json")`` still emits Python names →
# settings.json stays snake_case for save_settings.
_CAMEL_TO_SNAKE: dict[str, str] = {
    "providerId": "provider_id",
    "apiKeyRef": "api_key_ref",
    "baseUrl": "base_url",
    "modelPerCapability": "model_per_capability",
    "cloudConsentAcked": "cloud_consent_acked",
    "firstRunSkipped": "first_run_skipped",
}


def _normalize_keys(data: Any) -> Any:
    """Best-effort: rewrite known camelCase keys to snake_case in
    a freshly-received dict. Non-dict inputs (already-built model
    instances, etc.) pass through untouched."""
    if not isinstance(data, dict):
        return data
    result = dict(data)
    for camel, snake in _CAMEL_TO_SNAKE.items():
        if camel in result and snake not in result:
            result[snake] = result.pop(camel)
    return result

CURRENT_VERSION = 1

# How many times to retry an atomic settings write before giving up.
# `os.replace` can transiently fail on Windows when another process
# has the file open, and on macOS during iCloud-sync windows; a
# bounded retry covers the common cases without hiding real errors.
_WRITE_RETRY_COUNT = 3
_WRITE_RETRY_DELAY_SECONDS = 0.1


class ProviderConfig(BaseModel):
    """User-configured state for one provider preset.

    Reference to the static preset (capabilities, default models, auth
    kind) is by ``provider_id`` only — this dataclass holds the things
    a user can change at runtime.
    """

    provider_id: str = Field(..., min_length=1)
    enabled: bool = True
    api_key_ref: str | None = None
    base_url: str | None = None  # None = use preset's default base URL
    model_per_capability: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _accept_camel_case(cls, data: Any) -> Any:
        return _normalize_keys(data)


class FeatureConfig(BaseModel):
    """User-configured state for one feature.

    ``provider_id`` binds the feature to a configured provider.
    ``None`` means the feature is unbound; for mandatory features
    (semantic-search) the binding always points at *some* provider —
    the loader seeds ``local-gte`` as the default on a fresh install.
    """

    enabled: bool = False
    provider_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_camel_case(cls, data: Any) -> Any:
        return _normalize_keys(data)


class SearchSettings(BaseModel):
    """Versioned root document persisted to disk."""

    model_config = {
        "extra": "ignore",  # forward-compat: unknown fields drop on parse
    }

    version: int = CURRENT_VERSION
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)
    features: dict[str, FeatureConfig] = Field(default_factory=dict)
    # Provider IDs the user has acknowledged "this provider sends data
    # off-device" for. Per-provider one-shot — once consented, every
    # feature using that provider skips the dialog. Removing a provider
    # does NOT clear this by default; the Providers-section remove flow
    # offers an opt-in "also clear consent" checkbox (Unit 7).
    cloud_consent_acked: list[str] = Field(default_factory=list)
    # Whether the user explicitly dismissed the first-run download
    # banner. Persisted so we don't pop the consent countdown on every
    # app relaunch.
    first_run_skipped: bool = False

    @model_validator(mode="before")
    @classmethod
    def _accept_camel_case(cls, data: Any) -> Any:
        return _normalize_keys(data)


class SettingsVersionError(RuntimeError):
    """The on-disk file declares a `version` newer than this build supports."""


def default_settings() -> SearchSettings:
    """Fresh-install defaults. Mandatory features (semantic-search,
    result-reranking, image-ocr) are pre-bound to their local
    providers so a fresh install boots into a working full-pipeline
    state once the first-run downloads complete. PaddleOCR ships
    bundled inside the rapidocr-onnxruntime wheel, so image-ocr has
    no download cost — that's why it's mandatory rather than opt-in.
    Voice Notes is also enabled by default so the app can prepare
    Qwen3-ASR through the same model-download path before a recording
    starts. Image captioning is still optional pending the local Gemma path.
    """
    return SearchSettings(
        providers={
            "local-gte": ProviderConfig(
                provider_id="local-gte",
                enabled=True,
            ),
            "local-gte-reranker": ProviderConfig(
                provider_id="local-gte-reranker",
                enabled=True,
            ),
            "local-paddleocr": ProviderConfig(
                provider_id="local-paddleocr",
                enabled=True,
            ),
            "local-qwen-asr": ProviderConfig(
                provider_id="local-qwen-asr",
                enabled=True,
            ),
        },
        features={
            "semantic-search": FeatureConfig(
                enabled=True,
                provider_id="local-gte",
            ),
            "result-reranking": FeatureConfig(
                enabled=True,
                provider_id="local-gte-reranker",
            ),
            "image-ocr": FeatureConfig(
                enabled=True,
                provider_id="local-paddleocr",
            ),
            "image-captioning": FeatureConfig(enabled=False, provider_id=None),
            # Layout-aware OCR (PP-StructureV3 local, structured-prompt
            # vision for cloud). Off by default — local needs a 12-model
            # download (~600MB) and cloud incurs per-image API cost.
            # When enabled and bound, ImageProcessor routes through the
            # advanced extractor; basic image-ocr stays as the fallback.
            "advanced-ocr": FeatureConfig(enabled=False, provider_id=None),
            "voice-notes": FeatureConfig(
                enabled=True,
                provider_id="local-qwen-asr",
            ),
            "chat": FeatureConfig(enabled=True, provider_id="local-ollama"),
            "web-search": FeatureConfig(enabled=False, provider_id=None),
        },
    )


def load_settings(path: Path) -> SearchSettings:
    """Load and validate ``settings.json`` at ``path``.

    Returns ``default_settings()`` when the file is absent — the
    standard fresh-install path. Raises ``SettingsVersionError`` when
    the file declares a ``version`` higher than ``CURRENT_VERSION``;
    callers should surface this as a "please upgrade the app" message
    rather than silently downgrade. Pydantic ``ValidationError``
    propagates as-is on malformed JSON.

    Pure file reader — no migrations or defaults are layered in
    here so ``PUT /settings`` followed by ``GET /settings`` returns
    exactly what was written. Boot-time mandatory-feature backfill
    is in :func:`migrate_mandatory_features`, called by the lifecycle.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        LOG.info("settings.json missing at %s; using defaults", path)
        return default_settings()
    settings = SearchSettings.model_validate_json(text)
    if settings.version > CURRENT_VERSION:
        raise SettingsVersionError(
            f"settings.json declares version {settings.version}, "
            f"this sidecar only understands version {CURRENT_VERSION}. "
            "Upgrade the app to load these settings."
        )
    return settings


# Feature ids that are mandatory in v1. Kept here (not in
# providers/presets.py) so the settings layer has zero imports from
# the providers layer.
_MANDATORY_FEATURE_IDS: tuple[str, ...] = (
    "semantic-search",
    "result-reranking",
    "image-ocr",
    "voice-notes",
)

_DISPATCHER_FEATURE_CAPABILITIES: dict[str, str] = {
    "semantic-search": "embedding",
    "result-reranking": "reranking",
    "image-ocr": "ocr",
    "image-captioning": "vision",
    "advanced-ocr": "advanced-ocr",
}


def migrate_mandatory_features(
    settings: SearchSettings,
) -> tuple[SearchSettings, bool]:
    """Restore default bindings for mandatory features that ended up
    disabled or unbound on disk.

    Covers pre-mandatory installs whose ``result-reranking`` row was
    persisted as ``{enabled: false, providerId: null}`` before the
    feature was promoted. Only fixes the "looks like the user never
    picked anything" case — an explicit non-default binding is left
    alone. Also seeds any provider entries the restored bindings
    point at so the dispatcher doesn't see a dangling ``provider_id``.

    Returns ``(migrated_settings, changed)``. The lifecycle persists
    the result back to disk when ``changed`` is True so the migration
    runs at most once per install.
    """
    defaults = default_settings()
    changed = False
    for fid in _MANDATORY_FEATURE_IDS:
        default_feature = defaults.features.get(fid)
        if default_feature is None:
            continue
        existing = settings.features.get(fid)
        if existing is None:
            settings.features[fid] = default_feature.model_copy()
            changed = True
            continue
        if not existing.enabled or existing.provider_id is None:
            settings.features[fid] = default_feature.model_copy()
            changed = True
    for pid, pcfg in defaults.providers.items():
        if pid not in settings.providers and any(
            settings.features[fid].provider_id == pid
            for fid in _MANDATORY_FEATURE_IDS
            if fid in settings.features
        ):
            settings.providers[pid] = pcfg.model_copy()
            changed = True
    return settings, changed


def save_settings(path: Path, settings: SearchSettings) -> None:
    """Atomic write of ``settings`` to ``path`` with mode 0600.

    Strategy: write to ``<path>.tmp`` with explicit ``os.open`` mode
    0600 (so the file isn't briefly world-readable under default
    umask), ``json.dump`` the canonical form, then ``os.replace`` to
    swap into place. POSIX guarantees ``os.replace`` is atomic; on
    Windows it can transiently raise ``PermissionError`` if another
    process has the file open, so the write is wrapped in a small
    retry loop. iCloud Drive on macOS has the same hazard.
    """
    payload = settings.model_dump(mode="json")
    tmp_path = path.with_name(path.name + ".tmp")
    last_err: Exception | None = None
    for attempt in range(_WRITE_RETRY_COUNT):
        try:
            _atomic_write_json(tmp_path, path, payload)
            return
        except OSError as err:
            last_err = err
            LOG.warning(
                "save_settings attempt %d/%d failed: %s",
                attempt + 1,
                _WRITE_RETRY_COUNT,
                err,
            )
            time.sleep(_WRITE_RETRY_DELAY_SECONDS)
    raise OSError(
        f"save_settings: failed after {_WRITE_RETRY_COUNT} attempts: {last_err}"
    ) from last_err


def boot_signature(settings: SearchSettings) -> str:
    """Hash of the dispatcher-affecting fields of ``settings``.

    Two settings with the same boot signature wire the dispatcher
    identically; two with different signatures need a sidecar restart
    before the change takes effect. Used by the ``needs_restart`` flag
    on ``GET /settings``.

    Affecting fields, kept narrow on purpose:

    - Dispatcher-backed features' ``enabled`` flag and active
      ``provider_id`` — changing either reshapes which extractors /
      embedders the indexing dispatcher wires.
    - Dispatcher-bound providers' relevant ``model_per_capability``
      values — changing an embedding / OCR model changes what the
      dispatcher sends.
    - Dispatcher-bound providers' ``base_url`` — same reasoning
      (custom endpoint changes traffic destination).

    Explicitly NOT affecting (so changing them doesn't surface a
    spurious restart prompt):

    - ``chat`` and ``web-search`` feature/provider settings — those
      are refreshed in-process by the settings route and don't touch
      the indexing runner.
    - ``cloud_consent_acked`` — pure UI gate state.
    - ``first_run_skipped`` — pure UI banner state.
    - ``api_key_ref`` — the cloud Embedder reads keys lazily from
      the provider secret env file, so a key rotation is picked up
      on next embed.
    - Provider ``enabled`` flag — currently advisory only; the
      feature binding is the load-bearing field.

    A SHA-256 truncated to 16 hex chars; collision probability is
    cosmetic since the comparison is local-only and a single user
    will never see 2^32 distinct signatures in their lifetime.
    """
    features: dict[str, dict[str, str | bool | None]] = {}
    provider_capabilities: dict[str, set[str]] = {}
    for fid, capability in sorted(_DISPATCHER_FEATURE_CAPABILITIES.items()):
        cfg = settings.features.get(fid)
        enabled = bool(cfg and cfg.enabled)
        provider_id = cfg.provider_id if enabled and cfg else None
        features[fid] = {"enabled": enabled, "provider_id": provider_id}
        if provider_id is not None:
            provider_capabilities.setdefault(provider_id, set()).add(capability)

    providers: dict[str, dict[str, object]] = {}
    for provider_id, capabilities in sorted(provider_capabilities.items()):
        cfg = settings.providers.get(provider_id)
        if cfg is None:
            providers[provider_id] = {
                "model_per_capability": {},
                "base_url": None,
            }
            continue
        providers[provider_id] = {
            "model_per_capability": {
                capability: cfg.model_per_capability[capability]
                for capability in sorted(capabilities)
                if capability in cfg.model_per_capability
            },
            "base_url": cfg.base_url,
        }

    inputs: dict = {"features": features, "providers": providers}
    blob = json.dumps(inputs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _atomic_write_json(tmp_path: Path, final_path: Path, payload: dict) -> None:
    """One attempt at the tmp-write + replace cycle.

    Mode 0o600 is set on the file descriptor at create time, so the
    file is never briefly world-readable. On Windows the mode bits
    are ignored by the OS (NTFS uses ACLs, not POSIX bits); a
    Windows-aware permission tightening is out of scope for v1 and
    documented in the plan's risks.

    On any failure (write or rename), the tmp file is removed so the
    next retry attempt doesn't fight a stale sentinel and the final
    file remains either fully old or fully new — never partial.
    """
    try:
        fd = os.open(
            str(tmp_path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(str(tmp_path), str(final_path))
    except Exception:
        # Clean up the half-written tmp file on any failure (write,
        # fsync, or replace) so the next retry isn't fighting a
        # zero-byte or stale sentinel.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
