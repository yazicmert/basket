import fs from 'node:fs';
import path from 'node:path';

/**
 * Creates a deterministic, real-filesystem sandbox environment containing:
 * - 4 macOS .app bundles (Claude.app, Cursor.app, Codex.app, PixelCraft.app)
 * - Realistic AI project workspaces with .git metadata, source code, build outputs,
 *   model checkpoints, credentials, and stray unknown-provenance files
 * - Realistic multi-session JSONL transcripts where two conversations (Session Alpha
 *   and Session Beta) produce overlapping edits on shared files
 * - Regenerable application caches, diagnostic logs, and temporary shell snapshots
 * - Physical hardlinks and an out-of-boundary symlink for safety verification
 *
 * Clearly labeled as a deterministic Demo / Sandbox Fixture environment.
 */
export function createDeterministicDemoEnvironment(rootDir) {
  const baseDir = path.resolve(rootDir);
  fs.mkdirSync(baseDir, { recursive: true });

  const homeDir = path.join(baseDir, 'sandbox-home');
  const appsDir = path.join(baseDir, 'Applications');
  const externalSecretDir = path.join(baseDir, 'external-outside-boundary');

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(appsDir, { recursive: true });
  fs.mkdirSync(externalSecretDir, { recursive: true });

  fs.writeFileSync(
    path.join(externalSecretDir, 'outside-secret.txt'),
    'DO NOT SCAN OUTSIDE BOUNDARY\n',
    'utf8'
  );

  // 1. Create macOS .app bundles with realistic Contents/Info.plist
  const appBundles = {
    claude: createMockAppBundle(appsDir, {
      bundleFolder: 'Claude.app',
      displayName: 'Claude Code',
      bundleId: 'com.anthropic.claudefordesktop',
      executable: 'Claude',
      version: '1.2.4',
      copyright: 'Copyright © 2026 Anthropic PBC. All rights reserved.',
      category: 'public.app-category.developer-tools'
    }),
    cursor: createMockAppBundle(appsDir, {
      bundleFolder: 'Cursor.app',
      displayName: 'Cursor',
      bundleId: 'com.todesktop.230313mzl4w4u92',
      executable: 'Cursor',
      version: '0.48.2',
      copyright: 'Copyright © 2026 Anysphere Inc.',
      category: 'public.app-category.developer-tools'
    }),
    codex: createMockAppBundle(appsDir, {
      bundleFolder: 'Codex.app',
      displayName: 'Codex CLI',
      bundleId: 'com.openai.codex',
      executable: 'codex',
      version: '0.19.0',
      copyright: 'Copyright © 2026 OpenAI.',
      category: 'public.app-category.developer-tools'
    }),
    unsupported: createMockAppBundle(appsDir, {
      bundleFolder: 'NebulaSketch.app',
      displayName: 'NebulaSketch',
      bundleId: 'com.example.nebulasketch',
      executable: 'NebulaSketch',
      version: '3.0.1',
      copyright: 'Copyright © 2026 Example Studio.',
      category: 'public.app-category.graphics-design'
    })
  };

  // 2. Create a realistic project workspace: ~/Projects/neural-search-engine
  const workspaceDir = path.join(homeDir, 'Projects', 'neural-search-engine');
  fs.mkdirSync(path.join(workspaceDir, '.git', 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'checkpoints'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'models'), { recursive: true });

  // Protected Git & config files
  fs.writeFileSync(path.join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({ name: 'neural-search-engine', version: '1.0.0' }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.env'),
    'VECTOR_DB_SECRET_KEY=demo_redacted_placeholder\n',
    'utf8'
  );

  // Source files created/modified by AI sessions
  const sharedSourceFile = path.join(workspaceDir, 'src', 'vector-index.ts');
  const queryRouterFile = path.join(workspaceDir, 'src', 'query-router.ts');
  const tokenizerFile = path.join(workspaceDir, 'src', 'tokenizer.ts');

  fs.writeFileSync(
    sharedSourceFile,
    '// Co-authored across Session Alpha (initial write) and Session Beta (SIMD optimization edit)\nexport class VectorIndex {\n  search(query: Float32Array) { return []; }\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    queryRouterFile,
    '// Created in Session Alpha\nexport function routeQuery(q: string) { return q.trim(); }\n',
    'utf8'
  );
  fs.writeFileSync(
    tokenizerFile,
    '// Patched via Codex CLI\nexport function tokenize(input: string) { return input.split(/\\s+/); }\n',
    'utf8'
  );

  // Build outputs & derived data (dist/vector-index.bundle.js and source map)
  const bundleOutputFile = path.join(workspaceDir, 'dist', 'vector-index.bundle.js');
  const bundleMapFile = path.join(workspaceDir, 'dist', 'vector-index.bundle.js.map');
  fs.writeFileSync(
    bundleOutputFile,
    '/* Compiled bundle output from src/vector-index.ts */\n' + 'x'.repeat(24 * 1024),
    'utf8'
  );
  fs.writeFileSync(
    bundleMapFile,
    JSON.stringify({ version: 3, file: 'vector-index.bundle.js', sources: ['../src/vector-index.ts'] }) +
      ' '.repeat(8 * 1024),
    'utf8'
  );

  // High-risk checkpoint and model weight files
  const checkpointFile = path.join(workspaceDir, 'checkpoints', 'checkpoint-sess_alpha_01.json');
  const modelWeightsFile = path.join(workspaceDir, 'models', 'embedder-q4_k_m.gguf');
  fs.writeFileSync(
    checkpointFile,
    JSON.stringify({ sessionId: 'sess_alpha_01', step: 42, loss: 0.031 }) + ' '.repeat(16 * 1024),
    'utf8'
  );
  fs.writeFileSync(modelWeightsFile, 'GGUF_DEMO_MODEL_WEIGHTS_' + 'W'.repeat(96 * 1024), 'utf8');

  // Ambiguous .tmp file inside src/ (tests that extension .tmp alone NEVER makes a file LOW risk!)
  const ambiguousWorkspaceTmp = path.join(workspaceDir, 'src', 'draft-schema.tmp');
  fs.writeFileSync(
    ambiguousWorkspaceTmp,
    '// User draft schema with .tmp extension inside src/ directory\n',
    'utf8'
  );

  // Mystery file with NO session record (even though mtime is recent -> must be UNKNOWN provenance!)
  const mysteryUnknownFile = path.join(workspaceDir, 'untracked-experiment-notes.dat');
  fs.writeFileSync(
    mysteryUnknownFile,
    'Binary or unattributed data file with no tool call in any session transcript.\n' + 'U'.repeat(12 * 1024),
    'utf8'
  );

  // Symlink inside workspace pointing outside authorized boundary (must be skipped safely!)
  const escapeSymlinkPath = path.join(workspaceDir, 'escape-link');
  try {
    if (!fs.existsSync(escapeSymlinkPath)) {
      fs.symlinkSync(path.join(externalSecretDir, 'outside-secret.txt'), escapeSymlinkPath);
    }
  } catch {
    // Ignore if symlinks unsupported on host mount
  }

  // 3. Create Claude Code data directories & multi-session transcripts
  const claudeHome = path.join(homeDir, '.claude');
  const claudeProjectDir = path.join(claudeHome, 'projects', '-Users-demo-Projects-neural-search-engine');
  const claudeStatsigCacheDir = path.join(claudeHome, 'statsig');
  const claudeDebugLogDir = path.join(claudeHome, 'debug');
  const claudeShellSnapDir = path.join(claudeHome, 'shell-snapshots');
  const claudeDesktopCacheDir = path.join(
    homeDir,
    'Library',
    'Caches',
    'com.anthropic.claudefordesktop'
  );

  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.mkdirSync(claudeStatsigCacheDir, { recursive: true });
  fs.mkdirSync(claudeDebugLogDir, { recursive: true });
  fs.mkdirSync(claudeShellSnapDir, { recursive: true });
  fs.mkdirSync(claudeDesktopCacheDir, { recursive: true });

  // Session Alpha: Creates vector-index.ts and query-router.ts
  const sessionAlphaJsonl = path.join(claudeProjectDir, 'sess_alpha_01.jsonl');
  const sessionAlphaLines = [
    JSON.stringify({
      sessionId: 'sess_alpha_01',
      summary: 'Session Alpha: Core Vector Index Architecture',
      cwd: workspaceDir,
      timestamp: '2026-11-10T09:15:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: sharedSourceFile }
          },
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: queryRouterFile }
          }
        ]
      }
    }),
    // Include one intentionally malformed line to prove graceful degradation
    '{malformed_jsonl_record_for_resilience_check: true'
  ];
  fs.writeFileSync(sessionAlphaJsonl, sessionAlphaLines.join('\n') + '\n', 'utf8');

  // Session Beta: Modifies vector-index.ts (creating multi-session shared provenance!) and writes build output
  const sessionBetaJsonl = path.join(claudeProjectDir, 'sess_beta_02.jsonl');
  const sessionBetaLines = [
    JSON.stringify({
      sessionId: 'sess_beta_02',
      summary: 'Session Beta: SIMD Search & Bundle Optimization',
      cwd: workspaceDir,
      timestamp: '2026-11-10T11:40:00.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: sharedSourceFile }
          },
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: bundleOutputFile }
          }
        ]
      }
    })
  ];
  fs.writeFileSync(sessionBetaJsonl, sessionBetaLines.join('\n') + '\n', 'utf8');

  // Low-risk regenerable caches, logs, and temp files for Claude
  const claudeCacheBlob = path.join(claudeDesktopCacheDir, 'gpu-shader-cache-v2.bin');
  const claudeStatsigFile = path.join(claudeStatsigCacheDir, 'statsig.cached.evaluations.json');
  const claudeDebugLogFile = path.join(claudeDebugLogDir, 'mcp-transport-sess_alpha_01.log');
  const claudeShellTmpFile = path.join(claudeShellSnapDir, 'zsh-snapshot-sess_beta_02.tmp');

  fs.writeFileSync(claudeCacheBlob, 'CACHE_BLOB_' + 'C'.repeat(68 * 1024), 'utf8');
  fs.writeFileSync(claudeStatsigFile, JSON.stringify({ gates: {} }) + ' '.repeat(14 * 1024), 'utf8');
  fs.writeFileSync(claudeDebugLogFile, '[INFO] MCP transport initialized\n'.repeat(450), 'utf8');
  fs.writeFileSync(claudeShellTmpFile, 'export PATH="/usr/local/bin:$PATH"\n'.repeat(220), 'utf8');

  // Create a physical hardlink of the cache blob to verify hardlink deduplication
  const claudeCacheHardlink = path.join(claudeDesktopCacheDir, 'gpu-shader-cache-v2-hardlink.bin');
  try {
    if (!fs.existsSync(claudeCacheHardlink)) {
      fs.linkSync(claudeCacheBlob, claudeCacheHardlink);
    }
  } catch {
    // Ignore if filesystem does not support hardlinks
  }

  // 4. Create Cursor IDE data directories & workspaceStorage composer ledger
  const cursorSupportDir = path.join(homeDir, 'Library', 'Application Support', 'Cursor');
  const cursorWsBucket = path.join(cursorSupportDir, 'User', 'workspaceStorage', 'ws_hash_98f1a');
  const cursorCachedDataDir = path.join(cursorSupportDir, 'CachedData', 'v0.48.2-bytecode');
  const cursorLogsDir = path.join(homeDir, 'Library', 'Logs', 'Cursor');

  fs.mkdirSync(cursorWsBucket, { recursive: true });
  fs.mkdirSync(cursorCachedDataDir, { recursive: true });
  fs.mkdirSync(cursorLogsDir, { recursive: true });

  fs.writeFileSync(
    path.join(cursorWsBucket, 'workspace.json'),
    JSON.stringify({ folder: `file://${workspaceDir}` }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(cursorWsBucket, 'composerData.json'),
    JSON.stringify(
      {
        allComposers: [
          {
            composerId: 'cursor_comp_771',
            name: 'Composer: Refactor VectorIndex & Router',
            createdAt: '2026-11-10T12:10:00.000Z',
            updatedAt: '2026-11-10T12:35:00.000Z',
            operations: [
              {
                tool: 'CursorComposerApply',
                action: 'edit',
                filePath: sharedSourceFile,
                timestamp: '2026-11-10T12:20:00.000Z'
              },
              {
                tool: 'CursorComposerApply',
                action: 'edit',
                filePath: queryRouterFile,
                timestamp: '2026-11-10T12:30:00.000Z'
              }
            ]
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    path.join(cursorCachedDataDir, 'v8-compile-cache.bin'),
    'V8_CACHE_' + 'V'.repeat(54 * 1024),
    'utf8'
  );
  fs.writeFileSync(
    path.join(cursorLogsDir, 'renderer-process.log'),
    '[Cursor Renderer] Extension host ready\n'.repeat(300),
    'utf8'
  );

  // 5. Create Codex CLI data directories & rollout JSONL
  const codexSessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '11', '10');
  const codexCacheDir = path.join(homeDir, '.codex', 'cache');
  const codexTmpDir = path.join(homeDir, '.codex', 'tmp');
  fs.mkdirSync(codexSessionsDir, { recursive: true });
  fs.mkdirSync(codexCacheDir, { recursive: true });
  fs.mkdirSync(codexTmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(codexSessionsDir, 'rollout-20261110-codex_901.jsonl'),
    [
      JSON.stringify({
        session_id: 'codex_901',
        title: 'Codex CLI: Tokenizer Whitespace Patch',
        cwd: workspaceDir,
        timestamp: '2026-11-10T14:00:00.000Z',
        type: 'function_call',
        name: 'apply_patch',
        action: 'edit',
        target_file: tokenizerFile
      })
    ].join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(codexCacheDir, 'ast-symbol-index.cache'),
    'CODEX_AST_CACHE_' + 'A'.repeat(32 * 1024),
    'utf8'
  );
  fs.writeFileSync(
    path.join(codexTmpDir, 'patch-staging-codex_901.tmp'),
    'DIFF_STAGING_' + 'D'.repeat(10 * 1024),
    'utf8'
  );

  // 6. Create Generic macOS App caches for NebulaSketch.app
  const genericCacheDir = path.join(homeDir, 'Library', 'Caches', 'com.example.nebulasketch');
  const genericSavedStateDir = path.join(
    homeDir,
    'Library',
    'Saved Application State',
    'com.example.nebulasketch.savedState'
  );
  fs.mkdirSync(genericCacheDir, { recursive: true });
  fs.mkdirSync(genericSavedStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(genericCacheDir, 'thumbnail-atlas.cache'),
    'THUMBNAIL_CACHE_' + 'T'.repeat(28 * 1024),
    'utf8'
  );
  fs.writeFileSync(
    path.join(genericSavedStateDir, 'windows.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
    'utf8'
  );

  return {
    baseDir,
    homeDir,
    appsDir,
    workspaceDir,
    appBundles,
    sampleFiles: {
      sharedSourceFile,
      queryRouterFile,
      tokenizerFile,
      bundleOutputFile,
      bundleMapFile,
      checkpointFile,
      modelWeightsFile,
      ambiguousWorkspaceTmp,
      mysteryUnknownFile,
      claudeCacheBlob,
      claudeCacheHardlink,
      claudeStatsigFile,
      claudeDebugLogFile,
      claudeShellTmpFile
    }
  };
}

function createMockAppBundle(
  appsDir,
  { bundleFolder, displayName, bundleId, executable, version, copyright, category }
) {
  const bundlePath = path.join(appsDir, bundleFolder);
  const contentsDir = path.join(bundlePath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const codeSigDir = path.join(contentsDir, '_CodeSignature');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(codeSigDir, { recursive: true });

  const infoPlistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${displayName}</string>
  <key>CFBundleName</key>
  <string>${displayName}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}.100</string>
  <key>NSHumanReadableCopyright</key>
  <string>${copyright}</string>
  <key>LSApplicationCategoryType</key>
  <string>${category}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
</dict>
</plist>
`;

  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlistXml, 'utf8');
  fs.writeFileSync(
    path.join(macosDir, executable),
    '#!/bin/sh\n# Stub binary - Artifact Atlas NEVER executes .app binaries\nexit 1\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(codeSigDir, 'CodeResources'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
    'utf8'
  );

  return {
    name: displayName,
    bundleId,
    bundlePath,
    version
  };
}
