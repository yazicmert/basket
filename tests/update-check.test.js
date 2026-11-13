import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkForUpdate,
  compareVersions,
  parseVersion,
  RELEASES_API_URL,
  RELEASES_PAGE_URL
} from '../src/platform/update-check.js';
import { resolveOpenTarget } from '../src/platform/permissions.js';
import { createAtlasServer } from '../src/ui/server.js';

const releaseResponse = (release, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => release
});

test('version parsing and comparison', () => {
  assert.deepEqual(parseVersion('v0.4.2'), [0, 4, 2]);
  assert.deepEqual(parseVersion('1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.ok(compareVersions('0.4.10', '0.4.9') > 0, 'numeric, not alphabetical');
  assert.ok(compareVersions('v1.0.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.4.1', '0.4.2') < 0);
  assert.equal(compareVersions('0.4.2', 'v0.4.2'), 0);
});

test('the update check reports a newer release and sends nothing but the request itself', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return releaseResponse({ tag_name: 'v0.5.0', draft: false, prerelease: false });
  };
  const result = await checkForUpdate({ currentVersion: '0.4.2', fetchImpl });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '0.5.0');
  assert.equal(result.releaseUrl, RELEASES_PAGE_URL);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_API_URL);
  assert.equal(calls[0].init.body, undefined, 'no request body');
  assert.equal(calls[0].init.method, undefined, 'a plain GET');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(calls[0].init.headers['User-Agent'], 'ArtifactAtlas/0.4.2');
});

test('the update check stays quiet when there is nothing to offer or the network fails', async () => {
  const check = (release, status) =>
    checkForUpdate({ currentVersion: '0.4.2', fetchImpl: async () => releaseResponse(release, status) });

  assert.equal((await check({ tag_name: 'v0.4.2' })).updateAvailable, false);
  assert.equal((await check({ tag_name: 'v0.4.1' })).updateAvailable, false);
  assert.equal((await check({ tag_name: 'v0.9.0', prerelease: true })).updateAvailable, false);
  assert.equal((await check({ tag_name: 'v0.9.0', draft: true })).updateAvailable, false);
  assert.equal((await check({ tag_name: 'nightly' })).error, 'NO_USABLE_RELEASE');
  assert.equal((await check({}, 403)).error, 'HTTP_403');

  const offline = await checkForUpdate({
    currentVersion: '0.4.2',
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  assert.equal(offline.updateAvailable, false);
  assert.equal(offline.error, 'NETWORK_ERROR');
  assert.equal((await checkForUpdate({ currentVersion: 'dev', fetchImpl: async () => releaseResponse({}) })).error, 'UNKNOWN_CURRENT_VERSION');
});

test('update endpoint: cached, switchable, persisted, and the open target is allowlisted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-update-'));
  let requests = 0;
  const options = {
    sandboxRoot: path.join(root, 'sandbox'),
    dataDir: root,
    appVersion: '0.4.2',
    updateFetch: async () => {
      requests += 1;
      return releaseResponse({ tag_name: 'v0.6.0' });
    }
  };
  let atlas = createAtlasServer(options);
  await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
  const api = async (method, body) => {
    const res = await fetch(`http://127.0.0.1:${atlas.server.address().port}/api/update`, {
      method,
      headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return (await res.json()).update;
  };
  try {
    const first = await api('GET');
    assert.equal(first.enabled, true);
    assert.equal(first.currentVersion, '0.4.2');
    assert.equal(first.latestVersion, '0.6.0');
    assert.equal(first.updateAvailable, true);
    await api('GET');
    assert.equal(requests, 1, 'the result is cached between checks');

    // Turning the check off stops all requests
    const off = await api('POST', { enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.updateAvailable, false);
    await api('GET');
    assert.equal(requests, 1);

    // The choice survives a restart
    await atlas.shutdown();
    atlas = createAtlasServer(options);
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await api('GET')).enabled, false);
    assert.equal(requests, 1);

    const on = await api('POST', { enabled: true, checkNow: true });
    assert.equal(on.updateAvailable, true);
    assert.equal(requests, 2);

    assert.equal(resolveOpenTarget('update:latest'), RELEASES_PAGE_URL);
    assert.equal(resolveOpenTarget('update:https://evil.example'), null);
  } finally {
    await atlas.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- In-place update ----------

const selfUpdate = await import('../src/platform/self-update.js');
const cryptoMod = await import('node:crypto');

function downloadResponse(body, { url, status = 200 } = {}) {
  const buf = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    text: async () => buf.toString('utf8'),
    body: (async function* () {
      yield buf.subarray(0, Math.ceil(buf.length / 2));
      yield buf.subarray(Math.ceil(buf.length / 2));
    })()
  };
}

test('updater: release URLs, digest parsing and where the app can replace itself', () => {
  assert.deepEqual(selfUpdate.releaseAssetUrls('v0.5.0'), {
    zipUrl: 'https://github.com/yazicmert/basket/releases/download/v0.5.0/ArtifactAtlas-macOS.zip',
    sumsUrl: 'https://github.com/yazicmert/basket/releases/download/v0.5.0/SHA256SUMS.txt'
  });
  assert.equal(selfUpdate.releaseAssetUrls('../../evil'), null);

  const digest = 'a'.repeat(64);
  const sums = `${'b'.repeat(64)}  ArtifactAtlas-macOS.dmg\n${digest}  ArtifactAtlas-macOS.zip\n`;
  assert.equal(selfUpdate.digestFromSums(sums, 'ArtifactAtlas-macOS.zip'), digest);
  assert.equal(selfUpdate.digestFromSums(sums, 'Other.zip'), null);
  assert.equal(selfUpdate.digestFromSums('not a sums file', 'ArtifactAtlas-macOS.zip'), null);

  const inBundle = '/Applications/ArtifactAtlas.app/Contents/Resources/app/src/ui/server.js';
  assert.equal(selfUpdate.findRunningAppBundle(inBundle), '/Applications/ArtifactAtlas.app');
  assert.equal(selfUpdate.findRunningAppBundle('/home/user/basket/src/ui/server.js'), null);

  const can = (appBundlePath, platform = 'darwin') => selfUpdate.canInstallInPlace({ appBundlePath, platform }).reason;
  assert.equal(can(null), 'NOT_PACKAGED');
  assert.equal(can('/Applications/ArtifactAtlas.app', 'linux'), 'NOT_MACOS');
  assert.equal(can('/Volumes/Artifact Atlas/ArtifactAtlas.app'), 'RUNNING_FROM_DISK_IMAGE');
  assert.equal(can('/private/var/folders/x/AppTranslocation/ABC/d/ArtifactAtlas.app'), 'TRANSLOCATED');
  assert.equal(can('/nonexistent-dir/ArtifactAtlas.app'), 'FOLDER_NOT_WRITABLE');
});

test('updater: a download is kept only when it matches the published digest and comes from GitHub', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-selfupdate-'));
  const zipBytes = Buffer.from('pretend this is the release zip '.repeat(200));
  const goodDigest = cryptoMod.createHash('sha256').update(zipBytes).digest('hex');
  const requested = [];
  const fetchWith = (sumsDigest, finalHost = 'release-assets.githubusercontent.com') => async (url, init) => {
    requested.push({ url, init });
    return url.endsWith('SHA256SUMS.txt')
      ? downloadResponse(`${sumsDigest}  ArtifactAtlas-macOS.zip\n`, { url })
      : downloadResponse(zipBytes, { url: `https://${finalHost}/some/object` });
  };
  try {
    const zipPath = await selfUpdate.downloadVerifiedRelease({
      version: '0.5.0',
      stagingDir: path.join(root, 'ok'),
      fetchImpl: fetchWith(goodDigest)
    });
    assert.deepEqual(fs.readFileSync(zipPath), zipBytes);
    assert.ok(requested.every((r) => r.url.startsWith('https://github.com/yazicmert/basket/releases/download/v0.5.0/')));
    assert.ok(requested.every((r) => r.init.body === undefined), 'nothing is sent');

    await assert.rejects(
      selfUpdate.downloadVerifiedRelease({ version: '0.5.0', stagingDir: path.join(root, 'bad'), fetchImpl: fetchWith('c'.repeat(64)) }),
      /UPDATE_DIGEST_MISMATCH/
    );
    assert.equal(fs.existsSync(path.join(root, 'bad', 'ArtifactAtlas-macOS.zip')), false, 'a mismatching download is removed');

    await assert.rejects(
      selfUpdate.downloadVerifiedRelease({ version: '0.5.0', stagingDir: path.join(root, 'host'), fetchImpl: fetchWith(goodDigest, 'evil.example') }),
      /UPDATE_HOST_NOT_ALLOWED/
    );
    await assert.rejects(
      selfUpdate.downloadVerifiedRelease({ version: '0.5.0', stagingDir: path.join(root, 'nosum'), fetchImpl: async (url) => downloadResponse('nothing useful', { url }) }),
      /UPDATE_DIGEST_MISSING/
    );
    await assert.rejects(
      selfUpdate.downloadVerifiedRelease({ version: 'latest', stagingDir: path.join(root, 'v'), fetchImpl: fetchWith(goodDigest) }),
      /UPDATE_VERSION_INVALID/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updater: a copy that cannot replace itself reports why, and the install route refuses', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-install-'));
  let requests = 0;
  const atlas = createAtlasServer({
    sandboxRoot: path.join(root, 'sandbox'),
    dataDir: root,
    appVersion: '0.4.2',
    appBundlePath: null,
    updateFetch: async () => {
      requests += 1;
      return releaseResponse({ tag_name: 'v0.6.0' });
    }
  });
  await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
  const call = async (urlPath, method) => {
    const res = await fetch(`http://127.0.0.1:${atlas.server.address().port}${urlPath}`, {
      method,
      headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    const status = (await call('/api/update', 'GET')).data.update;
    assert.equal(status.updateAvailable, true);
    assert.equal(status.install.ok, false);
    assert.equal(status.install.phase, 'idle');

    const install = await call('/api/update/install', 'POST');
    assert.equal(install.status, 409);
    assert.equal(install.data.ok, false);
    assert.equal(requests, 1, 'nothing is downloaded when the copy cannot be replaced');
    assert.equal((await call('/api/update/install', 'GET')).status, 404);
  } finally {
    await atlas.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updater: the swap helper refuses unexpected paths and keeps the previous version until done', () => {
  const script = selfUpdate.swapScript();
  assert.match(script, /case "\$APP" in \*\/ArtifactAtlas\.app\) ;; \*\) echo "refusing/);
  assert.match(script, /case "\$NEW" in "\$STAGING"\/\*\/ArtifactAtlas\.app\) ;;/);
  // The old bundle is moved aside before the copy and restored if the copy fails
  assert.ok(script.indexOf('mv "$APP" "$BACKUP"') < script.indexOf('ditto "$NEW" "$APP"'));
  assert.match(script, /copy failed, restoring the previous version[\s\S]*mv "\$BACKUP" "\$APP"/);
  // Every rm stays inside the staging folder or is the half-copied app being replaced
  const removals = script.match(/rm -rf [^\n;]+/g) || [];
  assert.ok(removals.length > 0);
  for (const line of removals) {
    assert.ok(/^rm -rf ("\$STAGING\/[^"]+"( |$))+$/.test(line) || line === 'rm -rf "$APP"', line);
  }
});
