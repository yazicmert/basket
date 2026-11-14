import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtlasServer } from '../src/ui/server.js';
import { readWorktreeGitFacts, claudeWorktreeRoot } from '../src/graph/project-leftovers.js';

function write(p, contents = 'x') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

/** A repository with a Claude Code worktree that a session worked in and built. */
function makeHome() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-wt-')));
  const home = path.join(root, 'home');
  const bundle = path.join(root, 'Applications', 'Claude.app');
  write(
    path.join(bundle, 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleName</key><string>Claude</string><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>'
  );
  const repo = path.join(home, 'Projects', 'shop');
  const wt = path.join(repo, '.claude', 'worktrees', 'feat');
  write(path.join(repo, 'package.json'), '{}');
  write(path.join(repo, 'src', 'main.js'), 'main');
  write(path.join(repo, 'dist', 'main.js'), 'm'.repeat(300));
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(repo, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  write(path.join(repo, '.git', 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/feat\n`);
  write(path.join(repo, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/feat\n');
  write(path.join(repo, '.git', 'worktrees', 'feat', 'commondir'), '../..\n');
  write(path.join(repo, '.git', 'worktrees', 'feat', 'gitdir'), path.join(wt, '.git') + '\n');
  write(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feat')}\n`);
  write(path.join(wt, 'package.json'), '{}');
  write(path.join(wt, 'src', 'cart.js'), 'cart');
  write(path.join(wt, 'dist', 'assets', 'cart-1.js'), 'c'.repeat(5000));
  write(path.join(wt, 'dist', 'assets', 'cart-2.js'), 'c'.repeat(4000));

  const transcript = path.join(home, '.claude', 'projects', 'shop-feat', 'wt-sess.jsonl');
  const base = { sessionId: 'wt-sess', cwd: wt, timestamp: '2026-10-01T08:00:00.000Z' };
  write(
    transcript,
    [
      JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: 'Add a cart.' } }),
      JSON.stringify({ ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(wt, 'src', 'cart.js') } }] } })
    ].join('\n') + '\n'
  );
  const repoBase = { sessionId: 'repo-sess', cwd: repo, timestamp: '2026-10-02T08:00:00.000Z' };
  write(
    path.join(home, '.claude', 'projects', 'shop', 'repo-sess.jsonl'),
    JSON.stringify({ ...repoBase, type: 'user', message: { role: 'user', content: 'Build it.' } }) + '\n'
  );
  return { root, home, bundle, repo, wt };
}

test('WT1. Worktree facts come from Git metadata files only', () => {
  const env = makeHome();
  try {
    assert.equal(claudeWorktreeRoot(path.join(env.wt, 'dist', 'x.js')), env.wt);
    assert.equal(claudeWorktreeRoot(path.join(env.repo, 'src', 'x.js')), null);
    const facts = readWorktreeGitFacts(env.wt);
    assert.equal(facts.registered, true);
    assert.equal(facts.branch, 'feat');
    assert.equal(facts.branchExists, true, 'found in packed-refs');
    assert.equal(facts.repoRoot, env.repo);

    // The branch was deleted and Git forgot the worktree
    fs.writeFileSync(path.join(env.repo, '.git', 'packed-refs'), '# pack-refs\n');
    assert.equal(readWorktreeGitFacts(env.wt).branchExists, false);
    fs.rmSync(path.join(env.repo, '.git', 'worktrees'), { recursive: true });
    assert.equal(readWorktreeGitFacts(env.wt).registered, false);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('WT2. Worktrees and build outputs are listed, shown and selected by id; source is never selected', async () => {
  const env = makeHome();
  const atlas = createAtlasServer({ dataDir: path.join(env.root, 'data'), liveHomeDir: env.home, platform: 'darwin', applicationDirs: [path.dirname(env.bundle)], simulateSystemOpen: true });
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
    await api('/api/permissions/scan-scope', { id: 'project-folders', granted: true });

    // Without the dependency-folders permission, Git metadata is not read
    await api('/api/scan/start', { bundlePath: env.bundle });
    let left = (await api('/api/project-leftovers')).data.leftovers;
    assert.equal(left.gitMetadataRead, false);
    let wt = left.worktrees.find((w) => w.path === env.wt);
    assert.ok(wt, 'the worktree is found');
    assert.equal(wt.git, null);
    assert.equal(wt.removeCommand, null);

    await api('/api/permissions/scan-scope', { id: 'dependency-folders', granted: true });
    await api('/api/scan/start', { bundlePath: env.bundle });
    left = (await api('/api/project-leftovers')).data.leftovers;
    wt = left.worktrees.find((w) => w.path === env.wt);
    assert.equal(wt.madeByClaudeCode, true);
    assert.equal(wt.git.branch, 'feat');
    assert.equal(wt.removeCommand, `git -C "${env.repo}" worktree remove "${env.wt}"`);
    assert.equal(wt.buildOutputs.count, 2);
    assert.equal(wt.buildOutputs.bytes, 9000);
    assert.ok(wt.sessionIds.length === 1, 'the session that ran in it');

    // A worktree's build outputs are on its own row, not repeated under projects
    assert.deepEqual(left.buildProjects.map((b) => [b.path, b.count, b.manifest]), [[env.repo, 1, 'package.json']]);
    assert.deepEqual(wt.sessions.map((s) => s.id), wt.sessionIds);

    // Selecting a worktree's build outputs never picks its source or the main repository's files
    const sel = (await api('/api/selection/resolve', { kind: 'project-build', targetId: wt.id })).data;
    assert.equal(sel.artifactIds.length, 2);
    assert.equal((await api('/api/selection/resolve', { kind: 'project-build', targetId: 'worktree:/etc' })).data.artifactIds.length, 0);

    // Shown by id; an id the scan did not list is refused
    const shown = (await api('/api/finder/reveal', { targetId: wt.id })).data;
    assert.equal(shown.path, env.wt);
    assert.equal((await api('/api/finder/reveal', { targetId: 'worktree:/etc' })).status, 404);

    // Files in two folders of one project: the project folder they share is opened directly
    const both = [...sel.artifactIds, ...(await api('/api/selection/resolve', { kind: 'project-build', targetId: `build:${env.repo}` })).data.artifactIds];
    assert.equal(both.length, 3);
    const one = (await api('/api/finder/reveal', { artifactIds: both })).data;
    assert.equal(one.chooseRegion, undefined);
    assert.equal(one.path, env.repo);

    // Spread over the project and the app's own folder: both are offered, then the chosen one opens
    const record = (await api('/api/selection/resolve', { kind: 'search', query: 'repo-sess' })).data.artifactIds;
    assert.ok(record.length >= 1);
    const ask = (await api('/api/finder/reveal', { artifactIds: [...both, ...record] })).data;
    assert.equal(ask.chooseRegion, true);
    assert.equal(ask.reveal.regionCount, 2);
    assert.equal(ask.reveal.regions[0].path, env.repo);
    const second = (await api('/api/finder/reveal', { artifactIds: [...both, ...record], region: 1 })).data;
    assert.equal(second.path, path.join(env.home, '.claude', 'projects', 'shop'));
    assert.equal((await api('/api/finder/reveal', { artifactIds: both, region: 9 })).status, 400);

    // Marks of the map: a folder level is shown by its id
    const level = (await api('/api/map/level', { levelId: 'root' })).data.level;
    const kind = level.nodes.find((n) => n.drillId && n.drillId.startsWith('group:'));
    const inside = (await api('/api/map/level', { levelId: kind.drillId })).data.level;
    const folder = inside.nodes.find((n) => n.id.startsWith('dir:'));
    if (folder) {
      const res = (await api('/api/finder/reveal', { targetId: folder.id })).data;
      assert.ok(res.ok && res.path);
    }
    assert.equal((await api('/api/finder/reveal', { targetId: 'dir:x::/etc' })).status, 404);
  } finally {
    await atlas.shutdown();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test('WT3. Show in Finder never opens a path sent by the window', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rv-'));
  const atlas = createAtlasServer({ dataDir, simulateSystemOpen: true });
  try {
    await new Promise((resolve) => atlas.server.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${atlas.server.address().port}/api/finder/reveal`, {
      method: 'POST',
      headers: { 'X-Atlas-Token': atlas.sessionToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: os.homedir() })
    });
    assert.equal(res.status, 400);
  } finally {
    await atlas.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('WT4. The report is written locally, names sessions without their prompts, and is safe to open in a spreadsheet', async () => {
  const env = makeHome();
  const dataDir = path.join(env.root, 'data');
  const atlas = createAtlasServer({ dataDir, liveHomeDir: env.home, platform: 'darwin', applicationDirs: [path.dirname(env.bundle)], simulateSystemOpen: true });
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
    await api('/api/permissions/scan-scope', { id: 'project-folders', granted: true });
    await api('/api/scan/start', { bundlePath: env.bundle });
    const report = (await api('/api/report', {})).data;
    assert.ok(report.ok);
    assert.ok(report.htmlPath.startsWith(path.join(dataDir, 'reports')));
    const html = fs.readFileSync(report.htmlPath, 'utf8');
    const csv = fs.readFileSync(report.csvPath, 'utf8');
    assert.match(html, /Artifact Atlas report/);
    assert.match(html, /feat/, 'the worktree is listed');
    for (const text of [html, csv]) {
      assert.doesNotMatch(text, /Add a cart|Build it/, 'no prompt text');
    }
    assert.match(csv, /^section,name,files,bytes,size,detail\n/);

    const { reportCsv } = await import('../src/graph/report.js');
    const out = reportCsv({ application: '=HYPERLINK("x")', fileCount: 0, listedBytes: 0, measuredBytes: 0, scannedAt: '', kinds: [], risks: [], sessions: [], worktrees: [], buildProjects: [] });
    assert.match(out, /"'=HYPERLINK\(""x""\)"/, 'a formula is written as text');
  } finally {
    await atlas.shutdown();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
