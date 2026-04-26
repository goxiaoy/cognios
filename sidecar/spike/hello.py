"""
Cross-workspace search PyInstaller packaging spike.

Imports every deep ML dependency the v1 sidecar will use and exposes a
single /spike endpoint that exercises a trivial call into each library.
The point is to prove (or disprove) that PyInstaller --onedir on macOS
arm64 can produce a bundle that boots, imports cleanly, and survives a
codesign --deep pass.

This file is intentionally minimal. It is NOT the v1 sidecar. The real
sidecar lives at sidecar/search_sidecar/ once Phase 1 begins.
"""

from __future__ import annotations

import sys
import time
import socket
import os
import tempfile
from pathlib import Path

import uvicorn
from fastapi import FastAPI

# --- Deep-ML imports under test --------------------------------------------
# Each of these is a load-bearing dep for v1. We import at module level so
# any import-time failure surfaces during bundle boot rather than later.
import lancedb
import pyarrow as pa
import fitz  # PyMuPDF
import onnxruntime as ort

# llama-cpp-python and paddleocr-onnx are the highest-risk bundle pieces.
# We import them but don't construct heavy objects unless the spike
# endpoint is hit (avoids burning RAM during a smoke boot).
try:
    import llama_cpp  # type: ignore
    LLAMA_AVAILABLE = True
except Exception as exc:  # pragma: no cover - capture import failure detail
    LLAMA_AVAILABLE = False
    LLAMA_IMPORT_ERROR = repr(exc)

try:
    # paddleocr-onnx is the package name on PyPI; falls back to paddleocr
    # via the paddlex[ocr-core] + onnxruntime path if not installed.
    import paddleocr  # type: ignore
    PADDLE_AVAILABLE = True
except Exception as exc:  # pragma: no cover
    PADDLE_AVAILABLE = False
    PADDLE_IMPORT_ERROR = repr(exc)

try:
    from optimum.onnxruntime import ORTModelForSequenceClassification  # type: ignore  # noqa: F401
    OPTIMUM_AVAILABLE = True
except Exception as exc:  # pragma: no cover
    OPTIMUM_AVAILABLE = False
    OPTIMUM_IMPORT_ERROR = repr(exc)

# ---------------------------------------------------------------------------

START_TIME = time.monotonic()

app = FastAPI(title="Cognios search-sidecar packaging spike", version="0")


@app.get("/spike")
def spike() -> dict:
    """Exercise a trivial call into each bundled dep.

    Each section is wrapped in try/except so a single failing dep does not
    short-circuit reporting of the others.
    """
    report: dict[str, object] = {
        "python": sys.version,
        "executable": sys.executable,
        "frozen": getattr(sys, "frozen", False),
        "boot_seconds": round(time.monotonic() - START_TIME, 3),
        "checks": {},
    }
    checks = report["checks"]
    assert isinstance(checks, dict)

    # --- lancedb: open an empty store, create a tiny table, query it ------
    try:
        with tempfile.TemporaryDirectory() as tmp:
            db = lancedb.connect(tmp)
            schema = pa.schema(
                [("id", pa.string()), ("vector", pa.list_(pa.float32(), 4))]
            )
            tbl = db.create_table("spike", schema=schema, mode="overwrite")
            tbl.add([{"id": "a", "vector": [0.1, 0.2, 0.3, 0.4]}])
            rows = tbl.search([0.1, 0.2, 0.3, 0.4]).limit(1).to_list()
            checks["lancedb"] = {
                "ok": True,
                "rows": len(rows),
                "version": getattr(lancedb, "__version__", "unknown"),
            }
    except Exception as exc:  # pragma: no cover
        checks["lancedb"] = {"ok": False, "error": repr(exc)}

    # --- pymupdf: open a tiny in-memory PDF and read its page count -------
    try:
        # Build a single-page blank PDF in memory.
        doc = fitz.open()
        doc.new_page(width=200, height=200)
        page_count = doc.page_count
        doc.close()
        checks["pymupdf"] = {
            "ok": True,
            "pages": page_count,
            "version": fitz.__doc__.split()[1] if fitz.__doc__ else "unknown",
        }
    except Exception as exc:  # pragma: no cover
        checks["pymupdf"] = {"ok": False, "error": repr(exc)}

    # --- onnxruntime: enumerate available execution providers -------------
    try:
        providers = ort.get_available_providers()
        checks["onnxruntime"] = {
            "ok": True,
            "version": ort.__version__,
            "providers": providers,
        }
    except Exception as exc:  # pragma: no cover
        checks["onnxruntime"] = {"ok": False, "error": repr(exc)}

    # --- llama-cpp-python: import-only smoke; loading a 3GB model is too
    # heavy for the spike. We just confirm the C extension imports.
    if LLAMA_AVAILABLE:
        try:
            checks["llama_cpp"] = {
                "ok": True,
                "version": getattr(llama_cpp, "__version__", "unknown"),
            }
        except Exception as exc:  # pragma: no cover
            checks["llama_cpp"] = {"ok": False, "error": repr(exc)}
    else:
        checks["llama_cpp"] = {
            "ok": False,
            "import_error": LLAMA_IMPORT_ERROR,
        }

    # --- paddleocr (or paddleocr-onnx): import-only smoke -----------------
    if PADDLE_AVAILABLE:
        checks["paddleocr"] = {"ok": True}
    else:
        checks["paddleocr"] = {
            "ok": False,
            "import_error": PADDLE_IMPORT_ERROR,
        }

    # --- optimum.onnxruntime: import-only ---------------------------------
    if OPTIMUM_AVAILABLE:
        checks["optimum_onnxruntime"] = {"ok": True}
    else:
        checks["optimum_onnxruntime"] = {
            "ok": False,
            "import_error": OPTIMUM_IMPORT_ERROR,
        }

    return report


@app.get("/healthz")
def healthz() -> dict:
    return {"state": "ready"}


def main() -> None:
    # Bind 127.0.0.1:0 to mimic the v1 lifecycle (sidecar picks an ephemeral
    # port; Rust reads the port from a runtime file).
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    # Optional: write a runtime file for parity with the real sidecar.
    if "COGNIOS_SPIKE_RUNTIME" in os.environ:
        runtime = Path(os.environ["COGNIOS_SPIKE_RUNTIME"])
        runtime.write_text(f'{{"port": {port}}}\n')

    print(f"spike: serving on http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
