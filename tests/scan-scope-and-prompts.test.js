import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactAtlasService } from '../src/atlas-service.js';
import { createAtlasServer } from '../src/ui/server.js';
import { readSessionFirstPrompt, userTextOfRecord, MAX_PROMPT_CHARS } from '../src/provenance/session-prompt.js';
import { describePermissions, PermissionStatus } from '../src/platform/permissions.js';

const PROMPT = 'Build the importer and keep the old CSV path working.';

/** A home folder with one Claude session that wrote one file in a project with more in it. */
function makeHome() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scope-')));
  const home = path.join(root, 'home');
  const project = path.join(home, 'Projects', 'importer');
  const bundle = path.join(root, 'Applications', 'Claude.app');
  fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleName</key><string>Claude</string><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>'
  );
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'importer.js'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(project, 'src', 'untouched.js'), 'y'.repeat(5000));
  fs.writeFileSync(path.join(project, 'node_modules', 'left-pad', 'index.js'), 'z'.repeat(9000));
  fs.writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const transcripts = path.join(home, '.claude', 'projects', 'importer');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  // A subagent's transcript carries the parent's session ID and sorts before the main one
  const subagents = path.join(transcripts, 'sess-one', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(
    path.join(subagents, 'agent-1.jsonl'),
    JSON.stringify({ sessionId: 'sess-one', isSidechain: true, type: 'user', cwd: project, timestamp: '2026-11-01T10:05:00.000Z', message: { role: 'user', content: 'Subagent task text' } }) + '\n'
  );
  const transcript = path.join(transcripts, 'sess-one.jsonl');
  const base = { sessionId: 'sess-one', cwd: project, timestamp: '2026-11-01T10:00:00.000Z' };
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta text' } }),
      JSON.stringify({ ...base, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.' } }),
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: `<command-name>/init</command-name>` } }),
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(project, 'src', 'importer.js') } }]
        }
      }),
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'A later prompt that must not be shown.' } })
    ].join('\n') + '\n'
  );
  return { root, home, project, bundle, transcript };
}

function names(state) {
  return state.artifacts.map((a) => path.relative(state.workspaces[0].canonicalPath, a.canonicalPath));
}

test('S1. Scan scope: project folders are counted in full only when the user includes them', async () => {
  const env = makeHome();
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  try {
    const recordedOnly = await service.scanAndAnalyze({ bundlePath: env.bundle });
    const inProject = (state) => names(state).filter((rel) => !rel.startsWith('..'));
    assert.deepEqual(inProject(recordedOnly), [path.join('src', 'importer.js')]);
    assert.equal(recordedOnly.scan.scope.projectFolders, false);

    const whole = await service.scanAndAnalyze({ bundlePath: env.bundle, scanScope: { projectFolders: true } });
    assert.deepEqual(inProject(whole).sort(), [path.join('src', 'importer.js'), path.join('src', 'untouched.js')]);
    assert.ok(whole.scan.totalPhysicalBytes > recordedOnly.scan.totalPhysicalBytes);
    assert.equal(whole.scan.skippedBulkDirectories.length, 2);

    const everything = await service.scanAndAnalyze({
      bundlePath: env.bundle,
      scanScope: { projectFolders: true, dependencyFolders: true }
    });
    // Dependency and Git folders are measured as a whole, never listed file by file
    assert.ok(!inProject(everything).some((rel) => rel.startsWith('node_modules') || rel.startsWith('.git')));
    assert.equal(everything.scan.skippedBulkDirectories.length, 0);
    const measured = Object.fromEntries(everything.scan.bulkFolders.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(measured).sort(), ['.git', 'node_modules']);
    assert.equal(measured.node_modules.fileCount, 1);
    assert.equal(measured.node_modules.physicalBytes, 9000);
    assert.equal(measured.node_modules.projectRoot, env.project);
    assert.equal(everything.scan.measuredPhysicalBytes, 9000 + measured['.git'].physicalBytes);
    // The listed total is unchanged by the measured folders
    assert.equal(everything.scan.totalPhysicalBytes, whole.scan.totalPhysicalBytes);
    // On the map they are one mark that opens by project; nothing in them can be selected
    const { buildMapLevel, levelArtifactIds } = await import('../src/graph/map-levels.js');
    const root = buildMapLevel(everything, 'root');
    const mark = root.nodes.find((n) => n.id === 'measured');
    assert.equal(mark.metadata.summary.bytes, everything.scan.measuredPhysicalBytes);
    const byProject = buildMapLevel(everything, 'measured');
    const project = byProject.nodes.find((n) => n.drillId === `measured:${env.project}`);
    const inside = buildMapLevel(everything, project.drillId);
    assert.deepEqual(inside.nodes.slice(1).map((n) => n.label).sort(), ['.git', 'node_modules']);
    assert.ok(inside.nodes.every((n) => n.metadata.measuredOnly && n.nodeType !== 'ARTIFACT'));
    for (const id of ['measured', project.drillId]) assert.deepEqual(levelArtifactIds(everything, id), []);
    assert.equal(buildMapLevel(everything, 'measured:/nowhere'), null);
    // Nothing in a project folder becomes safe to remove because it was counted
    for (const art of everything.artifacts.filter((a) => a.workspaceId)) {
      assert.notEqual(art.cleanupClassification, 'LOW', art.canonicalPath);
    }
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S2. Scan scope: the home folder and folders above it are never walked as a project', async () => {
  const env = makeHome();
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  try {
    assert.equal(service.isWalkableProjectFolder(env.home), false);
    assert.equal(service.isWalkableProjectFolder(path.dirname(env.home)), false);
    assert.equal(service.isWalkableProjectFolder(path.parse(env.home).root), false);
    assert.equal(service.isWalkableProjectFolder(path.join(env.home, '.ssh')), false);
    assert.equal(service.isWalkableProjectFolder(env.project), true);

    // A session that ran in the home folder itself
    const transcript = fs.readFileSync(env.transcript, 'utf8').replaceAll(JSON.stringify(env.project), JSON.stringify(env.home));
    fs.writeFileSync(env.transcript, transcript);
    fs.writeFileSync(path.join(env.home, 'private-notes.txt'), 'not part of any app');
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle, scanScope: { projectFolders: true } });
    assert.deepEqual(state.scan.scope.projectFoldersLeftOut, [env.home]);
    assert.ok(!state.artifacts.some((a) => a.name === 'private-notes.txt'));
    // Nothing under the home folder becomes a project file, and the application's own
    // folders are listed as its own, not as project content
    // (the subagent's transcript still names the real project, which stays a project)
    const inProjects = state.artifacts.filter((a) => a.workspaceId);
    assert.ok(inProjects.length > 0);
    assert.ok(inProjects.every((a) => a.canonicalPath.startsWith(env.project + path.sep)));
    assert.ok(state.artifacts.filter((a) => a.canonicalPath.includes(`${path.sep}.claude${path.sep}`)).every((a) => !a.workspaceId));
    assert.equal(state.graph.stats.scopeTotals.projects.count, inProjects.length);
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S3. Scan scope is a stored permission, asked once and changeable', async () => {
  const env = makeHome();
  const dataDir = path.join(env.root, 'data');
  const start = () => createAtlasServer({ dataDir, liveHomeDir: env.home, platform: 'darwin', applicationDirs: [path.dirname(env.bundle)] });
  let atlas = start();
  const listen = (a) => new Promise((resolve) => a.server.listen(0, '127.0.0.1', resolve));
  const api = async (a, route, body) => {
    const res = await fetch(`http://127.0.0.1:${a.server.address().port}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Atlas-Token': a.sessionToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    await listen(atlas);
    const first = await api(atlas, '/api/permissions');
    assert.equal(first.data.scanPermissionsReviewed, false);
    const scopePerms = first.data.permissions.filter((p) => p.kind === 'SCAN_SCOPE');
    assert.deepEqual(scopePerms.map((p) => p.id), ['project-folders', 'dependency-folders']);
    assert.ok(scopePerms.every((p) => p.status === PermissionStatus.NOT_GRANTED));

    assert.equal((await api(atlas, '/api/permissions/scan-scope', { id: 'nope', granted: true })).status, 400);
    await api(atlas, '/api/permissions/home-folder-scan', { granted: true });
    const smaller = await api(atlas, '/api/scan/start', { bundlePath: env.bundle });
    const changed = await api(atlas, '/api/permissions/scan-scope', { id: 'project-folders', granted: true });
    assert.equal(changed.data.scanScope.projectFolders, true);
    await api(atlas, '/api/permissions/reviewed', {});
    const larger = await api(atlas, '/api/scan/start', { bundlePath: env.bundle });
    assert.ok(larger.data.state.scan.totalPhysicalBytes > smaller.data.state.scan.totalPhysicalBytes);
    assert.equal(larger.data.state.scan.scope.projectFolders, true);

    // The answers survive a restart
    await atlas.shutdown();
    atlas = start();
    await listen(atlas);
    const again = await api(atlas, '/api/permissions');
    assert.equal(again.data.scanPermissionsReviewed, true);
    assert.equal(again.data.scanScope.projectFolders, true);
    assert.equal(again.data.scanScope.dependencyFolders, false);
  } finally {
    await atlas.shutdown();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S4. Windows has no macOS privacy permissions', () => {
  const perms = describePermissions({ platform: 'win32', homeDir: os.tmpdir(), homeScanConsentAt: 'x' });
  const byId = Object.fromEntries(perms.map((p) => [p.id, p]));
  assert.equal(byId['home-folder-scan'].status, PermissionStatus.GRANTED);
  assert.match(byId['home-folder-scan'].summary, /AppData/);
  for (const id of ['full-disk-access', 'app-data', 'files-and-folders']) {
    assert.equal(byId[id].status, PermissionStatus.NOT_APPLICABLE);
  }
});

test('P1. First prompt: read from the transcript, wrappers and later prompts left out', () => {
  const env = makeHome();
  try {
    const found = readSessionFirstPrompt({ externalSessionId: 'sess-one', sourcePath: env.transcript });
    assert.deepEqual(found, { available: true, text: PROMPT, truncated: false });

    // Another session's records in the same file are not this session's prompt
    const other = readSessionFirstPrompt({ externalSessionId: 'sess-two', sourcePath: env.transcript });
    assert.equal(other.available, false);
    assert.equal(other.reason, 'NO_PROMPT_IN_TRANSCRIPT');

    const long = path.join(env.root, 'long.jsonl');
    fs.writeFileSync(long, JSON.stringify({ type: 'user', message: { role: 'user', content: 'p'.repeat(MAX_PROMPT_CHARS + 50) } }) + '\n{"cut":');
    const cut = readSessionFirstPrompt({ externalSessionId: 'long', sourcePath: long });
    assert.equal(cut.text.length, MAX_PROMPT_CHARS);
    assert.equal(cut.truncated, true);

    assert.equal(readSessionFirstPrompt({ sourcePath: path.join(env.root, 'state.vscdb') }).reason, 'NOT_RECORDED_FOR_THIS_APP');
    assert.equal(readSessionFirstPrompt({ sourcePath: path.join(env.root, 'gone.jsonl') }).reason, 'TRANSCRIPT_NOT_FOUND');

    // Record shapes
    assert.equal(userTextOfRecord({ type: 'assistant', message: { role: 'assistant', content: 'no' } }), '');
    assert.equal(userTextOfRecord({ message: { role: 'user', content: [{ type: 'tool_result', content: 'no' }] } }), '');
    assert.equal(
      userTextOfRecord({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
      ''
    );
    assert.equal(userTextOfRecord({ type: 'event_msg', payload: { type: 'user_message', message: 'fix it' } }), 'fix it');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('P2. First prompt: shown for a session, its tool calls and its files, and stored nowhere', async () => {
  const env = makeHome();
  const dbPath = path.join(env.root, 'index.sqlite');
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin', dbPath });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle });
    assert.equal(state.sessions.length, 1, 'the subagent transcript belongs to its session');
    const session = state.sessions[0];
    assert.equal(session.sourcePath, env.transcript, "the session's record is its main transcript");

    // Session marks on the map carry the prompt; the made-up title is replaced by it
    const { buildMapLevel } = await import('../src/graph/map-levels.js');
    const sessionsLevel = service.decorateLevelWithPrompts(buildMapLevel(state, 'sessions'));
    const mark = sessionsLevel.nodes.find((n) => n.id === `session:${session.id}`);
    assert.equal(mark.metadata.firstPrompt, PROMPT);
    assert.ok(PROMPT.startsWith(mark.label.replace(/…$/, '')), mark.label);
    const opened = service.decorateLevelWithPrompts(buildMapLevel(state, `session:${session.id}`));
    assert.equal(opened.nodes[0].metadata.firstPrompt, PROMPT);
    assert.match(session.title, /^Claude Session /, 'the session itself is not changed');
    const file = state.artifacts.find((a) => a.name === 'importer.js');
    const untraced = state.artifacts.find((a) => a.name === 'settings.json');
    assert.deepEqual(untraced.sessionIds, []);
    for (const nodeId of [session.id, `session:${session.id}`, `dir:session:${session.id}::src`, state.operations[0].id, file.id]) {
      const res = service.describeNodePrompts(nodeId);
      assert.equal(res.sessionCount, 1, nodeId);
      assert.equal(res.prompts[0].text, PROMPT, nodeId);
    }
    assert.deepEqual(service.describeNodePrompts(untraced.id), { prompts: [], sessionCount: 0 });
    assert.deepEqual(service.describeNodePrompts('no-such-node'), { prompts: [], sessionCount: 0 });

    // A transcript outside the scanned folders is not read
    session.sourcePath = path.join(env.root, 'elsewhere.jsonl');
    fs.copyFileSync(env.transcript, session.sourcePath);
    assert.equal(service.describeNodePrompts(session.id).prompts[0].available, false);

    // Neither the scan state nor the index holds any prompt text
    assert.ok(!JSON.stringify(state).includes('keep the old CSV path'));
    service.sqliteStore.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      assert.ok(!JSON.stringify(rows).includes('keep the old CSV path'), `prompt text found in table ${name}`);
    }
    db.close();
  } finally {
    try { service.sqliteStore.close(); } catch { /* already closed */ }
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S5. Files a session recorded are kept when a scan reaches the file limit', async () => {
  const env = makeHome();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(env.project, 'src', `bulk-${i}.txt`), 'b');
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin', maxFiles: 5 });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle, scanScope: { projectFolders: true } });
    assert.equal(state.scan.truncated, true);
    const recorded = state.artifacts.find((a) => a.name === 'importer.js');
    assert.ok(recorded, 'the recorded file is in the scan');
    assert.equal(recorded.provenanceConfidence, 'VERIFIED');
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S6. Past the file limit files are measured, so the total is complete although the listing is not', async () => {
  const env = makeHome();
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(env.project, 'src', `bulk-${i}.txt`), 'b'.repeat(100));
  // A file hardlinked into a measured folder is counted once
  fs.linkSync(path.join(env.project, 'src', 'untouched.js'), path.join(env.project, 'node_modules', 'left-pad', 'linked.js'));
  const full = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  const capped = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin', maxFiles: 8 });
  try {
    const scope = { projectFolders: true, dependencyFolders: true };
    const a = await full.scanAndAnalyze({ bundlePath: env.bundle, scanScope: scope });
    const b = await capped.scanAndAnalyze({ bundlePath: env.bundle, scanScope: scope });
    const totalOf = (s) => s.scan.totalPhysicalBytes + s.scan.measuredPhysicalBytes;
    assert.equal(a.scan.truncated, false);
    assert.equal(b.scan.truncated, true);
    assert.equal(b.artifacts.length, 8);
    assert.ok(b.scan.overflow.fileCount > 0);
    assert.equal(totalOf(b), totalOf(a), 'listed plus measured is the same total with or without the limit');
    // Every byte is counted once: listed files, measured folders and the overflow add up
    const files = a.scan.discoveredArtifactCount + a.scan.measuredFileCount;
    assert.equal(b.scan.discoveredArtifactCount + b.scan.measuredFileCount, files);
  } finally {
    full.sqliteStore.close();
    capped.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('S7. Project files no session recorded are your own work: protected, and shown apart from other unknown files', async () => {
  const env = makeHome();
  fs.writeFileSync(path.join(env.project, 'photo.png'), 'p'.repeat(3000));
  fs.writeFileSync(path.join(env.project, 'data.parquet'), 'q'.repeat(500));
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle, scanScope: { projectFolders: true } });
    const byName = Object.fromEntries(state.artifacts.map((a) => [a.name, a]));
    assert.equal(byName['photo.png'].artifactType, 'USER_CONTENT');
    assert.equal(byName['photo.png'].cleanupClassification, 'PROTECTED');
    assert.equal(byName['photo.png'].provenanceConfidence, 'UNKNOWN', 'the origin itself is not changed');
    const stats = state.graph.stats;
    assert.equal(stats.unknownInProjectsCount, state.artifacts.filter((a) => a.workspaceId && a.provenanceConfidence === 'UNKNOWN').length);
    assert.ok(stats.unknownInProjectsCount >= 2);

    const { typeBreakdown } = await import('../src/graph/map-levels.js');
    const breakdown = typeBreakdown([byName['photo.png'], byName['data.parquet'], byName['untouched.js']], 2);
    assert.deepEqual(breakdown.types.map((t) => t.type), ['.js', '.png'], 'largest first: untouched.js is 5,000 bytes');
    assert.equal(breakdown.otherTypes, 1);
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('C1. What a prompt cost: output, scratch, files kept for it and its record, adding up to the scan', async () => {
  const env = makeHome();
  // A scratch file a tool call wrote outside any project, and a tool result kept for the session
  const scratch = path.join(env.home, 'scratch', 'screenshot.png');
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  fs.writeFileSync(scratch, 's'.repeat(2000));
  const kept = path.join(path.dirname(env.transcript), 'sess-one', 'tool-results', 'result.txt');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'r'.repeat(700));
  // A file it only read, and an existing file outside any project that it edited
  const readOnly = path.join(env.home, 'notes', 'plan.md');
  fs.mkdirSync(path.dirname(readOnly), { recursive: true });
  fs.writeFileSync(readOnly, 'my own notes');
  const dotfile = path.join(env.home, '.zshrc');
  fs.writeFileSync(dotfile, 'export X=1');
  const base = { sessionId: 'sess-one', cwd: env.project, timestamp: '2026-11-01T10:00:00.000Z' };
  const call = (name, file) => JSON.stringify({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { file_path: file } }] } });
  fs.appendFileSync(env.transcript, [call('Write', scratch), call('Read', readOnly), call('Read', env.transcript.replace('sess-one.jsonl', 'nope')), call('Edit', dotfile)].join('\n') + '\n');
  // Nothing has changed for a day: the session is finished
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  for (const f of [env.transcript, kept, path.join(path.dirname(env.transcript), 'sess-one', 'subagents', 'agent-1.jsonl')]) fs.utimesSync(f, dayAgo, dayAgo);

  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle });
    const session = state.sessions[0];
    const cost = state.promptCosts.sessions[session.id];
    // Reading a file does not make it the session's (AGENTS.md rule 3); its own notes are not listed
    assert.ok(!state.artifacts.some((a) => a.name === 'plan.md'), 'a file the session only read is not part of the scan');
    assert.deepEqual(
      Object.fromEntries(Object.entries(cost.parts).map(([k, v]) => [k, v.count])),
      { output: 2, scratch: 1, kept: 1, record: 2 },
      'importer.js and the edited .zshrc; the screenshot; the tool result; the transcript and the subagent transcript'
    );
    assert.equal(cost.parts.scratch.bytes, 2000);
    assert.equal(cost.costCount, 4);
    assert.equal(cost.costBytes, cost.parts.scratch.bytes + cost.parts.kept.bytes + cost.parts.record.bytes);
    assert.equal(cost.possiblyRunning, false);

    // Traced, app-wide and project parts add up to every listed file
    const t = state.promptCosts.totals;
    assert.equal(t.traced.count + t.appWide.count + t.projects.count, state.artifacts.length);
    assert.equal(t.all.bytes, state.scan.totalPhysicalBytes);
    assert.equal(t.traced.bytes + t.appWide.bytes + t.projects.bytes, t.all.bytes);

    // The leftovers offered: the screenshot and the files kept for it, never the output or the record
    const { sessionLeftoverIds, computePromptCosts } = await import('../src/graph/prompt-costs.js');
    const names = sessionLeftoverIds(state, session.id, state.promptCosts).map((id) => state.artifacts.find((a) => a.id === id).name).sort();
    assert.ok(names.includes('screenshot.png') && names.includes('result.txt'), names.join(', '));
    assert.ok(!['importer.js', 'sess-one.jsonl', 'agent-1.jsonl', '.zshrc', 'plan.md'].some((n) => names.includes(n)), names.join(', '));

    // A session that changed in the last hour may still be running: nothing is offered
    const running = computePromptCosts(state, { now: Date.parse(cost.lastActiveAt) + 60 * 1000 });
    assert.equal(running.sessions[session.id].possiblyRunning, true);
    assert.deepEqual(sessionLeftoverIds(state, session.id, running), []);

    // On the map the session carries its cost, numbers only
    const { buildMapLevel } = await import('../src/graph/map-levels.js');
    const mark = buildMapLevel(state, 'sessions').nodes.find((n) => n.id === `session:${session.id}`);
    assert.equal(mark.metadata.cost.costBytes, cost.costBytes);
    assert.ok(!JSON.stringify(state.promptCosts).includes('CSV'), 'no conversation text in the costs');
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('C2. Files of a session that may still be running are never moved, however they are selected', async () => {
  const env = makeHome();
  const scratch = path.join(env.home, 'scratch', 'probe.png');
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  fs.writeFileSync(scratch, 'x'.repeat(500));
  const base = { sessionId: 'sess-one', cwd: env.project, timestamp: '2026-11-01T10:00:00.000Z' };
  fs.appendFileSync(env.transcript, JSON.stringify({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: scratch } }] } }) + '\n');
  // The transcript was just written: the session may still be running
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin', quarantineRoot: path.join(env.root, 'vault') });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle });
    const probe = state.artifacts.find((a) => a.name === 'probe.png');
    assert.equal(state.promptCosts.sessions[state.sessions[0].id].possiblyRunning, true);
    const review = service.prepareCleanupReview([probe.id]);
    assert.equal(review.eligibleItems.length, 0);
    assert.deepEqual(review.blockedItems.map((b) => b.code), ['SESSION_MAY_BE_RUNNING']);
    assert.equal(review.totalBlockedCount, 1);
    // Setting a file aside does not turn a two-file selection into a single one: a high-risk
    // file of no session stays under the bulk rule even with the single-file override
    const highRisk = { ...state.artifacts.find((a) => a.name === 'settings.json'), cleanupClassification: 'HIGH' };
    const review2 = service.cleanupEngine.prepareCleanupReview({ artifacts: [highRisk], authorizedRoots: state.authorizedRoots, allowHighRiskSingleOverride: true, selectionSize: 2 });
    assert.deepEqual(review2.blockedItems.map((b) => b.code), ['BULK_HIGH_RISK_OR_UNKNOWN_BLOCKED']);
    const result = service.executeQuarantine({ artifactIds: [probe.id], confirmationToken: review.confirmationToken });
    assert.equal((result.quarantinedEntries || []).length, 0);
    assert.ok(fs.existsSync(scratch), 'the file is still where it was');
  } catch (err) {
    // A refused confirmation is also a refusal to move
    if (!/EXPLICIT_CONFIRMATION_REQUIRED/.test(err.message)) throw err;
    assert.ok(fs.existsSync(scratch));
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('F1. Search looks through every listed file, with the risk and origin filters', async () => {
  const env = makeHome();
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin' });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle, scanScope: { projectFolders: true } });
    const { searchFiles } = await import('../src/graph/map-levels.js');
    const byName = searchFiles(state, { query: 'IMPORTER.JS' });
    assert.deepEqual(byName.results.map((n) => n.label), ['importer.js']);
    assert.equal(byName.results[0].nodeType, 'ARTIFACT');
    const byPath = searchFiles(state, { query: `${path.sep}src${path.sep}` });
    assert.ok(byPath.total >= 2);
    const verified = searchFiles(state, { origin: 'VERIFIED' });
    assert.ok(verified.ids.every((id) => state.artifacts.find((a) => a.id === id).provenanceConfidence === 'VERIFIED'));
    const protectedOnly = searchFiles(state, { risk: 'PROTECTED', query: '.js' });
    assert.ok(protectedOnly.total > 0 && protectedOnly.results.every((n) => n.riskCategory === 'PROTECTED'));
    const limited = searchFiles(state, { query: '', limit: 2 });
    assert.equal(limited.results.length, 2);
    assert.equal(limited.total, state.artifacts.length);
    assert.ok(limited.results[0].sizeBytes >= limited.results[1].sizeBytes, 'largest first');
    assert.equal(searchFiles(state, { query: 'no-such-file-anywhere' }).total, 0);
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('A1. The ChatGPT app that hosts Codex is listed once and traced; ChatGPT Classic is not given Codex sessions', async () => {
  for (const [bundleId, expected] of [
    ['com.openai.codex', { names: ['ChatGPT'], adapter: 'codex-cli' }],
    ['com.openai.chat', { names: ['ChatGPT', 'Codex'], adapter: 'generic-macos-app' }]
  ]) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-oai-')));
    const home = path.join(root, 'home');
    const apps = path.join(root, 'Applications');
    const write = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
    write(path.join(apps, 'ChatGPT.app', 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleName</key><string>ChatGPT</string><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`);
    write(path.join(home, '.codex', 'sessions', '2026', '11', '01', 'rollout-x.jsonl'), JSON.stringify({ session_id: 's1', cwd: home, timestamp: '2026-11-01T10:00:00Z', type: 'message' }) + '\n');
    const atlas = createAtlasServer({ dataDir: path.join(root, 'data'), liveHomeDir: home, platform: 'darwin', applicationDirs: [apps] });
    try {
      await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
      const api = async (route, body) =>
        (await fetch(`http://127.0.0.1:${atlas.server.address().port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
      await api('/api/permissions/home-folder-scan', { granted: true });
      const boot = await api('/api/bootstrap');
      assert.deepEqual(boot.availableBundles.map((b) => b.name), expected.names, bundleId);
      const scan = await api('/api/scan/start', { bundlePath: path.join(apps, 'ChatGPT.app') });
      assert.equal(scan.state.application.adapterId, expected.adapter, bundleId);
    } finally {
      await atlas.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Q1. A quarantined file keeps the session it came from after a new scan (IDs only)', async () => {
  const env = makeHome();
  const kept = path.join(path.dirname(env.transcript), 'sess-one', 'tool-results', 'result.txt');
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  fs.writeFileSync(kept, 'r'.repeat(700));
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  for (const f of [env.transcript, kept, path.join(path.dirname(env.transcript), 'sess-one', 'subagents', 'agent-1.jsonl')]) fs.utimesSync(f, dayAgo, dayAgo);
  const dbPath = path.join(env.root, 'index.sqlite');
  const service = new ArtifactAtlasService({ homeDir: env.home, platform: 'darwin', dbPath, quarantineRoot: path.join(env.root, 'vault') });
  try {
    const state = await service.scanAndAnalyze({ bundlePath: env.bundle });
    const sessionId = state.sessions[0].id;
    const { sessionLeftoverIds } = await import('../src/graph/prompt-costs.js');
    const ids = sessionLeftoverIds(state, sessionId, state.promptCosts);
    assert.ok(ids.length > 0);
    const review = service.prepareCleanupReview(ids);
    const moved = service.executeQuarantine({ artifactIds: ids, confirmationToken: review.confirmationToken });
    assert.equal(moved.quarantinedEntries.length, review.eligibleItems.length);

    await service.scanAndAnalyze({ bundlePath: env.bundle });
    const entries = service.quarantineEntriesWithSessions();
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => e.sessionIds.length === 1 && e.sessionIds[0] === sessionId));
    // The manifest carries the IDs too, and nothing else about the session
    const manifest = JSON.parse(fs.readFileSync(entries[0].manifestPath, 'utf8'));
    assert.deepEqual(manifest.sessionIds, [sessionId]);
    assert.ok(!JSON.stringify(manifest).includes('CSV'));
  } finally {
    service.sqliteStore.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('A2. Known apps that are not installed are listed apart, with the folder found, and only when it holds data', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dataonly-')));
  const home = path.join(root, 'home');
  const apps = path.join(root, 'Applications');
  fs.mkdirSync(path.join(home, '.trae'), { recursive: true }); // empty: not data left behind
  fs.writeFileSync(path.join(home, '.trae', '.DS_Store'), 'x');
  fs.mkdirSync(path.join(home, '.kiro', 'settings'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kiro', 'settings', 'mcp.json'), '{}');
  fs.mkdirSync(apps, { recursive: true });
  const atlas = createAtlasServer({ dataDir: path.join(root, 'data'), liveHomeDir: home, platform: 'darwin', applicationDirs: [apps] });
  try {
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    const api = async (route, body) =>
      (await fetch(`http://127.0.0.1:${atlas.server.address().port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
    await api('/api/permissions/home-folder-scan', { granted: true });
    const boot = await api('/api/bootstrap');
    assert.deepEqual(boot.availableBundles.map((b) => b.name), ['Kiro'], 'an empty .trae folder is not listed');
    const kiro = boot.availableBundles[0];
    assert.equal(kiro.dataOnly, true);
    assert.equal(kiro.evidencePath, path.join(home, '.kiro'));
  } finally {
    await atlas.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
