#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Artifact Atlas — Reproducible macOS Application, DMG & ZIP Packager
# Produces:
#   - dist/ArtifactAtlas.app
#   - dist/ArtifactAtlas-macOS.dmg
#   - dist/ArtifactAtlas-macOS.zip
#   - dist/SHA256SUMS.txt
# ==============================================================================

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: scripts/package-macos.sh must be run on macOS (Darwin)." >&2
  echo "Current OS is $(uname -s). Use the GitHub Actions macOS workflow (.github/workflows/macos-build.yml) to build genuine macOS releases." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="ArtifactAtlas"
APP_DISPLAY_NAME="Artifact Atlas"
BUNDLE_ID="com.artifactatlas.desktop"
APP_VERSION="${APP_VERSION:-0.3.0}"
BUILD_NUMBER="${BUILD_NUMBER:-200}"
MIN_MACOS_VERSION="14.0"
TARGET_ARCH="${TARGET_ARCH:-$(uname -m)}"

if [[ "$TARGET_ARCH" == "arm64" ]]; then
  NODE_ARCH="arm64"
  SWIFT_ARCH_FLAGS=(--arch arm64)
elif [[ "$TARGET_ARCH" == "x86_64" ]]; then
  NODE_ARCH="x64"
  SWIFT_ARCH_FLAGS=(--arch x86_64)
elif [[ "$TARGET_ARCH" == "universal" ]]; then
  NODE_ARCH="arm64"
  SWIFT_ARCH_FLAGS=(--arch arm64 --arch x86_64)
else
  echo "Unsupported TARGET_ARCH: $TARGET_ARCH (expected arm64, x86_64, or universal)" >&2
  exit 1
fi

DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/${APP_NAME}.app"
CONTENTS_DIR="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/runtime"
BUNDLED_APP_DIR="$RESOURCES_DIR/app"

echo "==> [1/8] Cleaning previous build outputs in $DIST_DIR..."
rm -rf "$DIST_DIR"
mkdir -p "$MACOS_DIR" "$RUNTIME_DIR" "$BUNDLED_APP_DIR"

echo "==> [2/8] Compiling native Swift macOS executable ($TARGET_ARCH)..."
swift build -c release "${SWIFT_ARCH_FLAGS[@]}"
BIN_PATH="$(swift build -c release "${SWIFT_ARCH_FLAGS[@]}" --show-bin-path)"
cp "$BIN_PATH/ArtifactAtlasApp" "$MACOS_DIR/ArtifactAtlasApp"
chmod 755 "$MACOS_DIR/ArtifactAtlasApp"

echo "==> [3/8] Generating macOS AppIcon.icns..."
swift "$ROOT_DIR/scripts/generate-app-icon.swift" "$RESOURCES_DIR/AppIcon.icns"

echo "==> [4/8] Bundling standalone Node.js runtime (with built-in node:sqlite)..."
resolve_standalone_node() {
  # Check if current node binary is standalone (does not link against /opt/homebrew or /usr/local/opt dylibs)
  if command -v node >/dev/null 2>&1; then
    local candidate
    candidate="$(command -v node)"
    local node_major
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$node_major" -ge 22 ]]; then
      if ! otool -L "$candidate" | grep -qE '(/opt/homebrew/|/usr/local/Cellar/|/usr/local/opt/)'; then
        echo "    Using standalone Node.js binary from $candidate (v$(node -v))"
        cp "$candidate" "$RUNTIME_DIR/node"
        chmod 755 "$RUNTIME_DIR/node"
        return 0
      fi
    fi
  fi

  # Otherwise download official standalone Node.js darwin tarball from nodejs.org
  local node_ver="${BUNDLED_NODE_VERSION:-v22.14.0}"
  local tarball="node-${node_ver}-darwin-${NODE_ARCH}.tar.gz"
  local url="https://nodejs.org/dist/${node_ver}/${tarball}"
  local tmp_dl
  tmp_dl="$(mktemp -d)"
  echo "    Downloading standalone Node.js runtime from $url..."
  curl -fsSL "$url" -o "$tmp_dl/$tarball"
  tar -xzf "$tmp_dl/$tarball" -C "$tmp_dl"
  cp "$tmp_dl/node-${node_ver}-darwin-${NODE_ARCH}/bin/node" "$RUNTIME_DIR/node"
  chmod 755 "$RUNTIME_DIR/node"
  rm -rf "$tmp_dl"
}

resolve_standalone_node

echo "    Verifying bundled Node.js shared library dependencies (otool -L)..."
otool -L "$RUNTIME_DIR/node"
if otool -L "$RUNTIME_DIR/node" | grep -qE '(/opt/homebrew/|/usr/local/Cellar/|/usr/local/opt/)'; then
  echo "ERROR: Bundled node binary links against non-system Homebrew libraries!" >&2
  exit 1
fi

echo "==> [5/8] Bundling Artifact Atlas backend engine & UI assets..."
cp "$ROOT_DIR/package.json" "$BUNDLED_APP_DIR/package.json"
cp -R "$ROOT_DIR/src" "$BUNDLED_APP_DIR/src"

cat > "$CONTENTS_DIR/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_DISPLAY_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_DISPLAY_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_NUMBER}</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>AATL</string>
  <key>CFBundleExecutable</key>
  <string>ArtifactAtlasApp</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>${MIN_MACOS_VERSION}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright © 2026 Artifact Atlas Contributors. MIT License.</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>Artifact Atlas scans project folders on your Desktop that an AI session worked in, to link the files it created to that session.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Artifact Atlas scans project folders in Documents that an AI session worked in, to link the files it created to that session.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>Artifact Atlas scans project folders in Downloads that an AI session worked in, to link the files it created to that session.</string>
  <key>NSAppDataUsageDescription</key>
  <string>Artifact Atlas lists the files inside the sandbox container of the application you dropped, to show its leftovers.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

printf "APPLAATL" > "$CONTENTS_DIR/PkgInfo"

echo "==> [6/8] Code signing ArtifactAtlas.app..."
ENTITLEMENTS="$ROOT_DIR/packaging/entitlements.plist"
if [[ -n "${APPLE_DEVELOPER_ID_APPLICATION:-}" ]]; then
  echo "    Signing with Developer ID identity: $APPLE_DEVELOPER_ID_APPLICATION"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_DEVELOPER_ID_APPLICATION" "$RUNTIME_DIR/node"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_DEVELOPER_ID_APPLICATION" "$MACOS_DIR/ArtifactAtlasApp"
  codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$APPLE_DEVELOPER_ID_APPLICATION" "$APP_BUNDLE"
else
  echo "    No APPLE_DEVELOPER_ID_APPLICATION set; applying ad-hoc signature for local execution..."
  codesign --force --entitlements "$ENTITLEMENTS" --sign - "$RUNTIME_DIR/node"
  codesign --force --entitlements "$ENTITLEMENTS" --sign - "$MACOS_DIR/ArtifactAtlasApp"
  codesign --force --entitlements "$ENTITLEMENTS" --sign - "$APP_BUNDLE"
fi

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

echo "==> [7/8] Running End-to-End Packaged Application Workflow Verification..."
"$MACOS_DIR/ArtifactAtlasApp" --verify-workflow

echo "==> [8/8] Creating ArtifactAtlas-macOS.zip, ArtifactAtlas-macOS.dmg, and SHA256SUMS.txt..."
ZIP_PATH="$DIST_DIR/ArtifactAtlas-macOS.zip"
DMG_PATH="$DIST_DIR/ArtifactAtlas-macOS.dmg"

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP_PATH"

DMG_STAGE="$(mktemp -d)"
cp -R "$APP_BUNDLE" "$DMG_STAGE/ArtifactAtlas.app"
ln -s /Applications "$DMG_STAGE/Applications"

hdiutil create \
  -volname "$APP_DISPLAY_NAME" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

rm -rf "$DMG_STAGE"

# Optional Apple Notarization if Developer ID & notarytool credentials are provided
if [[ -n "${APPLE_DEVELOPER_ID_APPLICATION:-}" && -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "    Submitting $DMG_PATH for Apple Notarization..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait
  xcrun stapler staple "$DMG_PATH"
else
  echo "    Skipping Apple notarization (notarization credentials not configured)."
fi

(
  cd "$DIST_DIR"
  shasum -a 256 "ArtifactAtlas-macOS.dmg" "ArtifactAtlas-macOS.zip" > "SHA256SUMS.txt"
)

echo "==================================================================="
echo "  macOS Packaging Complete!"
echo "==================================================================="
ls -lh "$DIST_DIR"
cat "$DIST_DIR/SHA256SUMS.txt"
