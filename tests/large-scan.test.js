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
    platform: 'darwin',
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
      ['application', 'graph', 'isDemoEnvironment', 'promptCosts', 'scan', 'workspaces']
    );
    assert.equal(state.graph.stats.artifactCount, 2);
    for (const grouping of ['byGroup', 'byFolder']) {
      assert.ok(state.graph.treemap[grouping].length > 0, grouping);
      assert.ok(state.graph.treemap[grouping].every((cell) => cell.artifactIds === undefined));
    }

    // The map arrives one level at a time; open the kinds to reach the two files
    const root = (await post('/api/map/level', { levelId: 'root' })).level;
    const fileNodes = [];
    for (const kind of root.nodes.filter((n) => n.drillId)) {
      const level = (await post('/api/map/level', { levelId: kind.drillId })).level;
      fileNodes.push(...level.nodes.filter((n) => n.nodeType === 'ARTIFACT'));
    }
    // The cache file is safe to remove, the stored data is not
    const cachedNode = fileNodes.find((n) => n.label === 'f_000001');
    const storedNode = fileNodes.find((n) => n.label === 'store.bin');
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

test('a scan with thousands of tool calls draws only the ones that touched a drawn file', () => {
  const artifacts = [];
  const operations = [];
  for (let i = 0; i < 2000; i++) {
    artifacts.push(fakeArtifact(i, { operationIds: [`op_${i}`], provenanceConfidence: i < 50 ? 'VERIFIED' : 'INFERRED' }));
  }
  for (let i = 0; i < 9000; i++) {
    operations.push({ id: `op_${i}`, toolName: 'Write', sequence: i, operationType: 'WRITE', confidence: 'VERIFIED', sessionId: 'sess_1' });
  }
  const groups = [{ id: 'grp', name: 'Group', artifactType: 'UNKNOWN', artifactIds: artifacts.map((a) => a.id), deduplicatedBytes: 1, riskSummary: 'REVIEW' }];
  const graph = new GraphEngine().buildKnowledgeGraph({
    application: { id: 'app', name: 'Big', adapterId: 'claude-code' },
    artifacts,
    artifactGroups: groups,
    operations
  });
  const opNodes = graph.nodes.filter((n) => n.nodeType === 'OPERATION');
  const shownFiles = new Set(graph.nodes.filter((n) => n.nodeType === 'ARTIFACT').map((n) => n.id));
  assert.ok(opNodes.length > 0 && opNodes.length <= 160, `drew ${opNodes.length} tool calls`);
  assert.ok(opNodes.every((op) => shownFiles.has(`art_${op.id.slice(3)}`)), 'each drawn tool call touched a drawn file');
  assert.equal(graph.stats.operationCount, 9000);
  assert.ok(graph.nodes.length < 700, `map has ${graph.nodes.length} nodes`);
});

test('map levels: few marks per level, folders open into their contents, and every file is reachable', async () => {
  const { buildMapLevel, levelArtifactIds } = await import('../src/graph/map-levels.js');
  const base = '/home/u/Library/Application Support/Big';
  const artifacts = [];
  const add = (dir, n, extra = {}) => {
    for (let i = 0; i < n; i++) {
      artifacts.push(
        fakeArtifact(artifacts.length, {
          canonicalPath: `${base}/${dir}/f_${i}`,
          parentDir: `${base}/${dir}`,
          sizeBytes: 100 + i,
          groupId: extra.groupId,
          ...extra
        })
      );
    }
  };
  add('Cache/Cache_Data', 3000, { groupId: 'grp_cache', cleanupClassification: 'LOW' });
  add('Cache/GPUCache', 40, { groupId: 'grp_cache', cleanupClassification: 'LOW' });
  add('logs/2026/11', 500, { groupId: 'grp_logs' });
  const groupOf = (gid) => artifacts.filter((a) => a.groupId === gid).map((a) => a.id);
  const state = {
    application: { id: 'app_big', name: 'Big', adapterId: 'generic-macos-app' },
    artifacts,
    artifactGroups: [
      { id: 'grp_cache', name: 'Regenerable Caches', artifactType: 'REGENERABLE_CACHE', artifactIds: groupOf('grp_cache') },
      { id: 'grp_logs', name: 'Logs', artifactType: 'LOG', artifactIds: groupOf('grp_logs') }
    ],
    sessions: [{ id: 'sess_1', title: 'Session One' }],
    provenanceEdges: []
  };
  artifacts[5].sessionIds = ['sess_1'];

  const root = buildMapLevel(state, 'root');
  assert.equal(root.nodes[0].pinned, true);
  assert.deepEqual(
    root.nodes.slice(1).map((n) => n.drillId).sort(),
    ['group:grp_cache', 'group:grp_logs', 'sessions']
  );
  assert.equal(root.edges.length, root.nodes.length - 1);

  // A kind opens on its folders; a chain of single folders is skipped
  const caches = buildMapLevel(state, 'group:grp_cache');
  assert.equal(caches.parentId, 'root');
  const folders = caches.nodes.filter((n) => n.nodeType === 'FOLDER');
  assert.deepEqual(folders.map((n) => n.label).sort(), ['Cache_Data', 'GPUCache']);
  const logs = buildMapLevel(state, 'group:grp_logs');
  assert.equal(logs.path, `${base}/logs/2026/11`, 'logs/2026/11 holds everything, so it opens directly');

  // A big folder shows its largest files and says how many there are
  const data = buildMapLevel(state, folders.find((n) => n.label === 'Cache_Data').drillId);
  const files = data.nodes.filter((n) => n.nodeType === 'ARTIFACT');
  assert.equal(files.length, 12, 'a crowded folder shows its largest few');
  assert.ok(data.nodes.length <= 61);
  assert.match(data.note, /3,000 files directly in this folder/);
  // ...and bundles all of its files by type; a bundle opens on its largest files
  const bundles = data.nodes.filter((n) => n.metadata.isTypeBundle);
  assert.deepEqual(bundles.map((n) => n.label), ['No extension']);
  assert.equal(bundles[0].metadata.summary.artifactCount, 3000);
  const bundle = buildMapLevel(state, bundles[0].drillId);
  assert.equal(bundle.parentId, data.id);
  assert.equal(bundle.nodes.filter((n) => n.nodeType === 'ARTIFACT').length, 36);
  assert.equal(levelArtifactIds(state, bundles[0].drillId).length, 3000);
  assert.equal(data.parentId, 'group:grp_cache');
  assert.equal(data.breadcrumb.at(-1).title, 'Cache_Data');
  assert.equal(files[0].metadata.sizeBytes, 100 + 2999, 'largest first');

  // Selecting a level selects every file in it, not only the drawn ones
  assert.equal(levelArtifactIds(state, data.id).length, 3000);
  assert.equal(levelArtifactIds(state, 'group:grp_cache').length, 3040);
  assert.equal(levelArtifactIds(state, 'root').length, 3540);

  // Sessions open on the files they are linked to
  const session = buildMapLevel(state, 'session:sess_1');
  assert.deepEqual(session.nodes.filter((n) => n.nodeType === 'ARTIFACT').map((n) => n.id), [artifacts[5].id]);
  assert.equal(session.edges[0].confidence, 'VERIFIED');

  assert.equal(buildMapLevel(state, 'dir:all::relative/path'), null);
  assert.equal(buildMapLevel(state, 'type:all::relative::.log'), null);
  assert.equal(buildMapLevel(state, 'group:missing'), null);
});

test('session project folders: only files a tool call named are read', async () => {
  const { createDeterministicDemoEnvironment } = await import('../src/fixtures/demo-environment.js');
  const { ArtifactAtlasService } = await import('../src/atlas-service.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recorded-'));
  let service = null;
  try {
    const demo = createDeterministicDemoEnvironment(root);
    service = new ArtifactAtlasService({ homeDir: demo.homeDir, platform: 'darwin', dbPath: path.join(root, 'i.sqlite'), quarantineRoot: path.join(root, 'vault') });
    const state = await service.scanAndAnalyze({ bundlePath: demo.appBundles.claude.bundlePath });
    const inProject = state.artifacts.filter((a) => a.canonicalPath.startsWith(demo.workspaceDir + path.sep));
    assert.ok(inProject.length > 0, 'recorded project files are found');
    assert.ok(
      inProject.every((a) => a.provenanceConfidence === 'VERIFIED'),
      'nothing in the project folder is read unless a session recorded it'
    );
    assert.ok(state.artifacts.some((a) => a.canonicalPath === demo.sampleFiles.sharedSourceFile));
    assert.equal(state.artifacts.some((a) => a.name === '.env'), false);
    const totals = state.graph.stats.scopeTotals;
    assert.equal(totals.projects.count, inProject.length);
    assert.equal(totals.appData.count + totals.projects.count, state.graph.stats.artifactCount);
    // Recorded files can still be traced although they have no mark on the overview map
    const trace = service.inspectNodeProvenance(inProject[0].id);
    assert.ok(trace && trace.highlightedNodeIds.includes(inProject[0].id));
  } finally {
    if (service) service.sqliteStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('map groupings: risk, origin, age and file type split the same files and open by folder', async () => {
  const { buildMapLevel, levelArtifactIds, GROUPINGS } = await import('../src/graph/map-levels.js');
  const base = '/home/u/Library/Application Support/Big';
  const now = Date.parse('2026-11-01T00:00:00Z');
  const artifacts = [];
  for (let i = 0; i < 400; i++) {
    artifacts.push(
      fakeArtifact(i, {
        name: `f_${i}${i % 4 === 0 ? '.json' : '.log'}`,
        canonicalPath: `${base}/d${i % 3}/f_${i}`,
        parentDir: `${base}/d${i % 3}`,
        cleanupClassification: i % 2 ? 'LOW' : 'HIGH',
        provenanceConfidence: i % 10 === 0 ? 'VERIFIED' : 'INFERRED',
        modifiedAt: new Date(now - (i % 300) * 86400000).toISOString()
      })
    );
  }
  const state = {
    application: { id: 'app', name: 'Big' },
    artifacts,
    artifactGroups: [{ id: 'g', name: 'Logs', artifactType: 'LOG', artifactIds: artifacts.map((a) => a.id) }],
    sessions: [],
    provenanceEdges: [],
    scan: { completedAt: new Date(now).toISOString() }
  };

  for (const grouping of Object.keys(GROUPINGS)) {
    const top = buildMapLevel(state, `root:${grouping}`);
    assert.equal(top.grouping, grouping);
    const buckets = top.nodes.slice(1);
    assert.ok(buckets.length >= 2, `${grouping} has several buckets`);
    // Every file lands in exactly one bucket
    const ids = buckets.flatMap((b) => levelArtifactIds(state, b.drillId));
    assert.equal(ids.length, 400, grouping);
    assert.equal(new Set(ids).size, 400, grouping);
    // A bucket opens by folder and leads back to its grouping
    const bucket = buildMapLevel(state, buckets[0].drillId);
    assert.equal(bucket.parentId, `root:${grouping}`);
    assert.equal(bucket.grouping, grouping);
    assert.ok(bucket.nodes.some((n) => n.nodeType === 'FOLDER' && n.drillId));
  }

  const age = buildMapLevel(state, 'root:age');
  assert.deepEqual(
    age.nodes.slice(1).map((n) => n.label),
    ['Last 7 days', '8 to 30 days ago', '1 to 6 months ago', 'More than 6 months ago']
  );
  const risk = buildMapLevel(state, 'root:risk');
  assert.deepEqual(risk.nodes.slice(1).map((n) => [n.label, n.riskCategory]), [['Safe to remove', 'LOW'], ['High risk', 'HIGH']]);
  assert.equal(buildMapLevel(state, 'root').grouping, 'kind');
  assert.equal(buildMapLevel(state, 'root:nope'), null);
  assert.equal(buildMapLevel(state, 'bucket:risk:NOPE'), null);
});
