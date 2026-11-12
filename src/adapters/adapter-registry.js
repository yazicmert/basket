import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ProvenanceConfidence,
  createWorkspaceModel,
  createSessionModel,
  createOperationModel
} from '../models/entities.js';

function normalizeFileUriOrPath(rawPath, baseCwd = null) {
  if (!rawPath || typeof rawPath !== 'string') {
    return null;
  }
  let cleaned = rawPath.trim();
  if (cleaned.startsWith('file://')) {
    cleaned = decodeURIComponent(cleaned.replace(/^file:\/\//, ''));
  }
  if (!path.isAbsolute(cleaned) && baseCwd) {
    return path.resolve(baseCwd, cleaned);
  }
  return path.resolve(cleaned);
}

function safeWalkJsonlFiles(rootDir, maxDepth = 5, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth || !fs.existsSync(rootDir)) {
    return results;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...safeWalkJsonlFiles(fullPath, maxDepth, currentDepth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 1. Claude Code & Claude Desktop Adapter
 */
export class ClaudeCodeAdapter {
  constructor() {
    this.id = 'claude-code';
    this.displayName = 'Claude Code / Claude Desktop';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return (
      lowerBundle.includes('anthropic.claude') ||
      lowerName.includes('claude')
    );
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    const dirs = [
      { role: 'CLAUDE_CLI_HOME', path: path.join(home, '.claude') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Claude') },
      { role: 'LOGS', path: path.join(home, 'Library', 'Logs', 'Claude') },
      {
        role: 'CACHES',
        path: path.join(home, 'Library', 'Caches', bundleId || 'com.anthropic.claudefordesktop')
      }
    ];
    return dirs;
  }

  parseProvenanceRecords({ application, authorizedRoots, platformServices }) {
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];

    const claudeProjectsDir = path.join(platformServices.homeDir, '.claude', 'projects');
    const candidateDirs = [claudeProjectsDir];
    for (const root of authorizedRoots) {
      const nestedProjects = path.join(root, '.claude', 'projects');
      if (fs.existsSync(nestedProjects) && !candidateDirs.includes(nestedProjects)) {
        candidateDirs.push(nestedProjects);
      }
    }

    for (const projectsRoot of candidateDirs) {
      if (!fs.existsSync(projectsRoot)) {
        continue;
      }
      const jsonlFiles = safeWalkJsonlFiles(projectsRoot, 4);
      for (const jsonlPath of jsonlFiles) {
        let content = '';
        try {
          content = fs.readFileSync(jsonlPath, 'utf8');
        } catch {
          continue;
        }

        const defaultSessionId = path.basename(jsonlPath, '.jsonl');
        const lines = content.split(/\r?\n/);
        let opSeq = 0;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx].trim();
          if (!line) {
            continue;
          }

          let record;
          try {
            record = JSON.parse(line);
          } catch (err) {
            malformedRecords.push({
              sourcePath: jsonlPath,
              lineNumber: lineIdx + 1,
              error: err.message
            });
            continue;
          }

          const externalSessionId = String(record.sessionId || record.session_id || defaultSessionId);
          const cwd = record.cwd ? platformServices.resolveRealPathSafe(record.cwd) : null;
          const timestamp = record.timestamp || record.createdAt || null;

          let workspace = null;
          if (cwd) {
            if (!workspacesByPath.has(cwd)) {
              workspacesByPath.set(
                cwd,
                createWorkspaceModel({
                  name: path.basename(cwd),
                  canonicalPath: cwd,
                  applicationIds: [application.id],
                  hasGitRepository: fs.existsSync(path.join(cwd, '.git'))
                })
              );
            }
            workspace = workspacesByPath.get(cwd);
          }

          if (!sessionsById.has(externalSessionId)) {
            sessionsById.set(
              externalSessionId,
              createSessionModel({
                externalSessionId,
                applicationId: application.id,
                workspaceId: workspace ? workspace.id : null,
                title: record.summary || record.sessionTitle || `Claude Session ${externalSessionId.slice(0, 8)}`,
                startedAt: timestamp,
                endedAt: timestamp,
                sourcePath: platformServices.resolveRealPathSafe(jsonlPath),
                adapterId: this.id,
                operationCount: 0
              })
            );
          }

          const session = sessionsById.get(externalSessionId);
          if (workspace && !session.workspaceId) {
            session.workspaceId = workspace.id;
          }
          if (timestamp) {
            if (!session.startedAt || timestamp < session.startedAt) {
              session.startedAt = timestamp;
            }
            if (!session.endedAt || timestamp > session.endedAt) {
              session.endedAt = timestamp;
            }
          }

          // Extract tool_use blocks without storing any conversation text
          const contentBlocks = Array.isArray(record?.message?.content)
            ? record.message.content
            : record.type === 'tool_use'
              ? [record]
              : [];

          for (const block of contentBlocks) {
            if (!block || block.type !== 'tool_use') {
              continue;
            }

            const toolName = String(block.name || 'unknown_tool');
            const input = block.input || {};
            const rawTarget =
              input.file_path ||
              input.path ||
              input.target_file ||
              input.notebook_path ||
              input.output_file ||
              null;

            const normalizedTarget = rawTarget
              ? normalizeFileUriOrPath(rawTarget, cwd)
              : null;

            let operationType = 'TOOL_CALL';
            const lowerTool = toolName.toLowerCase();
            if (lowerTool === 'write' || lowerTool === 'create_file' || lowerTool === 'write_to_file') {
              operationType = 'WRITE';
            } else if (
              lowerTool === 'edit' ||
              lowerTool === 'multiedit' ||
              lowerTool === 'str_replace_editor' ||
              lowerTool === 'notebookedit'
            ) {
              operationType = 'EDIT';
            } else if (lowerTool === 'bash' || lowerTool === 'run_command') {
              operationType = 'SHELL';
            }

            if (normalizedTarget || operationType === 'SHELL') {
              opSeq += 1;
              session.operationCount += 1;
              operations.push(
                createOperationModel({
                  sessionId: session.id,
                  applicationId: application.id,
                  workspaceId: session.workspaceId,
                  sequence: opSeq,
                  toolName,
                  operationType,
                  targetPath: normalizedTarget
                    ? platformServices.resolveRealPathSafe(normalizedTarget)
                    : null,
                  timestamp,
                  sourceRecordRef: `${platformServices.resolveRealPathSafe(jsonlPath)}#L${lineIdx + 1}`,
                  confidence: normalizedTarget
                    ? ProvenanceConfidence.VERIFIED
                    : ProvenanceConfidence.INFERRED
                })
              );
            }

            // Support multi-file edit arrays if present
            if (Array.isArray(input.edits)) {
              for (const subEdit of input.edits) {
                const subPath = subEdit?.file_path || subEdit?.path;
                if (subPath) {
                  opSeq += 1;
                  session.operationCount += 1;
                  const resolvedSub = platformServices.resolveRealPathSafe(
                    normalizeFileUriOrPath(subPath, cwd)
                  );
                  operations.push(
                    createOperationModel({
                      sessionId: session.id,
                      applicationId: application.id,
                      workspaceId: session.workspaceId,
                      sequence: opSeq,
                      toolName,
                      operationType: 'EDIT',
                      targetPath: resolvedSub,
                      timestamp,
                      sourceRecordRef: `${platformServices.resolveRealPathSafe(jsonlPath)}#L${lineIdx + 1}`,
                      confidence: ProvenanceConfidence.VERIFIED
                    })
                  );
                }
              }
            }
          }
        }
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * 2. Cursor AI IDE Adapter
 */
export class CursorAdapter {
  constructor() {
    this.id = 'cursor-ide';
    this.displayName = 'Cursor';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return (
      lowerBundle.includes('230313mzl4w4u92') ||
      lowerBundle.includes('cursor') ||
      lowerName === 'cursor' ||
      lowerName.includes('cursor')
    );
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    return [
      { role: 'CURSOR_DOTDIR', path: path.join(home, '.cursor') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Cursor') },
      { role: 'LOGS', path: path.join(home, 'Library', 'Logs', 'Cursor') },
      {
        role: 'CACHES',
        path: path.join(home, 'Library', 'Caches', bundleId || 'com.todesktop.230313mzl4w4u92')
      }
    ];
  }

  parseProvenanceRecords({ application, authorizedRoots, platformServices }) {
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];

    const storageRoots = [
      path.join(platformServices.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage')
    ];

    for (const root of authorizedRoots) {
      const candidate = path.join(root, 'User', 'workspaceStorage');
      if (fs.existsSync(candidate) && !storageRoots.includes(candidate)) {
        storageRoots.push(candidate);
      }
    }

    for (const storageRoot of storageRoots) {
      if (!fs.existsSync(storageRoot)) {
        continue;
      }

      let bucketEntries = [];
      try {
        bucketEntries = fs.readdirSync(storageRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const bucket of bucketEntries) {
        if (!bucket.isDirectory() || bucket.isSymbolicLink()) {
          continue;
        }
        const bucketDir = path.join(storageRoot, bucket.name);
        const workspaceJsonPath = path.join(bucketDir, 'workspace.json');
        let workspaceFolder = null;
        let workspaceModel = null;

        if (fs.existsSync(workspaceJsonPath)) {
          try {
            const wsRaw = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
            if (wsRaw.folder) {
              workspaceFolder = platformServices.resolveRealPathSafe(
                normalizeFileUriOrPath(wsRaw.folder)
              );
              if (!workspacesByPath.has(workspaceFolder)) {
                workspacesByPath.set(
                  workspaceFolder,
                  createWorkspaceModel({
                    name: path.basename(workspaceFolder),
                    canonicalPath: workspaceFolder,
                    applicationIds: [application.id],
                    hasGitRepository: fs.existsSync(path.join(workspaceFolder, '.git'))
                  })
                );
              }
              workspaceModel = workspacesByPath.get(workspaceFolder);
            }
          } catch (err) {
            malformedRecords.push({
              sourcePath: workspaceJsonPath,
              lineNumber: 1,
              error: err.message
            });
          }
        }

        // Real Cursor installs keep the composer index inside the workspace's VS Code state
        // database. Only structural metadata is read (composer id and timestamps); conversation
        // titles and message bodies are never copied.
        const stateDbPath = path.join(bucketDir, 'state.vscdb');
        if (fs.existsSync(stateDbPath)) {
          const composers = readCursorComposerIndex(stateDbPath, malformedRecords);
          for (const comp of composers) {
            if (sessionsById.has(comp.composerId)) {
              continue;
            }
            sessionsById.set(
              comp.composerId,
              createSessionModel({
                externalSessionId: comp.composerId,
                applicationId: application.id,
                workspaceId: workspaceModel ? workspaceModel.id : null,
                title: `Cursor Composer ${comp.composerId.slice(0, 8)}`,
                startedAt: comp.createdAt,
                endedAt: comp.updatedAt || comp.createdAt,
                sourcePath: platformServices.resolveRealPathSafe(stateDbPath),
                adapterId: this.id,
                operationCount: 0
              })
            );
          }
        }

        const composerPath = path.join(bucketDir, 'composerData.json');
        if (fs.existsSync(composerPath)) {
          try {
            const composerRaw = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
            const composers = Array.isArray(composerRaw.allComposers)
              ? composerRaw.allComposers
              : [];

            for (const comp of composers) {
              const composerId = String(comp.composerId || comp.id || `cursor_${bucket.name}`);
              const session = createSessionModel({
                externalSessionId: composerId,
                applicationId: application.id,
                workspaceId: workspaceModel ? workspaceModel.id : null,
                title: comp.name || `Cursor Composer ${composerId.slice(0, 8)}`,
                startedAt: comp.createdAt || null,
                endedAt: comp.updatedAt || comp.createdAt || null,
                sourcePath: platformServices.resolveRealPathSafe(composerPath),
                adapterId: this.id,
                operationCount: 0
              });
              sessionsById.set(composerId, session);

              const fileOps = Array.isArray(comp.operations) ? comp.operations : [];
              let seq = 0;
              for (const fop of fileOps) {
                const rawTarget = fop.filePath || fop.uri || fop.targetPath;
                if (!rawTarget) {
                  continue;
                }
                seq += 1;
                session.operationCount += 1;
                const resolvedTarget = platformServices.resolveRealPathSafe(
                  normalizeFileUriOrPath(rawTarget, workspaceFolder)
                );
                operations.push(
                  createOperationModel({
                    sessionId: session.id,
                    applicationId: application.id,
                    workspaceId: session.workspaceId,
                    sequence: seq,
                    toolName: fop.tool || 'CursorComposerApply',
                    operationType: fop.action === 'create' ? 'WRITE' : 'EDIT',
                    targetPath: resolvedTarget,
                    timestamp: fop.timestamp || comp.updatedAt || null,
                    sourceRecordRef: `${platformServices.resolveRealPathSafe(composerPath)}#${composerId}:${seq}`,
                    confidence: ProvenanceConfidence.VERIFIED
                  })
                );
              }
            }
          } catch (err) {
            malformedRecords.push({
              sourcePath: composerPath,
              lineNumber: 1,
              error: err.message
            });
          }
        }
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * 3. Codex CLI Adapter
 */
export class CodexAdapter {
  constructor() {
    this.id = 'codex-cli';
    this.displayName = 'Codex CLI';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return lowerBundle.includes('openai.codex') || lowerName.includes('codex');
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    return [
      { role: 'CODEX_HOME', path: path.join(home, '.codex') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Codex') },
      { role: 'CACHES', path: path.join(home, 'Library', 'Caches', bundleId || 'com.openai.codex') }
    ];
  }

  parseProvenanceRecords({ application, authorizedRoots, platformServices }) {
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];

    const sessionsDir = path.join(platformServices.homeDir, '.codex', 'sessions');
    const candidateRoots = [sessionsDir];
    for (const root of authorizedRoots) {
      const sub = path.join(root, '.codex', 'sessions');
      if (fs.existsSync(sub) && !candidateRoots.includes(sub)) {
        candidateRoots.push(sub);
      }
    }

    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      const rolloutFiles = safeWalkJsonlFiles(root, 5);
      for (const rolloutPath of rolloutFiles) {
        let lines = [];
        try {
          lines = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/);
        } catch {
          continue;
        }

        const fallbackSessionId = path.basename(rolloutPath, '.jsonl');
        let seq = 0;

        for (let i = 0; i < lines.length; i++) {
          const rawLine = lines[i].trim();
          if (!rawLine) {
            continue;
          }
          let entry;
          try {
            entry = JSON.parse(rawLine);
          } catch (err) {
            malformedRecords.push({
              sourcePath: rolloutPath,
              lineNumber: i + 1,
              error: err.message
            });
            continue;
          }

          const sessionId = String(entry.session_id || entry.id || fallbackSessionId);
          const cwd = entry.cwd ? platformServices.resolveRealPathSafe(entry.cwd) : null;
          let workspace = null;
          if (cwd) {
            if (!workspacesByPath.has(cwd)) {
              workspacesByPath.set(
                cwd,
                createWorkspaceModel({
                  name: path.basename(cwd),
                  canonicalPath: cwd,
                  applicationIds: [application.id],
                  hasGitRepository: fs.existsSync(path.join(cwd, '.git'))
                })
              );
            }
            workspace = workspacesByPath.get(cwd);
          }

          if (!sessionsById.has(sessionId)) {
            sessionsById.set(
              sessionId,
              createSessionModel({
                externalSessionId: sessionId,
                applicationId: application.id,
                workspaceId: workspace ? workspace.id : null,
                title: entry.title || `Codex Rollout ${sessionId.slice(0, 8)}`,
                startedAt: entry.timestamp || null,
                endedAt: entry.timestamp || null,
                sourcePath: platformServices.resolveRealPathSafe(rolloutPath),
                adapterId: this.id,
                operationCount: 0
              })
            );
          }

          const session = sessionsById.get(sessionId);
          if (entry.type === 'function_call' || entry.type === 'tool_call') {
            const toolName = String(entry.name || entry.tool || 'apply_patch');
            const target = entry.target_file || entry.file_path || entry.path;
            if (target) {
              seq += 1;
              session.operationCount += 1;
              const resolvedTarget = platformServices.resolveRealPathSafe(
                normalizeFileUriOrPath(target, cwd)
              );
              operations.push(
                createOperationModel({
                  sessionId: session.id,
                  applicationId: application.id,
                  workspaceId: session.workspaceId,
                  sequence: seq,
                  toolName,
                  operationType: entry.action === 'create' ? 'WRITE' : 'PATCH',
                  targetPath: resolvedTarget,
                  timestamp: entry.timestamp || null,
                  sourceRecordRef: `${platformServices.resolveRealPathSafe(rolloutPath)}#L${i + 1}`,
                  confidence: ProvenanceConfidence.VERIFIED
                })
              );
            }
          }
        }
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * 4. Generic macOS Application Adapter (Fallback for any .app bundle)
 */
export class GenericMacOSAppAdapter {
  constructor() {
    this.id = 'generic-macos-app';
    this.displayName = 'Generic macOS Application';
    this.isSpecializedAIAdapter = false;
  }

  matches() {
    return true;
  }

  getCandidateDataDirectories({ name, bundleId, platformServices }) {
    return platformServices.getStandardMacOSLocations({
      bundleId,
      appName: name
    });
  }

  parseProvenanceRecords() {
    // Generic macOS apps have no validated conversation transcript schema;
    // application-level attribution is preserved, session provenance remains honestly UNKNOWN.
    return {
      workspaces: [],
      sessions: [],
      operations: [],
      malformedRecords: []
    };
  }
}

export class AdapterRegistry {
  constructor() {
    this.specializedAdapters = [
      new ClaudeCodeAdapter(),
      new CursorAdapter(),
      new CodexAdapter()
    ];
    this.fallbackAdapter = new GenericMacOSAppAdapter();
  }

  resolveAdapterForApp(appIdentity) {
    for (const adapter of this.specializedAdapters) {
      if (adapter.matches(appIdentity)) {
        return adapter;
      }
    }
    return this.fallbackAdapter;
  }

  getAdapterById(adapterId) {
    return (
      this.specializedAdapters.find((a) => a.id === adapterId) ||
      this.fallbackAdapter
    );
  }

  listAdapters() {
    return [...this.specializedAdapters, this.fallbackAdapter];
  }
}

function epochMsToIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Reads the composer (chat session) index from a Cursor workspace `state.vscdb` SQLite file.
 * The database is opened strictly read-only and only the `composer.composerData` key is read.
 * Any failure (locked database, unknown schema) is reported as a malformed record, never thrown.
 */
export function readCursorComposerIndex(stateDbPath, malformedRecords = []) {
  let db = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get();
    if (!row || row.value == null) {
      return [];
    }
    const parsed = JSON.parse(
      typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
    );
    const all = Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
    return all
      .filter((c) => c && typeof c.composerId === 'string' && c.composerId)
      .map((c) => ({
        composerId: c.composerId,
        createdAt: epochMsToIso(c.createdAt),
        updatedAt: epochMsToIso(c.lastUpdatedAt)
      }));
  } catch (err) {
    malformedRecords.push({
      sourcePath: stateDbPath,
      lineNumber: 1,
      error: `Could not read Cursor composer index (${err.code || 'unreadable or unknown schema'})`
    });
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore
      }
    }
  }
}
