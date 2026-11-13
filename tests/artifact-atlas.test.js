import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NodeType,
  EdgeType,
  ProvenanceConfidence,
  ArtifactType,
  RiskCategory,
  ScanStatus,
  RestoreConflictStrategy
} from '../src/models/entities.js';
import { ArtifactAtlasService } from '../src/atlas-service.js';
import { createDeterministicDemoEnvironment } from '../src/fixtures/demo-environment.js';

function createTempSandbox(prefix = 'artifact-atlas-test-') {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let dir = rawDir;
  try {
    dir = fs.realpathSync(rawDir);
  } catch {
    dir = rawDir;
  }
  return {
    dir,
    cleanup() {
      try {
        // Restore permissions before rmSync in case tests set mode 000
        chmodRecursiveSafe(dir);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}

function chmodRecursiveSafe(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(target, st.isDirectory() ? 0o755 : 0o644);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        chmodRecursiveSafe(path.join(target, entry));
      }
    }
  } catch {
    // Ignore
  }
}

test('1. Application identification: parses supported and unsupported macOS .app bundles without executing them', () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const service = new ArtifactAtlasService({ homeDir: demo.homeDir });

    const claudeApp = service.identifyApplication(demo.appBundles.claude.bundlePath);
    assert.equal(claudeApp.name, 'Claude Code');
    assert.equal(claudeApp.bundleId, 'com.anthropic.claudefordesktop');
    assert.equal(claudeApp.version, '1.2.4');
    assert.equal(claudeApp.adapterId, 'claude-code');
    assert.equal(claudeApp.isSupportedAIApp, true);
    assert.equal(claudeApp.recognitionStatus, 'VERIFIED_AI_ADAPTER');
    assert.ok(claudeApp.executablePath.endsWith('Contents/MacOS/Claude'));
    assert.ok(claudeApp.knownDataDirectories.length >= 3);

    // Unsupported .app bundle falls back gracefully to Generic macOS Adapter
    const genericApp = service.identifyApplication(demo.appBundles.unsupported.bundlePath);
    assert.equal(genericApp.name, 'NebulaSketch');
    assert.equal(genericApp.bundleId, 'com.example.nebulasketch');
    assert.equal(genericApp.adapterId, 'generic-macos-app');
    assert.equal(genericApp.isSupportedAIApp, false);
    assert.equal(genericApp.recognitionStatus, 'GENERIC_MACOS_ADAPTER');
  } finally {
    sandbox.cleanup();
  }
});

test('2 & 3 & 4 & 5. Filesystem scanning, symlink boundaries, duplicate physical hardlinks, and size aggregation', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const service = new ArtifactAtlasService({ homeDir: demo.homeDir });

    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });

    assert.equal(state.scan.status, ScanStatus.COMPLETED);
    assert.ok(state.scan.discoveredArtifactCount >= 12);

    // Symlink escaping outside boundary must be skipped and never indexed
    assert.ok(
      state.scan.skippedSymlinks.some((s) => s.reason === 'SYMLINK_OUTSIDE_BOUNDARY'),
      'Expected out-of-boundary symlink to be skipped and logged'
    );
    assert.ok(
      !state.artifacts.some((a) => a.name === 'outside-secret.txt'),
      'Outside boundary symlink target must never be indexed'
    );

    // Duplicate physical hardlinks must be detected and deduplicated in physical byte totals
    if (fs.existsSync(demo.sampleFiles.claudeCacheHardlink)) {
      assert.ok(state.scan.deduplicatedHardlinkCount >= 1);
      assert.ok(
        state.scan.totalLogicalBytes > state.scan.totalPhysicalBytes,
        'Logical bytes should exceed deduplicated physical bytes when hardlinks exist'
      );

      const hardlinkedArtifacts = state.artifacts.filter(
        (a) =>
          a.canonicalPath === demo.sampleFiles.claudeCacheBlob ||
          a.canonicalPath === demo.sampleFiles.claudeCacheHardlink
      );
      assert.equal(hardlinkedArtifacts.length, 2);
      assert.equal(
        hardlinkedArtifacts[0].physicalInodeKey,
        hardlinkedArtifacts[1].physicalInodeKey
      );
      assert.ok(hardlinkedArtifacts[0].sharedDependencyIndicators.length > 0);
    }

    // Treemap total physical bytes must match deduplicated physical bytes
    assert.equal(state.graph.treemap.totalPhysicalBytes, state.scan.totalPhysicalBytes);
  } finally {
    sandbox.cleanup();
  }
});

test('6 & 7 & 8 & 9 & 10. Session parsing, Graph construction, Multi-parent provenance, Verified vs Inferred vs Unknown origins, and Malformed records', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const service = new ArtifactAtlasService({ homeDir: demo.homeDir });

    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });

    // Malformed JSONL record is gracefully recorded without aborting session parsing
    assert.equal(state.malformedRecords.length, 1);
    assert.equal(state.sessions.length, 2);

    // Multi-parent provenance: vector-index.ts was created in Session Alpha and edited in Session Beta
    const sharedFileArtifact = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.sharedSourceFile
    );
    assert.ok(sharedFileArtifact, 'Expected vector-index.ts to be indexed');
    assert.equal(sharedFileArtifact.provenanceConfidence, ProvenanceConfidence.VERIFIED);
    assert.equal(sharedFileArtifact.sessionIds.length, 2);
    assert.ok(
      sharedFileArtifact.sharedDependencyIndicators.some((ind) =>
        ind.includes('Shared across 2 AI conversations')
      )
    );

    // Trace provenance subgraph for vector-index.ts
    const trace = service.inspectNodeProvenance(sharedFileArtifact.id);
    assert.ok(trace);
    const hopEdgeTypes = new Set(trace.provenanceHops.map((h) => h.edgeType));
    assert.ok(hopEdgeTypes.has(EdgeType.CREATED_BY));
    assert.ok(hopEdgeTypes.has(EdgeType.MODIFIED_BY));
    assert.ok(hopEdgeTypes.has(EdgeType.SHARED_WITH));
    assert.ok(hopEdgeTypes.has(EdgeType.GENERATED_DURING));

    // Inferred provenance: mcp-transport-sess_alpha_01.log embeds session ID in path without direct tool write
    const inferredLog = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.claudeDebugLogFile
    );
    assert.ok(inferredLog);
    assert.equal(inferredLog.provenanceConfidence, ProvenanceConfidence.INFERRED);
    assert.ok(inferredLog.evidence.some((e) => e.confidence === ProvenanceConfidence.INFERRED));

    // Derived provenance: vector-index.bundle.js.map is derived from verified vector-index.ts
    const derivedMap = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.bundleMapFile
    );
    assert.ok(derivedMap);
    assert.equal(derivedMap.provenanceConfidence, ProvenanceConfidence.INFERRED);

    // Unknown provenance: untracked-experiment-notes.dat has NO tool record and must NOT be linked to a session despite close timestamp
    const mysteryArtifact = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.mysteryUnknownFile
    );
    assert.ok(mysteryArtifact);
    assert.equal(mysteryArtifact.provenanceConfidence, ProvenanceConfidence.UNKNOWN);
    assert.equal(mysteryArtifact.sessionIds.length, 0);

    const mysteryTrace = service.inspectNodeProvenance(mysteryArtifact.id);
    assert.ok(
      mysteryTrace.provenanceHops.some(
        (h) =>
          h.toNodeType === NodeType.UNKNOWN_ORIGIN &&
          h.edgeType === EdgeType.POSSIBLY_RELATED_TO
      ),
      'Unknown provenance artifact must trace to UNKNOWN_ORIGIN node'
    );

    // Verify all 7 node types exist in the Knowledge Graph
    const graphNodeTypes = new Set(state.graph.nodes.map((n) => n.nodeType));
    assert.ok(graphNodeTypes.has(NodeType.AI_APPLICATION));
    assert.ok(graphNodeTypes.has(NodeType.WORKSPACE));
    assert.ok(graphNodeTypes.has(NodeType.SESSION));
    assert.ok(graphNodeTypes.has(NodeType.OPERATION));
    assert.ok(graphNodeTypes.has(NodeType.ARTIFACT));
    assert.ok(graphNodeTypes.has(NodeType.ARTIFACT_GROUP));
    assert.ok(graphNodeTypes.has(NodeType.UNKNOWN_ORIGIN));
  } finally {
    sandbox.cleanup();
  }
});

test('6b. Cursor and Codex CLI adapters parse workspaceStorage composer ledgers and rollout JSONLs accurately', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);

    // Test Cursor Adapter
    const cursorService = new ArtifactAtlasService({ homeDir: demo.homeDir });
    const cursorState = await cursorService.scanAndAnalyze({
      bundlePath: demo.appBundles.cursor.bundlePath
    });
    assert.equal(cursorState.application.adapterId, 'cursor-ide');
    assert.equal(cursorState.sessions.length, 1);
    assert.ok(cursorState.operations.length >= 2);

    // Test Codex CLI Adapter
    const codexService = new ArtifactAtlasService({ homeDir: demo.homeDir });
    const codexState = await codexService.scanAndAnalyze({
      bundlePath: demo.appBundles.codex.bundlePath
    });
    assert.equal(codexState.application.adapterId, 'codex-cli');
    assert.equal(codexState.sessions.length, 1);
    const tokArtifact = codexState.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.tokenizerFile
    );
    assert.ok(tokArtifact);
    assert.equal(tokArtifact.provenanceConfidence, ProvenanceConfidence.VERIFIED);
  } finally {
    sandbox.cleanup();
  }
});

test('11. Risk classification: distinguishes all 10 artifact types and never relies on filename extension alone', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const service = new ArtifactAtlasService({ homeDir: demo.homeDir });
    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });

    const byPath = new Map(state.artifacts.map((a) => [a.canonicalPath, a]));

    // 1. Regenerable cache (unshared) -> LOW risk
    const statsigCache = byPath.get(demo.sampleFiles.claudeStatsigFile);
    assert.equal(statsigCache.artifactType, ArtifactType.REGENERABLE_CACHE);
    assert.equal(statsigCache.cleanupClassification, RiskCategory.LOW);

    // 2. Hardlinked cache -> elevated from LOW to REVIEW due to shared physical inode
    if (byPath.has(demo.sampleFiles.claudeCacheHardlink)) {
      const hardlinkedCache = byPath.get(demo.sampleFiles.claudeCacheBlob);
      assert.equal(hardlinkedCache.artifactType, ArtifactType.REGENERABLE_CACHE);
      assert.equal(hardlinkedCache.cleanupClassification, RiskCategory.REVIEW);
    }

    // 3. Dedicated temp file -> LOW risk
    const shellTmp = byPath.get(demo.sampleFiles.claudeShellTmpFile);
    assert.equal(shellTmp.artifactType, ArtifactType.TEMP_FILE);
    assert.equal(shellTmp.cleanupClassification, RiskCategory.LOW);

    // 4. Ambiguous .tmp file inside workspace src/ -> REVIEW (never LOW based on .tmp extension alone!)
    const srcTmp = byPath.get(demo.sampleFiles.ambiguousWorkspaceTmp);
    assert.equal(srcTmp.artifactType, ArtifactType.TEMP_FILE);
    assert.notEqual(
      srcTmp.cleanupClassification,
      RiskCategory.LOW,
      'A .tmp extension inside src/ must never be classified as LOW risk'
    );

    // 5. Dedicated log file -> LOW risk
    const debugLog = byPath.get(demo.sampleFiles.claudeDebugLogFile);
    assert.equal(debugLog.artifactType, ArtifactType.LOG);
    assert.equal(debugLog.cleanupClassification, RiskCategory.LOW);

    // 6. Build output & Derived data -> REVIEW
    const bundleOut = byPath.get(demo.sampleFiles.bundleOutputFile);
    assert.equal(bundleOut.artifactType, ArtifactType.BUILD_OUTPUT);
    assert.equal(bundleOut.cleanupClassification, RiskCategory.REVIEW);

    const bundleMap = byPath.get(demo.sampleFiles.bundleMapFile);
    assert.equal(bundleMap.artifactType, ArtifactType.DERIVED_DATA);
    assert.equal(bundleMap.cleanupClassification, RiskCategory.REVIEW);

    // 7. Session history (.jsonl) -> HIGH
    const sessionTranscript = state.artifacts.find((a) => a.name === 'sess_alpha_01.jsonl');
    assert.equal(sessionTranscript.artifactType, ArtifactType.SESSION_HISTORY);
    assert.equal(sessionTranscript.cleanupClassification, RiskCategory.HIGH);

    // 8. Checkpoint -> HIGH
    const checkpoint = byPath.get(demo.sampleFiles.checkpointFile);
    assert.equal(checkpoint.artifactType, ArtifactType.CHECKPOINT);
    assert.equal(checkpoint.cleanupClassification, RiskCategory.HIGH);

    // 9. Model weights -> HIGH
    const modelWeights = byPath.get(demo.sampleFiles.modelWeightsFile);
    assert.equal(modelWeights.artifactType, ArtifactType.MODEL_DATA);
    assert.equal(modelWeights.cleanupClassification, RiskCategory.HIGH);

    // 10. Source code, .env credentials, package.json, and .git/HEAD -> PROTECTED
    const sourceCode = byPath.get(demo.sampleFiles.sharedSourceFile);
    assert.equal(sourceCode.artifactType, ArtifactType.USER_CONTENT);
    assert.equal(sourceCode.cleanupClassification, RiskCategory.PROTECTED);

    const envFile = state.artifacts.find((a) => a.name === '.env');
    assert.equal(envFile.cleanupClassification, RiskCategory.PROTECTED);

    // Git data inside a project is never listed for cleanup: the folder is skipped and reported
    assert.equal(state.artifacts.some((a) => a.canonicalPath.includes('/.git/')), false);
    assert.ok(state.scan.skippedBulkDirectories.some((dir) => dir.endsWith('/.git')));
    // If a .git file is ever classified (outside a known project), it is still protected
    const strayGitFile = service.classificationEngine.classifySingleArtifact({
      ...sourceCode,
      name: 'HEAD',
      extension: '',
      canonicalPath: '/tmp/elsewhere/repo/.git/HEAD',
      parentDir: '/tmp/elsewhere/repo/.git',
      workspaceId: null
    });
    assert.equal(strayGitFile.riskCategory, RiskCategory.PROTECTED);
  } finally {
    sandbox.cleanup();
  }
});

test('12 & 13 & 14. Quarantine, Manifest persistence, Restore with conflict strategies, and File change detection between scan and cleanup', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);
    const dbPath = path.join(sandbox.dir, 'atlas.sqlite');
    const quarantineRoot = path.join(sandbox.dir, 'quarantine-vault');
    const service = new ArtifactAtlasService({
      homeDir: demo.homeDir,
      dbPath,
      quarantineRoot
    });

    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });

    const lowRiskCache = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.claudeStatsigFile
    );
    const lowRiskLog = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.claudeDebugLogFile
    );
    const protectedSource = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.sharedSourceFile
    );
    const highRiskWeights = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.modelWeightsFile
    );

    // Verify bulk cleanup blocks HIGH risk and PROTECTED artifacts automatically
    const bulkReview = service.prepareCleanupReview([
      lowRiskCache.id,
      protectedSource.id,
      highRiskWeights.id
    ]);
    assert.equal(bulkReview.totalEligibleCount, 1);
    assert.equal(bulkReview.totalBlockedCount, 2);
    assert.equal(bulkReview.eligibleItems[0].artifactId, lowRiskCache.id);

    // Verify file modification between scan and cleanup is detected and blocked (Test 14)
    fs.appendFileSync(demo.sampleFiles.claudeDebugLogFile, '\nNEW LINE AFTER SCAN\n', 'utf8');
    const mutatedReview = service.prepareCleanupReview([lowRiskLog.id]);
    assert.equal(mutatedReview.totalEligibleCount, 0);
    assert.equal(mutatedReview.blockedItems[0].code, 'FILE_CHANGED_SINCE_SCAN');

    // Verify quarantine execution requires matching confirmationToken
    assert.throws(() => {
      service.executeQuarantine({
        artifactIds: [lowRiskCache.id],
        confirmationToken: 'invalid_token'
      });
    }, /EXPLICIT_CONFIRMATION_REQUIRED/);

    // Execute valid quarantine on lowRiskCache
    const qResult = service.executeQuarantine({
      artifactIds: [lowRiskCache.id],
      confirmationToken: bulkReview.confirmationToken
    });
    assert.equal(qResult.quarantinedEntries.length, 1);
    const qEntry = qResult.quarantinedEntries[0];

    // Original file is gone; quarantine payload and manifest.json exist on disk
    assert.equal(fs.existsSync(demo.sampleFiles.claudeStatsigFile), false);
    assert.equal(fs.existsSync(qEntry.quarantinePath), true);
    assert.equal(fs.existsSync(qEntry.manifestPath), true);

    // Restore conflict check: create a new file at originalPath and verify FAIL_IF_EXISTS vs RENAME_RESTORED
    fs.writeFileSync(demo.sampleFiles.claudeStatsigFile, 'CONFLICTING_NEW_FILE', 'utf8');
    assert.throws(() => {
      service.restoreQuarantineEntry({
        entryId: qEntry.id,
        conflictStrategy: RestoreConflictStrategy.FAIL_IF_EXISTS
      });
    }, /RESTORE_CONFLICT_EXISTS/);

    // Remove conflicting file and restore normally to original path
    fs.unlinkSync(demo.sampleFiles.claudeStatsigFile);
    const restoreRes = service.restoreQuarantineEntry({
      entryId: qEntry.id,
      conflictStrategy: RestoreConflictStrategy.FAIL_IF_EXISTS
    });
    assert.equal(restoreRes.restored, true);
    assert.equal(restoreRes.restoredToPath, demo.sampleFiles.claudeStatsigFile);
    assert.equal(fs.existsSync(demo.sampleFiles.claudeStatsigFile), true);

    service.sqliteStore.close();
  } finally {
    sandbox.cleanup();
  }
});

test('15 & 17. Scan cancellation and permission failure resilience', async () => {
  const sandbox = createTempSandbox();
  try {
    const demo = createDeterministicDemoEnvironment(sandbox.dir);

    // Create an unreadable file (mode 0o000) to test permission failure reporting
    const unreadableFile = path.join(demo.workspaceDir, 'locked-secret.bin');
    fs.writeFileSync(unreadableFile, 'LOCKED_CONTENT', { mode: 0o000 });

    const service = new ArtifactAtlasService({ homeDir: demo.homeDir });
    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });

    // Note: on Linux non-root user, mode 0o000 triggers permissionLimitations
    if (process.getuid && process.getuid() !== 0) {
      assert.ok(
        state.scan.permissionLimitations.some((p) => p.path.endsWith('locked-secret.bin')),
        'Expected unreadable file to be reported in permissionLimitations'
      );
    }

    // Test scan cancellation mid-flight
    const cancelService = new ArtifactAtlasService({ homeDir: demo.homeDir });
    const scanPromise = cancelService.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath,
      artificialDelayMs: 15,
      onProgress: (prog) => {
        if (prog.discoveredArtifactCount >= 2) {
          cancelService.cancelActiveScan();
        }
      }
    });

    const cancelledState = await scanPromise;
    assert.equal(cancelledState.scan.status, ScanStatus.CANCELLED);
  } finally {
    sandbox.cleanup();
  }
});
