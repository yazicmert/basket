import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ArtifactType,
  ProvenanceConfidence,
  RiskCategory,
  RestoreConflictStrategy,
  ScanStatus
} from '../src/models/entities.js';
import { ArtifactAtlasService as AtlasService } from '../src/atlas-service.js';

// Windows cannot delete a folder while a database in it is open, so every service a test
// creates is closed before its sandbox is removed.
const openServices = [];
class ArtifactAtlasService extends AtlasService {
  constructor(options) {
    super(options);
    openServices.push(this);
  }
}
function closeOpenServices() {
  for (const service of openServices.splice(0)) {
    try {
      service.sqliteStore.close();
    } catch {
      // Already closed by the test
    }
  }
}
import { ClassificationEngine } from '../src/classification/classification-engine.js';
import { PlatformServices } from '../src/platform/platform-services.js';
import { createAtlasServer, isLoopbackHostHeader } from '../src/ui/server.js';
import { createDeterministicDemoEnvironment } from '../src/fixtures/demo-environment.js';

function createTempSandbox(prefix = 'artifact-atlas-safety-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    cleanup() {
      closeOpenServices();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function createScannedDemoService(sandboxDir) {
  const demo = createDeterministicDemoEnvironment(sandboxDir);
  const service = new ArtifactAtlasService({
    homeDir: demo.homeDir, platform: 'darwin',
    dbPath: path.join(sandboxDir, 'atlas.sqlite'),
    quarantineRoot: path.join(sandboxDir, 'quarantine-vault')
  });
  const state = await service.scanAndAnalyze({ bundlePath: demo.appBundles.claude.bundlePath });
  const lowRiskCache = state.artifacts.find(
    (a) => a.canonicalPath === demo.sampleFiles.claudeStatsigFile
  );
  assert.equal(lowRiskCache.cleanupClassification, RiskCategory.LOW);
  return { demo, service, state, lowRiskCache };
}

function quarantineArtifact(service, artifact) {
  const review = service.prepareCleanupReview([artifact.id]);
  const result = service.executeQuarantine({
    artifactIds: [artifact.id],
    confirmationToken: review.confirmationToken
  });
  return result;
}

function sha256Of(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

/**
 * Temporarily replaces fs.renameSync (the shared `node:fs` default export object) so tests can
 * simulate cross-volume (EXDEV) and failing moves.
 */
function withPatchedRename(replacement, fn) {
  const original = fs.renameSync;
  fs.renameSync = replacement;
  try {
    return fn();
  } finally {
    fs.renameSync = original;
  }
}

test('S1. OVERWRITE_IF_EXPLICIT restore never destroys the occupying file: it is displaced into the Quarantine Vault and is itself restorable', async () => {
  const sandbox = createTempSandbox();
  try {
    const { service, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const originalPath = lowRiskCache.canonicalPath;
    const originalContents = fs.readFileSync(originalPath);

    const { quarantinedEntries } = quarantineArtifact(service, lowRiskCache);
    const qEntry = quarantinedEntries[0];

    // The user (or the app) recreates a different file at the original path
    const occupantContents = 'IRREPLACEABLE_FILE_CREATED_AFTER_QUARANTINE';
    fs.writeFileSync(originalPath, occupantContents, 'utf8');

    const res = service.restoreQuarantineEntry({
      entryId: qEntry.id,
      conflictStrategy: RestoreConflictStrategy.OVERWRITE_IF_EXPLICIT
    });

    assert.equal(res.restored, true);
    assert.deepEqual(fs.readFileSync(originalPath), originalContents);

    // The displaced occupant is preserved byte-for-byte with manifest + SQLite record
    assert.ok(res.displacedEntry, 'displaced occupant must be reported');
    const displaced = res.displacedEntry;
    assert.equal(displaced.originalPath, originalPath);
    assert.equal(fs.readFileSync(displaced.quarantinePath, 'utf8'), occupantContents);
    assert.equal(displaced.sha256, sha256Of(occupantContents));
    const manifest = JSON.parse(fs.readFileSync(displaced.manifestPath, 'utf8'));
    assert.equal(manifest.status, 'QUARANTINED');
    assert.equal(manifest.originalPath, originalPath);
    const dbEntry = service.sqliteStore.getQuarantineEntryById(displaced.id);
    assert.equal(dbEntry.status, 'QUARANTINED');

    // And the displaced occupant can be restored alongside under a new name
    const res2 = service.restoreQuarantineEntry({
      entryId: displaced.id,
      conflictStrategy: RestoreConflictStrategy.RENAME_RESTORED
    });
    assert.notEqual(res2.restoredToPath, originalPath);
    assert.equal(fs.readFileSync(res2.restoredToPath, 'utf8'), occupantContents);
    assert.deepEqual(fs.readFileSync(originalPath), originalContents);

    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S2. Restore refuses directories/symlinks at the destination, swapped parent directories, and unknown strategies', async () => {
  const sandbox = createTempSandbox();
  try {
    const { service, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const originalPath = lowRiskCache.canonicalPath;
    const { quarantinedEntries } = quarantineArtifact(service, lowRiskCache);
    const qEntry = quarantinedEntries[0];

    assert.throws(
      () => service.restoreQuarantineEntry({ entryId: qEntry.id, conflictStrategy: 'DELETE_EVERYTHING' }),
      /Unsupported conflict strategy/
    );

    // A dangling symlink at the destination is a conflict (fs.existsSync would miss it)
    fs.symlinkSync(path.join(sandbox.dir, 'does-not-exist'), originalPath);
    assert.throws(
      () => service.restoreQuarantineEntry({ entryId: qEntry.id }),
      /RESTORE_CONFLICT_EXISTS/
    );
    assert.throws(
      () =>
        service.restoreQuarantineEntry({
          entryId: qEntry.id,
          conflictStrategy: RestoreConflictStrategy.OVERWRITE_IF_EXPLICIT
        }),
      /RESTORE_CONFLICT_NOT_REGULAR_FILE/
    );
    assert.ok(fs.lstatSync(originalPath).isSymbolicLink(), 'symlink must be left untouched');
    fs.unlinkSync(originalPath);

    // Parent directory replaced by a symlink pointing elsewhere -> refuse to write through it
    const parentDir = path.dirname(originalPath);
    const movedAside = `${parentDir}.moved-aside`;
    const decoyDir = path.join(sandbox.dir, 'decoy-target');
    fs.mkdirSync(decoyDir);
    fs.renameSync(parentDir, movedAside);
    fs.symlinkSync(decoyDir, parentDir);
    assert.throws(
      () => service.restoreQuarantineEntry({ entryId: qEntry.id }),
      /RESTORE_PATH_CHANGED/
    );
    assert.deepEqual(fs.readdirSync(decoyDir), []);
    assert.equal(fs.existsSync(qEntry.quarantinePath), true, 'payload stays safely in the vault');

    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S3. Classification: source code and Git working-tree files are never LOW, and UNKNOWN provenance never yields LOW', () => {
  const sandbox = createTempSandbox();
  try {
    const engine = new ClassificationEngine();
    const repo = path.join(sandbox.dir, 'proj');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const looseDir = path.join(sandbox.dir, 'Library', 'Caches', 'com.example.app');

    const mk = (filePath, overrides = {}) => ({
      canonicalPath: filePath,
      parentDir: path.dirname(filePath),
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      sharedDependencyIndicators: [],
      sessionIds: ['s1'],
      evidence: [],
      workspaceId: null,
      provenanceConfidence: ProvenanceConfidence.VERIFIED,
      ...overrides
    });

    // Source code in temp-/cache-looking directories of a Git repository
    for (const rel of ['scratch/main.py', '.cache/handler.ts', 'temp-work/migrate.sql']) {
      const res = engine.classifySingleArtifact(mk(path.join(repo, rel)));
      assert.notEqual(res.riskCategory, RiskCategory.LOW, `${rel} must not be LOW`);
      assert.equal(res.gitRepositoryRoot, repo);
      assert.match(res.explanation, /source-code file/);
    }

    // Source code in a known workspace without a Git repository
    const wsRes = engine.classifySingleArtifact(
      mk(path.join(sandbox.dir, 'plain-ws', 'scratch', 'main.py'), { workspaceId: 'ws_1' })
    );
    assert.equal(wsRes.riskCategory, RiskCategory.REVIEW);

    // Non-source scratch file inside a Git working tree may still be tracked content
    const scratchNote = engine.classifySingleArtifact(mk(path.join(repo, 'scratch', 'notes.txt')));
    assert.equal(scratchNote.artifactType, ArtifactType.TEMP_FILE);
    assert.equal(scratchNote.riskCategory, RiskCategory.REVIEW);

    // A cache with UNKNOWN provenance is not LOW
    const unknownCache = engine.classifySingleArtifact(
      mk(path.join(looseDir, 'blob.bin'), { provenanceConfidence: ProvenanceConfidence.UNKNOWN })
    );
    assert.equal(unknownCache.artifactType, ArtifactType.REGENERABLE_CACHE);
    assert.equal(unknownCache.riskCategory, RiskCategory.REVIEW);

    // Genuine regenerable caches stay LOW: app container cache, and bytecode cache in a repo
    const appCache = engine.classifySingleArtifact(mk(path.join(looseDir, 'blob.bin')));
    assert.equal(appCache.riskCategory, RiskCategory.LOW);
    assert.equal(appCache.gitRepositoryRoot, null);
    const pycache = engine.classifySingleArtifact(
      mk(path.join(repo, 'pkg', '__pycache__', 'mod.cpython-312.pyc'))
    );
    assert.equal(pycache.riskCategory, RiskCategory.LOW);
  } finally {
    sandbox.cleanup();
  }
});

test('S4. Local API: token is always required and Host header must be exactly loopback (DNS-rebinding guard)', async () => {
  assert.equal(isLoopbackHostHeader('127.0.0.1:4310'), true);
  assert.equal(isLoopbackHostHeader('localhost'), true);
  assert.equal(isLoopbackHostHeader('[::1]:4310'), true);
  assert.equal(isLoopbackHostHeader('localhost.evil.example:4310'), false);
  assert.equal(isLoopbackHostHeader('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHostHeader('localhost:4310@evil.example'), false);
  assert.equal(isLoopbackHostHeader(''), false);
  assert.equal(isLoopbackHostHeader(undefined), false);

  const sandbox = createTempSandbox();
  const { server, sessionToken, shutdown } = createAtlasServer({ sandboxRoot: sandbox.dir, dataDir: sandbox.dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const get = (urlPath, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });

  try {
    // No explicit token configured: the API must still reject unauthenticated callers
    assert.equal(await get('/api/bootstrap'), 401);
    assert.equal(await get('/api/bootstrap', { 'X-Atlas-Token': 'wrong' }), 401);
    assert.equal(await get('/api/bootstrap', { 'X-Atlas-Token': sessionToken }), 200);
    assert.equal(await get('/api/health'), 200);

    // Rebinding-style Host headers are rejected even with a valid token, including for static files
    for (const host of ['localhost.evil.example', `127.0.0.1.evil.example:${port}`, 'evil.example']) {
      assert.equal(await get('/api/bootstrap', { Host: host, 'X-Atlas-Token': sessionToken }), 403);
      assert.equal(await get('/', { Host: host }), 403);
    }
    assert.equal(await get('/api/bootstrap', { Host: `localhost:${port}`, 'X-Atlas-Token': sessionToken }), 200);
  } finally {
    await shutdown();
    sandbox.cleanup();
  }
});

test('S5. Quarantine is crash-safe: manifest precedes the move, a failed move leaves the file in place, and cross-volume moves are hash-verified', async () => {
  const sandbox = createTempSandbox();
  try {
    const { service, demo, state, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const originalPath = lowRiskCache.canonicalPath;
    const originalContents = fs.readFileSync(originalPath);
    const review = service.prepareCleanupReview([lowRiskCache.id]);
    const realRename = fs.renameSync;

    // (a) The manifest (status PENDING) is already on disk at the moment the payload moves
    let manifestSeenAtMoveTime = null;
    // (b) ...and a failing move must not lose the file or leave vault debris / DB records
    const failed = withPatchedRename(
      (src, dest) => {
        if (src === originalPath) {
          manifestSeenAtMoveTime = JSON.parse(
            fs.readFileSync(path.join(path.dirname(dest), 'manifest.json'), 'utf8')
          );
          const err = new Error('simulated EACCES');
          err.code = 'EACCES';
          throw err;
        }
        return realRename(src, dest);
      },
      () =>
        service.executeQuarantine({
          artifactIds: [lowRiskCache.id],
          confirmationToken: review.confirmationToken
        })
    );
    assert.equal(manifestSeenAtMoveTime.status, 'PENDING');
    assert.equal(manifestSeenAtMoveTime.originalPath, originalPath);
    assert.equal(manifestSeenAtMoveTime.sha256, sha256Of(originalContents));
    assert.equal(failed.quarantinedEntries.length, 0);
    assert.equal(failed.blockedItems[0].code, 'QUARANTINE_MOVE_FAILED');
    assert.deepEqual(fs.readFileSync(originalPath), originalContents);
    assert.equal(lowRiskCache.quarantined, false);
    assert.equal(service.sqliteStore.listQuarantineEntries().length, 0);
    const failedBatchDir = path.dirname(failed.batchManifestPath);
    assert.deepEqual(fs.readdirSync(failedBatchDir), ['batch-manifest.json']);

    // (c) Cross-volume (EXDEV) quarantine + restore: copy is verified before the source is removed
    const exdev = () => {
      const err = new Error('simulated EXDEV');
      err.code = 'EXDEV';
      throw err;
    };
    const ok = withPatchedRename(exdev, () =>
      service.executeQuarantine({
        artifactIds: [lowRiskCache.id],
        confirmationToken: review.confirmationToken
      })
    );
    const qEntry = ok.quarantinedEntries[0];
    assert.equal(fs.existsSync(originalPath), false);
    assert.deepEqual(fs.readFileSync(qEntry.quarantinePath), originalContents);
    assert.equal(JSON.parse(fs.readFileSync(qEntry.manifestPath, 'utf8')).status, 'QUARANTINED');

    const restored = withPatchedRename(exdev, () =>
      service.restoreQuarantineEntry({ entryId: qEntry.id })
    );
    assert.equal(restored.restoredToPath, originalPath);
    assert.deepEqual(fs.readFileSync(originalPath), originalContents);
    assert.equal(fs.existsSync(qEntry.quarantinePath), false);

    // (d) A cross-volume copy that does not match the source digest keeps the source in place
    const platform = service.platformServices;
    const src = path.join(sandbox.dir, 'verify-src.bin');
    const dest = path.join(sandbox.dir, 'verify-dest.bin');
    fs.writeFileSync(src, 'payload-bytes');
    assert.throws(
      () => withPatchedRename(exdev, () => platform.moveFileNoClobber(src, dest, 'f'.repeat(64))),
      /MOVE_COPY_VERIFICATION_FAILED/
    );
    assert.equal(fs.readFileSync(src, 'utf8'), 'payload-bytes');
    assert.equal(fs.existsSync(dest), false);

    // (e) Moves never clobber an existing destination
    fs.writeFileSync(dest, 'already-here');
    assert.throws(() => platform.moveFileNoClobber(src, dest), /MOVE_DESTINATION_EXISTS/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'already-here');

    // (f) Tampered payloads are refused on restore
    const debugLog = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.claudeDebugLogFile
    );
    const logEntry = quarantineArtifact(service, debugLog).quarantinedEntries[0];
    fs.appendFileSync(logEntry.quarantinePath, 'tampered');
    assert.throws(
      () => service.restoreQuarantineEntry({ entryId: logEntry.id }),
      /QUARANTINE_INTEGRITY_MISMATCH/
    );

    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S6. Integrity digests cover large files, and entries are recoverable from manifest.json when the SQLite record is lost', async () => {
  const sandbox = createTempSandbox();
  try {
    // Chunked hashing has no size cutoff (the previous implementation skipped big files)
    const platform = new PlatformServices({ homeDir: sandbox.dir });
    const big = crypto.randomBytes(3 * 1024 * 1024 + 123);
    const bigPath = path.join(sandbox.dir, 'big.bin');
    fs.writeFileSync(bigPath, big);
    assert.equal(platform.computeFileSha256(bigPath), sha256Of(big));
    assert.equal(platform.computeFileSha256(sandbox.dir), null);

    const { service, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const originalPath = lowRiskCache.canonicalPath;
    const originalContents = fs.readFileSync(originalPath);
    const qEntry = quarantineArtifact(service, lowRiskCache).quarantinedEntries[0];
    assert.equal(qEntry.sha256, sha256Of(originalContents));

    // Lose the database record: the on-disk manifest alone must be enough to restore
    service.sqliteStore.db.prepare('DELETE FROM quarantine_entries WHERE id = ?').run(qEntry.id);
    assert.equal(service.sqliteStore.getQuarantineEntryById(qEntry.id), null);

    const res = service.restoreQuarantineEntry({ entryId: qEntry.id });
    assert.equal(res.restoredToPath, originalPath);
    assert.deepEqual(fs.readFileSync(originalPath), originalContents);
    assert.equal(service.sqliteStore.getQuarantineEntryById(qEntry.id).status, 'RESTORED');

    // Entry IDs are never used as path traversal vectors
    assert.throws(
      () => service.restoreQuarantineEntry({ entryId: '../../etc' }),
      /Quarantine entry not found/
    );

    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S7. Scans that hit the file limit are flagged as truncated instead of looking complete', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const limited = new ArtifactAtlasService({ homeDir: demo.homeDir, platform: 'darwin', maxFiles: 3 });
    const partial = await limited.scanAndAnalyze({ bundlePath: demo.appBundles.claude.bundlePath });
    assert.equal(partial.scan.status, ScanStatus.COMPLETED);
    assert.equal(partial.scan.truncated, true);
    assert.equal(partial.scan.maxFilesLimit, 3);
    assert.equal(partial.artifacts.length, 3);
    const row = limited.sqliteStore.db
      .prepare('SELECT truncated, max_files_limit FROM scans WHERE id = ?')
      .get(partial.scan.id);
    assert.equal(row.truncated, 1);
    assert.equal(row.max_files_limit, 3);
    limited.sqliteStore.close();

    const full = new ArtifactAtlasService({ homeDir: demo.homeDir, platform: 'darwin' });
    const complete = await full.scanAndAnalyze({ bundlePath: demo.appBundles.claude.bundlePath });
    assert.equal(complete.scan.truncated, false);
    assert.ok(complete.artifacts.length > 3);
    full.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S8. Pre-flight rejects artifacts outside the authorized roots, inside the vault, and non-regular files', async () => {
  const sandbox = createTempSandbox();
  try {
    const { service, state, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const engine = service.cleanupEngine;
    const roots = state.authorizedRoots;

    const outsidePath = path.join(sandbox.dir, 'outside.cache');
    fs.writeFileSync(outsidePath, 'x');
    const st = fs.lstatSync(outsidePath);
    const forged = {
      ...lowRiskCache,
      id: 'art_forged',
      canonicalPath: outsidePath,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode,
      physicalInodeKey: `${st.dev}:${st.ino}`
    };
    assert.equal(engine.verifyArtifactPreFlight(forged, roots).code, 'OUTSIDE_AUTHORIZED_BOUNDARY');

    const vaultFile = path.join(engine.quarantineRoot, 'batches', 'x', 'payload');
    fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
    fs.writeFileSync(vaultFile, 'x');
    assert.equal(
      engine.verifyArtifactPreFlight({ ...forged, canonicalPath: vaultFile }, []).code,
      'QUARANTINE_VAULT_REJECTED'
    );

    const dirArtifact = { ...lowRiskCache, canonicalPath: path.dirname(lowRiskCache.canonicalPath) };
    assert.equal(engine.verifyArtifactPreFlight(dirArtifact, roots).code, 'NOT_REGULAR_FILE_REJECTED');

    assert.equal(engine.verifyArtifactPreFlight(lowRiskCache, roots).code, 'OK');
    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('S9. CLI quarantine/restore: two-step confirmation, persistent vault across invocations, high-risk acknowledgment', () => {
  const sandbox = createTempSandbox();
  try {
    const dataDir = path.join(sandbox.dir, 'data');
    const cacheDir = path.join(sandbox.dir, 'work', '.cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, 'index.bin');
    fs.writeFileSync(target, 'cached-bytes');

    const cli = (...cliArgs) =>
      spawnSync(process.execPath, [path.resolve('src/cli.js'), ...cliArgs, '--data-dir', dataDir], {
        encoding: 'utf8'
      });

    // UNKNOWN provenance requires the explicit high-risk acknowledgment flag
    const blocked = cli('quarantine', target);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /HIGH_RISK_CONFIRMATION_REQUIRED/);
    assert.equal(fs.existsSync(target), true);

    // Step 1: review only — prints a token and moves nothing
    const review = cli('quarantine', target, '--allow-high-risk');
    assert.equal(review.status, 0, review.stderr);
    const token = /--confirm (confirm_[0-9a-f]+)/.exec(review.stdout)?.[1];
    assert.ok(token, 'review must print a confirmation token');
    assert.equal(fs.existsSync(target), true);

    // A wrong token is refused
    const wrong = cli('quarantine', target, '--allow-high-risk', '--confirm', 'confirm_bogus');
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /EXPLICIT_CONFIRMATION_REQUIRED/);
    assert.equal(fs.existsSync(target), true);

    // Step 2: confirmed
    const done = cli('quarantine', target, '--allow-high-risk', '--confirm', token);
    assert.equal(done.status, 0, done.stderr);
    const entryId = /entry:\s+(qent_[0-9a-f]+)/.exec(done.stdout)?.[1];
    assert.ok(entryId);
    assert.equal(fs.existsSync(target), false);

    // A separate process can list and restore from the persistent vault
    const list = cli('restore', '--list');
    assert.match(list.stdout, new RegExp(`${entryId}\\s+\\[QUARANTINED\\]`));
    const restored = cli('restore', entryId);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fs.readFileSync(target, 'utf8'), 'cached-bytes');

    const again = cli('restore', entryId);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already been restored/);
  } finally {
    sandbox.cleanup();
  }
});

test('S9. Emptying the Quarantine: only after 30 days, only the confirmed list, only real payloads in the vault', async () => {
  const sandbox = createTempSandbox();
  try {
    const { service, lowRiskCache } = await createScannedDemoService(sandbox.dir);
    const result = quarantineArtifact(service, lowRiskCache);
    const entry = result.quarantinedEntries ? result.quarantinedEntries[0] : service.quarantineEntriesWithSessions()[0];
    const day = 24 * 60 * 60 * 1000;
    const heldAt = Date.parse(entry.quarantinedAt);

    // Too early: nothing may be emptied, and there is nothing to confirm
    const early = service.preparePurge({ now: heldAt + 29 * day });
    assert.equal(early.entries.length, 0);
    assert.equal(early.token, null);

    // A confirmation is bound to the list and used once
    const later = heldAt + 31 * day;
    const list = service.preparePurge({ now: later });
    assert.equal(list.entries.length, 1);
    assert.equal(list.minAgeDays, 30);
    assert.throws(() => service.purgeQuarantine({ token: 'purge_wrong', now: later }), /PURGE_CONFIRMATION_EXPIRED/);
    assert.throws(() => service.purgeQuarantine({ token: list.token, now: later + 11 * 60 * 1000 }), /PURGE_CONFIRMATION_EXPIRED/);

    // A manifest whose date differs from the database is skipped
    const manifest = JSON.parse(fs.readFileSync(entry.manifestPath, 'utf8'));
    fs.writeFileSync(entry.manifestPath, JSON.stringify({ ...manifest, quarantinedAt: '2000-01-01T00:00:00.000Z' }));
    assert.equal(service.preparePurge({ now: later }).entries.length, 0);
    fs.writeFileSync(entry.manifestPath, JSON.stringify(manifest));

    // A payload replaced by a symlink is never followed or deleted
    const outside = path.join(sandbox.dir, 'outside.txt');
    fs.writeFileSync(outside, 'keep me');
    const saved = fs.readFileSync(entry.quarantinePath);
    fs.rmSync(entry.quarantinePath);
    let linked = true;
    try {
      fs.symlinkSync(outside, entry.quarantinePath);
    } catch {
      linked = false; // Windows without the symlink privilege
    }
    if (linked) assert.equal(service.preparePurge({ now: later }).entries.length, 0);
    fs.rmSync(entry.quarantinePath, { force: true });
    fs.writeFileSync(entry.quarantinePath, saved);

    const confirmed = service.preparePurge({ now: later });
    const done = service.purgeQuarantine({ token: confirmed.token, now: later });
    assert.equal(done.purgedCount, 1);
    assert.equal(done.freedBytes, saved.length);
    assert.equal(fs.existsSync(entry.quarantinePath), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
    // The record stays, marked as emptied; it cannot be put back or emptied twice
    const after = service.quarantineEntriesWithSessions().find((e) => e.id === entry.id);
    assert.equal(after.status, 'PURGED');
    assert.ok(after.purgedAt);
    assert.equal(JSON.parse(fs.readFileSync(entry.manifestPath, 'utf8')).status, 'PURGED');
    assert.throws(() => service.restoreQuarantineEntry({ entryId: entry.id }), /cannot be restored/);
    assert.equal(service.preparePurge({ now: later }).entries.length, 0);
    assert.throws(() => service.purgeQuarantine({ token: confirmed.token, now: later }), /PURGE_CONFIRMATION_EXPIRED/);
  } finally {
    sandbox.cleanup();
  }
});
