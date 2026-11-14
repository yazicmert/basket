import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactType } from '../models/entities.js';

/**
 * A text the user can copy and share to help support more applications, made only when they
 * ask. Nothing is sent anywhere. It holds:
 *   - where the largest unclassified files are (folders relative to the home folder, sizes)
 *   - the shape of Cursor's and Codex's records: field names and value types only. Field
 *     names that are IDs or paths become placeholders; no value, prompt or reply is included
 *     (AGENTS.md rule 6). Cursor's database is opened read-only.
 */

const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const ID_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{6,})$/i;

/** A field name as shown: IDs, paths and long or odd names become placeholders. */
export function normalizeKey(key) {
  const k = String(key);
  if (ID_KEY.test(k)) return '<id>';
  if (/[\\/]/.test(k) || /^[A-Za-z]:/.test(k) || k.startsWith('file:')) return '<path>';
  // "composerData:3f2a…" keeps its prefix and hides the id
  const named = k.replace(/([:._-])(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|\d{6,})/gi, '$1<id>');
  if (named.length > 48 || /\s/.test(named)) return '<text>';
  return named;
}

/** The shape of a JSON value: field names and value types, never the values. */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= MAX_DEPTH) return '[…]';
    return [mergeShapes(value.slice(0, 5).map((v) => shapeOf(v, depth + 1)))];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '{…}';
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      const name = normalizeKey(key);
      out[name] = out[name] ? mergeShapes([out[name], shapeOf(value[key], depth + 1)]) : shapeOf(value[key], depth + 1);
    }
    if (Object.keys(value).length > MAX_KEYS) out['…'] = `${Object.keys(value).length - MAX_KEYS} more`;
    return out;
  }
  return typeof value;
}

export function mergeShapes(shapes) {
  const objects = shapes.filter((s) => s && typeof s === 'object' && !Array.isArray(s));
  const others = new Set(shapes.filter((s) => !(s && typeof s === 'object' && !Array.isArray(s))).map((s) => JSON.stringify(s)));
  if (objects.length > 0) {
    const merged = {};
    for (const o of objects) {
      for (const [k, v] of Object.entries(o)) merged[k] = k in merged ? mergeShapes([merged[k], v]) : v;
    }
    if (others.size === 0) return merged;
    return { '<one of>': [...[...others].map((s) => JSON.parse(s)), merged] };
  }
  const list = [...others].map((s) => JSON.parse(s));
  return list.length === 1 ? list[0] : list.join(' | ');
}

function newestFiles(dir, test, { depth = 5, limit = 3 } = {}) {
  const found = [];
  const walk = (d, left) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && test(e.name)) {
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (st) found.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, depth);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((f) => f.path);
}

/** Codex: JSONL records, grouped by their record type. */
export function codexRecordShapes(homeDir) {
  const files = newestFiles(path.join(homeDir, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'));
  if (files.length === 0) return null;
  const byType = new Map();
  for (const file of files) {
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 300);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const t = record && typeof record.type === 'string' && /^[a-z_]{1,40}$/i.test(record.type) ? record.type : '<untyped>';
      const shape = shapeOf(record);
      byType.set(t, byType.has(t) ? mergeShapes([byType.get(t), shape]) : shape);
    }
  }
  return { files: files.length, recordTypes: Object.fromEntries(byType) };
}

/** Cursor: its state databases, opened read-only. Key patterns and the shape of JSON values. */
export function cursorRecordShapes(homeDir, { platform = process.platform } = {}) {
  const base = platform === 'win32' ? path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User') : path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User');
  const dbs = [path.join(base, 'globalStorage', 'state.vscdb'), ...newestFiles(path.join(base, 'workspaceStorage'), (n) => n === 'state.vscdb', { depth: 1, limit: 1 })];
  const out = {};
  for (const dbPath of dbs) {
    const st = fs.lstatSync(dbPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      const tableShapes = {};
      for (const table of tables) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes('key') || !cols.includes('value')) {
          tableShapes[table] = { columns: cols };
          continue;
        }
        const patterns = new Map();
        for (const row of db.prepare(`SELECT key, value FROM ${table} LIMIT 20000`).iterate()) {
          const pattern = normalizeKey(row.key);
          const entry = patterns.get(pattern) || { count: 0, shape: null, samples: 0 };
          entry.count += 1;
          if (entry.samples < 3) {
            const text = typeof row.value === 'string' ? row.value : Buffer.isBuffer(row.value) || row.value instanceof Uint8Array ? Buffer.from(row.value).toString('utf8') : null;
            if (text && /^[[{]/.test(text.trim())) {
              try {
                const shape = shapeOf(JSON.parse(text));
                entry.shape = entry.shape ? mergeShapes([entry.shape, shape]) : shape;
                entry.samples += 1;
              } catch {
                // Not JSON: only counted
              }
            }
          }
          patterns.set(pattern, entry);
        }
        tableShapes[table] = Object.fromEntries(
          [...patterns].sort((a, b) => b[1].count - a[1].count).slice(0, 60).map(([k, v]) => [k, { count: v.count, ...(v.shape ? { shape: v.shape } : {}) }])
        );
      }
      out[path.relative(base, dbPath).split(path.sep).join('/').replace(/^workspaceStorage\/[^/]+/, 'workspaceStorage/<id>')] = tableShapes;
    } catch (err) {
      out[path.basename(dbPath)] = { error: 'could not be opened read-only' };
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Where the largest unclassified files are, by folder relative to the home folder. */
export function unclassifiedFolders(state, homeDir, { limit = 20 } = {}) {
  const groups = new Map();
  const exts = new Map();
  for (const a of state?.artifacts || []) {
    if (a.quarantined || a.artifactType !== ArtifactType.UNKNOWN) continue;
    const rel = path.relative(homeDir, path.dirname(a.canonicalPath));
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const parts = inside ? rel.split(path.sep) : [path.dirname(a.canonicalPath)];
    const key = inside ? `~/${parts.slice(0, 5).join('/')}` : parts[0];
    const g = groups.get(key) || { files: 0, bytes: 0 };
    g.files += 1;
    g.bytes += a.sizeBytes || 0;
    groups.set(key, g);
    const ext = (a.extension || '').toLowerCase() || '(none)';
    const e = exts.get(ext) || { files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += a.sizeBytes || 0;
    exts.set(ext, e);
  }
  const top = (m) => [...m].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, limit).map(([k, v]) => ({ name: k, ...v }));
  return { folders: top(groups), extensions: top(exts) };
}

export function buildDiagnostics({ state, homeDir, platform, appVersion }) {
  const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const unclassified = unclassifiedFolders(state, homeDir);
  const codex = codexRecordShapes(homeDir);
  const cursor = cursorRecordShapes(homeDir, { platform });
  const lines = [
    `Artifact Atlas ${appVersion || ''} diagnostics (${platform})`,
    `Scanned: ${state?.application?.name || 'nothing yet'}`,
    '',
    'Largest unclassified folders:',
    ...(unclassified.folders.length ? unclassified.folders.map((f) => `  ${fmt(f.bytes).padStart(10)}  ${String(f.files).padStart(7)} files  ${f.name}`) : ['  (none in this scan)']),
    '',
    'Largest unclassified file types:',
    ...(unclassified.extensions.length ? unclassified.extensions.map((e) => `  ${fmt(e.bytes).padStart(10)}  ${String(e.files).padStart(7)} files  ${e.name}`) : ['  (none)']),
    '',
    'Codex record shapes (field names and types only):',
    codex ? JSON.stringify(codex, null, 1) : '  (no Codex records found)',
    '',
    'Cursor record shapes (field names and types only):',
    cursor ? JSON.stringify(cursor, null, 1) : '  (no Cursor database found)'
  ];
  return lines.join('\n');
}
