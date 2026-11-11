#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Verifies the packaged ArtifactAtlas.app, ArtifactAtlas-macOS.dmg,
# ArtifactAtlas-macOS.zip, and SHA256SUMS.txt on macOS.
# Also mounts the .dmg read-only and executes the full workflow directly from
# the mounted DMG volume against isolated test fixtures.
# ==============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"

APP_BUNDLE="$DIST_DIR/ArtifactAtlas.app"
DMG_PATH="$DIST_DIR/ArtifactAtlas-macOS.dmg"
ZIP_PATH="$DIST_DIR/ArtifactAtlas-macOS.zip"
SUMS_PATH="$DIST_DIR/SHA256SUMS.txt"

echo "==> [Verify 1/6] Checking presence of release artifacts..."
for f in "$APP_BUNDLE/Contents/MacOS/ArtifactAtlasApp" \
         "$APP_BUNDLE/Contents/Resources/AppIcon.icns" \
         "$APP_BUNDLE/Contents/Resources/runtime/node" \
         "$APP_BUNDLE/Contents/Resources/app/src/cli.js" \
         "$DMG_PATH" \
         "$ZIP_PATH" \
         "$SUMS_PATH"; do
  if [[ ! -e "$f" ]]; then
    echo "ERROR: Missing expected build artifact: $f" >&2
    exit 1
  fi
done

echo "==> [Verify 2/6] Verifying SHA-256 checksums..."
(
  cd "$DIST_DIR"
  shasum -a 256 -c "SHA256SUMS.txt"
)

echo "==> [Verify 3/6] Inspecting binary architectures and Info.plist metadata..."
file "$APP_BUNDLE/Contents/MacOS/ArtifactAtlasApp"
file "$APP_BUNDLE/Contents/Resources/runtime/node"
file "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
plutil -lint "$APP_BUNDLE/Contents/Info.plist"

echo "==> [Verify 4/6] Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

echo "==> [Verify 5/6] Mounting ArtifactAtlas-macOS.dmg read-only and verifying contents..."
MOUNT_DIR="$(mktemp -d /tmp/artifact-atlas-dmg-mount.XXXXXX)"
rmdir "$MOUNT_DIR"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -readonly -quiet

cleanup_dmg() {
  hdiutil detach "$MOUNT_DIR" -quiet || hdiutil detach "$MOUNT_DIR" -force -quiet || true
}
trap cleanup_dmg EXIT

ls -la "$MOUNT_DIR"
if [[ ! -d "$MOUNT_DIR/ArtifactAtlas.app" ]]; then
  echo "ERROR: ArtifactAtlas.app missing inside mounted DMG" >&2
  exit 1
fi
if [[ ! -L "$MOUNT_DIR/Applications" ]]; then
  echo "ERROR: /Applications symlink missing inside mounted DMG" >&2
  exit 1
fi

echo "==> [Verify 6/6] Running full workflow verification directly from read-only mounted DMG..."
ISOLATED_DATA_DIR="$(mktemp -d /tmp/artifact-atlas-dmg-e2e.XXXXXX)"
ATLAS_DATA_DIR="$ISOLATED_DATA_DIR" "$MOUNT_DIR/ArtifactAtlas.app/Contents/MacOS/ArtifactAtlasApp" --verify-workflow
rm -rf "$ISOLATED_DATA_DIR"

echo "==================================================================="
echo "  ALL PACKAGED .APP, .DMG, AND .ZIP CHECKS PASSED ON MACOS!"
echo "==================================================================="
