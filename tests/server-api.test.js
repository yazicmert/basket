import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createAtlasServer } from '../src/ui/server.js';

test('HTTP Desktop UI Server & REST API end-to-end integration test', async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-server-test-'));
  const { server, service, sessionToken } = createAtlasServer({ sandboxRoot, dataDir: sandboxRoot });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1', 'Server must bind strictly to loopback 127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Verify UI HTML serves cleanly and injects atlas-api-token meta tag
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Drop an app to see what it left behind.'));
    assert.ok(htmlText.includes('meta name="atlas-api-token"'));

    assert.ok(htmlText.includes(`content="${sessionToken}"`));

    // 2. Verify /api/bootstrap (token is always required, even without an explicit --api-token)
    assert.equal((await fetch(`${baseUrl}/api/bootstrap`)).status, 401);
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'X-Atlas-Token': sessionToken }
    });
    const bootData = await bootRes.json();
    assert.equal(bootData.ok, true);
    assert.ok(bootData.availableBundles.length >= 4);

    const claudeBundle = bootData.availableBundles.find((b) => b.name === 'Claude Code');
    assert.ok(claudeBundle);

    // 3. Verify /api/app/identify
    const idRes = await fetch(`${baseUrl}/api/app/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ bundlePath: claudeBundle.bundlePath })
    });
    const idData = await idRes.json();
    assert.equal(idData.ok, true);
    assert.equal(idData.application.bundleId, 'com.anthropic.claudefordesktop');

    // 4. Verify /api/scan/start
    const scanRes = await fetch(`${baseUrl}/api/scan/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ bundlePath: claudeBundle.bundlePath })
    });
    const scanData = await scanRes.json();
    assert.equal(scanData.ok, true);
    assert.equal(scanData.state.graph.nodes.length, 0, 'the map is fetched level by level');
    const rootRes = await fetch(`${baseUrl}/api/map/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ levelId: 'root' })
    });
    const rootLevel = (await rootRes.json()).level;
    assert.ok(rootLevel.nodes.length >= 4 && rootLevel.nodes.length <= 60);

    // 5. Verify /api/graph/trace on a low-risk artifact
    // The file list stays on the server; the UI asks for ids by description
    const safeRes = await fetch(`${baseUrl}/api/selection/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ kind: 'safe' })
    });
    const safeData = await safeRes.json();
    assert.ok(safeData.artifactIds.length > 0);
    assert.equal(safeData.summary.count, safeData.artifactIds.length);
    assert.ok(safeData.summary.physicalBytes > 0);
    const lowRiskArt = { id: safeData.artifactIds[0] };
    assert.equal(scanData.state.artifacts, undefined);

    const traceRes = await fetch(`${baseUrl}/api/graph/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ nodeId: lowRiskArt.id })
    });
    const traceData = await traceRes.json();
    assert.equal(traceData.ok, true);
    assert.ok(traceData.trace.highlightedNodeIds.includes(lowRiskArt.id));

    // 6. Verify /api/cleanup/review & /api/cleanup/quarantine & /api/cleanup/restore
    const revRes = await fetch(`${baseUrl}/api/cleanup/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({ artifactIds: [lowRiskArt.id] })
    });
    const revData = await revRes.json();
    assert.equal(revData.ok, true);
    assert.equal(revData.review.totalEligibleCount, 1);

    const qRes = await fetch(`${baseUrl}/api/cleanup/quarantine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({
        artifactIds: [lowRiskArt.id],
        confirmationToken: revData.review.confirmationToken
      })
    });
    const qData = await qRes.json();
    assert.equal(qData.ok, true);
    assert.equal(qData.quarantinedEntries.length, 1);

    const restoreRes = await fetch(`${baseUrl}/api/cleanup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': sessionToken },
      body: JSON.stringify({
        entryId: qData.quarantinedEntries[0].id,
        conflictStrategy: 'FAIL_IF_EXISTS'
      })
    });
    const restoreData = await restoreRes.json();
    assert.equal(restoreData.ok, true);
    assert.equal(restoreData.restored, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    service.sqliteStore.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('Local API protection: enforces X-Atlas-Token authentication and blocks cross-origin CSRF', async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sec-test-'));
  const secretToken = 'test_secret_token_998877';
  const { server, shutdown } = createAtlasServer({
    sandboxRoot,
    dataDir: sandboxRoot,
    apiToken: secretToken
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Unauthenticated /api/bootstrap must fail with 401
    const unauthRes = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(unauthRes.status, 401);

    // 2. Authenticated /api/bootstrap with X-Atlas-Token succeeds
    const authRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'X-Atlas-Token': secretToken }
    });
    assert.equal(authRes.status, 200);

    // 3. Cross-origin request with Origin: https://evil.example.com must fail with 403
    const csrfRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: {
        'X-Atlas-Token': secretToken,
        Origin: 'https://evil.example.com'
      }
    });
    assert.equal(csrfRes.status, 403);
  } finally {
    await shutdown();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('Spawned backend lifecycle: starts on loopback port 0 and shuts down cleanly when stdin closes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-spawn-test-'));
  const cliPath = path.resolve('src/cli.js');

  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--port', '0', '--data-dir', dataDir, '--api-token', 'spawn_tok_123', '--watch-stdin'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  try {
    const readyPayload = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for ATLAS_SERVER_READY')), 8000);
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (const line of buffer.split('\n')) {
          if (line.startsWith('ATLAS_SERVER_READY:')) {
            clearTimeout(timeout);
            resolve(JSON.parse(line.slice('ATLAS_SERVER_READY:'.length)));
          }
        }
      });
      child.on('error', reject);
    });

    assert.equal(readyPayload.host, '127.0.0.1');
    assert.ok(readyPayload.port > 0);

    const healthRes = await fetch(`${readyPayload.url}/api/health`);
    assert.equal(healthRes.status, 200);

    // Closing stdin simulates the parent macOS app exiting
    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    const exitCode = await exitPromise;
    assert.equal(exitCode, 0);
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
