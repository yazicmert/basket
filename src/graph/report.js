import { formatArtifactTypeLabel } from '../classification/classification-engine.js';

/**
 * A report of one scan, as a page and as a CSV, written to the app's data folder when the
 * user asks. It holds numbers, paths and session titles. No prompt or reply text goes into it
 * (AGENTS.md rule 6): a session whose stored title was made up from its ID is named by that ID.
 */

const MADE_UP_TITLE = /^(Claude|Cursor|Codex) Session [\w-]{1,12}$/;
const RISK_LABELS = { LOW: 'Safe to remove', REVIEW: 'Review first', HIGH: 'High risk', PROTECTED: 'Protected' };

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let i = 0;
  while (Math.abs(value) >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const csvCell = (v) => {
  const s = String(v ?? '');
  // A leading =, +, - or @ would run as a formula in a spreadsheet
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function sessionLabel(session) {
  if (session.title && !MADE_UP_TITLE.test(session.title)) return session.title;
  return `Session ${String(session.externalSessionId || session.id).slice(0, 8)}`;
}

/** The rows of the report, shared by the page and the CSV. */
export function reportData(state, { leftovers = null, copies = null } = {}) {
  const live = (state.artifacts || []).filter((a) => !a.quarantined);
  const scan = state.scan || {};
  const kinds = new Map();
  const risks = new Map();
  for (const a of live) {
    const k = kinds.get(a.artifactType) || { count: 0, bytes: 0 };
    k.count += 1;
    k.bytes += a.sizeBytes || 0;
    kinds.set(a.artifactType, k);
    const r = risks.get(a.cleanupClassification) || { count: 0, bytes: 0 };
    r.count += 1;
    r.bytes += a.sizeBytes || 0;
    risks.set(a.cleanupClassification, r);
  }
  const costs = state.promptCosts?.sessions || {};
  const sessions = (state.sessions || [])
    .map((s) => {
      const c = costs[s.id] || { parts: {}, costBytes: 0, costCount: 0 };
      const part = (k) => c.parts?.[k] || { count: 0, bytes: 0 };
      return { label: sessionLabel(s), startedAt: s.startedAt || '', output: part('output'), scratch: part('scratch'), kept: part('kept'), record: part('record'), costBytes: c.costBytes || 0 };
    })
    .sort((a, b) => b.costBytes - a.costBytes);
  return {
    application: state.application?.name || 'Application',
    scannedAt: scan.completedAt || scan.startedAt || '',
    listedBytes: scan.totalPhysicalBytes || 0,
    measuredBytes: scan.measuredPhysicalBytes || 0,
    fileCount: live.length,
    truncated: Boolean(scan.truncated),
    kinds: Array.from(kinds, ([type, v]) => ({ label: formatArtifactTypeLabel(type), ...v })).sort((a, b) => b.bytes - a.bytes),
    risks: ['LOW', 'REVIEW', 'HIGH', 'PROTECTED'].map((k) => ({ label: RISK_LABELS[k], ...(risks.get(k) || { count: 0, bytes: 0 }) })),
    sessions,
    worktrees: (leftovers?.worktrees || []).map((w) => ({ name: w.name, path: w.path, bytes: w.bytes, fileCount: w.fileCount, branch: w.git?.branch || '' })),
    buildProjects: (leftovers?.buildProjects || []).map((b) => ({ name: b.name, path: b.path, bytes: b.bytes, count: b.count, rebuild: b.rebuild || '' })),
    copies: copies ? { groupCount: copies.groupCount, duplicateBytes: copies.duplicateBytes } : null,
    growth: state.growth?.comparable ? { since: state.growth.previousScannedAt, deltaBytes: state.growth.deltaBytes } : null
  };
}

export function reportCsv(data) {
  const rows = [['section', 'name', 'files', 'bytes', 'size', 'detail']];
  rows.push(['total', data.application, data.fileCount, data.listedBytes + data.measuredBytes, formatBytes(data.listedBytes + data.measuredBytes), data.scannedAt]);
  for (const k of data.kinds) rows.push(['kind', k.label, k.count, k.bytes, formatBytes(k.bytes), '']);
  for (const r of data.risks) rows.push(['risk', r.label, r.count, r.bytes, formatBytes(r.bytes), '']);
  for (const s of data.sessions) {
    rows.push(['session', s.label, s.output.count + s.scratch.count + s.kept.count + s.record.count, s.costBytes, formatBytes(s.costBytes), `left behind beyond its output (at least); started ${s.startedAt}`]);
  }
  for (const w of data.worktrees) rows.push(['worktree', w.name, w.fileCount, w.bytes, formatBytes(w.bytes), w.path]);
  for (const b of data.buildProjects) rows.push(['build output', b.name, b.count, b.bytes, formatBytes(b.bytes), b.rebuild ? `${b.path} (${b.rebuild})` : b.path]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function reportHtml(data, { appVersion = '' } = {}) {
  const total = data.listedBytes + data.measuredBytes;
  const date = data.scannedAt ? new Date(data.scannedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) : '';
  const table = (head, rows) =>
    rows.length === 0
      ? ''
      : `<table><thead><tr>${head.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
  const section = (title, body, note = '') => (body ? `<section><h2>${escapeHtml(title)}</h2>${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}${body}</section>` : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(data.application)} report</title>
<style>
:root { --bg: #fcfcfb; --ink: #1b1b1a; --ink-2: #5c5c58; --line: #e4e4e0; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --ink: #ededeb; --ink-2: #a3a39e; --line: #2c2c2a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 56px 24px 80px; }
.kicker { color: var(--ink-2); font-size: 13px; margin: 0 0 6px; }
h1 { font-size: 30px; letter-spacing: -0.02em; margin: 0; }
.total { font-size: 44px; font-weight: 600; letter-spacing: -0.03em; margin: 28px 0 0; font-variant-numeric: tabular-nums; }
.meta { color: var(--ink-2); margin: 2px 0 0; }
section { margin-top: 44px; }
h2 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: 0 0 10px; }
.note { color: var(--ink-2); font-size: 13px; margin: -4px 0 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; font-weight: 500; color: var(--ink-2); }
td.num, th.num { text-align: right; padding-left: 16px; white-space: nowrap; }
.path { display: block; color: var(--ink-2); font: 12px ui-monospace, "SF Mono", Menlo, Consolas, monospace; overflow-wrap: anywhere; }
footer { margin-top: 56px; color: var(--ink-2); font-size: 12px; }
</style>
</head>
<body>
<main>
<p class="kicker">Artifact Atlas report</p>
<h1>${escapeHtml(data.application)}</h1>
<p class="total">${formatBytes(total)}</p>
<p class="meta">${data.fileCount.toLocaleString('en-US')} files listed${data.measuredBytes ? `, ${formatBytes(data.measuredBytes)} more measured` : ''} · scanned ${escapeHtml(date)}${data.growth ? ` · ${data.growth.deltaBytes >= 0 ? '+' : '−'}${formatBytes(Math.abs(data.growth.deltaBytes))} since the scan of ${escapeHtml(new Date(data.growth.since).toLocaleDateString('en-US', { dateStyle: 'medium' }))}` : ''}</p>
${section('By cleanup risk', table(['Risk', 'Files', 'Size'], data.risks.filter((r) => r.count > 0).map((r) => [escapeHtml(r.label), r.count.toLocaleString('en-US'), formatBytes(r.bytes)])))}
${section('By kind', table(['Kind', 'Files', 'Size'], data.kinds.map((k) => [escapeHtml(k.label), k.count.toLocaleString('en-US'), formatBytes(k.bytes)])))}
${section(
  'What each session left behind',
  table(['Session', 'Its output', 'Left behind'], data.sessions.slice(0, 50).map((s) => [`${escapeHtml(s.label)}${s.startedAt ? `<span class="path">${escapeHtml(new Date(s.startedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }))}</span>` : ''}`, formatBytes(s.output.bytes), formatBytes(s.costBytes)])),
  'At least: files made by commands a session ran (installs, builds) are not named in its record. Prompts are not included in reports.'
)}
${section('Worktrees', table(['Worktree', 'Files', 'Size'], data.worktrees.map((w) => [`${escapeHtml(w.name)}<span class="path">${escapeHtml(w.path)}</span>`, w.fileCount.toLocaleString('en-US'), formatBytes(w.bytes)])))}
${section('Build outputs by project', table(['Project', 'Files', 'Size'], data.buildProjects.map((b) => [`${escapeHtml(b.name)}<span class="path">${escapeHtml(b.path)}${b.rebuild ? ` · ${escapeHtml(b.rebuild)}` : ''}</span>`, b.count.toLocaleString('en-US'), formatBytes(b.bytes)])))}
${data.copies && data.copies.groupCount > 0 ? section('Identical files', `<p>${data.copies.groupCount.toLocaleString('en-US')} groups of files with identical content; ${formatBytes(data.copies.duplicateBytes)} is held by copies beyond one of each.</p>`) : ''}
${data.truncated ? '<p class="note">This scan reached its file limit: files past it are in the total but not in the tables.</p>' : ''}
<footer>Made by Artifact Atlas${appVersion ? ` ${escapeHtml(appVersion)}` : ''} on this computer. Nothing in it was sent anywhere.</footer>
</main>
</body>
</html>
`;
}
