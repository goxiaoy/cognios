#!/usr/bin/env bash
# Build a macOS arm64 CogniOS DMG with the packaged Python search sidecar.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/src-tauri/target/release/bundle/macos/CogniOS.app"
DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"
DMG_STAGE_DIR="$DMG_DIR/stage"
SIDECAR_CONFIG='{"bundle":{"active":true,"targets":["app"],"externalBin":["binaries/search-sidecar"],"resources":["resources/search-sidecar"]}}'
APP_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$REPO_ROOT/src-tauri/tauri.conf.json")"
PRODUCT_NAME="$(node -e 'console.log(require(process.argv[1]).productName)' "$REPO_ROOT/src-tauri/tauri.conf.json" | tr ' /' '__')"
HOST_TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
HOST_ARCH="${HOST_TRIPLE%%-*}"
DMG_NAME="${PRODUCT_NAME}_${APP_VERSION}_${HOST_ARCH}.dmg"
mkdir -p "$DMG_DIR"

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
rm -rf "$DMG_STAGE_DIR"
rm -f "$DMG_DIR/$DMG_NAME"
mkdir -p "$DMG_STAGE_DIR"

ditto "$APP_DIR" "$DMG_STAGE_DIR/CogniOS.app"
ln -s /Applications "$DMG_STAGE_DIR/Applications"
hdiutil create \
  -volname CogniOS \
  -srcfolder "$DMG_STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_DIR/$DMG_NAME"
rm -rf "$DMG_STAGE_DIR"

hdiutil verify "$DMG_DIR/$DMG_NAME"
echo "built $DMG_DIR/$DMG_NAME"
