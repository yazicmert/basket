import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtlasServer } from '../src/ui/server.js';

test('HTTP Desktop UI Server & REST API end-to-end integration test', async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-server-test-'));
  const { server, service } = createAtlasServer({ sandboxRoot });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Verify UI HTML serves cleanly
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Drop an AI application to explore its artifacts.'));

    // 2. Verify /api/bootstrap
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`);
    const bootData = await bootRes.json();
    assert.equal(bootData.ok, true);
    assert.ok(bootData.availableBundles.length >= 4);

    const claudeBundle = bootData.availableBundles.find((b) => b.name === 'Claude Code');
    assert.ok(claudeBundle);

    // 3. Verify /api/app/identify
    const idRes = await fetch(`${baseUrl}/api/app/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundlePath: claudeBundle.bundlePath })
    });
    const idData = await idRes.json();
    assert.equal(idData.ok, true);
    assert.equal(idData.application.bundleId, 'com.anthropic.claudefordesktop');

    // 4. Verify /api/scan/start
    const scanRes = await fetch(`${baseUrl}/api/scan/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundlePath: claudeBundle.bundlePath })
    });
    const scanData = await scanRes.json();
    assert.equal(scanData.ok, true);
    assert.ok(scanData.state.graph.nodes.length > 10);

    // 5. Verify /api/graph/trace on a low-risk artifact
    const lowRiskArt = scanData.state.artifacts.find(
      (a) => a.cleanupClassification === 'LOW'
    );
    assert.ok(lowRiskArt);

    const traceRes = await fetch(`${baseUrl}/api/graph/trace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: lowRiskArt.id })
    });
    const traceData = await traceRes.json();
    assert.equal(traceData.ok, true);
    assert.ok(traceData.trace.highlightedNodeIds.includes(lowRiskArt.id));

    // 6. Verify /api/cleanup/review & /api/cleanup/quarantine & /api/cleanup/restore
    const revRes = await fetch(`${baseUrl}/api/cleanup/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactIds: [lowRiskArt.id] })
    });
    const revData = await revRes.json();
    assert.equal(revData.ok, true);
    assert.equal(revData.review.totalEligibleCount, 1);

    const qRes = await fetch(`${baseUrl}/api/cleanup/quarantine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
