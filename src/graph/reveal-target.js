import path from 'node:path';

/**
 * What "Show in Finder / File Explorer" opens for a selection. One file is selected in its
 * folder. For many files, the folder they all share is opened, unless that folder is the
 * home folder, a folder above it or a drive root: then the folder below it that holds the
 * largest part of the selection is opened, and the result says how much of the selection
 * it holds, so the user is never shown one arbitrary file of thousands.
 *
 * `files` is [{ path, bytes }]. Paths are compared as given; `pathApi` is path.posix or
 * path.win32 for the layout of the home folder being read.
 */
export function chooseRevealTarget(files, { homeDir = '', pathApi = path } = {}) {
  const list = (files || []).filter((f) => f && f.path);
  if (list.length === 0) return null;
  const totalBytes = list.reduce((sum, f) => sum + (f.bytes || 0), 0);
  if (list.length === 1) {
    return { kind: 'file', path: list[0].path, fileCount: 1, bytes: totalBytes, totalCount: 1, totalBytes, folderCount: 1 };
  }
  const sep = pathApi.sep;
  const fold = (p) => (pathApi === path.win32 ? p.toLowerCase() : p);
  const parts = list.map((f) => f.path.split(sep));
  // Folders shared by every file (the last part of each path is the file name)
  let depth = 0;
  let shortest = Infinity;
  for (const p of parts) shortest = Math.min(shortest, p.length - 1); // no spread: 300,000 paths
  while (depth < shortest && parts.every((p) => fold(p[depth]) === fold(parts[0][depth]))) depth += 1;

  // Judged on the files still in play, which all share their first `d` folders
  const tooBroad = (d, sample) => d <= 1 || (Boolean(homeDir) && isAboveOrHome(sample, d, homeDir, pathApi));

  // While the folder is too broad, go into the part of it that holds the most bytes
  let members = list.map((f, i) => ({ ...f, parts: parts[i] }));
  while (true) {
    const groups = new Map();
    for (const m of members) {
      if (m.parts.length - 1 <= depth) continue; // a file directly in this folder
      const key = fold(m.parts[depth]);
      const g = groups.get(key) || { files: [], bytes: 0 };
      g.files.push(m);
      g.bytes += m.bytes || 0;
      groups.set(key, g);
    }
    const largest = [...groups.values()].sort((a, b) => b.bytes - a.bytes || b.files.length - a.files.length)[0];
    if (!largest) break;
    // Past the broad folders, stop where the remaining files part ways
    if (!tooBroad(depth, members[0].parts) && largest.files.length < members.length) break;
    members = largest.files;
    depth += 1;
  }
  const folderParts = members[0].parts.slice(0, depth);
  const folder = folderParts.join(sep) || sep;
  const folderBytes = members.reduce((s, m) => s + (m.bytes || 0), 0);
  const folderCount = new Set(list.map((f) => fold(pathApi.dirname(f.path)))).size;
  return {
    kind: 'folder',
    path: /^[A-Za-z]:$/.test(folder) ? `${folder}\\` : folder,
    fileCount: members.length,
    bytes: folderBytes,
    totalCount: list.length,
    totalBytes,
    folderCount
  };
}

function isAboveOrHome(sampleParts, depth, homeDir, pathApi) {
  const folder = sampleParts.slice(0, depth).join(pathApi.sep) || pathApi.sep;
  const rel = pathApi.relative(folder, pathApi.resolve(homeDir));
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}
