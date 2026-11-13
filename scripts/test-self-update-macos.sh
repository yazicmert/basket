#!/bin/bash
# End-to-end check of the in-place updater on macOS, using the freshly built bundle and ZIP
# in dist/. No network is used: the "download" is the local ZIP, and the "running app" is a
# sleep process. Verifies that the staged bundle is checked, the swap replaces the installed
# copy, and that a bad request leaves the installed copy untouched.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DIST_DIR/ArtifactAtlas.app/Contents/Info.plist")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> [Update 1/4] Installing a copy of $VERSION to replace..."
mkdir -p "$WORK/Applications" "$WORK/staging"
/usr/bin/ditto "$DIST_DIR/ArtifactAtlas.app" "$WORK/Applications/ArtifactAtlas.app"
touch "$WORK/Applications/ArtifactAtlas.app/Contents/OLD_COPY_MARKER"
cp "$DIST_DIR/ArtifactAtlas-macOS.zip" "$WORK/staging/ArtifactAtlas-macOS.zip"

sleep 300 &
FAKE_APP_PID=$!

echo "==> [Update 2/4] Staging the ZIP and checking identifier, version and signature..."
( cd "$ROOT_DIR" && node --input-type=module -e "
  import { stageVerifiedBundle, launchSwap } from './src/platform/self-update.js';
  const [staging, app, pid, version] = process.argv.slice(1);
  let refused = false;
  try { stageVerifiedBundle({ zipPath: staging + '/ArtifactAtlas-macOS.zip', stagingDir: staging, expectedVersion: '99.0.0' }); }
  catch (err) { refused = /UPDATE_VERSION_MISMATCH/.test(err.message); }
  if (!refused) { console.error('a wrong version was not refused'); process.exit(1); }
  const staged = stageVerifiedBundle({ zipPath: staging + '/ArtifactAtlas-macOS.zip', stagingDir: staging, expectedVersion: version });
  launchSwap({ appBundlePath: app, stagedBundle: staged, appPid: Number(pid), stagingDir: staging, relaunch: false });
" "$WORK/staging" "$WORK/Applications/ArtifactAtlas.app" "$FAKE_APP_PID" "$VERSION" )

echo "==> [Update 3/4] Waiting for the swap helper..."
for _ in $(seq 1 300); do
  grep -q "update finished" "$WORK/staging/update.log" 2>/dev/null && break
  sleep 0.1
done
cat "$WORK/staging/update.log"
grep -q "update finished with status 0" "$WORK/staging/update.log"

if kill -0 "$FAKE_APP_PID" 2>/dev/null; then echo "ERROR: the running app was not stopped"; exit 1; fi
if [ -e "$WORK/Applications/ArtifactAtlas.app/Contents/OLD_COPY_MARKER" ]; then echo "ERROR: the old copy is still installed"; exit 1; fi
/usr/bin/codesign --verify --deep --strict "$WORK/Applications/ArtifactAtlas.app"
if [ -e "$WORK/staging/previous" ]; then echo "ERROR: the previous copy was not cleaned up"; exit 1; fi

echo "==> [Update 4/4] A request with an unexpected path must change nothing..."
node -e "
  import('$ROOT_DIR/src/platform/self-update.js').then((m) => require('fs').writeFileSync(process.argv[1], m.swapScript(), { mode: 0o700 }));
" "$WORK/swap-check.sh"
sleep 0.5
set +e
/bin/bash "$WORK/swap-check.sh" "$WORK/Applications/ArtifactAtlas.app" "/tmp/NotStaged/ArtifactAtlas.app" 999999 "$WORK/staging" 0
STATUS=$?
set -e
if [ "$STATUS" -ne 2 ]; then echo "ERROR: an unexpected staged path was accepted (status $STATUS)"; exit 1; fi
/usr/bin/codesign --verify --deep --strict "$WORK/Applications/ArtifactAtlas.app"

echo "In-place update verified: staged, checked, swapped, and refused when it should be."
