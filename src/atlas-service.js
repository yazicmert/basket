import fs from 'node:fs';
import path from 'node:path';
import { PlatformServices } from './platform/platform-services.js';
import { AdapterRegistry } from './adapters/adapter-registry.js';
import { ApplicationDiscovery } from './discovery/application-discovery.js';
import { Scanner } from './scanner/scanner.js';
import { ArtifactIndexer } from './indexer/artifact-indexer.js';
import { ProvenanceEngine } from './provenance/provenance-engine.js';
import { ClassificationEngine } from './classification/classification-engine.js';
import { GraphEngine } from './graph/graph-engine.js';
import { CleanupEngine } from './cleanup/cleanup-engine.js';
import { SQLiteStore } from './persistence/sqlite-store.js';
import { normalizeScanScope } from './platform/permissions.js';
import { readSessionFirstPrompt, promptExcerpt } from './provenance/session-prompt.js';

// Upper bound on files in one scan. The map and the UI stay responsive well beyond this
// because they work from summaries; the bound keeps memory and scan time predictable.
export const DEFAULT_MAX_FILES = 300000;

/** Upper bound on files named by session tool calls that are read inside project folders. */
export const MAX_RECORDED_FILES = 50000;

/** Titles the adapters make up from a session ID when the record names none. */
const GENERATED_SESSION_TITLE = /^(Claude Session|Codex Rollout|Cursor Composer|Session) \S+$/;

export class ArtifactAtlasService {
  constructor(options = {}) {
    this.platformServices = new PlatformServices({
      homeDir: options.homeDir,
      platform: options.platform
    });
    this.adapterRegistry = new AdapterRegistry();
    this.applicationDiscovery = new ApplicationDiscovery({
      platformServices: this.platformServices,
      adapterRegistry: this.adapterRegistry
    });
    this.scanner = new Scanner({
      platformServices: this.platformServices,
      maxFiles: options.maxFiles || DEFAULT_MAX_FILES
    });
    this.indexer = new ArtifactIndexer();
    this.provenanceEngine = new ProvenanceEngine();
    this.classificationEngine = new ClassificationEngine({ platformServices: this.platformServices });
    this.graphEngine = new GraphEngine();
    this.sqliteStore = new SQLiteStore(options.dbPath || ':memory:');
    this.cleanupEngine = new CleanupEngine({
      platformServices: this.platformServices,
      sqliteStore: this.sqliteStore,
      quarantineRoot: options.quarantineRoot
    });

    this.activeState = {
      application: null,
      workspaces: [],
      sessions: [],
      operations: [],
      scan: null,
      artifacts: [],
      artifactGroups: [],
      provenanceEdges: [],
      evidence: [],
      recommendations: [],
      malformedRecords: [],
      graph: null,
      authorizedRoots: [],
      isDemoEnvironment: Boolean(options.isDemoEnvironment)
    };

    this.currentScanAbortController = null;
    this.lastProgress = null;
    this.scanInProgress = false;
  }

  /**
   * Step 1: Identify a dropped or selected macOS .app bundle without executing it.
   */
  identifyApplication(bundlePath) {
    const app = this.applicationDiscovery.identifyApplication(bundlePath);
    this.activeState.application = app;
    return app;
  }

  /**
   * Step 2: Run full discovery, session provenance analysis, classification,
   * SQLite persistence, and Knowledge Graph + Treemap construction.
   */
  async scanAndAnalyze(params = {}) {
    this.lastProgress = null;
    this.scanInProgress = true;
    try {
      return await this.runScanAndAnalyze(params);
    } finally {
      this.scanInProgress = false;
    }
  }

  async runScanAndAnalyze({
    bundlePath = null,
    additionalWorkspacePaths = [],
    onProgress = null,
    artificialDelayMs = 0,
    scanScope = null
  }) {
    const scope = normalizeScanScope(scanScope);
    if (this.currentScanAbortController) {
      this.currentScanAbortController.abort();
    }
    this.currentScanAbortController = new AbortController();
    const signal = this.currentScanAbortController.signal;

    let application = this.activeState.application;
    if (bundlePath) {
      application = this.identifyApplication(bundlePath);
    }

    const candidateRoots = [];
    if (application) {
      for (const dirEntry of application.knownDataDirectories) {
        if (fs.existsSync(dirEntry.path)) {
          candidateRoots.push(dirEntry.path);
        }
      }
    }

    for (const wsPath of additionalWorkspacePaths) {
      if (wsPath && fs.existsSync(wsPath)) {
        candidateRoots.push(this.platformServices.resolveRealPathSafe(wsPath));
      }
    }

    // Parse adapter provenance records first so any workspaces referenced in session transcripts
    // within the user's home/workspace scope are discovered
    const adapter = application
      ? this.adapterRegistry.getAdapterById(application.adapterId)
      : this.adapterRegistry.fallbackAdapter;

    const parsedRecords = application
      ? adapter.parseProvenanceRecords({
          application,
          authorizedRoots: candidateRoots,
          platformServices: this.platformServices
        })
      : { workspaces: [], sessions: [], operations: [], malformedRecords: [] };

    // Project folders named in session transcripts hold the user's own work. By default only
    // the files a session's tool calls name are read there. With the "whole project folders"
    // scan permission they are walked in full; that is the user's choice, made before the scan.
    // A folder the user picks explicitly (additionalWorkspacePaths) is always scanned in full.
    const workspacesByPath = new Map();
    const projectFoldersLeftOut = [];
    for (const ws of parsedRecords.workspaces) {
      workspacesByPath.set(ws.canonicalPath, ws);
      if (!scope.projectFolders || !fs.existsSync(ws.canonicalPath)) {
        continue;
      }
      if (this.isWalkableProjectFolder(ws.canonicalPath)) {
        candidateRoots.push(ws.canonicalPath);
      } else {
        projectFoldersLeftOut.push(ws.canonicalPath);
      }
    }
    const recordedFiles = new Set();
    for (const op of parsedRecords.operations) {
      const target = op.targetPath;
      if (typeof target !== 'string' || !path.isAbsolute(target) || recordedFiles.size >= MAX_RECORDED_FILES) {
        continue;
      }
      const resolved = path.resolve(target);
      if (this.platformServices.isProtectedSystemPath(resolved)) {
        continue;
      }
      const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
      if (stat && stat.isFile()) {
        recordedFiles.add(resolved);
      }
    }

    for (const manualWsPath of additionalWorkspacePaths) {
      if (!manualWsPath || !fs.existsSync(manualWsPath)) {
        continue;
      }
      const wsModel = this.applicationDiscovery.identifyWorkspaceTarget
        ? this.applicationDiscovery.identifyWorkspaceTarget(manualWsPath)
        : this.applicationDiscovery.identifyWorkspaceDirectory(
            manualWsPath,
            application ? [application.id] : []
          );
      if (!workspacesByPath.has(wsModel.canonicalPath)) {
        workspacesByPath.set(wsModel.canonicalPath, wsModel);
      }
    }

    const workspaces = Array.from(workspacesByPath.values());
    // Recorded files are authorized one by one, so cleanup can reach them and nothing next to them
    const authorizedRoots = Array.from(new Set([...candidateRoots, ...recordedFiles]));
    const walkRoots = Array.from(new Set(candidateRoots));

    // Execute cancellable permission-aware scan
    const { scan, rawEntries } = await this.scanner.scan({
      applicationId: application ? application.id : null,
      authorizedRoots: walkRoots,
      extraFiles: Array.from(recordedFiles),
      projectRoots: workspaces.map((ws) => ws.canonicalPath),
      skipBulkDirectories: !scope.dependencyFolders,
      signal,
      artificialDelayMs,
      onProgress: (prog) => {
        this.lastProgress = prog;
        if (typeof onProgress === 'function') {
          onProgress(prog);
        }
      }
    });

    // What this scan was allowed to read, so the result can say what it left out
    scan.scope = {
      ...scope,
      projectFolderCount: parsedRecords.workspaces.length,
      projectFoldersLeftOut
    };

    // The walk is done. The remaining steps run without touching the disk tree; report the
    // phase and yield so the progress endpoint can answer between them.
    const enterPhase = async (phase) => {
      this.lastProgress = { ...(this.lastProgress || {}), phase };
      await new Promise((resolve) => setImmediate(resolve));
    };
    await enterPhase('analyzing');

    // Index raw entries into canonical Artifact models
    const indexedArtifacts = this.indexer.indexEntries({
      rawEntries,
      scanId: scan.id,
      applicationId: application ? application.id : null,
      workspaces
    });

    // Resolve provenance links (VERIFIED, INFERRED, UNKNOWN) & multi-session sharing
    const provenanceResult = this.provenanceEngine.analyzeProvenance({
      artifacts: indexedArtifacts,
      application,
      workspaces,
      sessions: parsedRecords.sessions,
      operations: parsedRecords.operations
    });

    // Classify artifact types and risk levels (LOW, REVIEW, HIGH, PROTECTED)
    const classificationResult = this.classificationEngine.classifyArtifacts({
      artifacts: provenanceResult.artifacts,
      application
    });

    // Build Knowledge Graph & Space Treemap
    const graph = this.graphEngine.buildKnowledgeGraph({
      application,
      workspaces,
      sessions: parsedRecords.sessions,
      operations: parsedRecords.operations,
      artifacts: classificationResult.artifacts,
      artifactGroups: classificationResult.artifactGroups,
      provenanceEdges: provenanceResult.provenanceEdges,
      unknownOriginNodeId: provenanceResult.unknownOriginNodeId
    });

    await enterPhase('saving');

    // Persist snapshot in SQLite
    this.sqliteStore.saveSnapshot({
      application,
      workspaces,
      sessions: parsedRecords.sessions,
      operations: parsedRecords.operations,
      scan,
      artifacts: classificationResult.artifacts,
      artifactGroups: classificationResult.artifactGroups,
      evidence: provenanceResult.evidence,
      provenanceEdges: provenanceResult.provenanceEdges,
      recommendations: classificationResult.recommendations
    });

    this.activeState = {
      application,
      workspaces,
      sessions: parsedRecords.sessions,
      operations: parsedRecords.operations,
      scan,
      artifacts: classificationResult.artifacts,
      artifactGroups: classificationResult.artifactGroups,
      provenanceEdges: provenanceResult.provenanceEdges,
      evidence: provenanceResult.evidence,
      recommendations: classificationResult.recommendations,
      malformedRecords: parsedRecords.malformedRecords,
      unknownOriginNodeId: provenanceResult.unknownOriginNodeId,
      graph,
      authorizedRoots,
      isDemoEnvironment: this.activeState.isDemoEnvironment
    };

    return this.activeState;
  }

  /**
   * A project folder may be walked in full only when it is a real project location: never the
   * home folder, a folder that contains it, a drive or filesystem root, or a protected path.
   */
  isWalkableProjectFolder(folderPath) {
    const resolved = path.resolve(folderPath);
    const home = this.platformServices.homeDir;
    if (this.platformServices.isProtectedSystemPath(resolved)) {
      return false;
    }
    if (path.parse(resolved).root === resolved) {
      return false;
    }
    return !(home === resolved || home.startsWith(resolved + path.sep));
  }

  cancelActiveScan() {
    if (this.currentScanAbortController) {
      this.currentScanAbortController.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  inspectNodeProvenance(nodeId) {
    if (!this.activeState.graph) {
      return null;
    }
    const onMap = this.activeState.graph.nodes.some((n) => n.id === nodeId);
    if (onMap) {
      return this.graphEngine.traceProvenancePaths(this.activeState.graph, nodeId);
    }
    // A file without a mark on the overview map: trace it on a small graph of its own
    const art = (this.activeState.artifacts || []).find((a) => a.id === nodeId);
    if (!art) {
      return null;
    }
    const opIds = new Set(art.operationIds || []);
    const group = (this.activeState.artifactGroups || []).find((g) => g.artifactIds.includes(art.id));
    const graph = this.graphEngine.buildKnowledgeGraph({
      application: this.activeState.application,
      workspaces: this.activeState.workspaces,
      sessions: this.activeState.sessions,
      operations: (this.activeState.operations || []).filter((op) => opIds.has(op.id)),
      artifacts: [art],
      artifactGroups: group ? [{ ...group, artifactIds: [art.id] }] : [],
      provenanceEdges: (this.activeState.provenanceEdges || []).filter(
        (e) => e.sourceId === art.id || e.targetId === art.id || opIds.has(e.sourceId) || opIds.has(e.targetId)
      ),
      unknownOriginNodeId: this.activeState.unknownOriginNodeId
    });
    return this.graphEngine.traceProvenancePaths(graph, art.id);
  }

  /**
   * The sessions a map node belongs to: a session itself, anything inside a session's levels,
   * a tool call, or a file (every session linked to it).
   */
  sessionsForNode(nodeId) {
    const state = this.activeState;
    const id = String(nodeId || '');
    const byId = new Map((state.sessions || []).map((s) => [s.id, s]));
    const scoped = /(?:^|:)session:([^:]+)/.exec(id);
    if (scoped && byId.has(scoped[1])) {
      return [byId.get(scoped[1])];
    }
    if (byId.has(id)) {
      return [byId.get(id)];
    }
    const op = (state.operations || []).find((o) => o.id === id);
    if (op) {
      return byId.has(op.sessionId) ? [byId.get(op.sessionId)] : [];
    }
    const art = (state.artifacts || []).find((a) => a.id === id);
    if (art) {
      return (art.sessionIds || []).map((sid) => byId.get(sid)).filter(Boolean);
    }
    return [];
  }

  /**
   * First prompt of a session, read from its transcript now. Only a transcript inside the
   * folders this scan covered is read. Nothing is stored.
   */
  readPromptOf(session) {
    const roots = this.activeState.authorizedRoots || [];
    const inScope =
      session && session.sourcePath && this.platformServices.isWithinAuthorizedRoots(session.sourcePath, roots);
    return inScope ? readSessionFirstPrompt(session) : { available: false, reason: 'NOT_RECORDED_FOR_THIS_APP' };
  }

  /**
   * Adds each session's first prompt to the session marks of a map level, for display. The
   * level is built fresh for every request; the prompt is put on that copy only, never on
   * the session, the scan state or the index. A session whose title was made up from its ID
   * is labelled by its prompt instead.
   */
  decorateLevelWithPrompts(level) {
    if (!level || !Array.isArray(level.nodes)) {
      return level;
    }
    const byId = new Map((this.activeState.sessions || []).map((s) => [s.id, s]));
    for (const node of level.nodes) {
      const session = node.metadata && node.metadata.session ? byId.get(node.metadata.session.id) : null;
      if (!session) {
        continue;
      }
      const prompt = this.readPromptOf(session);
      if (!prompt.available) {
        continue;
      }
      node.metadata = { ...node.metadata, firstPrompt: promptExcerpt(prompt.text, 200) };
      if (GENERATED_SESSION_TITLE.test(node.label || '')) {
        node.label = promptExcerpt(prompt.text, 42);
      }
    }
    return level;
  }

  /**
   * First prompt of each session behind a node. Read from the transcripts now, for display;
   * nothing is stored. A transcript is only read from inside the folders this scan covered.
   */
  describeNodePrompts(nodeId, { limit = 3 } = {}) {
    const sessions = this.sessionsForNode(nodeId).sort((a, b) =>
      String(a.startedAt || '').localeCompare(String(b.startedAt || ''))
    );
    const prompts = sessions.slice(0, limit).map((session) => {
      const prompt = this.readPromptOf(session);
      return {
        sessionId: session.id,
        title: session.title,
        startedAt: session.startedAt,
        ...prompt
      };
    });
    return { prompts, sessionCount: sessions.length };
  }

  prepareCleanupReview(artifactIds = [], allowHighRiskSingleOverride = false) {
    const wanted = new Set(artifactIds);
    const selected = this.activeState.artifacts.filter(
      (a) => wanted.has(a.id) && !a.quarantined
    );
    return this.cleanupEngine.prepareCleanupReview({
      artifacts: selected,
      authorizedRoots: this.activeState.authorizedRoots,
      allowHighRiskSingleOverride
    });
  }

  executeQuarantine({ artifactIds = [], confirmationToken, allowHighRiskSingleOverride = false }) {
    const wanted = new Set(artifactIds);
    const selected = this.activeState.artifacts.filter(
      (a) => wanted.has(a.id) && !a.quarantined
    );
    const result = this.cleanupEngine.executeQuarantine({
      artifacts: selected,
      authorizedRoots: this.activeState.authorizedRoots,
      confirmationToken,
      allowHighRiskSingleOverride
    });

    // Refresh Knowledge Graph and Treemap after quarantining items
    this.rebuildActiveGraph();
    return {
      ...result,
      updatedGraph: this.activeState.graph,
      quarantineEntries: this.sqliteStore.listQuarantineEntries()
    };
  }

  restoreQuarantineEntry({ entryId, conflictStrategy }) {
    const result = this.cleanupEngine.restoreQuarantineEntry({
      entryId,
      conflictStrategy
    });

    // Unmark artifact in activeState if present and refresh graph
    const entry = this.sqliteStore.getQuarantineEntryById(entryId);
    if (entry) {
      const art = this.activeState.artifacts.find((a) => a.id === entry.artifactId);
      if (art && result.restoredToPath === art.canonicalPath) {
        art.quarantined = false;
      }
    }
    this.rebuildActiveGraph();

    return {
      ...result,
      updatedGraph: this.activeState.graph,
      quarantineEntries: this.sqliteStore.listQuarantineEntries()
    };
  }

  rebuildActiveGraph() {
    if (!this.activeState.artifacts) {
      return;
    }
    const activeArtifacts = this.activeState.artifacts.filter((a) => !a.quarantined);
    const classificationResult = this.classificationEngine.classifyArtifacts({
      artifacts: activeArtifacts,
      application: this.activeState.application
    });
    this.activeState.artifactGroups = classificationResult.artifactGroups;
    this.activeState.graph = this.graphEngine.buildKnowledgeGraph({
      application: this.activeState.application,
      workspaces: this.activeState.workspaces,
      sessions: this.activeState.sessions,
      operations: this.activeState.operations,
      artifacts: this.activeState.artifacts,
      artifactGroups: this.activeState.artifactGroups,
      provenanceEdges: this.activeState.provenanceEdges,
      unknownOriginNodeId: this.activeState.unknownOriginNodeId
    });
  }
}
