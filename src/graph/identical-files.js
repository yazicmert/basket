import fs from 'node:fs';
import crypto from 'node:crypto';
import { RiskCategory } from '../models/entities.js';

/**
 * Files with identical content, found only when the user asks. Candidates are listed files
 * of the same size on different inodes (hardlinks are one file already). A short hash of the
 * first bytes rules most of them out; the rest are read in full, in pieces, yielding between
 * them so the app stays responsive, and the search can be cancelled.
 *
 * Identical content is reported as such, not as space to reclaim: which copy is needed is the
 * user's call. "Select all but one" keeps a protected copy or a copy in a project folder when
 * there is one, else the oldest, and says which. Protected copies are never selected.
 */

export const MIN_COPY_BYTES = 64 * 1024;
const PREFIX_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_GROUPS = 200;

const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

function readRegular(filePath) {
  const st = fs.lstatSync(filePath, { throwIfNoEntry: false });
  return st && st.isFile() ? st : null;
}

async function hashFile(filePath, { limit = Infinity, signal } = {}) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let read = 0;
    for (;;) {
      if (signal?.aborted) throw new Error('CANCELLED');
      const want = Math.min(CHUNK_BYTES, limit - read);
      if (want <= 0) break;
      const n = fs.readSync(fd, buffer, 0, want, read);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      read += n;
      if (read % (8 * CHUNK_BYTES) === 0) await yieldNow();
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** The copy "select all but one" keeps: protected, else in a project folder, else the oldest. */
export function keeperOf(files) {
  const rank = (f) => (f.cleanupClassification === RiskCategory.PROTECTED ? 0 : f.workspaceId ? 1 : 2);
  return [...files].sort((a, b) => rank(a) - rank(b) || String(a.createdAt || a.modifiedAt || '').localeCompare(String(b.createdAt || b.modifiedAt || '')) || a.canonicalPath.localeCompare(b.canonicalPath))[0];
}

export async function findIdenticalFiles(state, { signal, onProgress = () => {}, minBytes = MIN_COPY_BYTES } = {}) {
  const live = (state.artifacts || []).filter((a) => !a.quarantined && (a.sizeBytes || 0) >= minBytes);
  const bySize = new Map();
  for (const a of live) {
    if (!bySize.has(a.sizeBytes)) bySize.set(a.sizeBytes, []);
    bySize.get(a.sizeBytes).push(a);
  }
  // Same size, and more than one physical file
  const candidates = [];
  for (const group of bySize.values()) {
    const byInode = new Map();
    for (const a of group) {
      const key = a.physicalInodeKey || a.canonicalPath;
      if (!byInode.has(key)) byInode.set(key, a);
    }
    if (byInode.size > 1) candidates.push(Array.from(byInode.values()));
  }
  const totalBytes = candidates.reduce((s, g) => s + g.length * g[0].sizeBytes, 0);
  let doneBytes = 0;
  let sinceYield = 0;
  // Many small files never reach the pause inside hashFile, so pause by files read as well
  const pace = async () => {
    if (++sinceYield >= 25) {
      sinceYield = 0;
      onProgress({ doneBytes, totalBytes });
      await yieldNow();
    }
  };
  const groups = [];
  for (const group of candidates) {
    if (signal?.aborted) throw new Error('CANCELLED');
    const byPrefix = new Map();
    for (const a of group) {
      if (!readRegular(a.canonicalPath)) continue;
      let key;
      try {
        key = await hashFile(a.canonicalPath, { limit: PREFIX_BYTES, signal });
      } catch (err) {
        if (err.message === 'CANCELLED') throw err;
        continue; // Unreadable: left out
      }
      if (!byPrefix.has(key)) byPrefix.set(key, []);
      byPrefix.get(key).push(a);
      await pace();
    }
    for (const same of byPrefix.values()) {
      if (same.length < 2) continue;
      const byFull = new Map();
      for (const a of same) {
        let key;
        try {
          key = a.sizeBytes <= PREFIX_BYTES ? null : await hashFile(a.canonicalPath, { signal });
        } catch (err) {
          if (err.message === 'CANCELLED') throw err;
          continue;
        }
        key ||= 'prefix-is-whole';
        if (!byFull.has(key)) byFull.set(key, []);
        byFull.get(key).push(a);
        await pace();
      }
      for (const copies of byFull.values()) {
        if (copies.length < 2) continue;
        const keeper = keeperOf(copies);
        groups.push({
          id: `copies:${copies[0].sizeBytes}:${copies.map((c) => c.id).sort()[0]}`,
          sizeBytes: copies[0].sizeBytes,
          name: copies[0].name,
          keeperId: keeper.id,
          files: copies.map((c) => ({ id: c.id, path: c.canonicalPath, risk: c.cleanupClassification, inProject: Boolean(c.workspaceId) }))
        });
      }
    }
    doneBytes += group.length * group[0].sizeBytes;
    onProgress({ doneBytes, totalBytes });
    await yieldNow();
  }
  groups.sort((a, b) => b.sizeBytes * (b.files.length - 1) - a.sizeBytes * (a.files.length - 1));
  return {
    groupCount: groups.length,
    fileCount: groups.reduce((s, g) => s + g.files.length, 0),
    // Bytes held by copies beyond one of each; whether they are needed is the user's call
    duplicateBytes: groups.reduce((s, g) => s + g.sizeBytes * (g.files.length - 1), 0),
    groups: groups.slice(0, MAX_GROUPS),
    minBytes
  };
}

/** Ids "select all but one" picks in a group: never the keeper, never a protected copy. */
export function copiesToSelect(group, state) {
  const live = new Map((state.artifacts || []).filter((a) => !a.quarantined).map((a) => [a.id, a]));
  return group.files
    .filter((f) => f.id !== group.keeperId && live.has(f.id) && live.get(f.id).cleanupClassification !== RiskCategory.PROTECTED)
    .map((f) => f.id);
}
