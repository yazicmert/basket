import path from 'node:path';
import { toPathKey, fromPathKey } from '../platform/path-keys.js';
import {
  NodeType,
  EdgeType,
  ProvenanceConfidence,
  RiskCategory
} from '../models/entities.js';
import { summarizeRisk } from './graph-engine.js';

/**
 * The map is explored one level at a time. Each level is a small graph: the item being looked
 * at in the middle, and what it contains around it. A scan of any size stays readable and
 * fast because no level holds more than a few dozen marks.
 *
 *   root                      the application, its kinds of files, and its sessions
 *   root:<grouping>           the same files grouped another way: risk, origin, age, type
 *   sessions                  every session
 *   group:<id>                one kind of file (caches, logs, ...), by folder
 *   session:<id>              the files one session wrote or is linked to, by folder
 *   dir:<scope>::<path>       one folder inside a kind, a session, or the whole scan (scope "all")
 *   type:<scope>::<path>::<t> the files of one type directly inside a folder that holds many
 *
 * Levels only describe the scan. Cleanup still moves files one by one.
 */

export const LEVEL_MAX_FOLDERS = 24;
export const LEVEL_MAX_FILES = 36;
export const LEVEL_MAX_SESSIONS = 40;
/** A folder with more direct files than this shows its largest few and bundles the rest by type. */
export const LEVEL_FILES_BEFORE_BUNDLING = 12;
export const LEVEL_MAX_TYPE_BUNDLES = 14;

/**
 * Other ways to split the whole scan at the top level. Each one is a list of buckets; a
 * bucket is a scope (like a kind or a session) that then opens by folder.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const GROUPINGS = {
  risk: {
    title: 'By cleanup risk',
    buckets: () => [
      { key: 'LOW', label: 'Safe to remove' },
      { key: 'REVIEW', label: 'Review first' },
      { key: 'HIGH', label: 'High risk' },
      { key: 'PROTECTED', label: 'Protected' }
    ],
    keyOf: (art) => art.cleanupClassification
  },
  origin: {
    title: 'By origin',
    buckets: () => [
      { key: 'VERIFIED', label: 'Recorded by a session' },
      { key: 'INFERRED', label: 'Likely from this app' },
      { key: 'UNKNOWN', label: 'Unknown origin' }
    ],
    keyOf: (art) => art.provenanceConfidence
  },
  age: {
    title: 'By last change',
    buckets: () => [
      { key: 'week', label: 'Last 7 days' },
      { key: 'month', label: '8 to 30 days ago' },
      { key: 'halfyear', label: '1 to 6 months ago' },
      { key: 'older', label: 'More than 6 months ago' },
      { key: 'unknown', label: 'Date unknown' }
    ],
    keyOf: (art, now) => {
      const at = Date.parse(art.modifiedAt || '');
      if (!Number.isFinite(at)) return 'unknown';
      const days = (now - at) / DAY_MS;
      return days <= 7 ? 'week' : days <= 30 ? 'month' : days <= 183 ? 'halfyear' : 'older';
    }
  },
  type: {
    title: 'By file type',
    buckets: (files) => {
      const counts = new Map();
      for (const f of files) counts.set(fileTypeOf(f), (counts.get(fileTypeOf(f)) || 0) + (f.sizeBytes || 0));
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 22)
        .map(([key]) => ({ key, label: key === 'no extension' ? 'No extension' : `${key} files` }));
    },
    keyOf: (art) => fileTypeOf(art)
  }
};

/** What a file "is" for bundling: its extension, or a short word for files without one. */
export function fileTypeOf(art) {
  const name = String(art.name || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 12) return 'no extension';
  return name.slice(dot).toLowerCase();
}
const RING = 250;

const dirOf = (a) => {
  if (a.parentDir) return toPathKey(a.parentDir);
  const key = toPathKey(a.canonicalPath);
  const cut = key.lastIndexOf('/');
  return cut <= 0 ? '/' : key.slice(0, cut);
};
const parentOf = (dir) => {
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? '/' : dir.slice(0, cut);
};
const isWithin = (dir, prefix) => dir === prefix || dir.startsWith(prefix === '/' ? '/' : prefix + '/');

function radiusForBytes(bytes, min = 15, max = 34) {
  return Math.max(min, Math.min(max, 6 + Math.log10(Math.max(bytes, 1000)) * 3));
}

/** File count, physical bytes (hardlinked data once) and risk counts for a set of files. */
function summarize(files) {
  const seen = new Set();
  const riskCounts = {};
  let bytes = 0;
  for (const f of files) {
    const key = f.physicalInodeKey || f.canonicalPath;
    if (!seen.has(key)) {
      seen.add(key);
      bytes += f.sizeBytes || 0;
    }
    riskCounts[f.cleanupClassification] = (riskCounts[f.cleanupClassification] || 0) + 1;
  }
  return { artifactCount: files.length, bytes, riskCounts, riskCategory: summarizeRisk(riskCounts) };
}

function commonDir(files) {
  if (files.length === 0) return '/';
  let common = dirOf(files[0]).split('/');
  for (const f of files) {
    const parts = dirOf(f).split('/');
    let k = 0;
    while (k < common.length && k < parts.length && common[k] === parts[k]) k += 1;
    if (k < common.length) common = common.slice(0, k);
  }
  return common.join('/') || '/';
}

/** Direct files and immediate subfolders of `prefix` among `files`. */
function childrenOf(files, prefix) {
  const folders = new Map();
  const direct = [];
  const base = prefix === '/' ? '/' : prefix + '/';
  for (const f of files) {
    const dir = dirOf(f);
    if (dir === prefix) {
      direct.push(f);
    } else if (dir.startsWith(base)) {
      const name = dir.slice(base.length).split('/')[0];
      let entry = folders.get(name);
      if (!entry) {
        entry = { name, path: base + name, files: [] };
        folders.set(name, entry);
      }
      entry.files.push(f);
    }
  }
  return { folders: Array.from(folders.values()), direct };
}

/** Skips folders that hold a single subfolder and nothing else, so no click is wasted. */
function compress(files, prefix) {
  let current = prefix;
  for (let i = 0; i < 64; i++) {
    const { folders, direct } = childrenOf(files, current);
    if (folders.length === 1 && direct.length === 0) {
      current = folders[0].path;
    } else {
      return { prefix: current, folders, direct };
    }
  }
  return { prefix: current, ...childrenOf(files, current) };
}

function ring(nodes) {
  nodes.forEach((n, i) => {
    const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const r = RING + (nodes.length > 18 ? (i % 2) * 70 : 0);
    n.x = Math.cos(angle) * r;
    n.y = Math.sin(angle) * r;
  });
  return nodes;
}

function containsEdge(childId, parentId, confidence = ProvenanceConfidence.VERIFIED) {
  return {
    id: `lvl:${childId}->${parentId}`,
    sourceId: childId,
    targetId: parentId,
    edgeType: EdgeType.CONTAINS,
    confidence
  };
}

function fileNode(art) {
  return {
    id: art.id,
    nodeType: NodeType.ARTIFACT,
    label: art.name,
    subtitle: art.artifactType,
    sizeBytes: art.sizeBytes,
    confidence: art.provenanceConfidence,
    riskCategory: art.cleanupClassification,
    artifactType: art.artifactType,
    radius: Math.max(9, Math.min(18, 6 + Math.log10(Math.max(art.sizeBytes, 100)) * 1.6)),
    metadata: art
  };
}

function summaryNode({ id, nodeType, label, summary, drillId = null, artifactType = null, extra = {} }) {
  return {
    id,
    nodeType,
    label,
    subtitle: `${summary.artifactCount.toLocaleString('en-US')} files`,
    sizeBytes: summary.bytes,
    confidence: ProvenanceConfidence.VERIFIED,
    riskCategory: summary.riskCategory,
    artifactType,
    radius: radiusForBytes(summary.bytes),
    drillId,
    // Folder keys are '/'-separated; the details panel shows the real path
    metadata: { summary, ...extra, ...(extra.path ? { path: fromPathKey(extra.path) } : {}) }
  };
}

/** Builds the lookups a level needs from the active scan state. */
function indexState(state) {
  const live = (state.artifacts || []).filter((a) => !a.quarantined);
  const byId = new Map(live.map((a) => [a.id, a]));
  const sessions = state.sessions || [];
  const sessionIds = new Set(sessions.map((s) => s.id));

  // Session -> files, with how each link is known
  const sessionLinks = new Map(sessions.map((s) => [s.id, new Map()]));
  for (const art of live) {
    for (const sid of art.sessionIds || []) {
      sessionLinks.get(sid)?.set(art.id, ProvenanceConfidence.VERIFIED);
    }
  }
  for (const edge of state.provenanceEdges || []) {
    if (sessionIds.has(edge.targetId) && byId.has(edge.sourceId)) {
      const links = sessionLinks.get(edge.targetId);
      if (!links.has(edge.sourceId)) links.set(edge.sourceId, edge.confidence);
    }
  }
  const now = Date.parse(state.scan?.completedAt || '') || Date.now();
  return { live, byId, sessions, sessionLinks, now };
}

function scopeFiles(ix, state, scope) {
  if (scope === 'all') return { files: ix.live, links: null };
  if (scope.startsWith('group:')) {
    const group = (state.artifactGroups || []).find((g) => g.id === scope.slice(6));
    if (!group) return null;
    return { files: group.artifactIds.map((id) => ix.byId.get(id)).filter(Boolean), links: null, group };
  }
  if (scope.startsWith('bucket:')) {
    const [, grouping, ...rest] = scope.split(':');
    const key = rest.join(':');
    const def = GROUPINGS[grouping];
    if (!def) return null;
    const bucket = def.buckets(ix.live).find((b) => b.key === key);
    if (!bucket) return null;
    return { files: ix.live.filter((a) => def.keyOf(a, ix.now) === key), links: null, bucket: { grouping, ...bucket } };
  }
  if (scope.startsWith('session:')) {
    const session = ix.sessions.find((s) => s.id === scope.slice(8));
    if (!session) return null;
    const links = ix.sessionLinks.get(session.id);
    return { files: [...links.keys()].map((id) => ix.byId.get(id)).filter(Boolean), links, session };
  }
  return null;
}

function scopeTitle(state, scope, scoped) {
  if (scope === 'all') return 'All files';
  if (scoped.group) return scoped.group.name;
  if (scoped.session) return scoped.session.title || 'Session';
  if (scoped.bucket) return scoped.bucket.label;
  return scope;
}

/** Parses a level id. Returns null for anything that is not a level. */
export function parseLevelId(levelId) {
  const id = String(levelId || 'root');
  if (id === 'root' || id === 'sessions' || id === 'measured') return { kind: id };
  if (id.startsWith('measured:')) return { kind: 'measured', project: id.slice(9) };
  if (id.startsWith('root:')) return GROUPINGS[id.slice(5)] ? { kind: 'grouping', grouping: id.slice(5) } : null;
  if (id.startsWith('bucket:')) return { kind: 'scope', scope: id };
  if (id.startsWith('group:')) return { kind: 'scope', scope: id };
  if (id.startsWith('session:')) return { kind: 'scope', scope: id };
  if (id.startsWith('type:')) {
    const first = id.indexOf('::');
    const last = id.lastIndexOf('::');
    if (first < 0 || last <= first) return null;
    const dir = id.slice(first + 2, last);
    if (!dir.startsWith('/')) return null;
    return { kind: 'type', scope: id.slice(5, first), dir, type: id.slice(last + 2) };
  }
  if (id.startsWith('dir:')) {
    const sep = id.indexOf('::');
    if (sep < 0) return null;
    const scope = id.slice(4, sep);
    const dir = id.slice(sep + 2);
    if (!dir.startsWith('/')) return null;
    return { kind: 'dir', scope, dir };
  }
  return null;
}

/** File ids a level stands for (used by "Select files here"). */
export function levelArtifactIds(state, levelId) {
  const parsed = parseLevelId(levelId);
  if (!parsed) return null;
  const ix = indexState(state);
  if (parsed.kind === 'root' || parsed.kind === 'grouping') return ix.live.map((a) => a.id);
  // Measured folders are never files that can be selected
  if (parsed.kind === 'measured') return [];
  if (parsed.kind === 'sessions') {
    const ids = new Set();
    for (const links of ix.sessionLinks.values()) for (const id of links.keys()) ids.add(id);
    return [...ids];
  }
  const scoped = scopeFiles(ix, state, parsed.scope);
  if (!scoped) return null;
  if (parsed.kind === 'scope') return scoped.files.map((a) => a.id);
  if (parsed.kind === 'type') {
    return scoped.files
      .filter((a) => dirOf(a) === parsed.dir && fileTypeOf(a) === parsed.type)
      .map((a) => a.id);
  }
  return scoped.files.filter((a) => isWithin(dirOf(a), parsed.dir)).map((a) => a.id);
}

export function buildMapLevel(state, levelId = 'root') {
  const parsed = parseLevelId(levelId);
  if (!parsed || !state) return null;
  const ix = indexState(state);
  const app = state.application;
  const rootCrumb = { id: 'root', title: app ? app.name : 'All files' };

  if (parsed.kind === 'root') {
    const center = app
      ? {
          id: app.id,
          nodeType: NodeType.AI_APPLICATION,
          label: app.name,
          subtitle: `${ix.live.length.toLocaleString('en-US')} files`,
          sizeBytes: 0,
          confidence: ProvenanceConfidence.VERIFIED,
          riskCategory: RiskCategory.PROTECTED,
          radius: 30,
          metadata: { ...app, summary: summarize(ix.live) }
        }
      : summaryNode({ id: 'all', nodeType: NodeType.FOLDER, label: 'All files', summary: summarize(ix.live) });
    const children = [];
    for (const group of state.artifactGroups || []) {
      const files = group.artifactIds.map((id) => ix.byId.get(id)).filter(Boolean);
      if (files.length === 0) continue;
      children.push(
        summaryNode({
          id: `group:${group.id}`,
          nodeType: NodeType.ARTIFACT_GROUP,
          label: group.name,
          summary: summarize(files),
          drillId: `group:${group.id}`,
          artifactType: group.artifactType
        })
      );
    }
    children.sort((a, b) => b.sizeBytes - a.sizeBytes);
    if (ix.sessions.length > 0) {
      const linked = levelArtifactIds(state, 'sessions').map((id) => ix.byId.get(id));
      children.push(
        summaryNode({
          id: 'sessions',
          nodeType: NodeType.SESSION,
          label: `Sessions (${ix.sessions.length})`,
          summary: summarize(linked),
          drillId: 'sessions'
        })
      );
    }
    const measuredMark = measuredRootNode(state);
    if (measuredMark) children.push(measuredMark);
    return finish({ id: 'root', title: rootCrumb.title, breadcrumb: [rootCrumb], parentId: null, center, children });
  }

  if (parsed.kind === 'measured') {
    return buildMeasuredLevel(state, parsed, rootCrumb);
  }

  if (parsed.kind === 'grouping') {
    const def = GROUPINGS[parsed.grouping];
    const center = app
      ? {
          id: app.id,
          nodeType: NodeType.AI_APPLICATION,
          label: app.name,
          subtitle: `${ix.live.length.toLocaleString('en-US')} files`,
          sizeBytes: 0,
          confidence: ProvenanceConfidence.VERIFIED,
          riskCategory: RiskCategory.PROTECTED,
          radius: 30,
          metadata: { ...app, summary: summarize(ix.live) }
        }
      : summaryNode({ id: 'all', nodeType: NodeType.FOLDER, label: 'All files', summary: summarize(ix.live) });
    const children = [];
    for (const bucket of def.buckets(ix.live)) {
      const files = ix.live.filter((a) => def.keyOf(a, ix.now) === bucket.key);
      if (files.length === 0) continue;
      const scope = `bucket:${parsed.grouping}:${bucket.key}`;
      children.push(
        summaryNode({ id: scope, nodeType: NodeType.FOLDER, label: bucket.label, summary: summarize(files), drillId: scope, extra: { bucket: { grouping: parsed.grouping, key: bucket.key } } })
      );
    }
    return finish({ id: levelId, title: rootCrumb.title, breadcrumb: [{ id: levelId, title: rootCrumb.title }], parentId: null, center, children, grouping: parsed.grouping });
  }

  if (parsed.kind === 'sessions') {
    const center = summaryNode({
      id: 'sessions',
      nodeType: NodeType.SESSION,
      label: `Sessions (${ix.sessions.length})`,
      summary: summarize(levelArtifactIds(state, 'sessions').map((id) => ix.byId.get(id)))
    });
    const children = ix.sessions.map((s) => {
      const files = [...ix.sessionLinks.get(s.id).keys()].map((id) => ix.byId.get(id)).filter(Boolean);
      return summaryNode({
        id: `session:${s.id}`,
        nodeType: NodeType.SESSION,
        label: s.title || s.externalSessionId || 'Session',
        summary: summarize(files),
        drillId: `session:${s.id}`,
        extra: { session: s }
      });
    });
    children.sort((a, b) => b.metadata.summary.artifactCount - a.metadata.summary.artifactCount);
    const shown = children.slice(0, LEVEL_MAX_SESSIONS);
    return finish({
      id: 'sessions',
      title: 'Sessions',
      breadcrumb: [rootCrumb, { id: 'sessions', title: 'Sessions' }],
      parentId: 'root',
      center,
      children: shown,
      note: children.length > shown.length ? `Showing the ${shown.length} sessions with the most files out of ${children.length}.` : null
    });
  }

  const scoped = scopeFiles(ix, state, parsed.scope);
  if (!scoped) return null;
  const scopeLevelId = parsed.scope === 'all' ? 'root' : parsed.scope;
  const bucketRoot = scoped.bucket ? `root:${scoped.bucket.grouping}` : null;
  const scopeCrumbs =
    parsed.scope === 'all'
      ? [rootCrumb]
      : bucketRoot
        ? [{ id: bucketRoot, title: rootCrumb.title }, { id: parsed.scope, title: scoped.bucket.label }]
      : parsed.scope.startsWith('session:')
        ? [rootCrumb, { id: 'sessions', title: 'Sessions' }, { id: parsed.scope, title: scopeTitle(state, parsed.scope, scoped) }]
        : [rootCrumb, { id: parsed.scope, title: scopeTitle(state, parsed.scope, scoped) }];

  const base = compress(scoped.files, commonDir(scoped.files));

  // One type of file inside one folder
  if (parsed.kind === 'type') {
    const ofType = scoped.files
      .filter((a) => dirOf(a) === parsed.dir && fileTypeOf(a) === parsed.type)
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    if (ofType.length === 0) return null;
    const folderLevelId = parsed.dir === base.prefix ? scopeLevelId : `dir:${parsed.scope}::${parsed.dir}`;
    const label = parsed.type === 'no extension' ? 'Files without an extension' : `${parsed.type} files`;
    const center = summaryNode({ id: levelId, nodeType: NodeType.FOLDER, label, summary: summarize(ofType), extra: { path: parsed.dir, fileType: parsed.type } });
    const shown = ofType.slice(0, LEVEL_MAX_FILES).map(fileNode);
    if (scoped.links) for (const node of shown) node.linkConfidence = scoped.links.get(node.id);
    const crumbs = [...scopeCrumbs];
    if (folderLevelId !== scopeLevelId) {
      crumbs.push({ id: folderLevelId, title: parsed.dir.slice(base.prefix === '/' ? 1 : base.prefix.length + 1) });
    }
    crumbs.push({ id: levelId, title: label });
    return finish({
      id: levelId,
      title: label,
      breadcrumb: crumbs,
      parentId: folderLevelId,
      center,
      children: shown,
      note: ofType.length > shown.length ? `Showing the ${shown.length} largest of ${ofType.length.toLocaleString('en-US')} ${label.toLowerCase()}.` : null,
      path: fromPathKey(parsed.dir)
    });
  }

  const level =
    parsed.kind === 'scope'
      ? base
      : compress(scoped.files.filter((a) => isWithin(dirOf(a), parsed.dir)), parsed.dir);
  const inLevel = parsed.kind === 'scope' ? scoped.files : scoped.files.filter((a) => isWithin(dirOf(a), level.prefix));
  const isScopeTop = parsed.kind === 'scope' || level.prefix === base.prefix;
  const thisId = isScopeTop ? scopeLevelId : `dir:${parsed.scope}::${level.prefix}`;

  // The center: the kind, the session, or the folder
  let center;
  if (isScopeTop && scoped.group) {
    center = summaryNode({ id: thisId, nodeType: NodeType.ARTIFACT_GROUP, label: scoped.group.name, summary: summarize(inLevel), artifactType: scoped.group.artifactType, extra: { path: level.prefix } });
  } else if (isScopeTop && scoped.bucket) {
    center = summaryNode({ id: thisId, nodeType: NodeType.FOLDER, label: scoped.bucket.label, summary: summarize(inLevel), extra: { path: level.prefix, bucket: scoped.bucket } });
  } else if (isScopeTop && scoped.session) {
    center = summaryNode({ id: thisId, nodeType: NodeType.SESSION, label: scoped.session.title || 'Session', summary: summarize(inLevel), extra: { session: scoped.session, path: level.prefix } });
  } else {
    center = summaryNode({ id: thisId, nodeType: NodeType.FOLDER, label: level.prefix.slice(level.prefix.lastIndexOf('/') + 1) || '/', summary: summarize(inLevel), extra: { path: level.prefix } });
  }

  // Around it: subfolders, then the largest files directly inside
  const folderNodes = level.folders
    .map((folder) => {
      const inner = compress(folder.files, folder.path);
      const label = inner.prefix.slice(level.prefix === '/' ? 1 : level.prefix.length + 1);
      return summaryNode({
        id: `dir:${parsed.scope}::${inner.prefix}`,
        nodeType: NodeType.FOLDER,
        label,
        summary: summarize(folder.files),
        drillId: `dir:${parsed.scope}::${inner.prefix}`,
        extra: { path: inner.prefix }
      });
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const shownFolders = folderNodes.slice(0, LEVEL_MAX_FOLDERS);
  const directSorted = [...level.direct].sort((a, b) => b.sizeBytes - a.sizeBytes);
  // A folder with many files shows its largest few and bundles the rest by type
  const bundling = directSorted.length > LEVEL_MAX_FILES;
  const shownFiles = directSorted.slice(0, bundling ? LEVEL_FILES_BEFORE_BUNDLING : LEVEL_MAX_FILES).map(fileNode);
  const bundleNodes = [];
  if (bundling) {
    const byType = new Map();
    for (const art of directSorted) {
      const type = fileTypeOf(art);
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(art);
    }
    for (const [type, files] of byType) {
      bundleNodes.push(
        summaryNode({
          id: `type:${parsed.scope}::${level.prefix}::${type}`,
          nodeType: NodeType.FOLDER,
          label: type === 'no extension' ? 'No extension' : `${type} files`,
          summary: summarize(files),
          drillId: `type:${parsed.scope}::${level.prefix}::${type}`,
          extra: { path: level.prefix, fileType: type, isTypeBundle: true }
        })
      );
    }
    bundleNodes.sort((a, b) => b.sizeBytes - a.sizeBytes);
    bundleNodes.splice(LEVEL_MAX_TYPE_BUNDLES);
  }
  if (scoped.links) {
    for (const node of shownFiles) node.linkConfidence = scoped.links.get(node.id);
  }

  const notes = [];
  if (folderNodes.length > shownFolders.length) {
    notes.push(`Showing the ${shownFolders.length} largest of ${folderNodes.length} folders.`);
  }
  if (bundling) {
    notes.push(`${directSorted.length.toLocaleString('en-US')} files directly in this folder: the ${shownFiles.length} largest, and all of them grouped by type.`);
  }

  // Up: the nearest ancestor that is its own level
  let parentId = null;
  if (thisId === scopeLevelId) {
    parentId = parsed.scope === 'all' ? null : bucketRoot ? bucketRoot : parsed.scope.startsWith('session:') ? 'sessions' : 'root';
  } else {
    let dir = parentOf(level.prefix);
    parentId = scopeLevelId;
    while (isWithin(dir, base.prefix) && dir !== base.prefix) {
      const probe = childrenOf(scoped.files, dir);
      if (probe.folders.length > 1 || probe.direct.length > 0) {
        parentId = `dir:${parsed.scope}::${dir}`;
        break;
      }
      dir = parentOf(dir);
    }
  }

  const breadcrumb = [...scopeCrumbs];
  if (thisId !== scopeLevelId) {
    const relative = level.prefix.slice(base.prefix === '/' ? 1 : base.prefix.length + 1);
    breadcrumb.push({ id: thisId, title: relative || center.label });
  }

  return finish({
    id: thisId,
    title: breadcrumb[breadcrumb.length - 1].title,
    breadcrumb,
    parentId,
    center,
    children: [...shownFolders, ...bundleNodes, ...shownFiles],
    note: notes.join(' ') || null,
    path: fromPathKey(level.prefix)
  });
}

/* Dependency and Git folders measured as a whole. They are marks with a size and a file
   count only: nothing in them is listed, so nothing in them can be selected or cleaned up. */
function measuredSummary(folders) {
  const fileCount = folders.reduce((n, f) => n + f.fileCount, 0);
  const bytes = folders.reduce((n, f) => n + f.physicalBytes, 0);
  return {
    artifactCount: fileCount,
    bytes,
    riskCounts: { PROTECTED: fileCount },
    riskCategory: RiskCategory.PROTECTED
  };
}

function measuredNode({ id, label, folders, drillId = null, extra = {} }) {
  const node = summaryNode({ id, nodeType: NodeType.FOLDER, label, summary: measuredSummary(folders), drillId, extra: { measuredOnly: true, ...extra } });
  node.measuredOnly = true;
  return node;
}

function measuredRootNode(state) {
  const folders = state.scan?.bulkFolders || [];
  if (folders.length === 0) return null;
  return measuredNode({ id: 'measured', label: 'Dependencies & Git (measured)', folders, drillId: 'measured' });
}

function buildMeasuredLevel(state, parsed, rootCrumb) {
  const folders = state.scan?.bulkFolders || [];
  const crumb = { id: 'measured', title: 'Dependencies & Git' };
  const note = 'Measured as a whole: counted and sized, never listed file by file, and never offered for cleanup.';
  if (!parsed.project) {
    const byProject = new Map();
    for (const f of folders) {
      const key = f.projectRoot || path.dirname(f.path);
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(f);
    }
    const children = [...byProject.entries()]
      .map(([project, list]) => measuredNode({ id: `measured:${project}`, label: path.basename(project) || project, folders: list, drillId: `measured:${project}`, extra: { path: toPathKey(project) } }))
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    const shown = children.slice(0, LEVEL_MAX_SESSIONS);
    return finish({
      id: 'measured',
      title: crumb.title,
      breadcrumb: [rootCrumb, crumb],
      parentId: 'root',
      center: measuredNode({ id: 'measured-center', label: `Dependencies & Git (${folders.length})`, folders }),
      children: shown,
      note: children.length > shown.length ? `${note} Showing the ${shown.length} largest of ${children.length} projects.` : note
    });
  }
  const list = folders.filter((f) => (f.projectRoot || path.dirname(f.path)) === parsed.project);
  if (list.length === 0) return null;
  const children = list
    .map((f) => measuredNode({ id: `measured-folder:${f.path}`, label: path.relative(parsed.project, f.path) || f.name, folders: [f], extra: { path: toPathKey(f.path) } }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const shown = children.slice(0, LEVEL_MAX_SESSIONS);
  return finish({
    id: `measured:${parsed.project}`,
    title: path.basename(parsed.project),
    breadcrumb: [rootCrumb, crumb, { id: `measured:${parsed.project}`, title: path.basename(parsed.project) }],
    parentId: 'measured',
    center: measuredNode({ id: `measured-project:${parsed.project}`, label: path.basename(parsed.project), folders: list, extra: { path: toPathKey(parsed.project) } }),
    children: shown,
    note: children.length > shown.length ? `${note} Showing the ${shown.length} largest of ${children.length}.` : note
  });
}

function finish({ id, title, breadcrumb, parentId, center, children, note = null, path = null, grouping = null }) {
  center.pinned = true;
  center.x = 0;
  center.y = 0;
  center.drillId = null;
  ring(children);
  const edges = children.map((child) =>
    containsEdge(
      child.id,
      center.id,
      child.nodeType === NodeType.ARTIFACT ? child.linkConfidence || child.confidence : ProvenanceConfidence.VERIFIED
    )
  );
  // Which top-level grouping this level belongs to, so the control on the map can show it
  const rootId = breadcrumb[0].id;
  const activeGrouping = grouping || (rootId.startsWith('root:') ? rootId.slice(5) : 'kind');
  return { id, title, breadcrumb, parentId, note, path, grouping: activeGrouping, nodes: [center, ...children], edges };
}
