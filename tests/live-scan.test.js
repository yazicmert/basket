import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactAtlasService } from '../src/atlas-service.js';
import { PlatformServices } from '../src/platform/platform-services.js';
import {
  discoverApplicationFootprint,
  deriveNameTokens,
  matchContainerEntry
} from '../src/discovery/app-footprint.js';
import { parseMacOSBinaryPlist } from '../src/discovery/application-discovery.js';
import { readCursorComposerIndex } from '../src/adapters/adapter-registry.js';
import {
  describePermissions,
  resolveOpenTarget,
  PermissionStatus,
  SITE_BASE_URL
} from '../src/platform/permissions.js';
import { createAtlasServer } from '../src/ui/server.js';
import { ProvenanceConfidence, RiskCategory } from '../src/models/entities.js';

function createTempHome(prefix = 'artifact-atlas-live-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(filePath, contents = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeAppBundle(appsDir, fileName, { name, bundleId }) {
  const bundlePath = path.join(appsDir, fileName);
  writeFile(
    path.join(bundlePath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>CFBundleName</key><string>${name}</string>
      <key>CFBundleIdentifier</key><string>${bundleId}</string>
      <key>CFBundleShortVersionString</key><string>2.1.0</string>
    </dict></plist>`
  );
  return bundlePath;
}

/** A home folder for an app Artifact Atlas has no session adapter for. */
function createUnknownAppHome(home) {
  const lib = path.join(home, 'Library');
  const files = {
    appSupport: path.join(lib, 'Application Support', 'Orbit Chat', 'conversations.db'),
    cache: path.join(lib, 'Caches', 'ai.orbit.chat', 'Cache.db'),
    shipIt: path.join(lib, 'Caches', 'ai.orbit.chat.ShipIt', 'update.zip'),
    log: path.join(lib, 'Logs', 'Orbit Chat', 'main.log'),
    prefs: path.join(lib, 'Preferences', 'ai.orbit.chat.plist'),
    savedState: path.join(lib, 'Saved Application State', 'ai.orbit.chat.savedState', 'windows.plist'),
    container: path.join(lib, 'Containers', 'ai.orbit.chat', 'Data', 'Library', 'Caches', 'blob.bin'),
    groupContainer: path.join(lib, 'Group Containers', 'TEAM123.ai.orbit.chat', 'shared.db'),
    httpStorage: path.join(lib, 'HTTPStorages', 'ai.orbit.chat', 'httpstorages.sqlite'),
    hiddenDotDir: path.join(home, '.orbitchat', 'models', 'small.gguf'),
    hiddenHyphenDir: path.join(home, '.orbit-chat', 'settings.json'),
    xdgConfig: path.join(home, '.config', 'orbit-chat', 'config.toml'),
    xdgCache: path.join(home, '.cache', 'orbitchat', 'index.bin')
  };
  for (const filePath of Object.values(files)) {
    writeFile(filePath, `data:${path.basename(filePath)}`);
  }
  const unrelated = {
    otherApp: path.join(lib, 'Application Support', 'Orbit Chatter', 'data.db'),
    otherBundle: path.join(lib, 'Caches', 'ai.orbit.chatbot', 'Cache.db'),
    otherVendor: path.join(lib, 'Caches', 'ai.orbit', 'Cache.db'),
    userDoc: path.join(home, 'Documents', 'orbit chat notes.txt')
  };
  for (const filePath of Object.values(unrelated)) {
    writeFile(filePath, 'unrelated');
  }
  return { files, unrelated };
}

test('L1. Footprint matching is strict: exact app name or bundle-identifier boundary only', () => {
  const tokens = deriveNameTokens('LM Studio');
  assert.deepEqual([...tokens].sort(), ['lm studio', 'lm-studio', 'lm_studio', 'lmstudio']);
  assert.equal(deriveNameTokens('App', 'ab').size, 0, 'generic or very short names are ignored');

  const identity = { nameTokens: deriveNameTokens('Orbit Chat'), bundleId: 'ai.orbit.chat' };
  assert.equal(matchContainerEntry('ai.orbit.chat', identity), 'BUNDLE_IDENTIFIER');
  assert.equal(matchContainerEntry('ai.orbit.chat.ShipIt', identity), 'BUNDLE_IDENTIFIER');
  assert.equal(matchContainerEntry('AI.Orbit.Chat.savedState', identity), 'BUNDLE_IDENTIFIER');
  assert.equal(matchContainerEntry('TEAM123.ai.orbit.chat', identity), 'BUNDLE_IDENTIFIER');
  assert.equal(matchContainerEntry('ai.orbit.chat.plist', identity), 'BUNDLE_IDENTIFIER');
  assert.equal(matchContainerEntry('Orbit Chat', identity), 'APPLICATION_NAME');
  assert.equal(matchContainerEntry('orbitchat', identity), 'APPLICATION_NAME');
  // Near misses must not be attributed to the application
  assert.equal(matchContainerEntry('ai.orbit.chatbot', identity), null);
  assert.equal(matchContainerEntry('ai.orbit', identity), null);
  assert.equal(matchContainerEntry('Orbit Chatter', identity), null);
  assert.equal(matchContainerEntry('My Orbit Chat Backup', identity), null);
});

test('L2. Any dropped app: leftovers are found across Library containers and hidden home folders, attributed as INFERRED', async () => {
  const home = createTempHome();
  try {
    const { files, unrelated } = createUnknownAppHome(home.dir);
    const bundlePath = writeAppBundle(path.join(home.dir, 'Applications'), 'Orbit Chat.app', {
      name: 'Orbit Chat',
      bundleId: 'ai.orbit.chat'
    });

    const service = new ArtifactAtlasService({ homeDir: home.dir });
    const progressPaths = [];
    const state = await service.scanAndAnalyze({
      bundlePath,
      onProgress: (p) => p.currentPath && progressPaths.push(p.currentPath)
    });

    assert.equal(state.application.adapterId, 'generic-macos-app');
    const found = new Map(state.artifacts.map((a) => [a.canonicalPath, a]));
    for (const [label, filePath] of Object.entries(files)) {
      assert.ok(found.has(filePath), `leftover '${label}' must be discovered: ${filePath}`);
      assert.equal(
        found.get(filePath).provenanceConfidence,
        ProvenanceConfidence.INFERRED,
        `'${label}' is attributed to the app container, not to a session`
      );
    }
    for (const [label, filePath] of Object.entries(unrelated)) {
      assert.equal(found.has(filePath), false, `unrelated '${label}' must not be attributed`);
    }

    // A single-file root (preferences plist) is indexed exactly once
    assert.equal(state.artifacts.filter((a) => a.canonicalPath === files.prefs).length, 1);
    // Model weights in a hidden folder are found and stay high risk
    assert.equal(found.get(files.hiddenDotDir).cleanupClassification, RiskCategory.HIGH);
    // Live progress reported the folders as they were scanned, including hidden ones
    assert.ok(progressPaths.some((p) => p.includes(`${path.sep}.orbit`)), 'hidden folder progress');
    assert.ok(progressPaths.some((p) => p.includes('Library')), 'Library folder progress');
    assert.equal(service.scanInProgress, false);

    service.sqliteStore.close();
  } finally {
    home.cleanup();
  }
});

test('L3. Footprint never follows symlinked containers or protected locations, and reports unreadable containers', () => {
  const home = createTempHome();
  try {
    const platform = new PlatformServices({ homeDir: home.dir });
    const outside = path.join(home.dir, 'elsewhere');
    writeFile(path.join(outside, 'secret.txt'));
    fs.mkdirSync(path.join(home.dir, 'Library', 'Caches'), { recursive: true });
    fs.symlinkSync(outside, path.join(home.dir, 'Library', 'Caches', 'ai.orbit.chat'));
    // An app that happens to be called "ssh" must not get ~/.ssh
    writeFile(path.join(home.dir, '.ssh', 'id_ed25519'));

    const res = discoverApplicationFootprint({
      name: 'Orbit Chat',
      bundleId: 'ai.orbit.chat',
      platformServices: platform
    });
    assert.deepEqual(res.locations, []);

    const sshRes = discoverApplicationFootprint({ name: 'ssh', bundleId: 'x.y.ssh', platformServices: platform });
    assert.equal(sshRes.locations.some((l) => l.path.endsWith('.ssh')), false);

    if (process.getuid && process.getuid() !== 0) {
      const locked = path.join(home.dir, 'Library', 'Containers');
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o000);
      try {
        const lockedRes = discoverApplicationFootprint({
          name: 'Orbit Chat',
          bundleId: 'ai.orbit.chat',
          platformServices: platform
        });
        assert.deepEqual(lockedRes.unreadableContainers, [locked]);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  } finally {
    home.cleanup();
  }
});

test('L4. Binary Info.plist bundles are identified (name, bundle identifier, version)', () => {
  // Hand-built bplist00: { CFBundleIdentifier: "ai.orbit.chat", CFBundleName: "Orbit Chat" }
  const ascii = (str) => {
    const head = str.length < 15 ? [0x50 | str.length] : [0x5f, 0x10, str.length];
    return Buffer.from([...head, ...Buffer.from(str, 'latin1')]);
  };
  const objects = [
    Buffer.from([0xd2, 1, 2, 3, 4]),
    ascii('CFBundleIdentifier'),
    ascii('CFBundleName'),
    ascii('ai.orbit.chat'),
    ascii('Orbit Chat')
  ];
  const header = Buffer.from('bplist00', 'latin1');
  const offsets = [];
  let cursor = header.length;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }
  const trailer = Buffer.alloc(32);
  trailer[6] = 1; // offset int size
  trailer[7] = 1; // object ref size
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(cursor), 24);
  const bplist = Buffer.concat([header, ...objects, Buffer.from(offsets), trailer]);

  assert.deepEqual(parseMacOSBinaryPlist(bplist), {
    CFBundleIdentifier: 'ai.orbit.chat',
    CFBundleName: 'Orbit Chat'
  });
  assert.deepEqual(parseMacOSBinaryPlist(Buffer.from('bplist00garbage')), {});

  const home = createTempHome();
  try {
    const bundlePath = path.join(home.dir, 'Applications', 'Renamed.app');
    writeFile(path.join(bundlePath, 'Contents', 'Info.plist'), bplist);
    writeFile(path.join(home.dir, 'Library', 'Caches', 'ai.orbit.chat', 'Cache.db'));
    const service = new ArtifactAtlasService({ homeDir: home.dir });
    const app = service.identifyApplication(bundlePath);
    assert.equal(app.name, 'Orbit Chat');
    assert.equal(app.bundleId, 'ai.orbit.chat');
    assert.ok(app.knownDataDirectories.some((d) => d.path.endsWith(path.join('Caches', 'ai.orbit.chat'))));
    service.sqliteStore.close();
  } finally {
    home.cleanup();
  }
});

test('L5. Cursor: sessions are read from the real state.vscdb composer index without copying titles or prompts', async () => {
  const home = createTempHome();
  try {
    const workspace = path.join(home.dir, 'Projects', 'demo');
    fs.mkdirSync(workspace, { recursive: true });
    const bucket = path.join(home.dir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage', 'abc123');
    writeFile(path.join(bucket, 'workspace.json'), JSON.stringify({ folder: `file://${workspace}` }));
    const dbPath = path.join(bucket, 'state.vscdb');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({
        allComposers: [
          { composerId: 'cmp-1111-aaaa', name: 'SECRET PROMPT TITLE', createdAt: 1790000000000, lastUpdatedAt: 1790000360000 },
          { composerId: 'cmp-2222-bbbb', name: 'ANOTHER SECRET', createdAt: 1790001000000 },
          { name: 'no id, ignored' }
        ]
      })
    );
    db.close();

    const index = readCursorComposerIndex(dbPath);
    assert.deepEqual(index.map((c) => c.composerId), ['cmp-1111-aaaa', 'cmp-2222-bbbb']);
    assert.equal(index[0].createdAt, new Date(1790000000000).toISOString());

    const bundlePath = writeAppBundle(path.join(home.dir, 'Applications'), 'Cursor.app', {
      name: 'Cursor',
      bundleId: 'com.todesktop.230313mzl4w4u92'
    });
    const service = new ArtifactAtlasService({ homeDir: home.dir });
    const state = await service.scanAndAnalyze({ bundlePath });
    assert.equal(state.sessions.length, 2);
    assert.ok(state.workspaces.some((w) => w.canonicalPath === workspace));
    assert.equal(JSON.stringify(state.sessions).includes('SECRET'), false, 'titles are not copied');

    // Unreadable / foreign databases degrade to "no sessions" instead of failing the scan
    const junk = path.join(home.dir, 'junk.vscdb');
    fs.writeFileSync(junk, 'not a database');
    const malformed = [];
    assert.deepEqual(readCursorComposerIndex(junk, malformed), []);
    assert.equal(malformed.length, 1);
    service.sqliteStore.close();
  } finally {
    home.cleanup();
  }
});

test('L6. Permissions: status model, allowlisted open targets, and per-permission documentation pages', () => {
  const home = createTempHome();
  try {
    const linux = describePermissions({ platform: 'linux', homeDir: home.dir });
    assert.deepEqual(linux.map((p) => p.id), ['home-folder-scan', 'full-disk-access', 'app-data', 'files-and-folders']);
    assert.equal(linux[0].status, PermissionStatus.NOT_GRANTED);
    assert.equal(linux[1].status, PermissionStatus.NOT_APPLICABLE);

    // macOS without the TCC directory readable -> on-demand prompts; with it -> covered
    const before = describePermissions({ platform: 'darwin', homeDir: home.dir, homeScanConsentAt: '2026-01-01T00:00:00Z' });
    assert.equal(before[0].status, PermissionStatus.GRANTED);
    assert.equal(before[1].status, PermissionStatus.UNKNOWN);
    assert.equal(before[2].status, PermissionStatus.ASKED_ON_DEMAND);
    fs.mkdirSync(path.join(home.dir, 'Library', 'Application Support', 'com.apple.TCC'), { recursive: true });
    const after = describePermissions({ platform: 'darwin', homeDir: home.dir });
    assert.equal(after[1].status, PermissionStatus.GRANTED);
    assert.equal(after[2].status, PermissionStatus.COVERED_BY_FULL_DISK_ACCESS);
    assert.equal(after[3].status, PermissionStatus.COVERED_BY_FULL_DISK_ACCESS);

    // Every permission has its own page on the project site, and that page exists in site/
    for (const perm of after) {
      assert.equal(perm.docsUrl, `${SITE_BASE_URL}/permissions/${perm.id}/`);
      assert.ok(
        fs.existsSync(path.resolve('site', 'permissions', perm.id, 'index.html')),
        `site page for ${perm.id}`
      );
      assert.equal(resolveOpenTarget(`docs:${perm.id}`), perm.docsUrl);
    }
    assert.ok(fs.existsSync(path.resolve('site', 'permissions', 'index.html')));
    assert.match(resolveOpenTarget('settings:full-disk-access'), /^x-apple\.systempreferences:/);
    assert.equal(resolveOpenTarget('settings:home-folder-scan'), null);
    assert.equal(resolveOpenTarget('docs:../../etc/passwd'), null);
    assert.equal(resolveOpenTarget('https://evil.example'), null);
  } finally {
    home.cleanup();
  }
});

test('L7. Server data scope: sample data until consent, then the real home folder; consent persists and can be revoked', async () => {
  const sandbox = createTempHome('artifact-atlas-scope-');
  const home = createTempHome('artifact-atlas-scope-home-');
  try {
    createUnknownAppHome(home.dir);
    const appsDir = path.join(home.dir, 'Applications');
    const bundlePath = writeAppBundle(appsDir, 'Orbit Chat.app', { name: 'Orbit Chat', bundleId: 'ai.orbit.chat' });
    writeAppBundle(appsDir, 'Ollama.app', { name: 'Ollama', bundleId: 'com.electron.ollama' });

    const options = {
      dataDir: sandbox.dir,
      liveHomeDir: home.dir,
      applicationDirs: [appsDir],
      simulateSystemOpen: true
    };
    let atlas = createAtlasServer(options);
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    let base = `http://127.0.0.1:${atlas.server.address().port}`;
    const api = async (urlPath, body) => {
      const res = await fetch(`${base}${urlPath}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Atlas-Token': atlas.sessionToken },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: res.status, data: await res.json() };
    };

    // Before consent: sample data only, and live mode cannot be forced
    let boot = (await api('/api/bootstrap')).data;
    assert.equal(boot.mode, 'demo');
    assert.equal(boot.isDemoEnvironment, true);
    assert.ok(boot.availableBundles.every((b) => b.isDemoFixture));
    assert.equal((await api('/api/mode', { mode: 'live' })).status, 403);

    // Allowlisted open targets only
    const opened = await api('/api/system/open', { target: 'docs:full-disk-access' });
    assert.equal(opened.data.url, `${SITE_BASE_URL}/permissions/full-disk-access/`);
    assert.equal((await api('/api/system/open', { target: 'docs:nope' })).status, 400);

    // Consent switches to the real home folder
    const granted = await api('/api/permissions/home-folder-scan', { granted: true });
    assert.equal(granted.data.mode, 'live');
    boot = (await api('/api/bootstrap')).data;
    assert.equal(boot.isDemoEnvironment, false);
    assert.equal(boot.homeDir, home.dir);
    assert.deepEqual(boot.availableBundles.map((b) => b.name), ['Ollama', 'Orbit Chat'], 'known AI apps first');
    assert.equal(boot.availableBundles[0].isKnownAIApp, true);
    assert.ok(boot.quarantineVaultLocation.startsWith(path.join(sandbox.dir, 'live')));

    // Live progress endpoint reports the folder being scanned while a scan runs
    const scanPromise = api('/api/scan/start', { bundlePath, artificialDelayMs: 15 });
    const seenPaths = new Set();
    for (let i = 0; i < 200; i++) {
      const prog = (await api('/api/scan/progress')).data;
      if (prog.progress && prog.progress.currentPath) {
        seenPaths.add(prog.progress.currentPath);
      }
      if (!prog.active && seenPaths.size > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const scan = (await scanPromise).data;
    assert.ok(seenPaths.size >= 2, `expected live folder updates, saw ${seenPaths.size}`);
    assert.ok([...seenPaths].every((p) => p.startsWith(home.dir)));
    assert.ok(scan.state.graph.stats.artifactCount >= 13);
    assert.equal(scan.state.artifacts, undefined, 'the file list stays on the server');
    assert.equal((await api('/api/demo/reset', {})).status, 409);

    // Consent persists across restarts
    await atlas.shutdown();
    atlas = createAtlasServer(options);
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${atlas.server.address().port}`;
    assert.equal((await api('/api/bootstrap')).data.mode, 'live');

    // The user can drop back to sample data, or revoke consent entirely
    assert.equal((await api('/api/mode', { mode: 'demo' })).data.mode, 'demo');
    assert.equal((await api('/api/mode', { mode: 'live' })).data.mode, 'live');
    const revoked = await api('/api/permissions/home-folder-scan', { granted: false });
    assert.equal(revoked.data.mode, 'demo');
    assert.equal(revoked.data.permissions[0].status, PermissionStatus.NOT_GRANTED);
    assert.equal((await api('/api/mode', { mode: 'live' })).status, 403);
    await atlas.shutdown();
  } finally {
    sandbox.cleanup();
    home.cleanup();
  }
});
