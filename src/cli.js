#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtlasServer } from './ui/server.js';
import { ArtifactAtlasService } from './atlas-service.js';
import { createDeterministicDemoEnvironment } from './fixtures/demo-environment.js';
import { RestoreConflictStrategy } from './models/entities.js';

const args = process.argv.slice(2);
const command = args[0] || 'serve';

function parseFlagValue(flagName, defaultValue) {
  const idx = args.indexOf(flagName);
  if (idx !== -1 && args[idx + 1] !== undefined) {
    return args[idx + 1];
  }
  return defaultValue;
}

function hasFlag(flagName) {
  return args.includes(flagName);
}

async function runServe() {
  const rawPort = parseFlagValue('--port', process.env.PORT ?? '4310');
  const port = Number(rawPort);
  const homeDir = parseFlagValue('--home', null);
  const dataDir = parseFlagValue('--data-dir', process.env.ATLAS_DATA_DIR || null);
  const apiToken = parseFlagValue('--api-token', process.env.ATLAS_API_TOKEN || null);
  const parentPid = Number(parseFlagValue('--parent-pid', process.env.ATLAS_PARENT_PID || 0));
  const watchStdin = hasFlag('--watch-stdin');

  const { server, demoEnv, sessionToken, shutdown } = createAtlasServer({
    homeDir,
    dataDir,
    apiToken
  });

  let shuttingDown = false;
  const gracefulExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', gracefulExit);
  process.on('SIGINT', gracefulExit);
  process.on('SIGHUP', gracefulExit);

  if (watchStdin) {
    process.stdin.resume();
    process.stdin.on('end', gracefulExit);
    process.stdin.on('close', gracefulExit);
  }

  if (parentPid > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(timer);
        gracefulExit();
      }
    }, 1500);
    timer.unref();
  }

  // Always bind strictly to loopback 127.0.0.1 (Requirement 8)
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : port;
    const readyPayload = {
      port: actualPort,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${actualPort}`,
      pid: process.pid
    };

    // Machine-readable readiness line for the native macOS Swift app launcher
    console.log(`ATLAS_SERVER_READY:${JSON.stringify(readyPayload)}`);
    console.log('===================================================================');
    console.log('  Artifact Atlas — AI Artifact Provenance & Cleanup Explorer');
    console.log('===================================================================');
    console.log(`  Local Desktop UI:   http://127.0.0.1:${actualPort}`);
    console.log(`  Sandbox Workspace:  ${demoEnv.workspaceDir}`);
    console.log(`  Loopback Auth:      Active (Token Protected)`);
    console.log(`  Available .apps:    Claude.app, Cursor.app, Codex.app, NebulaSketch.app`);
    console.log('===================================================================');
  });
}

async function runVerticalSliceDemo() {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-atlas-vertical-slice-'));
  try {
    const demo = createDeterministicDemoEnvironment(sandboxDir);
    const service = new ArtifactAtlasService({
      homeDir: demo.homeDir,
      dbPath: path.join(sandboxDir, 'atlas.sqlite'),
      quarantineRoot: path.join(sandboxDir, 'quarantine-vault'),
      isDemoEnvironment: true
    });

    console.log('1. [Drop Application] Identifying Claude.app without executing binary...');
    const app = service.identifyApplication(demo.appBundles.claude.bundlePath);
    console.log(`   -> Identified: ${app.name} (${app.bundleId}) v${app.version} [${app.recognitionStatus}]`);

    console.log('\n2. [Discover Artifacts & Build Graph] Scanning authorized locations...');
    const state = await service.scanAndAnalyze({
      bundlePath: demo.appBundles.claude.bundlePath
    });
    console.log(`   -> Scanned ${state.scan.scannedLocations.length} directories`);
    console.log(`   -> Indexed ${state.scan.discoveredArtifactCount} artifacts (${state.scan.totalPhysicalBytes} physical bytes, ${state.scan.deduplicatedHardlinkCount} deduplicated hardlink)`);
    console.log(`   -> Skipped ${state.scan.skippedSymlinks.length} out-of-boundary symlink(s)`);
    console.log(`   -> Graph constructed: ${state.graph.stats.totalNodes} nodes, ${state.graph.stats.totalEdges} provenance edges`);
    console.log(`   -> Provenance breakdown: ${state.graph.stats.verifiedArtifactCount} VERIFIED, ${state.graph.stats.inferredArtifactCount} INFERRED, ${state.graph.stats.unknownArtifactCount} UNKNOWN`);

    const sharedFile = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.sharedSourceFile
    );
    console.log('\n3. [Inspect Provenance] Tracing shared multi-session artifact:');
    console.log(`   -> File: ${sharedFile.name} (${sharedFile.cleanupClassification})`);
    console.log(`   -> Shared Indicators: ${sharedFile.sharedDependencyIndicators.join('; ')}`);

    const lowRiskCache = state.artifacts.find(
      (a) => a.canonicalPath === demo.sampleFiles.claudeStatsigFile
    );
    console.log('\n4. [Review Cleanup & Quarantine] Preparing cleanup review for low-risk cache:');
    const review = service.prepareCleanupReview([lowRiskCache.id]);
    console.log(`   -> Eligible: ${review.totalEligibleCount} (${review.eligibleItems[0].name}), Token: ${review.confirmationToken}`);

    const qRes = service.executeQuarantine({
      artifactIds: [lowRiskCache.id],
      confirmationToken: review.confirmationToken
    });
    const qEntry = qRes.quarantinedEntries[0];
    console.log(`   -> Moved to Quarantine Vault: ${qEntry.quarantinePath}`);
    console.log(`   -> Manifest persisted: ${qEntry.manifestPath}`);

    console.log('\n5. [Restore] Restoring quarantined artifact to original path...');
    const rRes = service.restoreQuarantineEntry({
      entryId: qEntry.id,
      conflictStrategy: RestoreConflictStrategy.FAIL_IF_EXISTS
    });
    console.log(`   -> Restored to: ${rRes.restoredToPath}`);
    service.sqliteStore.close();
    console.log('\nVertical slice completed and verified successfully.');
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
}

async function runCliScan() {
  const target = args[1];
  if (!target) {
    console.error('Usage: artifact-atlas scan <path-to-.app-or-directory>');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  const service = new ArtifactAtlasService();
  const isAppBundle = resolved.endsWith('.app');

  const state = await service.scanAndAnalyze({
    bundlePath: isAppBundle ? resolved : null,
    additionalWorkspacePaths: isAppBundle ? [] : [resolved]
  });

  console.log(`Scan Status: ${state.scan.status}`);
  console.log(`Discovered Artifacts: ${state.scan.discoveredArtifactCount}`);
  console.log(`Physical Bytes: ${state.scan.totalPhysicalBytes}`);
  for (const art of state.artifacts.slice(0, 30)) {
    console.log(
      ` - [${art.cleanupClassification}] [${art.provenanceConfidence}] (${art.artifactType}) ${art.canonicalPath} (${art.sizeBytes} B)`
    );
  }
  service.sqliteStore.close();
}

if (command === 'serve') {
  runServe();
} else if (command === 'demo') {
  runVerticalSliceDemo();
} else if (command === 'scan') {
  runCliScan();
} else {
  console.error(`Unknown command '${command}'. Supported: serve, demo, scan`);
  process.exit(1);
}
