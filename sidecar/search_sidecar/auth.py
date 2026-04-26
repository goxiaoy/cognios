"""Bearer-token middleware for the sidecar's HTTP surface.

The token is a 256-bit value rendered as 64 lowercase hex chars
(``secrets.token_hex(32)``). This format is enforced on the Rust side
by ``src-tauri/src/services/search/runtime_file.rs`` — keep them in
sync.

Every request must carry ``Authorization: Bearer <token>``. We use
``hmac.compare_digest`` for constant-time comparison so request timing
cannot be used to brute-force the token.

Logged request lines redact the ``Authorization`` header by replacing
its value with ``"<redacted>"`` before any structured logger sees it
(see :mod:`search_sidecar.app`).
"""

from __future__ import annotations

import hmac
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


def generate_token() -> str:
    """Return a 64-char lowercase hex string (256 bits of entropy)."""
    return secrets.token_hex(32)


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Reject any request without a matching ``Authorization: Bearer ...`` header.

    The token is captured by closure rather than read from request state
    so a misconfigured route handler cannot accidentally bypass it.
    """

    def __init__(self, app, *, token: str) -> None:
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next):
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return JSONResponse(
                {
                    "ok": False,
                    "error": {
                        "code": "missing_authorization",
                        "message": "Bearer token required",
                    },
                },
                status_code=401,
            )
        provided = header[len("Bearer ") :]
        if not hmac.compare_digest(provided, self._token):
            return JSONResponse(
                {
                    "ok": False,
                    "error": {
                        "code": "invalid_token",
                        "message": "bad bearer token",
                    },
                },
                status_code=401,
            )
        return await call_next(request)
