import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArtifactAtlasService } from '../atlas-service.js';
import { createDeterministicDemoEnvironment } from '../fixtures/demo-environment.js';
import { RestoreConflictStrategy } from '../models/entities.js';
import { execFile } from 'node:child_process';
import {
  describePermissions,
  resolveOpenTarget,
  normalizeScanScope,
  SCAN_SCOPE_PERMISSIONS
} from '../platform/permissions.js';
import { findKnownAppProfile, findStorePackageProfile, listKnownApplicationsWithData, profileDisplayName } from '../discovery/app-footprint.js';
import { listStartMenuApplications, listStoreApplications } from '../discovery/windows-apps.js';
import { PICK_KINDS, pickWithWindowsDialog } from '../platform/windows-picker.js';
import { chooseRevealTarget } from '../graph/reveal-target.js';
import { summarizeProjectLeftovers, projectBuildOutputIds } from '../graph/project-leftovers.js';
import { findIdenticalFiles, copiesToSelect } from '../graph/identical-files.js';
import { reportData, reportHtml, reportCsv } from '../graph/report.js';
import { buildDiagnostics } from '../discovery/diagnostics.js';
import { fromPathKey } from '../platform/path-keys.js';
import { KNOWN_APP_PREFIX, parseMacOSBinaryPlist, parseMacOSPlistXml } from '../discovery/application-discovery.js';

/**
 * The bundle identifier in an application's Info.plist (static read; the app is not run).
 * Used to tell apart apps that share a name, such as the ChatGPT app that now hosts Codex
 * and ChatGPT Classic.
 */
function readBundleIdentifier(bundlePath) {
  try {
    const raw = fs.readFileSync(path.join(bundlePath, 'Contents', 'Info.plist'));
    const plist = raw.toString('latin1', 0, 6) === 'bplist' ? parseMacOSBinaryPlist(raw) : parseMacOSPlistXml(raw.toString('utf8'));
    return typeof plist.CFBundleIdentifier === 'string' ? plist.CFBundleIdentifier : null;
  } catch {
    return null;
  }
}
import { readAppIconPng } from '../discovery/app-icon.js';
import { readWindowsAppIconPng } from '../discovery/windows-icon.js';
import { buildMapLevel, levelArtifactIds, searchFiles } from '../graph/map-levels.js';
import { sessionLeftoverIds } from '../graph/prompt-costs.js';
import { checkForUpdate, UPDATE_CHECK_INTERVAL_MS } from '../platform/update-check.js';
import {
  findRunningAppBundle,
  canInstallInPlace,
  resolveInstallTarget,
  readSwapFailure,
  downloadVerifiedRelease,
  stageVerifiedBundle,
  launchSwap,
  createStagingDir
} from '../platform/self-update.js';
import {
  WINDOWS_ZIP_ASSET_NAME,
  findRunningWindowsInstall,
  resolveWindowsInstallTarget,
  stageVerifiedWindowsPackage,
  launchWindowsSwap
} from '../platform/self-update-windows.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.icns': 'application/octet-stream'
};

function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = v;
    }
  }
  return out;
}

/**
 * True only when the Host header names loopback exactly (optionally with a numeric port).
 */
export function isLoopbackHostHeader(hostHeader) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.exec(
    String(hostHeader || '').trim().toLowerCase()
  );
  return Boolean(match);
}

// The running version: the package.json shipped next to the source tree.
function readAppVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    return null;
  }
}

export function createAtlasServer(options = {}) {
  const defaultBaseDir =
    options.dataDir ||
    process.env.ATLAS_DATA_DIR ||
    path.join(os.tmpdir(), 'artifact-atlas-live-workspace');

  const sandboxRoot = options.sandboxRoot || path.join(defaultBaseDir, 'sandbox');
  const demoEnv = createDeterministicDemoEnvironment(sandboxRoot);

  const dbPath = options.dbPath || path.join(defaultBaseDir, 'atlas-index.sqlite');
  const quarantineRoot =
    options.quarantineRoot || path.join(defaultBaseDir, 'quarantine-vault');

  // Local API security token (Requirement 8). Every /api/* route except /api/health always
  // requires it: a caller-supplied token (packaged app) or a random per-process token that the
  // UI receives via the HttpOnly cookie + meta tag served with index.html.
  const explicitToken = options.apiToken || process.env.ATLAS_API_TOKEN || null;
  const sessionToken = explicitToken || crypto.randomBytes(32).toString('hex');
  const sessionTokenDigest = crypto.createHash('sha256').update(sessionToken).digest();
  const isValidToken = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      return false;
    }
    const digest = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(digest, sessionTokenDigest);
  };

  // ---------------------------------------------------------------------------------------
  // Data scope: "demo" (isolated sandbox fixtures) or "live" (the user's real home folder).
  // Live scanning needs the user's explicit, persisted consent; until then every request is
  // served from the sandbox. An explicit homeDir (CLI --home) pins the server to that home.
  // ---------------------------------------------------------------------------------------
  const explicitHomeDir = options.homeDir || null;
  const liveHomeDir = explicitHomeDir || options.liveHomeDir || os.homedir();
  const platform = options.platform || process.platform;
  const settingsPath = path.join(defaultBaseDir, 'settings.json');

  const loadSettings = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return {
        homeScanConsentAt: typeof raw.homeScanConsentAt === 'string' ? raw.homeScanConsentAt : null,
        mode: raw.mode === 'live' ? 'live' : 'demo',
        updateCheckEnabled: raw.updateCheckEnabled !== false,
        scanScope: normalizeScanScope(raw.scanScope),
        pendingUpdate:
          raw.pendingUpdate && typeof raw.pendingUpdate.version === 'string' && typeof raw.pendingUpdate.stagingDir === 'string'
            ? { version: raw.pendingUpdate.version, stagingDir: raw.pendingUpdate.stagingDir }
            : null,
        scanPermissionsReviewedAt:
          typeof raw.scanPermissionsReviewedAt === 'string' ? raw.scanPermissionsReviewedAt : null
      };
    } catch {
      return {
        homeScanConsentAt: null,
        mode: 'demo',
        updateCheckEnabled: true,
        scanScope: normalizeScanScope(null),
        pendingUpdate: null,
        scanPermissionsReviewedAt: null
      };
    }
  };
  const settings = loadSettings();
  const saveSettings = () => {
    fs.mkdirSync(defaultBaseDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  };

  // New-version check. This is the app's only network request; it can be turned off, and its
  // result is cached so GitHub is asked at most once every few hours.
  const appVersion = options.appVersion || readAppVersion();
  let cachedUpdate = null;
  const updateStatus = async ({ force = false } = {}) => {
    if (!settings.updateCheckEnabled) {
      return { enabled: false, currentVersion: appVersion, updateAvailable: false, install: installStatus() };
    }
    const fresh =
      cachedUpdate && Date.now() - Date.parse(cachedUpdate.checkedAt) < UPDATE_CHECK_INTERVAL_MS;
    if (!fresh || force) {
      cachedUpdate = await checkForUpdate({
        currentVersion: appVersion,
        fetchImpl: options.updateFetch || globalThis.fetch
      });
    }
    return { enabled: true, ...cachedUpdate, install: installStatus() };
  };

  // In-place update. Only a packaged copy in a writable folder can replace itself; any
  // other copy is sent to the download page instead.
  // On macOS the running copy is a .app bundle; on Windows, the folder holding
  // ArtifactAtlas.exe.
  const isWindowsUpdate = platform === 'win32';
  // The system file dialogs of the Windows app (the Mac app has its own Open panels)
  const pickImpl = options.pickImpl || pickWithWindowsDialog;
  const nativePicker = platform === 'win32' && (process.platform === 'win32' || Boolean(options.pickImpl));
  const appBundlePath =
    options.appBundlePath !== undefined
      ? options.appBundlePath
      : isWindowsUpdate
        ? findRunningWindowsInstall(fileURLToPath(import.meta.url))
        : findRunningAppBundle(fileURLToPath(import.meta.url));
  const installState = { phase: 'idle', error: null, received: 0, total: 0 };
  const installTarget = () =>
    isWindowsUpdate
      ? resolveWindowsInstallTarget({ installDir: appBundlePath, localAppData: options.localAppData })
      : resolveInstallTarget({
          appBundlePath,
          platform,
          homeDir: liveHomeDir,
          systemApplicationsDir: options.systemApplicationsDir || '/Applications'
        });
  // An update that was started before this launch: if this is still the old version, the
  // helper did not finish, and its log says why. Reported once.
  let lastFailure = null;
  if (settings.pendingUpdate) {
    if (settings.pendingUpdate.version !== appVersion) {
      lastFailure = {
        version: settings.pendingUpdate.version,
        detail: readSwapFailure(settings.pendingUpdate.stagingDir) || 'the app was reopened before the new version was in place'
      };
    }
    settings.pendingUpdate = null;
    try {
      saveSettings();
    } catch {
      // The notice is still shown for this launch
    }
  }
  const installStatus = () => ({
    ...installTarget(),
    lastFailure,
    phase: installState.phase,
    error: installState.error,
    received: installState.received,
    total: installState.total
  });
  const installUpdate = async () => {
    const possible = installTarget();
    if (!possible.ok) throw new Error(possible.reason);
    if (installState.phase !== 'idle' && installState.phase !== 'failed') throw new Error('UPDATE_ALREADY_RUNNING');
    const status = await updateStatus({ force: true });
    if (!status.updateAvailable) throw new Error('NO_UPDATE_AVAILABLE');

    const stagingDir = createStagingDir();
    try {
      Object.assign(installState, { phase: 'downloading', error: null, received: 0, total: 0 });
      const zipPath = await downloadVerifiedRelease({
        version: status.latestVersion,
        stagingDir,
        fetchImpl: options.updateFetch || globalThis.fetch,
        onProgress: (p) => Object.assign(installState, p),
        ...(isWindowsUpdate ? { assetName: WINDOWS_ZIP_ASSET_NAME } : {})
      });
      installState.phase = 'verifying';
      const staged = isWindowsUpdate
        ? stageVerifiedWindowsPackage({ zipPath, stagingDir, expectedVersion: status.latestVersion })
        : stageVerifiedBundle({ zipPath, stagingDir, expectedVersion: status.latestVersion });
      installState.phase = 'restarting';
      // The helper waits for the app (this backend's parent) to quit, swaps it and reopens it
      settings.pendingUpdate = { version: status.latestVersion, stagingDir };
      saveSettings();
      if (isWindowsUpdate) {
        await launchWindowsSwap({
          installDir: possible.targetPath,
          runningDir: appBundlePath,
          stagedDir: staged,
          appPid: options.appPid || process.ppid,
          stagingDir
        });
      } else {
        launchSwap({
          appBundlePath: possible.targetPath,
          runningBundlePath: appBundlePath,
          stagedBundle: staged,
          appPid: options.appPid || process.ppid,
          stagingDir
        });
      }
      return { version: status.latestVersion };
    } catch (err) {
      Object.assign(installState, { phase: 'failed', error: err.message });
      // Already reported here; nothing is left for the next launch to report
      if (settings.pendingUpdate && settings.pendingUpdate.stagingDir === stagingDir) {
        settings.pendingUpdate = null;
        saveSettings();
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  };

  const services = new Map();
  const currentMode = () => {
    if (explicitHomeDir) {
      return 'live';
    }
    return settings.mode === 'live' && settings.homeScanConsentAt ? 'live' : 'demo';
  };
  const activeService = () => {
    const mode = currentMode();
    if (!services.has(mode)) {
      const isPinnedHome = Boolean(explicitHomeDir);
      services.set(
        mode,
        mode === 'live'
          ? new ArtifactAtlasService({
              homeDir: liveHomeDir,
              platform,
              maxFiles: options.maxFiles,
              dbPath: isPinnedHome ? dbPath : path.join(defaultBaseDir, 'live', 'atlas-index.sqlite'),
              quarantineRoot: isPinnedHome
                ? quarantineRoot
                : path.join(defaultBaseDir, 'live', 'quarantine-vault'),
              isDemoEnvironment: false
            })
          : new ArtifactAtlasService({
              homeDir: demoEnv.homeDir,
              // The sample home folder is laid out like a Mac's on every system
              platform: 'darwin',
              dbPath,
              quarantineRoot,
              isDemoEnvironment: true
            })
      );
    }
    return services.get(mode);
  };

  const permissionsPayload = () => ({
    mode: currentMode(),
    canSwitchMode: !explicitHomeDir,
    platform,
    liveHomeDir,
    // False until the user has answered the questions asked before the first real scan
    scanPermissionsReviewed: Boolean(settings.scanPermissionsReviewedAt),
    scanScope: settings.scanScope,
    permissions: describePermissions({
      platform,
      homeDir: liveHomeDir,
      homeScanConsentAt: explicitHomeDir ? 'pinned-by-cli' : settings.homeScanConsentAt,
      scanScope: settings.scanScope
    })
  });

  const demoBundles = () => [
    {
      ...demoEnv.appBundles.claude,
      description: 'Anthropic AI coding assistant & desktop client (Multi-session JSONL provenance)',
      isDemoFixture: true
    },
    {
      ...demoEnv.appBundles.cursor,
      description: 'AI-first code editor (workspaceStorage & Composer operation ledger)',
      isDemoFixture: true
    },
    {
      ...demoEnv.appBundles.codex,
      description: 'OpenAI terminal coding agent (Rollout JSONL patch & shell ledger)',
      isDemoFixture: true
    },
    {
      ...demoEnv.appBundles.unsupported,
      description: 'Third-party macOS app without AI session transcripts (Generic adapter fallback)',
      isDemoFixture: true
    }
  ];

  // Installed applications, listed by name only (nothing is opened or run). On macOS these
  // are the .app bundles in the Applications folders; on Windows, the Start Menu shortcuts.
  // Known applications that left data but have nothing to list (command-line tools) follow.
  const installedBundles = () => {
    const bundles = [];
    const seen = new Set();
    const add = (name, bundlePath, description, bundleId = null, dataOnly = null, knownProfile = null) => {
      if (seen.has(bundlePath)) {
        return;
      }
      seen.add(bundlePath);
      const profile = knownProfile || findKnownAppProfile({ name, bundleId });
      bundles.push({
        name,
        bundleId,
        bundlePath,
        version: 'Installed',
        description,
        isDemoFixture: false,
        isKnownAIApp: Boolean(profile && profile.ai),
        profileId: profile ? profile.id : null,
        // Not an installed app: only a data folder of a known one was found (shown as evidence)
        dataOnly: Boolean(dataOnly),
        evidencePath: dataOnly ? dataOnly.location : null
      });
    };

    if (platform === 'win32') {
      const startMenuDirs = options.applicationDirs || [
        path.join(liveHomeDir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
      ];
      for (const app of listStartMenuApplications(startMenuDirs)) {
        add(app.name, app.shortcutPath, 'Start Menu');
      }
      // Store apps have no shortcut file; a known one is found by its data folder's name
      const listed = new Set(bundles.map((b) => b.profileId).filter(Boolean));
      const packagesDir = options.storePackagesDir || path.join(liveHomeDir, 'AppData', 'Local', 'Packages');
      for (const pkg of listStoreApplications(packagesDir)) {
        const profile = findStorePackageProfile(pkg.packageName);
        if (profile && !listed.has(profile.id)) {
          listed.add(profile.id);
          add(profileDisplayName(profile), `${KNOWN_APP_PREFIX}${profile.id}`, 'Microsoft Store', null, null, profile);
        }
      }
    } else {
      const appDirs = options.applicationDirs || [
        '/Applications',
        '/Applications/Utilities',
        path.join(liveHomeDir, 'Applications')
      ];
      for (const appDir of appDirs) {
        let entries = [];
        try {
          entries = fs.readdirSync(appDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.endsWith('.app')) {
            const name = entry.name.replace(/\.app$/, '');
            const bundlePath = path.join(appDir, entry.name);
            // Known AI apps are told apart by their bundle identifier; others by name only
            const bundleId = findKnownAppProfile({ name }) ? readBundleIdentifier(bundlePath) : null;
            add(name, bundlePath, `Installed in ${appDir}`, bundleId);
          }
        }
      }
    }

    const listedProfiles = new Set(bundles.map((b) => b.profileId).filter(Boolean));
    for (const known of listKnownApplicationsWithData({ platformServices: activeService().platformServices })) {
      if (!listedProfiles.has(known.profileId)) {
        add(known.name, `${KNOWN_APP_PREFIX}${known.profileId}`, 'Not installed; data found', null, known);
      }
    }

    return bundles.sort(
      (a, b) =>
        Number(b.isKnownAIApp) - Number(a.isKnownAIApp) || a.name.localeCompare(b.name)
    );
  };

  const discoverAvailableBundles = () =>
    currentMode() === 'live' ? installedBundles() : demoBundles();

  // The UI works from summaries. The file list, evidence and edge lists stay on the server:
  // a scan can hold hundreds of thousands of files, and the UI asks for file ids only when
  // the user selects something (see the /api/selection routes).
  const TREEMAP_GROUPINGS = ['byGroup', 'byWorkspace', 'bySession', 'byFolder'];
  const stateForClient = (state) => {
    if (!state) return state;
    let graph = state.graph;
    if (graph) {
      const treemap = { ...graph.treemap };
      for (const key of TREEMAP_GROUPINGS) {
        if (Array.isArray(treemap[key])) {
          treemap[key] = treemap[key].map(({ artifactIds, ...cell }) => cell);
        }
      }
      // The map is fetched level by level (/api/map/level), so the overview graph stays here
      graph = {
        ...graph,
        nodes: [],
        edges: [],
        treemap,
      };
    }
    return {
      application: state.application,
      workspaces: state.workspaces,
      scan: state.scan
        ? {
            ...state.scan,
            // Counts are enough for the UI; the full lists can be very long
            scannedLocations: undefined,
            scannedLocationsCount: (state.scan.scannedLocations || []).length,
            skippedSymlinks: (state.scan.skippedSymlinks || []).slice(0, 50),
            skippedBulkDirectories: (state.scan.skippedBulkDirectories || []).slice(0, 50),
            skippedBulkDirectoryCount: (state.scan.skippedBulkDirectories || []).length,
            // The map lists measured folders by project; the panel needs totals only
            bulkFolders: undefined,
            bulkFolderCount: (state.scan.bulkFolders || []).length,
            permissionLimitations: (state.scan.permissionLimitations || []).slice(0, 200)
          }
        : state.scan,
      graph,
      isDemoEnvironment: state.isDemoEnvironment,
      promptCosts: state.promptCosts || null,
      growth: state.growth || null
    };
  };

  // File ids for a selection the user made by description rather than one by one.
  const resolveSelection = (state, body) => {
    const live = (state.artifacts || []).filter((a) => !a.quarantined);
    if (body.kind === 'safe') {
      return live.filter((a) => a.cleanupClassification === 'LOW').map((a) => a.id);
    }
    if (body.kind === 'level') {
      const ids = levelArtifactIds(state, body.levelId);
      if (!ids) return [];
      const liveIds = new Set(live.map((a) => a.id));
      return ids.filter((id) => liveIds.has(id));
    }
    // The files a finished session left behind outside your projects (see prompt-costs.js)
    if (body.kind === 'session-leftovers' && typeof body.sessionId === 'string' && state.promptCosts) {
      return sessionLeftoverIds(state, body.sessionId, state.promptCosts);
    }
    // All copies but one of a group of identical files (never the kept one, never protected)
    if (body.kind === 'copies' && typeof body.groupId === 'string') {
      const result = copiesJob && copiesJob.scanId === state.scan?.id ? copiesJob.result : null;
      const groups = (result?.groups || []).filter((g) => body.groupId === '*' || g.id === body.groupId);
      return groups.flatMap((g) => copiesToSelect(g, state));
    }
    // The build outputs of one listed worktree or project
    if (body.kind === 'project-build' && typeof body.targetId === 'string') {
      const leftovers = projectLeftovers(state);
      const row = [...(leftovers?.worktrees || []), ...(leftovers?.buildProjects || [])].find((r) => r.id === body.targetId);
      return row ? projectBuildOutputIds(state, row.path) : [];
    }
    if (body.kind === 'search') {
      if (!String(body.query || '').trim() && (body.risk || 'ALL') === 'ALL' && (body.origin || 'ALL') === 'ALL') return [];
      return searchFiles(state, body).ids;
    }
    if (body.kind === 'cell' && TREEMAP_GROUPINGS.includes(body.groupBy)) {
      const cell = (state.graph?.treemap?.[body.groupBy] || []).find((c) => c.id === body.cellId);
      if (!cell) return [];
      const liveIds = new Set(live.map((a) => a.id));
      return (cell.artifactIds || []).filter((id) => liveIds.has(id));
    }
    return null;
  };

  // Files with identical content, searched only when the user asks (see identical-files.js)
  let copiesJob = null;
  const copiesStatus = () => {
    const state = activeService().activeState;
    if (!copiesJob || copiesJob.scanId !== state?.scan?.id) return { status: 'idle' };
    const { controller, ...rest } = copiesJob;
    return rest;
  };
  const startCopies = () => {
    const state = activeService().activeState;
    if (!state?.scan) return { status: 'idle' };
    if (copiesJob && copiesJob.scanId === state.scan.id && copiesJob.status === 'running') return copiesStatus();
    const controller = new AbortController();
    copiesJob = { scanId: state.scan.id, status: 'running', progress: { doneBytes: 0, totalBytes: 0 }, result: null, controller };
    const job = copiesJob;
    findIdenticalFiles(state, { signal: controller.signal, onProgress: (p) => (job.progress = p) })
      .then((result) => Object.assign(job, { status: 'done', result }))
      .catch((err) => Object.assign(job, { status: err.message === 'CANCELLED' ? 'cancelled' : 'failed', error: err.message }));
    return copiesStatus();
  };

  // Worktrees and build outputs of this scan (see project-leftovers.js), worked out once per scan
  let leftoversCache = { scanId: null, value: null };
  const projectLeftovers = (state) => {
    const scanId = state?.scan?.id || null;
    if (!state || !state.scan) return null;
    if (leftoversCache.scanId !== scanId || leftoversCache.quarantinedCount !== quarantinedCountOf(state)) {
      leftoversCache = {
        scanId,
        quarantinedCount: quarantinedCountOf(state),
        value: summarizeProjectLeftovers(state, { readGitMetadata: Boolean(state.scan.scope?.dependencyFolders) })
      };
    }
    return leftoversCache.value;
  };
  const quarantinedCountOf = (state) => (state.artifacts || []).reduce((n, a) => n + (a.quarantined ? 1 : 0), 0);

  // The folder or file behind a mark of the map, a worktree or a project. Only places the scan
  // listed can be shown; the client never names a path here.
  const revealPathForId = (state, id) => {
    if (!state) return null;
    const live = (state.artifacts || []).filter((a) => !a.quarantined);
    const art = live.find((a) => a.id === id);
    if (art) return art.canonicalPath;
    const leftovers = projectLeftovers(state);
    const listed = [...(leftovers?.worktrees || []), ...(leftovers?.buildProjects || [])].find((r) => r.id === id);
    if (listed) return listed.path;
    const dir = /^(?:dir|type):.*?::(\/[^]*?)(?:::[^:]*)?$/.exec(id);
    if (dir) {
      const folder = fromPathKey(dir[1]);
      const hasFiles = live.some((a) => a.canonicalPath === folder || a.canonicalPath.startsWith(folder.endsWith(path.sep) ? folder : folder + path.sep));
      return hasFiles ? folder : null;
    }
    const pastLimit = /^overflow-folder:(.+)$/.exec(id);
    if (pastLimit) {
      return (state.scan?.overflow?.folders || []).some((f) => f.path === pastLimit[1]) ? pastLimit[1] : null;
    }
    const measured = /^measured(?:-folder|-project)?:(.+)$/.exec(id);
    if (measured) {
      const p = measured[1];
      const known = (state.scan?.bulkFolders || []).some((f) => f.path === p || f.projectRoot === p);
      return known ? p : null;
    }
    return null;
  };

  // Count, physical size and first path for a set of file ids.
  const summarizeSelection = (state, artifactIds, { withReveal = false } = {}) => {
    const wanted = new Set(Array.isArray(artifactIds) ? artifactIds : []);
    const seenInodes = new Set();
    let count = 0;
    let physicalBytes = 0;
    let first = null;
    const files = [];
    for (const art of state.artifacts || []) {
      if (!wanted.has(art.id) || art.quarantined) continue;
      count += 1;
      if (!first) first = art;
      files.push({ path: art.canonicalPath, bytes: art.sizeBytes || 0 });
      const key = art.physicalInodeKey || art.canonicalPath;
      if (!seenInodes.has(key)) {
        seenInodes.add(key);
        physicalBytes += art.sizeBytes || 0;
      }
    }
    return {
      count,
      physicalBytes,
      firstName: first ? first.name : null,
      firstPath: first ? first.canonicalPath : null,
      // What Show in Finder / File Explorer opens; worked out only when asked for
      reveal: withReveal
        ? chooseRevealTarget(files, {
            homeDir: activeService().platformServices.homeDir,
            // Paths on disk follow the system this runs on, whatever layout the home folder has
            pathApi: path
          })
        : undefined
    };
  };

  // The review dialog lists at most this many files; totals always cover the whole selection.
  const REVIEW_LIST_LIMIT = 200;
  const reviewForClient = (review) => ({
    ...review,
    eligibleItems: (review.eligibleItems || []).slice(0, REVIEW_LIST_LIMIT),
    blockedItems: (review.blockedItems || []).slice(0, REVIEW_LIST_LIMIT),
    listLimit: REVIEW_LIST_LIMIT
  });

  // Application icons are requested once per row of the app list. Reading them is cached,
  // and so is the list of bundles that may be asked for.
  const iconCache = new Map();
  const cachedAppIcon = (bundlePath) => {
    if (!iconCache.has(bundlePath)) {
      if (iconCache.size > 600) iconCache.clear();
      iconCache.set(bundlePath, platform === 'win32' ? readWindowsAppIconPng(bundlePath) : readAppIconPng(bundlePath));
    }
    return iconCache.get(bundlePath);
  };
  let listedCache = { at: 0, mode: null, paths: new Set() };
  const listedBundlePaths = () => {
    const mode = currentMode();
    if (listedCache.mode !== mode || Date.now() - listedCache.at > 15000) {
      listedCache = { at: Date.now(), mode, paths: new Set(discoverAvailableBundles().map((b) => b.bundlePath)) };
    }
    return listedCache.paths;
  };

  const sendJson = (res, statusCode, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      ...extraHeaders
    });
    res.end(body);
  };

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 16 * 1024 * 1024) {
          reject(new Error('Request payload too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!data.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

  /**
   * Verifies that requests originate locally (loopback Host, non-cross-site Origin,
   * and valid session token when strict token protection is active).
   */
  const verifyLocalRequestSecurity = (req, url) => {
    // 1. Verify socket remote address is loopback (127.0.0.1 or ::1)
    const remoteAddr = req.socket?.remoteAddress || '';
    if (
      remoteAddr &&
      remoteAddr !== '127.0.0.1' &&
      remoteAddr !== '::1' &&
      remoteAddr !== '::ffff:127.0.0.1'
    ) {
      return { allowed: false, status: 403, error: 'FORBIDDEN_NON_LOOPBACK_CLIENT' };
    }

    // 2. DNS Rebinding Guard: Host header hostname must be exactly a loopback name.
    // Prefix matching is not enough (`localhost.evil.example` resolves wherever an attacker likes).
    if (!isLoopbackHostHeader(req.headers.host)) {
      return { allowed: false, status: 403, error: 'FORBIDDEN_HOST_HEADER' };
    }

    // 3. Cross-Origin CSRF Guard: block cross-origin browser requests
    const originHeader = req.headers.origin;
    if (originHeader) {
      try {
        const parsedOrigin = new URL(originHeader);
        if (
          parsedOrigin.hostname !== '127.0.0.1' &&
          parsedOrigin.hostname !== 'localhost' &&
          parsedOrigin.hostname !== '[::1]' &&
          parsedOrigin.protocol !== 'file:'
        ) {
          return { allowed: false, status: 403, error: 'FORBIDDEN_CROSS_ORIGIN_REQUEST' };
        }
      } catch {
        return { allowed: false, status: 403, error: 'INVALID_ORIGIN_HEADER' };
      }
    }

    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return { allowed: false, status: 403, error: 'FORBIDDEN_CROSS_SITE_FETCH' };
    }

    // 4. API Token check for /api/* routes (except /api/health)
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      const headerToken = req.headers['x-atlas-token'];
      const cookies = parseCookies(req.headers.cookie);
      const cookieToken = cookies.atlas_token;
      const queryToken = url.searchParams.get('token');
      const providedToken = headerToken || cookieToken || queryToken;

      if (!isValidToken(providedToken)) {
        return {
          allowed: false,
          status: 401,
          error: 'UNAUTHORIZED_LOCAL_API_TOKEN'
        };
      }
    }

    return { allowed: true };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      const securityCheck = verifyLocalRequestSecurity(req, url);
      if (!securityCheck.allowed) {
        return sendJson(res, securityCheck.status, {
          ok: false,
          error: securityCheck.error
        });
      }

      // Lightweight readiness endpoint for macOS app launcher
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          status: 'ready',
          pid: process.pid,
          platform: process.platform,
          arch: process.arch
        });
      }

      // API routes
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          ...permissionsPayload(),
          arch: process.arch,
          systemPicker: nativePicker,
          isDemoEnvironment: activeService().activeState.isDemoEnvironment,
          homeDir: activeService().platformServices.homeDir,
          quarantineVaultLocation: activeService().cleanupEngine.quarantineRoot,
          availableBundles: discoverAvailableBundles(),
          defaultWorkspacePath: currentMode() === 'demo' ? demoEnv.workspaceDir : '',
          activeState: stateForClient(activeService().activeState),
          quarantineEntries: activeService().quarantineEntriesWithSessions()
        });
      }

      // The application's own icon, copied out of its bundle (static read, nothing is run).
      // Only bundles that are already listed in the picker can be asked for.
      if (url.pathname === '/api/app/icon' && req.method === 'GET') {
        const requested = url.searchParams.get('bundlePath') || '';
        const png = listedBundlePaths().has(requested) ? cachedAppIcon(requested) : null;
        if (!png) {
          return sendJson(res, 404, { ok: false, error: 'NO_ICON' });
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(png);
        return;
      }

      if (url.pathname === '/api/app/identify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.bundlePath) {
          return sendJson(res, 400, { ok: false, error: 'bundlePath is required' });
        }
        const application = activeService().identifyApplication(body.bundlePath);
        return sendJson(res, 200, {
          ok: true,
          application
        });
      }

      if (url.pathname === '/api/scan/start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // Sample mode scans the built-in sample apps only. A real application is scanned
        // after the user has allowed the home folder scan.
        if (
          currentMode() === 'demo' &&
          body.bundlePath &&
          !demoBundles().some((b) => b.bundlePath === body.bundlePath)
        ) {
          return sendJson(res, 409, { ok: false, error: 'HOME_FOLDER_SCAN_NOT_ALLOWED' });
        }
        const state = await activeService().scanAndAnalyze({
          bundlePath: body.bundlePath || null,
          additionalWorkspacePaths: Array.isArray(body.workspacePaths)
            ? body.workspacePaths
            : body.workspacePath
              ? [body.workspacePath]
              : [],
          artificialDelayMs: Number(body.artificialDelayMs || 0),
          scanScope: settings.scanScope
        });
        return sendJson(res, 200, {
          ok: true,
          state: stateForClient(state),
          quarantineEntries: activeService().quarantineEntriesWithSessions()
        });
      }

      if (url.pathname === '/api/scan/progress' && req.method === 'GET') {
        const svc = activeService();
        return sendJson(res, 200, {
          ok: true,
          active: Boolean(svc.scanInProgress),
          progress: svc.lastProgress
        });
      }

      if (url.pathname === '/api/permissions' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...permissionsPayload() });
      }

      // Grant or revoke the in-app consent to scan the real home folder
      if (url.pathname === '/api/permissions/home-folder-scan' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (explicitHomeDir) {
          return sendJson(res, 409, { ok: false, error: 'HOME_SCOPE_PINNED_BY_CLI' });
        }
        activeService().cancelActiveScan();
        if (body.granted === true) {
          settings.homeScanConsentAt = new Date().toISOString();
          settings.mode = 'live';
        } else {
          settings.homeScanConsentAt = null;
          settings.mode = 'demo';
        }
        saveSettings();
        return sendJson(res, 200, { ok: true, ...permissionsPayload() });
      }

      // Scan scope: what a scan may count beyond the application's own folders. Asked before
      // the first real scan and changeable in the Permissions window at any time.
      if (url.pathname === '/api/permissions/scan-scope' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const key = SCAN_SCOPE_PERMISSIONS[body.id];
        if (!key || typeof body.granted !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'UNKNOWN_SCAN_SCOPE' });
        }
        settings.scanScope = { ...settings.scanScope, [key]: body.granted };
        saveSettings();
        return sendJson(res, 200, { ok: true, ...permissionsPayload() });
      }

      // The user has answered the questions asked before a scan
      if (url.pathname === '/api/permissions/reviewed' && req.method === 'POST') {
        settings.scanPermissionsReviewedAt = new Date().toISOString();
        saveSettings();
        return sendJson(res, 200, { ok: true, ...permissionsPayload() });
      }

      if (url.pathname === '/api/mode' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (explicitHomeDir) {
          return sendJson(res, 409, { ok: false, error: 'HOME_SCOPE_PINNED_BY_CLI' });
        }
        if (body.mode !== 'demo' && body.mode !== 'live') {
          return sendJson(res, 400, { ok: false, error: 'mode must be "demo" or "live"' });
        }
        if (body.mode === 'live' && !settings.homeScanConsentAt) {
          return sendJson(res, 403, { ok: false, error: 'HOME_FOLDER_SCAN_CONSENT_REQUIRED' });
        }
        activeService().cancelActiveScan();
        settings.mode = body.mode;
        saveSettings();
        return sendJson(res, 200, { ok: true, ...permissionsPayload() });
      }

      // Opens a permission's documentation page or System Settings pane (allowlisted targets only)
      if (url.pathname === '/api/update' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, update: await updateStatus() });
      }

      if (url.pathname === '/api/update' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body.enabled === 'boolean') {
          settings.updateCheckEnabled = body.enabled;
          saveSettings();
          cachedUpdate = null;
        }
        return sendJson(res, 200, {
          ok: true,
          update: await updateStatus({ force: Boolean(body.checkNow) })
        });
      }

      if (url.pathname === '/api/update/install' && req.method === 'POST') {
        try {
          const result = await installUpdate();
          return sendJson(res, 200, { ok: true, restarting: true, ...result });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: err.message, update: await updateStatus() });
        }
      }

      if (url.pathname === '/api/system/pick' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!nativePicker) {
          return sendJson(res, 404, { ok: false, error: 'NO_SYSTEM_PICKER' });
        }
        if (!PICK_KINDS.includes(body.kind)) {
          return sendJson(res, 400, { ok: false, error: 'UNKNOWN_PICKER' });
        }
        try {
          const startMenuDir = path.join(liveHomeDir, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
          const picked = await pickImpl(body.kind, { startMenuDir });
          return sendJson(res, 200, { ok: true, path: picked || null });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (url.pathname === '/api/system/open' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const targetUrl = resolveOpenTarget(body.target);
        if (!targetUrl) {
          return sendJson(res, 400, { ok: false, error: 'UNKNOWN_OPEN_TARGET' });
        }
        if (platform === 'win32' && process.platform === 'win32' && !options.simulateSystemOpen && /^https:\/\//.test(targetUrl)) {
          // Opens the page in the default browser. explorer.exe reports a non-zero exit code
          // even when it worked, so the result is not read from it.
          await new Promise((resolve) => execFile('explorer.exe', [targetUrl], () => resolve()));
          return sendJson(res, 200, { ok: true, opened: true, url: targetUrl });
        }
        if (platform !== 'darwin' || options.simulateSystemOpen) {
          return sendJson(res, 200, { ok: true, opened: false, url: targetUrl });
        }
        const opened = await new Promise((resolve) => {
          execFile('/usr/bin/open', [targetUrl], (err) => resolve(!err));
        });
        return sendJson(res, 200, { ok: true, opened, url: targetUrl });
      }

      if (url.pathname === '/api/scan/cancel' && req.method === 'POST') {
        const result = activeService().cancelActiveScan();
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (url.pathname === '/api/graph/trace' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const trace = activeService().inspectNodeProvenance(body.nodeId);
        if (!trace) {
          return sendJson(res, 404, { ok: false, error: 'Node not found in active graph' });
        }
        return sendJson(res, 200, { ok: true, trace });
      }

      // First prompt of the session(s) behind a node, read from the transcript for display.
      // It is sent to the local window only and is not kept anywhere.
      if (url.pathname === '/api/node/prompt' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...activeService().describeNodePrompts(body.nodeId) });
      }

      // Diagnostics the user can copy to help support more applications; made on request,
      // never sent anywhere (see src/discovery/diagnostics.js)
      if (url.pathname === '/api/diagnostics' && req.method === 'POST') {
        const service = activeService();
        const text = buildDiagnostics({
          state: service.activeState,
          homeDir: service.platformServices.homeDir,
          platform: service.platformServices.platform,
          appVersion
        });
        return sendJson(res, 200, { ok: true, text });
      }

      // A report of this scan, written to the data folder and shown in Finder / File Explorer
      if (url.pathname === '/api/report' && req.method === 'POST') {
        const state = activeService().activeState;
        if (!state?.scan) return sendJson(res, 409, { ok: false, error: 'NO_SCAN' });
        const data = reportData(state, { leftovers: projectLeftovers(state), copies: copiesJob?.scanId === state.scan.id ? copiesJob.result : null });
        const dir = path.join(defaultBaseDir, 'reports');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const base = `${String(data.application).replace(/[^\w.-]+/g, '-').slice(0, 40)}-${stamp}`;
        const htmlPath = path.join(dir, `${base}.html`);
        const csvPath = path.join(dir, `${base}.csv`);
        fs.writeFileSync(htmlPath, reportHtml(data, { appVersion }));
        fs.writeFileSync(csvPath, reportCsv(data));
        const shown = await activeService().platformServices.revealInFinder(htmlPath, { simulate: Boolean(options.simulateSystemOpen) });
        return sendJson(res, 200, { ok: true, htmlPath, csvPath, shown: shown.ok });
      }

      if (url.pathname === '/api/insights/copies' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, copies: copiesStatus() });
      }
      if (url.pathname === '/api/insights/copies/start' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, copies: startCopies() });
      }
      if (url.pathname === '/api/insights/copies/cancel' && req.method === 'POST') {
        if (copiesJob?.status === 'running') copiesJob.controller.abort();
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname === '/api/project-leftovers' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, leftovers: projectLeftovers(activeService().activeState) });
      }

      if (url.pathname === '/api/finder/reveal' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // A selection is revealed by what the summary chose for it (a file or a folder)
        // Only places the server listed can be shown; a path sent by the window is never opened
        let target = null;
        let reveal = null;
        if (Array.isArray(body.artifactIds)) {
          reveal = summarizeSelection(activeService().activeState, body.artifactIds, { withReveal: true }).reveal;
          if (!reveal) return sendJson(res, 404, { ok: false, error: 'NOTHING_SELECTED' });
          // A region is chosen by its place in the list the server worked out, not by a path
          const index = Number.isInteger(body.region) ? body.region : 0;
          if (!reveal.regions[index]) return sendJson(res, 400, { ok: false, error: 'UNKNOWN_REGION' });
          target = reveal.regions[index].path;
          // With several regions and none chosen, only the list is sent back to choose from
          if (reveal.regionCount > 1 && !Number.isInteger(body.region)) {
            return sendJson(res, 200, { ok: true, chooseRegion: true, reveal });
          }
        } else if (typeof body.targetId === 'string') {
          target = revealPathForId(activeService().activeState, body.targetId);
          if (!target) return sendJson(res, 404, { ok: false, error: 'UNKNOWN_TARGET' });
        } else {
          return sendJson(res, 400, { ok: false, error: 'NOTHING_TO_SHOW' });
        }
        const result = await activeService().platformServices.revealInFinder(target, { simulate: Boolean(options.simulateSystemOpen) });
        return sendJson(res, result.ok ? 200 : 404, { ...result, reveal });
      }

      if (url.pathname === '/api/selection/resolve' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const artifactIds = resolveSelection(activeService().activeState, body);
        if (artifactIds === null) {
          return sendJson(res, 400, { ok: false, error: 'UNKNOWN_SELECTION_KIND' });
        }
        return sendJson(res, 200, {
          ok: true,
          artifactIds,
          summary: summarizeSelection(activeService().activeState, artifactIds)
        });
      }

      // Search over every listed file of the scan, not only the marks of the open level
      if (url.pathname === '/api/search' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const { total, bytes, results } = searchFiles(activeService().activeState, {
          query: body.query,
          risk: body.risk,
          origin: body.origin
        });
        return sendJson(res, 200, { ok: true, total, bytes, results });
      }

      if (url.pathname === '/api/map/level' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // Session marks carry their first prompt, read now for this response only
        const level = activeService().decorateLevelWithPrompts(
          buildMapLevel(activeService().activeState, body.levelId || 'root')
        );
        if (!level) {
          return sendJson(res, 404, { ok: false, error: 'UNKNOWN_MAP_LEVEL' });
        }
        return sendJson(res, 200, { ok: true, level });
      }

      if (url.pathname === '/api/selection/summary' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, {
          ok: true,
          summary: summarizeSelection(activeService().activeState, body.artifactIds)
        });
      }

      if (url.pathname === '/api/cleanup/review' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const review = activeService().prepareCleanupReview(
          body.artifactIds || [],
          Boolean(body.allowHighRiskSingleOverride)
        );
        return sendJson(res, 200, { ok: true, review: reviewForClient(review) });
      }

      if (url.pathname === '/api/cleanup/quarantine' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = activeService().executeQuarantine({
          artifactIds: body.artifactIds || [],
          confirmationToken: body.confirmationToken,
          allowHighRiskSingleOverride: Boolean(body.allowHighRiskSingleOverride)
        });
        return sendJson(res, 200, {
          ok: true,
          ...result,
          updatedGraph: undefined,
          activeState: stateForClient(activeService().activeState)
        });
      }

      // Emptying the Quarantine: first the list of what has waited long enough, then the
      // confirmed deletion of exactly that list
      if (url.pathname === '/api/quarantine/purge/prepare' && req.method === 'POST') {
        return sendJson(res, 200, { ok: true, purge: activeService().preparePurge() });
      }
      if (url.pathname === '/api/quarantine/purge' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await activeService().purgeQuarantine({ token: body.token });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 409, { ok: false, error: err.message });
        }
      }

      if (url.pathname === '/api/cleanup/restore' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = activeService().restoreQuarantineEntry({
          entryId: body.entryId,
          conflictStrategy: body.conflictStrategy || RestoreConflictStrategy.FAIL_IF_EXISTS
        });
        return sendJson(res, 200, {
          ok: true,
          ...result,
          updatedGraph: undefined,
          activeState: stateForClient(activeService().activeState)
        });
      }

      if (url.pathname === '/api/demo/reset' && req.method === 'POST') {
        if (currentMode() !== 'demo') {
          return sendJson(res, 409, { ok: false, error: 'DEMO_RESET_ONLY_IN_SAMPLE_DATA_MODE' });
        }
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
        createDeterministicDemoEnvironment(sandboxRoot);
        activeService().activeState.application = null;
        activeService().activeState.graph = null;
        activeService().activeState.artifacts = [];
        return sendJson(res, 200, {
          ok: true,
          availableBundles: discoverAvailableBundles()
        });
      }

      // Serve static files from src/ui/public
      let relPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(PUBLIC_DIR, safePath);

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const headers = {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        };

        // Inject session token cookie and meta tag into index.html
        if (relPath === '/index.html') {
          headers['Set-Cookie'] = `atlas_token=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
          const rawHtml = fs.readFileSync(filePath, 'utf8');
          const injectedHtml = rawHtml.replace(
            '</head>',
            `  <meta name="atlas-api-token" content="${sessionToken}" />\n</head>`
          );
          res.writeHead(200, headers);
          res.end(injectedHtml);
          return;
        }

        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err.message || 'Unexpected error'
      });
    }
  });

  const shutdown = () => {
    return new Promise((resolve) => {
      for (const svc of services.values()) {
        try {
          svc.cancelActiveScan();
        } catch {
          // Ignore
        }
      }
      server.close(() => {
        for (const svc of services.values()) {
          try {
            svc.sqliteStore.close();
          } catch {
            // Ignore
          }
        }
        resolve();
      });
    });
  };

  return {
    server,
    get service() {
      return activeService();
    },
    demoEnv,
    sessionToken,
    shutdown
  };
}
