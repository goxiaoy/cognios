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

from ..settings import SearchSettings, load_settings, save_settings

router = APIRouter(prefix="/settings", tags=["settings"])


def _get_settings_path(request: Request) -> Path:
    path = getattr(request.app.state, "settings_path", None)
    if path is None:
        raise HTTPException(
            status_code=500,
            detail="settings_path not configured on app.state",
        )
    return path


def _settings_response(settings: SearchSettings, *, needs_restart: bool) -> dict:
    """Serialize for the wire — adds the computed ``needs_restart``
    field that's not part of the persisted shape."""
    body = settings.model_dump(mode="json")
    body["needs_restart"] = needs_restart
    return body


@router.get("")
def get_settings(request: Request) -> dict:
    """Return the current persisted settings + computed ``needs_restart``."""
    path = _get_settings_path(request)
    settings = load_settings(path)
    return _settings_response(settings, needs_restart=False)


@router.put("")
def put_settings(body: SearchSettings, request: Request) -> dict:
    """Persist the supplied settings and return the new state.

    FastAPI auto-validates ``body`` against ``SearchSettings`` — bad
    JSON / wrong field types surface as a 422 with the standard
    Pydantic error shape; the route never sees a malformed object.
    """
    path = _get_settings_path(request)
    save_settings(path, body)
    settings = load_settings(path)  # re-load to confirm round-trip
    return _settings_response(settings, needs_restart=False)
