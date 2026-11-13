import { ArtifactType, RiskCategory } from '../models/entities.js';

/**
 * What each session left behind, and how much of the scan can be traced to a session at all.
 *
 * A session is named on the map by the prompt that started it. Its files are split by how
 * the link is known and where the file is:
 *
 *   output   a tool call of the session wrote the file in a project folder, or changed a
 *            file that already existed elsewhere (the work it delivered)
 *   scratch  a tool call of the session created the file outside every project folder
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

/** Whether a session's tool call created the file (rather than changed an existing one). */
function createdBySession(art, opTypeById) {
  return (art.operationIds || []).some((id) => opTypeById.get(id) === 'WRITE');
}

// Only write-type tool calls give a file operationIds (see WRITE_OPERATION_TYPES)
function partOf(art, opTypeById) {
  if (art.artifactType === ArtifactType.SESSION_HISTORY && !art.workspaceId) return 'record';
  if ((art.operationIds || []).length > 0) {
    return !art.workspaceId && createdBySession(art, opTypeById) ? 'scratch' : 'output';
  }
  return 'kept';
}

const operationTypes = (state) => new Map((state.operations || []).map((op) => [op.id, op.operationType]));

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
  const opTypeById = operationTypes(state);
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

    const part = partOf(art, opTypeById);
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
 * in a project folder, not its output (files it changed that existed before), not a session
 * record (removing it would drop the prompt and every link of the session), and not
 * protected. A file it created must not be older than the session. Nothing is offered for
 * a session that may still be running. The cleanup review still checks every file.
 */
export function sessionLeftoverIds(state, sessionId, costs) {
  const entry = costs.sessions[sessionId];
  if (!entry || entry.possiblyRunning) return [];
  const session = (state.sessions || []).find((s) => s.id === sessionId);
  const startedAt = Date.parse(session?.startedAt || '');
  const opTypeById = operationTypes(state);
  return (state.artifacts || [])
    .filter((art) => {
      if (
        art.quarantined ||
        art.workspaceId ||
        (art.sessionIds || []).length !== 1 ||
        art.sessionIds[0] !== sessionId ||
        art.cleanupClassification === RiskCategory.PROTECTED
      ) {
        return false;
      }
      const part = partOf(art, opTypeById);
      if (part === 'kept') return true;
      if (part !== 'scratch') return false;
      // Narrowing only: a file born well before the session started was not made by it
      const born = Date.parse(art.createdAt || '');
      return !(Number.isFinite(born) && Number.isFinite(startedAt) && born < startedAt - 60 * 1000);
    })
    .map((art) => art.id);
}
