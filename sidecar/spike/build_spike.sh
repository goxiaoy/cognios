#!/usr/bin/env bash
# Build the search-sidecar packaging spike with PyInstaller --onedir.
# Target: macOS arm64. Run from the repo root or from sidecar/spike/.
#
# Records: bundle size, build time, codesign result. Writes findings to
# sidecar/spike/build.log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_VERSION="${PYTHON_VERSION:-3.13}"
DIST_DIR="$SCRIPT_DIR/dist"
BUILD_DIR="$SCRIPT_DIR/build"
LOG_FILE="$SCRIPT_DIR/build.log"

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

: > "$LOG_FILE"
log "starting spike build"
log "python: $PYTHON_VERSION (managed by uv)"
log "host: $(uname -sm)"

# --- deps via uv ----------------------------------------------------------
# uv sync creates .venv/ and installs everything from pyproject.toml.
log "uv sync (creates .venv and installs deps)"
uv sync --python "$PYTHON_VERSION" 2>&1 | tee -a "$LOG_FILE"

log "uv pip freeze ->"
uv pip freeze 2>&1 | tee -a "$LOG_FILE"

# --- pyinstaller ----------------------------------------------------------
log "running pyinstaller --onedir"
rm -rf "$DIST_DIR" "$BUILD_DIR"

START_BUILD=$SECONDS
uv run pyinstaller \
  --onedir \
  --name search-sidecar-spike \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR" \
  --noconfirm \
  --collect-all lancedb \
  --collect-all pyarrow \
  --collect-all numpy \
  --collect-binaries onnxruntime \
  --collect-binaries pymupdf \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  "$SCRIPT_DIR/hello.py" 2>&1 | tee -a "$LOG_FILE"
BUILD_SECONDS=$((SECONDS - START_BUILD))
log "pyinstaller finished in ${BUILD_SECONDS}s"

# --- bundle stats ---------------------------------------------------------
BUNDLE_PATH="$DIST_DIR/search-sidecar-spike"
if [ -d "$BUNDLE_PATH" ]; then
  BUNDLE_SIZE=$(du -sh "$BUNDLE_PATH" | awk '{print $1}')
  log "bundle path: $BUNDLE_PATH"
  log "bundle size: $BUNDLE_SIZE"
else
  log "ERROR: bundle path missing at $BUNDLE_PATH"
  exit 1
fi

# --- smoke test -----------------------------------------------------------
log "booting bundle and hitting /spike"
"$BUNDLE_PATH/search-sidecar-spike" &
SIDECAR_PID=$!
trap 'kill $SIDECAR_PID 2>/dev/null || true' EXIT

# Wait for the bundle to bind a TCP port — give it up to 60s.
PORT=""
for i in $(seq 1 60); do
  PORT=$(lsof -p "$SIDECAR_PID" -P -n 2>/dev/null | awk '/TCP 127\.0\.0\.1:/ {split($9, a, ":"); print a[2]; exit}' || true)
  if [ -n "${PORT:-}" ]; then
    log "spike bound to port $PORT after ${i}s"
    break
  fi
  sleep 1
done

if [ -z "${PORT:-}" ]; then
  log "ERROR: spike did not bind a port within 60s"
  exit 1
fi

log "GET /spike ->"
curl -sS "http://127.0.0.1:${PORT}/spike" | tee -a "$LOG_FILE"
echo | tee -a "$LOG_FILE"

# --- codesign smoke -------------------------------------------------------
log "codesign --deep --options runtime --sign - $BUNDLE_PATH"
codesign --deep --options runtime --sign - "$BUNDLE_PATH" 2>&1 | tee -a "$LOG_FILE" || \
  log "codesign returned non-zero (this is informational; v1 will use a real identity)"

kill "$SIDECAR_PID" 2>/dev/null || true
log "spike build complete; see $LOG_FILE for full output"
