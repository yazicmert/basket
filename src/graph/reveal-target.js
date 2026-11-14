import path from 'node:path';

/**
 * What "Show in Finder / File Explorer" opens for a selection.
 *
 * One file is selected in its folder. Many files are split into the folders they sit in
 * ("regions"): a region is the deepest folder its files share, never the home folder, a
 * folder above it or a drive root. One region is opened directly. Several are offered as a
 * short list with sizes, largest first, so the user is never shown one arbitrary file of
 * thousands and always sees where the rest are.
 *
 * `files` is [{ path, bytes }]. `pathApi` is path.posix or path.win32 for the layout of the
 * home folder being read.
 */
export const MAX_REGIONS = 8;

export function chooseRevealTarget(files, { homeDir = '', pathApi = path } = {}) {
  const list = (files || []).filter((f) => f && f.path);
  if (list.length === 0) return null;
  const totalBytes = list.reduce((sum, f) => sum + (f.bytes || 0), 0);
  if (list.length === 1) {
    const only = { path: list[0].path, fileCount: 1, bytes: totalBytes };
    return { kind: 'file', ...only, totalCount: 1, totalBytes, regions: [only], regionCount: 1 };
  }
  const sep = pathApi.sep;
  const fold = pathApi === path.win32 ? (p) => p.toLowerCase() : (p) => p;
  const members = list.map((f) => ({ bytes: f.bytes || 0, parts: f.path.split(sep) }));
  const tooBroad = (d, sample) => d <= 1 || (Boolean(homeDir) && isAboveOrHome(sample, d, homeDir, pathApi));

  // Regions, found without recursion so deep trees cannot overflow the stack
  const regions = [];
  const work = [{ members, depth: 0 }];
  while (work.length > 0) {
    let { members: group, depth } = work.pop();
    // Go down while every file shares the next folder (the last part is the file name)
    for (;;) {
      if (!group.every((m) => m.parts.length - 1 > depth)) break;
      const next = fold(group[0].parts[depth]);
      if (!group.every((m) => fold(m.parts[depth]) === next)) break;
      depth += 1;
    }
    if (!tooBroad(depth, group[0].parts)) {
      regions.push(regionOf(group, depth, sep));
      continue;
    }
    // Too broad: split by the next folder; files lying directly in it form their own region
    const children = new Map();
    const direct = [];
    for (const m of group) {
      if (m.parts.length - 1 <= depth) {
        direct.push(m);
        continue;
      }
      const key = fold(m.parts[depth]);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(m);
    }
    if (direct.length > 0) regions.push(regionOf(direct, depth, sep));
    for (const child of children.values()) work.push({ members: child, depth: depth + 1 });
  }
  regions.sort((a, b) => b.bytes - a.bytes || b.fileCount - a.fileCount);
  const shown = regions.slice(0, MAX_REGIONS);
  return {
    kind: regions.length === 1 ? 'folder' : 'folders',
    path: shown[0].path,
    fileCount: shown[0].fileCount,
    bytes: shown[0].bytes,
    totalCount: list.length,
    totalBytes,
    regions: shown,
    regionCount: regions.length
  };
}

function regionOf(group, depth, sep) {
  const folder = group[0].parts.slice(0, depth).join(sep) || sep;
  return {
    path: /^[A-Za-z]:$/.test(folder) ? `${folder}\\` : folder,
    fileCount: group.length,
    bytes: group.reduce((s, m) => s + m.bytes, 0)
  };
}

function isAboveOrHome(sampleParts, depth, homeDir, pathApi) {
  const folder = sampleParts.slice(0, depth).join(pathApi.sep) || pathApi.sep;
  const rel = pathApi.relative(folder, pathApi.resolve(homeDir));
  return rel === '' || (!rel.startsWith('..') && !pathApi.isAbsolute(rel));
}
