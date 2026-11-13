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
import { describePermissions, resolveOpenTarget } from '../platform/permissions.js';
import { findKnownAppProfile } from '../discovery/app-footprint.js';
import { readAppIconPng } from '../discovery/app-icon.js';
import { buildMapLevel, levelArtifactIds } from '../graph/map-levels.js';
import { checkForUpdate, UPDATE_CHECK_INTERVAL_MS } from '../platform/update-check.js';
import {
  findRunningAppBundle,
  canInstallInPlace,
  downloadVerifiedRelease,
  stageVerifiedBundle,
  launchSwap,
  createStagingDir
} from '../platform/self-update.js';

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
        updateCheckEnabled: raw.updateCheckEnabled !== false
      };
    } catch {
      return { homeScanConsentAt: null, mode: 'demo', updateCheckEnabled: true };
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
  const appBundlePath =
    options.appBundlePath !== undefined
      ? options.appBundlePath
      : findRunningAppBundle(fileURLToPath(import.meta.url));
  const installState = { phase: 'idle', error: null, received: 0, total: 0 };
  const installStatus = () => ({
    ...canInstallInPlace({ appBundlePath, platform }),
    phase: installState.phase,
    error: installState.error,
    received: installState.received,
    total: installState.total
  });
  const installUpdate = async () => {
    const possible = canInstallInPlace({ appBundlePath, platform });
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
        onProgress: (p) => Object.assign(installState, p)
      });
      installState.phase = 'verifying';
      const stagedBundle = stageVerifiedBundle({ zipPath, stagingDir, expectedVersion: status.latestVersion });
      installState.phase = 'restarting';
      // The helper stops the app (this backend's parent), swaps the bundle and reopens it
      launchSwap({ appBundlePath, stagedBundle, appPid: options.appPid || process.ppid, stagingDir });
      return { version: status.latestVersion };
    } catch (err) {
      Object.assign(installState, { phase: 'failed', error: err.message });
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
    permissions: describePermissions({
      platform,
      homeDir: liveHomeDir,
      homeScanConsentAt: explicitHomeDir ? 'pinned-by-cli' : settings.homeScanConsentAt
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

  // Installed applications, listed by directory name only (bundles are never opened or run).
  const installedBundles = () => {
    const bundles = [];
    const seen = new Set();
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
        if (!entry.isDirectory() || !entry.name.endsWith('.app')) {
          continue;
        }
        const bundlePath = path.join(appDir, entry.name);
        if (seen.has(bundlePath)) {
          continue;
        }
        seen.add(bundlePath);
        const name = entry.name.replace(/\.app$/, '');
        const profile = findKnownAppProfile({ name });
        bundles.push({
          name,
          bundleId: null,
          bundlePath,
          version: 'Installed',
          description: `Installed in ${appDir}`,
          isDemoFixture: false,
          isKnownAIApp: Boolean(profile && profile.ai)
        });
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
            permissionLimitations: (state.scan.permissionLimitations || []).slice(0, 200)
          }
        : state.scan,
      graph,
      isDemoEnvironment: state.isDemoEnvironment
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
    if (body.kind === 'cell' && TREEMAP_GROUPINGS.includes(body.groupBy)) {
      const cell = (state.graph?.treemap?.[body.groupBy] || []).find((c) => c.id === body.cellId);
      if (!cell) return [];
      const liveIds = new Set(live.map((a) => a.id));
      return (cell.artifactIds || []).filter((id) => liveIds.has(id));
    }
    return null;
  };

  // Count, physical size and first path for a set of file ids.
  const summarizeSelection = (state, artifactIds) => {
    const wanted = new Set(Array.isArray(artifactIds) ? artifactIds : []);
    const seenInodes = new Set();
    let count = 0;
    let physicalBytes = 0;
    let first = null;
    for (const art of state.artifacts || []) {
      if (!wanted.has(art.id) || art.quarantined) continue;
      count += 1;
      if (!first) first = art;
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
      firstPath: first ? first.canonicalPath : null
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
          isDemoEnvironment: activeService().activeState.isDemoEnvironment,
          homeDir: activeService().platformServices.homeDir,
          quarantineVaultLocation: activeService().cleanupEngine.quarantineRoot,
          availableBundles: discoverAvailableBundles(),
          defaultWorkspacePath: currentMode() === 'demo' ? demoEnv.workspaceDir : '',
          activeState: stateForClient(activeService().activeState),
          quarantineEntries: activeService().sqliteStore.listQuarantineEntries()
        });
      }

      // The application's own icon, copied out of its bundle (static read, nothing is run).
      // Only bundles that are already listed in the picker can be asked for.
      if (url.pathname === '/api/app/icon' && req.method === 'GET') {
        const requested = url.searchParams.get('bundlePath') || '';
        const listed = discoverAvailableBundles().some((b) => b.bundlePath === requested);
        const png = listed ? readAppIconPng(requested) : null;
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
          artificialDelayMs: Number(body.artificialDelayMs || 0)
        });
        return sendJson(res, 200, {
          ok: true,
          state: stateForClient(state),
          quarantineEntries: activeService().sqliteStore.listQuarantineEntries()
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

      if (url.pathname === '/api/system/open' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const targetUrl = resolveOpenTarget(body.target);
        if (!targetUrl) {
          return sendJson(res, 400, { ok: false, error: 'UNKNOWN_OPEN_TARGET' });
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

      if (url.pathname === '/api/finder/reveal' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await activeService().platformServices.revealInFinder(body.path);
        return sendJson(res, result.ok ? 200 : 404, result);
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

      if (url.pathname === '/api/map/level' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const level = buildMapLevel(activeService().activeState, body.levelId || 'root');
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
