import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { parseVersion } from './update-check.js';

/**
 * Installs a newer release in place of the running application, when the user asks for it.
 *
 * Steps, each of which must succeed before the next:
 *   1. Download SHA256SUMS.txt and the release ZIP from the project's GitHub release.
 *   2. Check the ZIP against the published SHA-256 digest.
 *   3. Unpack it into a private staging folder and check that it is this application
 *      (bundle identifier), the expected version, and that its code signature is intact.
 *   4. Hand over to a small helper that waits for the app to quit, swaps the bundle,
 *      and starts the new version. If the swap fails, the old bundle is put back.
 *
 * Nothing about the user or their files is sent. Without an Apple Developer ID the release
 * cannot be tied to a publisher by signature, so its integrity rests on HTTPS to GitHub and
 * the published digest. Nothing is installed without a click.
 */

export const APP_BUNDLE_ID = 'com.artifactatlas.desktop';
export const ZIP_ASSET_NAME = 'ArtifactAtlas-macOS.zip';
export const SUMS_ASSET_NAME = 'SHA256SUMS.txt';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/yazicmert/basket/releases/download/';
const ALLOWED_FINAL_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const MAX_ZIP_BYTES = 400 * 1024 * 1024;

/** The .app bundle this backend runs inside, or null when run from source. */
export function findRunningAppBundle(modulePath) {
  const marker = `.app${path.sep}Contents${path.sep}Resources${path.sep}`;
  const at = String(modulePath || '').indexOf(marker);
  return at < 0 ? null : modulePath.slice(0, at + 4);
}

/**
 * Whether the running copy can be replaced in place. Returns { ok, reason }.
 * A copy run from the disk image, from a quarantine translocation, or from a folder the user
 * cannot write to has to be updated by hand.
 */
export function canInstallInPlace({ appBundlePath, platform = process.platform }) {
  if (platform !== 'darwin') return { ok: false, reason: 'NOT_MACOS' };
  if (!appBundlePath) return { ok: false, reason: 'NOT_PACKAGED' };
  if (appBundlePath.includes('/AppTranslocation/')) return { ok: false, reason: 'TRANSLOCATED' };
  if (appBundlePath.startsWith('/Volumes/')) return { ok: false, reason: 'RUNNING_FROM_DISK_IMAGE' };
  try {
    fs.accessSync(path.dirname(appBundlePath), fs.constants.W_OK);
    fs.accessSync(appBundlePath, fs.constants.W_OK);
  } catch {
    return { ok: false, reason: 'FOLDER_NOT_WRITABLE' };
  }
  return { ok: true, reason: null };
}

/** Download URLs for a version. Only the project's own release path is ever used. */
export function releaseAssetUrls(version) {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const tag = `v${parsed.join('.')}`;
  return {
    zipUrl: `${RELEASE_DOWNLOAD_PREFIX}${tag}/${ZIP_ASSET_NAME}`,
    sumsUrl: `${RELEASE_DOWNLOAD_PREFIX}${tag}/${SUMS_ASSET_NAME}`
  };
}

/** The digest SHA256SUMS.txt lists for a file name, or null. */
export function digestFromSums(sumsText, fileName) {
  for (const line of String(sumsText || '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2].trim() === fileName) {
      return match[1].toLowerCase();
    }
  }
  return null;
}

async function fetchChecked(url, fetchImpl) {
  if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
    throw new Error('UPDATE_URL_NOT_ALLOWED');
  }
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'ArtifactAtlas-updater' },
    signal: AbortSignal.timeout(5 * 60 * 1000)
  });
  // GitHub redirects release downloads to its own storage hosts; nothing else is accepted
  const finalHost = new URL(response.url || url).hostname;
  if (!ALLOWED_FINAL_HOSTS.has(finalHost)) {
    throw new Error('UPDATE_HOST_NOT_ALLOWED');
  }
  if (!response.ok) {
    throw new Error(`UPDATE_DOWNLOAD_HTTP_${response.status}`);
  }
  return response;
}

/**
 * Downloads the release ZIP for `version` into `stagingDir` and verifies its digest.
 * Returns the path of the verified ZIP.
 */
export async function downloadVerifiedRelease({ version, stagingDir, fetchImpl = globalThis.fetch, onProgress = null }) {
  const urls = releaseAssetUrls(version);
  if (!urls) throw new Error('UPDATE_VERSION_INVALID');

  const sumsText = await (await fetchChecked(urls.sumsUrl, fetchImpl)).text();
  const expected = digestFromSums(sumsText, ZIP_ASSET_NAME);
  if (!expected) throw new Error('UPDATE_DIGEST_MISSING');

  const response = await fetchChecked(urls.zipUrl, fetchImpl);
  const total = Number(response.headers?.get?.('content-length') || 0);
  if (total > MAX_ZIP_BYTES) throw new Error('UPDATE_TOO_LARGE');

  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const zipPath = path.join(stagingDir, ZIP_ASSET_NAME);
  const hash = crypto.createHash('sha256');
  const file = fs.openSync(zipPath, 'w', 0o600);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_ZIP_BYTES) throw new Error('UPDATE_TOO_LARGE');
      hash.update(buf);
      fs.writeSync(file, buf);
      if (onProgress) onProgress({ received, total });
    }
  } finally {
    fs.closeSync(file);
  }

  const actual = hash.digest('hex');
  if (actual !== expected) {
    fs.rmSync(zipPath, { force: true });
    throw new Error('UPDATE_DIGEST_MISMATCH');
  }
  return zipPath;
}

function plistString(xml, key) {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match ? match[1] : null;
}

/**
 * Unpacks a verified ZIP and checks that it holds this application at the expected version
 * with an intact code signature. Returns the staged bundle path. macOS only.
 */
export function stageVerifiedBundle({ zipPath, stagingDir, expectedVersion }) {
  const unpackDir = path.join(stagingDir, 'unpacked');
  fs.rmSync(unpackDir, { recursive: true, force: true });
  fs.mkdirSync(unpackDir, { recursive: true, mode: 0o700 });
  execFileSync('/usr/bin/ditto', ['-x', '-k', zipPath, unpackDir], { stdio: 'ignore' });

  const stagedBundle = path.join(unpackDir, 'ArtifactAtlas.app');
  const stat = fs.lstatSync(stagedBundle, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error('UPDATE_BUNDLE_MISSING');

  const plist = fs.readFileSync(path.join(stagedBundle, 'Contents', 'Info.plist'), 'utf8');
  if (plistString(plist, 'CFBundleIdentifier') !== APP_BUNDLE_ID) {
    throw new Error('UPDATE_BUNDLE_ID_MISMATCH');
  }
  const stagedVersion = plistString(plist, 'CFBundleShortVersionString');
  const want = parseVersion(expectedVersion);
  const got = parseVersion(stagedVersion);
  if (!want || !got || want.join('.') !== got.join('.')) {
    throw new Error('UPDATE_VERSION_MISMATCH');
  }
  // Fails if any file in the bundle was altered after it was signed
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedBundle], { stdio: 'ignore' });
  return stagedBundle;
}

/**
 * The helper that swaps the bundle once the app has quit. It only ever touches the app
 * bundle and the staging folder, keeps the old bundle until the new one is in place, and
 * restores it if the copy fails.
 */
export function swapScript() {
  return `#!/bin/bash
# Artifact Atlas update helper. Arguments: app bundle, staged bundle, app pid, staging dir, relaunch(1|0)
APP="$1"; NEW="$2"; APP_PID="$3"; STAGING="$4"; RELAUNCH="$5"
LOG="$STAGING/update.log"
exec >>"$LOG" 2>&1
echo "update started $(date)"

case "$APP" in */ArtifactAtlas.app) ;; *) echo "refusing: unexpected app path"; exit 2;; esac
case "$NEW" in "$STAGING"/*/ArtifactAtlas.app) ;; *) echo "refusing: unexpected staged path"; exit 2;; esac
[ -d "$NEW" ] || { echo "staged bundle missing"; exit 2; }

# Ask the app to quit, then wait for it
kill -TERM "$APP_PID" 2>/dev/null
for _ in $(seq 1 150); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.1; done
kill -KILL "$APP_PID" 2>/dev/null
sleep 0.3

BACKUP="$STAGING/previous/ArtifactAtlas.app"
rm -rf "$STAGING/previous"; mkdir -p "$STAGING/previous"
if ! mv "$APP" "$BACKUP"; then
  echo "could not move the current app aside"
  [ "$RELAUNCH" = "1" ] && /usr/bin/open "$APP"
  exit 1
fi
if /usr/bin/ditto "$NEW" "$APP"; then
  echo "installed"
  STATUS=0
else
  echo "copy failed, restoring the previous version"
  rm -rf "$APP"
  mv "$BACKUP" "$APP"
  STATUS=1
fi
[ "$RELAUNCH" = "1" ] && /usr/bin/open "$APP"
if [ "$STATUS" = "0" ]; then rm -rf "$STAGING/previous" "$STAGING/unpacked" "$STAGING/${ZIP_ASSET_NAME}"; fi
echo "update finished with status $STATUS"
exit $STATUS
`;
}

/** Starts the swap helper detached from this process, which is about to be stopped. */
export function launchSwap({ appBundlePath, stagedBundle, appPid, stagingDir, relaunch = true }) {
  const scriptPath = path.join(stagingDir, 'swap.sh');
  fs.writeFileSync(scriptPath, swapScript(), { mode: 0o700 });
  const child = spawn(
    '/bin/bash',
    [scriptPath, appBundlePath, stagedBundle, String(appPid), stagingDir, relaunch ? '1' : '0'],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  return scriptPath;
}

/** A private folder for one update attempt. */
export function createStagingDir(baseDir = os.tmpdir()) {
  return fs.mkdtempSync(path.join(baseDir, 'artifact-atlas-update-'));
}
