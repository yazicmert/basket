import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GraphEngine,
  selectArtifactsForMap,
  buildFolderRollups,
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

test('the UI receives summaries, selects files by description, and app-container caches are safe', async () => {
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
    const post = async (urlPath, body) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
        method: 'POST',
        headers: { 'X-Atlas-Token': sessionToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return r.json();
    };

    // Only summaries travel to the UI
    assert.deepEqual(
      Object.keys(state).sort(),
      ['application', 'graph', 'isDemoEnvironment', 'scan', 'workspaces']
    );
    assert.equal(state.graph.stats.artifactCount, 2);
    for (const grouping of ['byGroup', 'byFolder']) {
      assert.ok(state.graph.treemap[grouping].length > 0, grouping);
      assert.ok(state.graph.treemap[grouping].every((cell) => cell.artifactIds === undefined));
    }

    // The cache file is safe to remove, the stored data is not
    const cachedNode = state.graph.nodes.find((n) => n.label === 'f_000001');
    const storedNode = state.graph.nodes.find((n) => n.label === 'store.bin');
    assert.equal(cachedNode.metadata.artifactType, 'REGENERABLE_CACHE');
    assert.equal(cachedNode.riskCategory, 'LOW');
    assert.notEqual(storedNode.riskCategory, 'LOW');

    // Selection by description resolves on the server
    const safe = await post('/api/selection/resolve', { kind: 'safe' });
    assert.deepEqual(safe.artifactIds, [cachedNode.id]);
    assert.equal(safe.summary.count, 1);
    assert.equal(safe.summary.physicalBytes, 6);
    assert.ok(safe.summary.firstPath.endsWith('f_000001'));

    const folderCell = state.graph.treemap.byFolder.find((c) => c.label.startsWith('Cache'));
    const inFolder = await post('/api/selection/resolve', { kind: 'cell', groupBy: 'byFolder', cellId: folderCell.id });
    assert.deepEqual(inFolder.artifactIds, [cachedNode.id]);

    const both = await post('/api/selection/summary', { artifactIds: [cachedNode.id, storedNode.id, 'art_missing'] });
    assert.equal(both.summary.count, 2);
    assert.equal((await post('/api/selection/resolve', { kind: 'everything' })).ok, false);
  } finally {
    await shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folder rollups cover every file once and split the fullest folders', () => {
  const artifacts = [];
  const add = (dir, n, risk = 'REVIEW') => {
    for (let i = 0; i < n; i++) {
      const id = artifacts.length;
      artifacts.push(
        fakeArtifact(id, {
          canonicalPath: `/home/u/Library/Application Support/Big/${dir}/f_${i}`,
          parentDir: `/home/u/Library/Application Support/Big/${dir}`,
          sizeBytes: 10,
          cleanupClassification: risk
        })
      );
    }
  };
  add('Cache/Cache_Data', 900, 'LOW');
  add('vm_bundles/img/a', 2000);
  add('vm_bundles/img/b', 1500);
  add('vm_bundles/node_modules/x', 800, 'PROTECTED');
  add('logs', 40, 'LOW');
  // Files directly in the common folder, and a hardlinked pair that must count once
  artifacts.push(fakeArtifact(9000, { canonicalPath: '/home/u/Library/Application Support/Big/config.json', parentDir: '/home/u/Library/Application Support/Big', sizeBytes: 10 }));
  artifacts.push(fakeArtifact(9001, { canonicalPath: '/home/u/Library/Application Support/Big/logs/link', parentDir: '/home/u/Library/Application Support/Big/logs', sizeBytes: 500, physicalInodeKey: '1:77' }));
  artifacts.push(fakeArtifact(9002, { canonicalPath: '/home/u/Library/Application Support/Big/logs/link2', parentDir: '/home/u/Library/Application Support/Big/logs', sizeBytes: 500, physicalInodeKey: '1:77' }));

  const rollups = buildFolderRollups(artifacts);
  const totalFiles = rollups.reduce((sum, r) => sum + r.artifactCount, 0);
  const assigned = rollups.flatMap((r) => r.artifactIds);
  assert.equal(totalFiles, artifacts.length);
  assert.equal(new Set(assigned).size, artifacts.length, 'every file belongs to exactly one folder');
  assert.ok(rollups.every((r) => r.artifactIds.length === r.artifactCount));

  const byLabel = new Map(rollups.map((r) => [r.label, r]));
  // The largest folder was split into its subfolders
  assert.equal(byLabel.has('vm_bundles'), false);
  assert.equal(byLabel.get('vm_bundles/img/a').artifactCount, 2000);
  assert.equal(byLabel.get('vm_bundles/node_modules/x').riskCategory, 'PROTECTED');
  // A folder is safe only when all of its files are
  assert.equal(byLabel.get('Cache/Cache_Data').riskCategory, 'LOW');
  assert.equal(byLabel.get('logs').riskCategory, 'REVIEW');
  // Hardlinked data is counted once: 40 x 10 + 500
  assert.equal(byLabel.get('logs').bytes, 900);
  // Files directly in the common folder keep their own entry
  assert.equal(byLabel.get('Big (files directly inside)').artifactCount, 1);

  assert.deepEqual(buildFolderRollups([]), []);
});
