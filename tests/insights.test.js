import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeScanForHistory, compareScans } from '../src/graph/scan-history.js';

const state = ({ scope = { projectFolders: true }, truncated = false, files = [], costs = {} } = {}) => ({
  application: { id: 'app_1' },
  scan: { id: `scan_${Math.random()}`, completedAt: '2026-11-01T00:00:00.000Z', scope, truncated, totalPhysicalBytes: files.reduce((s, f) => s + f.sizeBytes, 0), measuredPhysicalBytes: 0 },
  artifacts: files,
  promptCosts: { sessions: costs }
});
const file = (type, sizeBytes) => ({ artifactType: type, sizeBytes });
const cost = (bytes) => ({ parts: { output: { bytes: 0 }, scratch: { bytes }, kept: { bytes: 0 }, record: { bytes: 0 } } });

test('G1. Growth is claimed only between scans that counted the same things', () => {
  const before = summarizeScanForHistory(state({ files: [file('LOG', 100), file('BUILD_OUTPUT', 1000)], costs: { s1: cost(10) } }));
  const after = summarizeScanForHistory(state({ files: [file('LOG', 300), file('BUILD_OUTPUT', 1000), file('REGENERABLE_CACHE', 50)], costs: { s1: cost(40), s2: cost(500) } }));
  const change = compareScans(before, after);
  assert.equal(change.comparable, true);
  assert.equal(change.deltaBytes, 250);
  assert.equal(change.deltaFiles, 1);
  assert.deepEqual(change.kinds.map((k) => [k.artifactType, k.deltaBytes]), [['LOG', 200], ['REGENERABLE_CACHE', 50]]);
  assert.deepEqual(change.sessions.map((s) => [s.sessionId, s.isNew, s.deltaBytes]), [['s2', true, 500], ['s1', false, 30]]);

  assert.equal(compareScans(null, after).reason, 'FIRST_SCAN');
  const wider = summarizeScanForHistory(state({ scope: { projectFolders: true, dependencyFolders: true } }));
  assert.equal(compareScans(before, wider).reason, 'DIFFERENT_SCOPE');
  // Past the file limit the total is still complete: it is compared, the breakdown is not
  const capped = compareScans(before, summarizeScanForHistory(state({ truncated: true, files: [file('LOG', 5000)] })));
  assert.equal(capped.comparable, true);
  assert.equal(capped.totalsOnly, true);
  assert.equal(capped.deltaBytes, 5000 - 1100);
  assert.deepEqual([capped.kinds, capped.sessions, capped.deltaFiles], [[], [], null]);
  assert.equal(compareScans({ ...before, applicationId: 'other' }, after).reason, 'OTHER_APPLICATION');

  // Only numbers and IDs are kept
  assert.deepEqual(Object.keys(after).sort(), ['applicationId', 'cancelled', 'fileCount', 'kinds', 'listedBytes', 'measuredBytes', 'scanId', 'scannedAt', 'scope', 'sessions', 'truncated']);
  assert.deepEqual(after.sessions, { s2: 500, s1: 40 });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findIdenticalFiles, copiesToSelect, keeperOf } from '../src/graph/identical-files.js';

test('G2. Identical files: same content only, hardlinks are one file, protected copies are never selected', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-copies-')));
  try {
    const big = Buffer.alloc(200 * 1024, 7);
    const sameStart = Buffer.concat([Buffer.alloc(100 * 1024, 7), Buffer.alloc(100 * 1024, 9)]);
    const files = {
      a: path.join(root, 'cache', 'a.bin'),
      b: path.join(root, 'project', 'b.bin'),
      c: path.join(root, 'cache', 'c.bin'),
      d: path.join(root, 'cache', 'd.bin'),
      small1: path.join(root, 'cache', 's1'),
      small2: path.join(root, 'cache', 's2')
    };
    for (const p of Object.values(files)) fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(files.a, big);
    fs.writeFileSync(files.b, big);
    fs.writeFileSync(files.c, big);
    fs.writeFileSync(files.d, sameStart); // Same size and same first bytes, different content
    fs.writeFileSync(files.small1, 'tiny');
    fs.writeFileSync(files.small2, 'tiny');
    const art = (id, p, extra = {}) => ({ id, canonicalPath: p, name: path.basename(p), sizeBytes: fs.statSync(p).size, physicalInodeKey: `ino:${id}`, cleanupClassification: 'REVIEW', ...extra });
    const state = {
      artifacts: [
        art('a', files.a, { createdAt: '2026-01-02' }),
        art('b', files.b, { workspaceId: 'ws', cleanupClassification: 'PROTECTED' }),
        art('c', files.c, { createdAt: '2026-01-01' }),
        art('c-link', files.c, { physicalInodeKey: 'ino:c' }), // A hardlink of c
        art('d', files.d),
        art('s1', files.small1),
        art('s2', files.small2)
      ]
    };
    const result = await findIdenticalFiles(state);
    assert.equal(result.groupCount, 1);
    const group = result.groups[0];
    assert.deepEqual(group.files.map((f) => f.id).sort(), ['a', 'b', 'c']);
    assert.equal(result.duplicateBytes, 2 * big.length);
    // The protected copy in the project is kept; the others may be selected
    assert.equal(group.keeperId, 'b');
    assert.deepEqual(copiesToSelect(group, state).sort(), ['a', 'c']);
    // Without a protected or project copy, the oldest is kept
    assert.equal(keeperOf([state.artifacts[0], state.artifacts[2]]).id, 'c');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(findIdenticalFiles(state, { signal: controller.signal }), /CANCELLED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { DatabaseSync } from 'node:sqlite';
import { buildDiagnostics, normalizeKey, shapeOf } from '../src/discovery/diagnostics.js';

test('G3. Diagnostics hold field names and types only: no prompt, value, ID or path', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-diag-')));
  const SECRET = 'Refactor the billing module please';
  const UUID = '3f2a1b4c-1111-2222-3333-444455556666';
  try {
    assert.equal(normalizeKey(UUID), '<id>');
    assert.equal(normalizeKey('/Users/me/x'), '<path>');
    assert.equal(normalizeKey(`composerData:${UUID}`), 'composerData:<id>');
    assert.equal(normalizeKey('quarterly-report.xlsx'), '<file>');
    assert.equal(normalizeKey('jane@example.com'), '<name>');
    assert.equal(normalizeKey('editor.fontSize'), 'editor.fontSize', 'a setting name stays');
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`project${i}`, { size: i }]));
    assert.deepEqual(shapeOf(many), { '<key>': { size: 'number' }, '…': '20 entries' });
    assert.deepEqual(shapeOf({ a: 'text', b: [1, 2], c: { d: null } }), { a: 'string', b: ['number'], c: { d: 'null' } });

    const codexDir = path.join(home, '.codex', 'sessions', '2026', '11', '01');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'rollout.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: UUID, cwd: '/Users/me/p' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ type: 'input_text', text: SECRET }] } })
      ].join('\n')
    );
    const cursorDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    fs.mkdirSync(cursorDir, { recursive: true });
    const db = new DatabaseSync(path.join(cursorDir, 'state.vscdb'));
    db.exec('CREATE TABLE cursorDiskKV (key TEXT, value BLOB)');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${UUID}`, JSON.stringify({ text: SECRET, files: { [`/Users/me/${UUID}.js`]: 1, 'billing-plan.md': 2 }, owner: { 'jane@example.com': true } }));
    db.close();

    const text = buildDiagnostics({
      state: { application: { name: 'Codex' }, artifacts: [{ artifactType: 'UNKNOWN', canonicalPath: path.join(home, 'Library', 'Big', 'blob.bin'), extension: '.bin', sizeBytes: 5 * 1024 * 1024 }] },
      homeDir: home,
      platform: 'darwin',
      appVersion: '0.9.0'
    });
    assert.match(text, /~\/Library\/Big/);
    assert.match(text, /session_meta/);
    assert.match(text, /composerData:<id>/);
    assert.match(text, /"text": "string"/);
    assert.doesNotMatch(text, /billing|3f2a1b4c|\/Users\/me|jane|example\.com/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
