/**
 * What changed since the last scan of the same application. After each scan a summary of
 * numbers is kept: totals, sizes by kind, by session and by worktree. Only IDs, paths of
 * worktrees and numbers are stored; never conversation text (AGENTS.md rule 6). Session names
 * are looked up in the current scan when the change is shown.
 *
 * Two scans are compared only when they counted the same things: same application and same
 * scan permissions (whole project folders, dependency folders). Otherwise the totals differ for
 * reasons other than growth, so no change is claimed. A scan that reached the file limit still
 * has a complete total (files past it are measured), so totals are compared; the breakdown by
 * kind and by session covers listed files only and is left out.
 */

export const MAX_SESSIONS_KEPT = 200;

const scopeKey = (scope = {}) => `${scope.projectFolders ? 'P' : '-'}${scope.dependencyFolders ? 'D' : '-'}`;

export function summarizeScanForHistory(state) {
  const scan = state.scan || {};
  const live = (state.artifacts || []).filter((a) => !a.quarantined);
  const kinds = {};
  for (const a of live) {
    const k = (kinds[a.artifactType] ||= { bytes: 0, count: 0 });
    k.bytes += a.sizeBytes || 0;
    k.count += 1;
  }
  const sessions = {};
  const costs = state.promptCosts?.sessions || {};
  const ranked = Object.entries(costs)
    .map(([id, c]) => [id, Object.values(c.parts || {}).reduce((s, p) => s + (p.bytes || 0), 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SESSIONS_KEPT);
  for (const [id, bytes] of ranked) sessions[id] = bytes;
  return {
    scanId: scan.id || null,
    applicationId: state.application?.id || null,
    scannedAt: scan.completedAt || scan.startedAt || new Date().toISOString(),
    scope: scopeKey(scan.scope),
    truncated: Boolean(scan.truncated),
    cancelled: scan.status === 'CANCELLED',
    listedBytes: scan.totalPhysicalBytes || 0,
    measuredBytes: scan.measuredPhysicalBytes || 0,
    fileCount: live.length,
    kinds,
    sessions
  };
}

/** Why two scans cannot be compared, or null when they can. */
export function whyNotComparable(previous, current) {
  if (current.cancelled) return 'CANCELLED';
  if (!previous) return 'FIRST_SCAN';
  if (previous.applicationId !== current.applicationId) return 'OTHER_APPLICATION';
  if (previous.scope !== current.scope) return 'DIFFERENT_SCOPE';
  return null;
}

export function compareScans(previous, current) {
  const reason = whyNotComparable(previous, current);
  if (reason) {
    return { comparable: false, reason, previousScannedAt: previous?.scannedAt || null };
  }
  const total = (s) => s.listedBytes + s.measuredBytes;
  // Past the file limit only the total is complete
  if (previous.truncated || current.truncated) {
    return {
      comparable: true,
      totalsOnly: true,
      previousScannedAt: previous.scannedAt,
      deltaBytes: total(current) - total(previous),
      deltaFiles: null,
      kinds: [],
      sessions: []
    };
  }
  const kinds = new Set([...Object.keys(previous.kinds), ...Object.keys(current.kinds)]);
  const kindChanges = Array.from(kinds, (type) => ({
    artifactType: type,
    deltaBytes: (current.kinds[type]?.bytes || 0) - (previous.kinds[type]?.bytes || 0),
    deltaCount: (current.kinds[type]?.count || 0) - (previous.kinds[type]?.count || 0)
  }))
    .filter((k) => k.deltaBytes !== 0 || k.deltaCount !== 0)
    .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
  const sessionChanges = Object.entries(current.sessions)
    .map(([id, bytes]) => ({ sessionId: id, isNew: !(id in previous.sessions), deltaBytes: bytes - (previous.sessions[id] || 0) }))
    .filter((s) => s.deltaBytes > 0)
    .sort((a, b) => b.deltaBytes - a.deltaBytes)
    .slice(0, 5);
  return {
    comparable: true,
    previousScannedAt: previous.scannedAt,
    deltaBytes: total(current) - total(previous),
    deltaFiles: current.fileCount - previous.fileCount,
    kinds: kindChanges.slice(0, 6),
    sessions: sessionChanges
  };
}
