#!/usr/bin/env bash
# Build a macOS arm64 CogniOS DMG with the packaged Python search sidecar.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/src-tauri/target/release/bundle/macos/CogniOS.app"
DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
SIDECAR_CONFIG='{"bundle":{"active":true,"targets":["app"],"externalBin":["binaries/search-sidecar"],"resources":["resources/search-sidecar"]}}'
APP_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$REPO_ROOT/src-tauri/tauri.conf.json")"
PRODUCT_NAME="$(node -e 'console.log(require(process.argv[1]).productName)' "$REPO_ROOT/src-tauri/tauri.conf.json" | tr ' /' '__')"
HOST_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
HOST_ARCH="${HOST_TRIPLE%%-*}"
DMG_NAME="${PRODUCT_NAME}_${APP_VERSION}_${HOST_ARCH}.dmg"

if [[ "${COGNIOS_SKIP_SIDECAR_BUILD:-}" != "1" ]]; then
  "$SCRIPT_DIR/build_macos_arm64.sh"
fi

cd "$REPO_ROOT"
npx tauri build --bundles app --config "$SIDECAR_CONFIG" --no-sign

codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

find "$DMG_DIR" "$REPO_ROOT/src-tauri/target/release/bundle/macos" \
  -maxdepth 1 \
  -name 'rw.*.dmg' \
  -delete
rm -f "$DMG_DIR/$DMG_NAME"

(
  cd "$DMG_DIR"
  ./bundle_dmg.sh \
    --volname CogniOS \
    --window-size 500 350 \
    --icon-size 128 \
    --icon CogniOS.app 128 170 \
    --hide-extension CogniOS.app \
    --app-drop-link 350 170 \
    --skip-jenkins \
    "$DMG_NAME" \
    ../macos
)

hdiutil verify "$DMG_DIR/$DMG_NAME"
echo "built $DMG_DIR/$DMG_NAME"
