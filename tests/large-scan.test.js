import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GraphEngine,
  selectArtifactsForMap,
  MAP_MAX_ARTIFACT_NODES
} from '../src/graph/graph-engine.js';
import { isAppContainerCachePath } from '../src/classification/classification-engine.js';
import { createAtlasServer } from '../src/ui/server.js';

function fakeArtifact(i, overrides = {}) {
  return {
    id: `art_${i}`,
    name: `file_${i}`,
    canonicalPath: `/home/u/Library/Application Support/Big/file_${i}`,
    sizeBytes: 100 + i,
    artifactType: 'UNKNOWN',
    provenanceConfidence: 'INFERRED',
    cleanupClassification: 'REVIEW',
    sessionIds: [],
    quarantined: false,
    ...overrides
  };
}

test('a large scan draws a bounded selection of files while totals cover every file', () => {
  const artifacts = [];
  for (let i = 0; i < 5000; i++) {
    artifacts.push(fakeArtifact(i));
  }
  // Small files that a session recorded must still be drawn
  const recorded = [3, 17, 42].map((i) => artifacts[i]);
  recorded.forEach((a) => { a.provenanceConfidence = 'VERIFIED'; });
  artifacts[7].cleanupClassification = 'LOW';

  const groups = [
    { id: 'grp_a', name: 'Group A', artifactType: 'UNKNOWN', artifactIds: artifacts.slice(0, 2500).map((a) => a.id), deduplicatedBytes: 1, riskSummary: 'REVIEW' },
    { id: 'grp_b', name: 'Group B', artifactType: 'LOG', artifactIds: artifacts.slice(2500).map((a) => a.id), deduplicatedBytes: 1, riskSummary: 'REVIEW' }
  ];

  const shown = selectArtifactsForMap(artifacts, groups);
  assert.equal(shown.length, MAP_MAX_ARTIFACT_NODES);
  for (const a of recorded) {
    assert.ok(shown.includes(a), `${a.id} was recorded by a session and must be on the map`);
  }
  assert.ok(shown.includes(artifacts[4999]), 'the largest file is on the map');
  assert.ok(shown.some((a) => groups[0].artifactIds.includes(a.id)), 'every group is represented');

  const graph = new GraphEngine().buildKnowledgeGraph({
    application: { id: 'app_big', name: 'Big', adapterId: 'generic-macos-app' },
    artifacts,
    artifactGroups: groups
  });
  const fileNodes = graph.nodes.filter((n) => n.nodeType === 'ARTIFACT');
  assert.equal(fileNodes.length, MAP_MAX_ARTIFACT_NODES);
  assert.equal(graph.stats.artifactCount, 5000);
  assert.equal(graph.stats.shownArtifactCount, MAP_MAX_ARTIFACT_NODES);
  assert.equal(graph.stats.hiddenArtifactCount, 5000 - MAP_MAX_ARTIFACT_NODES);
  assert.deepEqual(graph.stats.riskCounts, { REVIEW: 4999, LOW: 1 });
  assert.equal(graph.stats.largestArtifact.id, 'art_4999');
  // Every edge still connects two nodes that exist
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.every((e) => ids.has(e.sourceId) && ids.has(e.targetId)));

  // A small scan is drawn in full
  assert.equal(selectArtifactsForMap(artifacts.slice(0, 50), groups).length, 50);
});

test('Chromium cache folders count as caches only inside an application data container', () => {
  const inside = '/users/u/library/application support/claude/';
  assert.ok(isAppContainerCachePath(`${inside}cache/cache_data/f_0001`));
  assert.ok(isAppContainerCachePath(`${inside}dawngraphitecache/data_1`));
  assert.ok(isAppContainerCachePath(`${inside}service worker/cachestorage/abc/1`));
  assert.ok(isAppContainerCachePath('/users/u/library/containers/com.example.app/data/cache/x'));
  // The same folder name elsewhere proves nothing
  assert.equal(isAppContainerCachePath('/users/u/projects/site/cache/page.html'), false);
  assert.equal(isAppContainerCachePath('/users/u/documents/cache/report.pdf'), false);
  // Other data inside the container is not a cache
  assert.equal(isAppContainerCachePath(`${inside}indexeddb/store.leveldb/000003.log`), false);
  assert.equal(isAppContainerCachePath(`${inside}config.json`), false);
});

test('the scan response sent to the UI is lean and classifies app-container caches as safe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-lean-'));
  const homeDir = path.join(root, 'home');
  const appsDir = path.join(root, 'Applications');
  const bundle = path.join(appsDir, 'Lean.app');
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Lean</string><key>CFBundleIdentifier</key><string>com.example.lean</string></dict></plist>'
  );
  const data = path.join(homeDir, 'Library', 'Application Support', 'Lean');
  fs.mkdirSync(path.join(data, 'Cache', 'Cache_Data'), { recursive: true });
  fs.mkdirSync(path.join(data, 'IndexedDB'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Cache', 'Cache_Data', 'f_000001'), 'cached');
  fs.writeFileSync(path.join(data, 'IndexedDB', 'store.bin'), 'user data');

  const { server, sessionToken, shutdown } = createAtlasServer({
    sandboxRoot: path.join(root, 'sandbox'),
    homeDir,
    dataDir: path.join(root, 'data'),
    applicationDirs: [appsDir]
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/scan/start`, {
      method: 'POST',
      headers: { 'X-Atlas-Token': sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundlePath: bundle })
    });
    const { state } = await res.json();
    assert.deepEqual(
      Object.keys(state).sort(),
      ['application', 'artifacts', 'graph', 'isDemoEnvironment', 'scan', 'workspaces']
    );
    const cached = state.artifacts.find((a) => a.name === 'f_000001');
    const stored = state.artifacts.find((a) => a.name === 'store.bin');
    assert.equal(cached.artifactType, 'REGENERABLE_CACHE');
    assert.equal(cached.cleanupClassification, 'LOW');
    assert.notEqual(stored.cleanupClassification, 'LOW');
    // Heavy per-file detail stays on the server
    assert.equal(cached.evidence, undefined);
    assert.equal(cached.cleanupExplanation, undefined);
    assert.equal(state.graph.stats.artifactCount, 2);
  } finally {
    await shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
