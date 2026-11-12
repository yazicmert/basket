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
