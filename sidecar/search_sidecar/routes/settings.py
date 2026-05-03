"""``/settings`` — read and write the persisted search-subsystem settings.

The frontend (and the Rust supervisor when it needs the canonical
state) talks to these routes; both processes ultimately resolve API
keys from the OS keychain via the shared ``cognios-search`` service
name. Bearer auth is inherited from the global middleware.

``needs_restart`` is a computed flag indicating whether the on-disk
settings differ from what the running sidecar booted with in any
dispatcher-affecting way. v1 of this unit returns ``False``
unconditionally — Unit 3 wires the boot-signature comparison that
makes the flag actually useful. Returning ``False`` here keeps the
JSON shape stable so the frontend can build against the final
contract immediately.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from ..providers import invalidate_provider_secret_cache
from ..settings import (
    SearchSettings,
    boot_signature,
    load_settings,
    save_settings,
)

router = APIRouter(prefix="/settings", tags=["settings"])


def _get_settings_path(request: Request) -> Path:
    path = getattr(request.app.state, "settings_path", None)
    if path is None:
        raise HTTPException(
            status_code=500,
            detail="settings_path not configured on app.state",
        )
    return path


def _compute_needs_restart(request: Request, settings: SearchSettings) -> bool:
    """Compare current settings to the signature captured at boot.

    Returns False when no boot signature is wired (e.g. test harnesses
    that build the app without lifecycle's boot capture) so the route
    stays usable in that mode.
    """
    boot_sig = getattr(request.app.state, "boot_settings_signature", None)
    if boot_sig is None:
        return False
    return boot_signature(settings) != boot_sig


def _settings_response(needs_restart: bool, settings: SearchSettings) -> dict:
    """Serialize for the wire — adds the computed ``needs_restart``
    field that's not part of the persisted shape."""
    body = settings.model_dump(mode="json")
    body["needs_restart"] = needs_restart
    return body


def _set_runner_pause(request: Request, paused: bool) -> None:
    """Pause / resume the indexing runner if one is wired.

    Pausing on `needs_restart=True` prevents the mixed-provider
    corruption case where new chunks would be embedded by the
    just-changed provider while existing chunks are still on the
    boot-time provider's embedding space.
    """
    runner = getattr(request.app.state, "indexing_runner", None)
    if runner is None:
        return
    runner.set_paused(paused)


@router.get("")
def get_settings(request: Request) -> dict:
    """Return the current persisted settings + computed ``needs_restart``."""
    path = _get_settings_path(request)
    settings = load_settings(path)
    needs_restart = _compute_needs_restart(request, settings)
    # Keep the runner-pause flag in sync with the live state — covers
    # the case where the on-disk file was edited externally.
    _set_runner_pause(request, needs_restart)
    return _settings_response(needs_restart, settings)


@router.put("")
def put_settings(body: SearchSettings, request: Request) -> dict:
    """Persist the supplied settings and return the new state.

    FastAPI auto-validates ``body`` against ``SearchSettings`` — bad
    JSON / wrong field types surface as a 422 with the standard
    Pydantic error shape; the route never sees a malformed object.

    Side effect: if the new settings change any dispatcher-affecting
    field, the runner is paused so subsequent embedding work doesn't
    happen against the about-to-be-replaced provider.
    """
    path = _get_settings_path(request)
    save_settings(path, body)
    settings = load_settings(path)  # re-load to confirm round-trip
    # Invalidate cached provider secrets on every PUT — the user may
    # have rotated a key on the Rust side (set_provider_secret IPC)
    # between PUTs, and the per-process cache in
    # ``providers.keychain`` would otherwise serve the stale value
    # until the next sidecar restart.
    invalidate_provider_secret_cache()
    needs_restart = _compute_needs_restart(request, settings)
    _set_runner_pause(request, needs_restart)
    return _settings_response(needs_restart, settings)
