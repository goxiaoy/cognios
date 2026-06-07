#!/usr/bin/env bash
# Build the Python search sidecar as a macOS arm64 Tauri sidecar.
#
# Outputs:
#   src-tauri/binaries/search-sidecar-aarch64-apple-darwin
#   src-tauri/resources/search-sidecar/
#
# Tauri's sidecar resolver expects a single executable with the platform
# suffix. The executable here is a tiny wrapper; the real PyInstaller onedir
# payload lives in app resources so startup avoids onefile extraction.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
HOST_TRIPLE="${HOST_TRIPLE:-$(rustc -vV | awk '/^host:/ {print $2}')}"

if [[ "$HOST_TRIPLE" != "aarch64-apple-darwin" ]]; then
  echo "error: expected aarch64-apple-darwin host, got $HOST_TRIPLE" >&2
  exit 1
fi

DIST_DIR="$SIDECAR_DIR/dist"
BUILD_DIR="$SIDECAR_DIR/build"
PACKAGING_VENV="$BUILD_DIR/pyinstaller-venv"
OUTPUT_DIR="$REPO_ROOT/src-tauri/binaries"
OUTPUT="$OUTPUT_DIR/search-sidecar-$HOST_TRIPLE"
RESOURCE_DIR="$REPO_ROOT/src-tauri/resources/search-sidecar"
REALTIME_VOICE_RESOURCE_DIR="$REPO_ROOT/src-tauri/resources/realtime-voice"
ENTRY="$SCRIPT_DIR/pyinstaller_entry.py"
SPEC_FILE="$SIDECAR_DIR/search-sidecar.spec"
REALTIME_VOICE_RUNTIME_SOURCE="${COGNIOS_REALTIME_VOICE_RUNTIME_SOURCE:-}"

mkdir -p "$OUTPUT_DIR" "$REPO_ROOT/src-tauri/resources"
rm -rf \
  "$DIST_DIR/search-sidecar" \
  "$BUILD_DIR/search-sidecar" \
  "$OUTPUT" \
  "$RESOURCE_DIR" \
  "$REALTIME_VOICE_RESOURCE_DIR" \
  "$SPEC_FILE"

cd "$SIDECAR_DIR"

UV_PROJECT_ENVIRONMENT="$PACKAGING_VENV" uv run --exact --no-default-groups --with pyinstaller==6.11.1 pyinstaller \
  --onedir \
  --name search-sidecar \
  --distpath "$DIST_DIR" \
  --workpath "$BUILD_DIR" \
  --noconfirm \
  --collect-binaries lancedb \
  --collect-data lancedb \
  --collect-binaries pyarrow \
  --collect-binaries numpy \
  --collect-submodules numpy._core \
  --collect-data trafilatura \
  --collect-data rapidocr_onnxruntime \
  --collect-binaries rapidocr_onnxruntime \
  --copy-metadata genai-prices \
  --copy-metadata pydantic-ai-slim \
  --collect-binaries onnxruntime \
  --collect-binaries pymupdf \
  --exclude-module lancedb.embeddings \
  --exclude-module lancedb.rerankers \
  --exclude-module pyarrow.tests \
  --exclude-module numpy.tests \
  --exclude-module numpy._core.tests \
  --exclude-module pytest \
  --exclude-module pandas \
  --exclude-module torch \
  --exclude-module torchvision \
  --exclude-module torchaudio \
  --exclude-module transformers \
  --exclude-module av \
  --exclude-module openpyxl \
  --exclude-module matplotlib \
  --exclude-module paddle \
  --exclude-module paddleocr \
  --exclude-module paddlex \
  --exclude-module modelscope \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import tokenizers \
  --hidden-import soundfile \
  --hidden-import librosa \
  --hidden-import librosa.filters \
  --hidden-import librosa.feature \
  --hidden-import scipy._cyutility \
  "$ENTRY"

cp -R "$DIST_DIR/search-sidecar" "$RESOURCE_DIR"
cat > "$OUTPUT" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_MACOS_DIR="$SELF_DIR"
if [[ "$(basename "$APP_MACOS_DIR")" == "MacOS" ]]; then
  APP_CONTENTS_DIR="$(cd "$APP_MACOS_DIR/.." && pwd)"
  PAYLOAD="$APP_CONTENTS_DIR/Resources/resources/search-sidecar/search-sidecar"
  if [[ ! -x "$PAYLOAD" ]]; then
    PAYLOAD="$APP_CONTENTS_DIR/Resources/search-sidecar/search-sidecar"
  fi
else
  # Development fallback when invoked from src-tauri/binaries.
  PAYLOAD="$(cd "$SELF_DIR/../resources/search-sidecar" && pwd)/search-sidecar"
fi

exec "$PAYLOAD" "$@"
SH
chmod +x "$OUTPUT"
find "$RESOURCE_DIR" -type f -perm -111 -exec codesign --force --sign - {} \; >/dev/null 2>&1 || true
if [[ -n "$REALTIME_VOICE_RUNTIME_SOURCE" ]]; then
  mkdir -p "$REALTIME_VOICE_RESOURCE_DIR"
  if [[ -d "$REALTIME_VOICE_RUNTIME_SOURCE" ]]; then
    cp -R "$REALTIME_VOICE_RUNTIME_SOURCE"/. "$REALTIME_VOICE_RESOURCE_DIR"
  elif [[ -f "$REALTIME_VOICE_RUNTIME_SOURCE" ]]; then
    cp "$REALTIME_VOICE_RUNTIME_SOURCE" "$REALTIME_VOICE_RESOURCE_DIR/vllm"
  else
    echo "error: realtime voice runtime source does not exist: $REALTIME_VOICE_RUNTIME_SOURCE" >&2
    exit 1
  fi
  chmod +x "$REALTIME_VOICE_RESOURCE_DIR/vllm"
  find "$REALTIME_VOICE_RESOURCE_DIR" -type f -perm -111 -exec codesign --force --sign - {} \; >/dev/null 2>&1 || true
fi
codesign --force --sign - "$OUTPUT" >/dev/null 2>&1 || true
rm -f "$SPEC_FILE"

echo "built $OUTPUT and $RESOURCE_DIR"
if [[ -x "$REALTIME_VOICE_RESOURCE_DIR/vllm" ]]; then
  echo "realtime voice runtime packaging: supported"
else
  echo "realtime voice runtime packaging: missing"
fi
