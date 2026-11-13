import { ArtifactType, RiskCategory } from '../models/entities.js';

/**
 * What each session left behind, and how much of the scan can be traced to a session at all.
 *
 * A session is named on the map by the prompt that started it. Its files are split by how
 * the link is known and where the file is:
 *
 *   output   a tool call of the session names the file, and it is in a project folder
 *   scratch  a tool call names the file, and it is outside every project folder
 *            (screenshots, test files, temporary scripts)
 *   kept     the application keeps the file for the session (its ID is in the path:
 *            tool results, subagent records, todo lists, debug logs) or it was derived
 *            from a file the session wrote
 *   record   the session's own record (transcript and subagent transcripts)
 *
 * Everything but `output` is what the session cost beyond the work it delivered. These are
 * lower bounds: files made by commands a session ran (installs, builds) are not named in its
 * record and cannot be counted. Only numbers are produced here; no conversation text.
 */

export const COST_PARTS = ['output', 'scratch', 'kept', 'record'];

/** A session counts as possibly running when its record changed this recently. */
export const ACTIVE_SESSION_WINDOW_MS = 60 * 60 * 1000;

function partOf(art) {
  if (art.artifactType === ArtifactType.SESSION_HISTORY && !art.workspaceId) return 'record';
  if ((art.operationIds || []).length > 0) return art.workspaceId ? 'output' : 'scratch';
  return 'kept';
}

const emptyPart = () => ({ count: 0, bytes: 0 });

/**
 * @returns {{
 *   sessions: Object<string, {parts, shared, costCount, costBytes, lastActiveAt, possiblyRunning, recordedOperations}>,
 *   totals: {traced, appWide, projects, all}
 * }}
 */
export function computePromptCosts(state, { now = Date.now() } = {}) {
  const live = (state.artifacts || []).filter((a) => !a.quarantined);
  const sessions = state.sessions || [];
  const known = new Set(sessions.map((s) => s.id));
  const perSession = {};
  for (const s of sessions) {
    perSession[s.id] = {
      parts: Object.fromEntries(COST_PARTS.map((p) => [p, emptyPart()])),
      shared: 0,
      costCount: 0,
      costBytes: 0,
      lastActiveAt: s.endedAt || null,
      recordedOperations: Number(s.operationCount || 0)
    };
  }

  // Totals count each physical file once, however many sessions it belongs to
  const totals = { traced: emptyPart(), appWide: emptyPart(), projects: emptyPart(), all: emptyPart() };
  const seen = new Set();
  for (const art of live) {
    const sids = (art.sessionIds || []).filter((sid) => known.has(sid));
    const key = art.physicalInodeKey || art.canonicalPath;
    const first = !seen.has(key);
    seen.add(key);
    const bytes = first ? art.sizeBytes || 0 : 0;

    const bucket = sids.length > 0 ? totals.traced : art.workspaceId ? totals.projects : totals.appWide;
    bucket.count += 1;
    bucket.bytes += bytes;
    totals.all.count += 1;
    totals.all.bytes += bytes;

    const part = partOf(art);
    for (const sid of sids) {
      const entry = perSession[sid];
      entry.parts[part].count += 1;
      entry.parts[part].bytes += art.sizeBytes || 0;
      if (sids.length > 1) entry.shared += 1;
      if (part !== 'output') {
        entry.costCount += 1;
        entry.costBytes += art.sizeBytes || 0;
      }
      // The newest change to anything the application keeps for the session
      if (part === 'record' || part === 'kept') {
        const at = art.modifiedAt || null;
        if (at && (!entry.lastActiveAt || at > entry.lastActiveAt)) entry.lastActiveAt = at;
      }
    }
  }
  for (const entry of Object.values(perSession)) {
    const last = Date.parse(entry.lastActiveAt || '');
    // Without a date a session is never treated as finished
    entry.possiblyRunning = !Number.isFinite(last) || now - last < ACTIVE_SESSION_WINDOW_MS;
  }
  return { sessions: perSession, totals };
}

/**
 * Files that "remove this session's leftovers" may offer: linked to this session only, not
 * the work it delivered into a project, not a session record (removing it would drop the
 * prompt and every link of the session), and not protected. Nothing is offered for a
 * session that may still be running. The cleanup review still checks every file.
 */
export function sessionLeftoverIds(state, sessionId, costs) {
  const entry = costs.sessions[sessionId];
  if (!entry || entry.possiblyRunning) return [];
  return (state.artifacts || [])
    .filter(
      (art) =>
        !art.quarantined &&
        (art.sessionIds || []).length === 1 &&
        art.sessionIds[0] === sessionId &&
        art.cleanupClassification !== RiskCategory.PROTECTED &&
        ['scratch', 'kept'].includes(partOf(art))
    )
    .map((art) => art.id);
}
