import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  '.svg': 'image/svg+xml'
};

export function createAtlasServer(options = {}) {
  const sandboxRoot =
    options.sandboxRoot || path.join(os.tmpdir(), 'artifact-atlas-live-workspace');
  const demoEnv = createDeterministicDemoEnvironment(sandboxRoot);

  const dbPath = options.dbPath || path.join(sandboxRoot, 'atlas-index.sqlite');
  const quarantineRoot =
    options.quarantineRoot || path.join(sandboxRoot, 'quarantine-vault');

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

  const sendJson = (res, statusCode, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      // API routes
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          platform: process.platform,
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
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
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

  return { server, service, demoEnv };
}
