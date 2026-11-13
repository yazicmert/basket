import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactAtlasService } from '../src/atlas-service.js';
import { PlatformServices } from '../src/platform/platform-services.js';
import { createAtlasServer } from '../src/ui/server.js';
import { toPathKey, fromPathKey } from '../src/platform/path-keys.js';
import { parseWindowsShortcutTarget, listStartMenuApplications } from '../src/discovery/windows-apps.js';
import { ClassificationEngine } from '../src/classification/classification-engine.js';
import { buildMapLevel } from '../src/graph/map-levels.js';
import { RiskCategory, ProvenanceConfidence, createArtifactModel } from '../src/models/entities.js';

function writeFile(filePath, contents = 'x') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

/** A shortcut file as Windows writes it: header, no ID list, LinkInfo with a local path. */
function makeShortcut(target, { unicode = false } = {}) {
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  header.writeUInt32LE(0x2, 0x14); // HasLinkInfo
  const headerSize = unicode ? 0x24 : 0x1c;
  const base = unicode ? Buffer.from(`${target}\0`, 'utf16le') : Buffer.from(`${target}\0`, 'latin1');
  const suffix = unicode ? Buffer.from('\0', 'utf16le') : Buffer.from('\0', 'latin1');
  const info = Buffer.alloc(headerSize);
  info.writeUInt32LE(headerSize + base.length + suffix.length + (unicode ? 2 : 0), 0);
  info.writeUInt32LE(headerSize, 4);
  info.writeUInt32LE(0x1, 8); // VolumeIDAndLocalBasePath
  if (unicode) {
    // The ANSI strings are still present; they are empty here
    info.writeUInt32LE(headerSize, 16);
    info.writeUInt32LE(headerSize + 1, 24);
    info.writeUInt32LE(headerSize + 2, 28);
    info.writeUInt32LE(headerSize + 2 + base.length, 32);
    return Buffer.concat([header, info, Buffer.from([0, 0]), base, suffix]);
  }
  info.writeUInt32LE(headerSize, 16);
  info.writeUInt32LE(headerSize + base.length, 24);
  return Buffer.concat([header, info, base, suffix]);
}

/** A Windows-style home folder: AppData, hidden tool folders and a Start Menu. */
function makeWindowsHome() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-win-')));
  const home = path.join(root, 'Users', 'me');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  const startMenu = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const project = path.join(home, 'source', 'shop');

  writeFile(path.join(roaming, 'Cursor', 'Cache', 'Cache_Data', 'f_000001'), 'cached');
  writeFile(path.join(roaming, 'Cursor', 'User', 'settings.json'), '{}');
  writeFile(path.join(local, 'cursor-updater', 'pending', 'update.exe'), 'installer');
  writeFile(path.join(local, 'Cursorless', 'other-app.dat'), 'another application');
  writeFile(path.join(home, '.cursor', 'extensions', 'ext.json'), '{}');
  writeFile(path.join(roaming, 'Microsoft', 'Credentials', 'secret'), 'never listed');
  writeFile(path.join(project, 'cart.js'), 'export {}');
  writeFile(path.join(project, 'untouched.js'), 'export {}');

  const transcript = path.join(home, '.claude', 'projects', 'shop', 'win-one.jsonl');
  const base = { sessionId: 'win-one', cwd: project, timestamp: '2026-11-02T08:00:00.000Z' };
  writeFile(
    transcript,
    [
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'Add a cart module.' } }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(project, 'cart.js') } }] }
      })
    ].join('\n') + '\n'
  );

  const cursorShortcut = path.join(startMenu, 'Cursor', 'Cursor.lnk');
  writeFile(cursorShortcut, makeShortcut('C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe'));
  writeFile(path.join(startMenu, 'Cursor', 'Uninstall Cursor.lnk'), makeShortcut('C:\\x\\unins000.exe'));
  writeFile(path.join(startMenu, 'Notepad Plus.lnk'), Buffer.alloc(0x4c));
  return { root, home, roaming, local, startMenu, project, cursorShortcut, transcript };
}

test('W1. Path keys: Windows paths are matched with the same rules and shown as they are', () => {
  assert.equal(toPathKey('C:\\Users\\me\\AppData\\Roaming\\Claude'), '/C:/Users/me/AppData/Roaming/Claude');
  assert.equal(toPathKey('D:\\'), '/D:');
  assert.equal(toPathKey('\\\\server\\share\\x'), '//server/share/x');
  assert.equal(toPathKey('/Users/me/Library'), '/Users/me/Library');
  for (const real of ['C:\\Users\\me\\a b', 'D:\\', '\\\\server\\share\\x', '/Users/me/Library', '/']) {
    assert.equal(fromPathKey(toPathKey(real)), real);
  }
});

test('W2. Classification reads Windows paths: caches in AppData are safe, source and Git never are', () => {
  const engine = new ClassificationEngine({ platformServices: new PlatformServices({ homeDir: os.tmpdir(), platform: 'win32' }) });
  const classify = (canonicalPath, extra = {}) =>
    engine.classifyByContextRules(
      createArtifactModel({
        name: canonicalPath.split('\\').pop(),
        canonicalPath,
        parentDir: canonicalPath.slice(0, canonicalPath.lastIndexOf('\\')),
        extension: (/\.[^.\\]+$/.exec(canonicalPath) || [''])[0],
        sizeBytes: 10,
        sharedDependencyIndicators: [],
        sessionIds: [],
        evidence: [],
        provenanceConfidence: ProvenanceConfidence.INFERRED,
        ...extra
      })
    );
  const cache = classify('C:\\Users\\me\\AppData\\Roaming\\Cursor\\Cache\\Cache_Data\\f_000001');
  assert.equal(cache.artifactType, 'REGENERABLE_CACHE');
  assert.equal(cache.riskCategory, RiskCategory.LOW);
  // A folder called Cache outside an application's data folder proves nothing
  assert.notEqual(classify('C:\\Users\\me\\Documents\\Cache\\report.pdf').riskCategory, RiskCategory.LOW);
  assert.equal(classify('C:\\Users\\me\\source\\shop\\.git\\HEAD').riskCategory, RiskCategory.PROTECTED);
  assert.notEqual(classify('C:\\Users\\me\\.claude\\projects\\shop\\s.jsonl').riskCategory, RiskCategory.LOW);
  assert.notEqual(classify('C:\\Users\\me\\.ssh\\id_ed25519').riskCategory, RiskCategory.LOW);
});

test('W3. Map levels group Windows folders across drives', () => {
  const art = (id, canonicalPath) =>
    createArtifactModel({
      id,
      name: canonicalPath.split('\\').pop(),
      canonicalPath,
      parentDir: canonicalPath.slice(0, canonicalPath.lastIndexOf('\\')),
      extension: '.bin',
      sizeBytes: 100,
      physicalInodeKey: id,
      cleanupClassification: 'REVIEW',
      artifactType: 'UNKNOWN',
      sessionIds: [],
      evidence: [],
      sharedDependencyIndicators: []
    });
  const artifacts = [
    art('a1', 'C:\\Users\\me\\AppData\\Roaming\\Tool\\data\\one.bin'),
    art('a2', 'C:\\Users\\me\\AppData\\Roaming\\Tool\\logs\\two.bin'),
    art('a3', 'D:\\models\\three.bin')
  ];
  const state = {
    application: { id: 'app', name: 'Tool' },
    artifacts,
    artifactGroups: [{ id: 'g1', name: 'Other', artifactType: 'UNKNOWN', artifactIds: artifacts.map((a) => a.id) }],
    sessions: [],
    operations: [],
    workspaces: [],
    graph: { stats: {} }
  };
  const root = buildMapLevel(state, 'root');
  const group = buildMapLevel(state, root.nodes.find((n) => n.drillId).drillId);
  const folders = group.nodes.filter((n) => n.nodeType === 'FOLDER' && n.drillId);
  assert.ok(folders.length >= 2, 'both drives are reachable from the top');
  const paths = folders.map((n) => n.metadata.path);
  assert.ok(paths.some((p) => p.startsWith('C:\\')), paths.join(' | '));
  assert.ok(paths.some((p) => p.startsWith('D:\\')), paths.join(' | '));
  // Every folder can be opened and leads to its files
  const seen = new Set();
  const open = (levelId) => {
    const level = buildMapLevel(state, levelId);
    assert.ok(level, levelId);
    for (const node of level.nodes) {
      if (node.nodeType === 'ARTIFACT') seen.add(node.id);
      else if (node.drillId && node.drillId !== levelId) open(node.drillId);
    }
  };
  open(group.id);
  assert.deepEqual([...seen].sort(), ['a1', 'a2', 'a3']);
});

test('W4. Shortcuts: the stored target is read, nothing is run, and non-applications are not listed', () => {
  assert.equal(parseWindowsShortcutTarget(makeShortcut('C:\\Tools\\App\\app.exe')), 'C:\\Tools\\App\\app.exe');
  assert.equal(parseWindowsShortcutTarget(makeShortcut('C:\\Tools\\Ünï\\app.exe', { unicode: true })), 'C:\\Tools\\Ünï\\app.exe');
  assert.equal(parseWindowsShortcutTarget(Buffer.alloc(0x4c)), null);
  assert.equal(parseWindowsShortcutTarget(Buffer.from('not a shortcut')), null);
  const truncated = makeShortcut('C:\\Tools\\App\\app.exe').subarray(0, 0x60);
  assert.equal(parseWindowsShortcutTarget(truncated), null);

  const env = makeWindowsHome();
  try {
    const apps = listStartMenuApplications([env.startMenu]);
    assert.deepEqual(apps.map((a) => a.name).sort(), ['Cursor', 'Notepad Plus']);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('W5. Protected Windows locations are never scanned or offered', () => {
  const platform = new PlatformServices({ homeDir: 'C:\\Users\\me', platform: 'win32' });
  // path.resolve keeps these as they are only on Windows; the rule itself is checked directly
  if (process.platform === 'win32') {
    for (const p of ['C:\\', 'C:\\Windows\\System32', 'c:\\program files\\App', 'C:\\Users\\me', 'C:\\Users\\me\\.ssh\\id', 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\x']) {
      assert.equal(platform.isProtectedSystemPath(p), true, p);
    }
    for (const p of ['C:\\Users\\me\\AppData\\Roaming\\Claude', 'D:\\projects\\shop', 'C:\\Users\\me\\.claude']) {
      assert.equal(platform.isProtectedSystemPath(p), false, p);
    }
  }
  const dirs = platform.getWindowsAppDataDirs();
  assert.ok(dirs.roaming.replace(/\\/g, '/').endsWith('AppData/Roaming'));
});

test('W6. A Windows application is found by name in AppData and scanned end to end', async () => {
  const env = makeWindowsHome();
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'win32' });
  try {
    const app = service.identifyApplication(env.cursorShortcut);
    assert.equal(app.name, 'Cursor');
    assert.equal(app.executablePath, 'C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe');
    assert.equal(app.isSupportedAIApp, true);
    const dirs = app.knownDataDirectories.filter((d) => fs.existsSync(d.path)).map((d) => path.relative(env.home, d.path).split(path.sep).join('/'));
    assert.deepEqual(dirs.sort(), ['.cursor', 'AppData/Local/cursor-updater', 'AppData/Roaming/Cursor']);

    const state = await service.scanAndAnalyze({ bundlePath: env.cursorShortcut });
    const byName = Object.fromEntries(state.artifacts.map((a) => [a.name, a]));
    assert.equal(byName.f_000001.cleanupClassification, 'LOW');
    assert.notEqual(byName['settings.json'].cleanupClassification, 'LOW');
    assert.equal(byName['other-app.dat'], undefined, 'a folder that only starts with the name belongs to another app');
    assert.equal(byName.secret, undefined);

    // A program file and its folder are accepted too; anything else is refused
    const exe = path.join(env.local, 'Programs', 'orbit', 'Orbit Chat.exe');
    writeFile(exe, 'MZ');
    writeFile(path.join(env.roaming, 'Orbit Chat', 'state.db'), 'x');
    const orbit = service.identifyApplication(exe);
    assert.equal(orbit.name, 'Orbit Chat');
    assert.equal(orbit.recognitionStatus, 'GENERIC_WINDOWS_APP');
    assert.ok(orbit.knownDataDirectories.some((d) => d.path === path.join(env.roaming, 'Orbit Chat')));
    assert.throws(() => service.identifyApplication(path.join(env.roaming, 'Cursor', 'User', 'settings.json')), /Expected a program/);
    assert.throws(() => service.identifyApplication(path.join(env.home, 'missing.exe')), /not found/);
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('W7. Windows app list: Start Menu shortcuts, plus tools found by the data they left', async () => {
  const env = makeWindowsHome();
  const atlas = createAtlasServer({
    dataDir: path.join(env.root, 'data'),
    liveHomeDir: env.home,
    platform: 'win32',
    applicationDirs: [env.startMenu],
    simulateSystemOpen: true
  });
  const api = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${atlas.server.address().port}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    await api('/api/permissions/home-folder-scan', { granted: true });
    const boot = (await api('/api/bootstrap')).data;
    assert.equal(boot.platform, 'win32');
    const names = boot.availableBundles.map((b) => b.name);
    assert.deepEqual(names.slice(0, 2).sort(), ['Claude Code', 'Cursor'], 'AI apps come first');
    assert.ok(names.includes('Notepad Plus'));
    // No macOS privacy settings are offered on Windows
    assert.ok(boot.permissions.filter((p) => p.kind === 'MACOS_PRIVACY').every((p) => p.status === 'NOT_APPLICABLE'));

    // Claude Code has no Start Menu entry; it is offered because ~/.claude exists
    const claude = boot.availableBundles.find((b) => b.name === 'Claude Code');
    assert.equal(claude.bundlePath, 'atlas-known:claude');
    const scan = (await api('/api/scan/start', { bundlePath: claude.bundlePath })).data;
    assert.equal(scan.state.application.name, 'Claude Code');
    assert.equal(scan.state.graph.stats.sessionCount, 1);
    assert.ok(scan.state.graph.stats.verifiedArtifactCount >= 1);

    const sessions = (await api('/api/map/level', { levelId: 'sessions' })).data.level;
    const sessionNode = sessions.nodes.find((n) => n.drillId && n.drillId.startsWith('session:'));
    const prompt = (await api('/api/node/prompt', { nodeId: sessionNode.id })).data;
    assert.equal(prompt.prompts[0].text, 'Add a cart module.');
    assert.equal((await api('/api/app/identify', { bundlePath: 'atlas-known:nope' })).status, 400);
  } finally {
    await atlas.shutdown();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
