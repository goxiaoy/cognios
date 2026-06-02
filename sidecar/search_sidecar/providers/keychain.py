"""Provider secret access backed by ``~/.cogios/.env``.

The Rust side writes provider API keys to dotenv-style variables such
as ``COGNIOS_PROVIDER_OPENAI_KEY``. The sidecar reads the same file at
runtime and keeps a process-lifetime cache so repeated provider probes
do not re-read the file on every request.

The module name is retained for import compatibility with the rest of
the codebase, but it only reads the env file now.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

SECRET_ENV_FILE_OVERRIDE = "COGNIOS_SECRETS_ENV_FILE"
DEFAULT_SECRET_ENV_FILE = Path.home() / ".cogios" / ".env"

LOG = logging.getLogger("search_sidecar.providers.keychain")

_CACHE: dict[str, str | None] = {}
_CACHE_LOCK = threading.Lock()


class SecretStoreUnavailableError(RuntimeError):
    """Raised when the provider secret env file cannot be read."""


# Backwards-compatible alias for callers that still import the older name.
KeychainUnavailableError = SecretStoreUnavailableError


def _secret_env_file_path() -> Path:
    override = os.environ.get(SECRET_ENV_FILE_OVERRIDE)
    if override:
        return Path(override).expanduser()
    return DEFAULT_SECRET_ENV_FILE


def _env_var_name(provider_id: str) -> str:
    """Derive the env-var name for a provider's persisted API key.

    ``openai`` -> ``COGNIOS_PROVIDER_OPENAI_KEY``
    ``qwen-dashscope`` -> ``COGNIOS_PROVIDER_QWEN_DASHSCOPE_KEY``
    """
    if not provider_id:
        raise ValueError("provider_id must not be empty")
    return f"COGNIOS_PROVIDER_{provider_id.upper().replace('-', '_')}_KEY"


def _parse_quoted_value(value: str) -> str:
    if len(value) < 2 or not value.startswith('"') or not value.endswith('"'):
        return value
    out: list[str] = []
    escaped = False
    for char in value[1:-1]:
        if escaped:
            out.append({"n": "\n", "r": "\r", "t": "\t"}.get(char, char))
            escaped = False
        elif char == "\\":
            escaped = True
        else:
            out.append(char)
    return "".join(out)


def _parse_env_file(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as err:
        LOG.warning("provider secret env file unavailable at %s: %s", path, err)
        raise SecretStoreUnavailableError(str(err)) from err

    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        values[key] = _parse_quoted_value(raw_value.strip()).strip()
    return values


def _env_override(provider_id: str) -> str | None:
    raw = os.environ.get(_env_var_name(provider_id))
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def get_provider_secret(provider_id: str) -> str | None:
    """Return the stored secret for ``provider_id`` or ``None``.

    Resolution order:
      1. Process environment variable ``COGNIOS_PROVIDER_<ID>_KEY``.
      2. Process-lifetime cache.
      3. ``~/.cogios/.env``.
    """
    override = _env_override(provider_id)
    if override is not None:
        return override

    with _CACHE_LOCK:
        if provider_id in _CACHE:
            return _CACHE[provider_id]

    key = _env_var_name(provider_id)
    value = _parse_env_file(_secret_env_file_path()).get(key)
    resolved = (value.strip() or None) if value else None
    with _CACHE_LOCK:
        _CACHE[provider_id] = resolved
    return resolved


def invalidate_provider_secret_cache(provider_id: str | None = None) -> None:
    """Drop cached secrets so the next read goes back to the env file."""
    with _CACHE_LOCK:
        if provider_id is None:
            _CACHE.clear()
        else:
            _CACHE.pop(provider_id, None)


def has_provider_secret(provider_id: str) -> bool:
    """Convenience wrapper for Settings UI's "configured?" indicator."""
    try:
        return get_provider_secret(provider_id) is not None
    except SecretStoreUnavailableError:
        return False


def delete_provider_secret(provider_id: str) -> None:
    """Remove the stored secret from ``~/.cogios/.env``.

    Idempotent: deleting a non-existent entry is a no-op. This Python
    path is mostly used by tests; normal writes/deletes happen through
    the Rust IPC commands.
    """
    key = _env_var_name(provider_id)
    path = _secret_env_file_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        invalidate_provider_secret_cache(provider_id)
        return
    except OSError as err:
        raise SecretStoreUnavailableError(str(err)) from err

    kept: list[str] = []
    for line in lines:
        stripped = line.strip()
        assignment = stripped[len("export ") :].lstrip() if stripped.startswith("export ") else stripped
        entry_key = assignment.split("=", 1)[0].strip() if "=" in assignment else None
        if entry_key == key:
            continue
        kept.append(line)

    if kept:
        path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    else:
        path.write_text("", encoding="utf-8")
    invalidate_provider_secret_cache(provider_id)
