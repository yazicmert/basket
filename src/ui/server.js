import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ArtifactAtlasService } from '../atlas-service.js';
import { createDeterministicDemoEnvironment } from '../fixtures/demo-environment.js';
import { RestoreConflictStrategy } from '../models/entities.js';

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

  // Local API security token (Requirement 8)
  const explicitToken = options.apiToken || process.env.ATLAS_API_TOKEN || null;
  const sessionToken = explicitToken || crypto.randomBytes(24).toString('hex');
  const enforceStrictToken = Boolean(explicitToken || options.enforceToken);

  const service = new ArtifactAtlasService({
    homeDir: options.homeDir || demoEnv.homeDir,
    dbPath,
    quarantineRoot,
    isDemoEnvironment: !options.homeDir
  });

  // Discover real macOS /Applications bundles if running on macOS, plus sandbox demo bundles
  const discoverAvailableBundles = () => {
    const bundles = [
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

    if (fs.existsSync('/Applications')) {
      try {
        const sysEntries = fs.readdirSync('/Applications', { withFileTypes: true });
        for (const entry of sysEntries) {
          if (entry.isDirectory() && entry.name.endsWith('.app')) {
            bundles.push({
              name: entry.name.replace(/\.app$/, ''),
              bundleId: null,
              bundlePath: path.join('/Applications', entry.name),
              version: 'System Installed',
              description: 'Installed in /Applications',
              isDemoFixture: false
            });
          }
        }
      } catch {
        // Ignore if /Applications cannot be listed
      }
    }
    return bundles;
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
        if (data.length > 2 * 1024 * 1024) {
          reject(new Error('Request payload too large'));
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

    // 2. DNS Rebinding Guard: Host header must be localhost or 127.0.0.1
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (
      hostHeader &&
      !hostHeader.startsWith('127.0.0.1') &&
      !hostHeader.startsWith('localhost') &&
      !hostHeader.startsWith('[::1]')
    ) {
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

      if (enforceStrictToken && providedToken !== sessionToken) {
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
          platform: process.platform,
          arch: process.arch,
          isDemoEnvironment: service.activeState.isDemoEnvironment,
          homeDir: service.platformServices.homeDir,
          quarantineVaultLocation: service.cleanupEngine.quarantineRoot,
          availableBundles: discoverAvailableBundles(),
          defaultWorkspacePath: demoEnv.workspaceDir,
          activeState: service.activeState,
          quarantineEntries: service.sqliteStore.listQuarantineEntries()
        });
      }

      if (url.pathname === '/api/app/identify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!body.bundlePath) {
          return sendJson(res, 400, { ok: false, error: 'bundlePath is required' });
        }
        const application = service.identifyApplication(body.bundlePath);
        return sendJson(res, 200, {
          ok: true,
          application
        });
      }

      if (url.pathname === '/api/scan/start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const state = await service.scanAndAnalyze({
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
          state,
          quarantineEntries: service.sqliteStore.listQuarantineEntries()
        });
      }

      if (url.pathname === '/api/scan/cancel' && req.method === 'POST') {
        const result = service.cancelActiveScan();
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (url.pathname === '/api/graph/trace' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const trace = service.inspectNodeProvenance(body.nodeId);
        if (!trace) {
          return sendJson(res, 404, { ok: false, error: 'Node not found in active graph' });
        }
        return sendJson(res, 200, { ok: true, trace });
      }

      if (url.pathname === '/api/finder/reveal' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = await service.platformServices.revealInFinder(body.path);
        return sendJson(res, result.ok ? 200 : 404, result);
      }

      if (url.pathname === '/api/cleanup/review' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const review = service.prepareCleanupReview(
          body.artifactIds || [],
          Boolean(body.allowHighRiskSingleOverride)
        );
        return sendJson(res, 200, { ok: true, review });
      }

      if (url.pathname === '/api/cleanup/quarantine' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = service.executeQuarantine({
          artifactIds: body.artifactIds || [],
          confirmationToken: body.confirmationToken,
          allowHighRiskSingleOverride: Boolean(body.allowHighRiskSingleOverride)
        });
        return sendJson(res, 200, {
          ok: true,
          ...result,
          activeState: service.activeState
        });
      }

      if (url.pathname === '/api/cleanup/restore' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = service.restoreQuarantineEntry({
          entryId: body.entryId,
          conflictStrategy: body.conflictStrategy || RestoreConflictStrategy.FAIL_IF_EXISTS
        });
        return sendJson(res, 200, {
          ok: true,
          ...result,
          activeState: service.activeState
        });
      }

      if (url.pathname === '/api/demo/reset' && req.method === 'POST') {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
        createDeterministicDemoEnvironment(sandboxRoot);
        service.activeState.application = null;
        service.activeState.graph = null;
        service.activeState.artifacts = [];
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
      try {
        service.cancelActiveScan();
      } catch {
        // Ignore
      }
      server.close(() => {
        try {
          service.sqliteStore.close();
        } catch {
          // Ignore
        }
        resolve();
      });
    });
  };

  return {
    server,
    service,
    demoEnv,
    sessionToken,
    shutdown
  };
}
