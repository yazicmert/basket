import fs from 'node:fs';
import path from 'node:path';
import { ArtifactType, RiskCategory } from '../models/entities.js';

/**
 * Two kinds of project leftovers that sessions often leave: Git worktrees (a full second
 * checkout of a project, which Claude Code makes under `.claude/worktrees/`) and build
 * outputs. Only what files state is reported. Whether a worktree's branch was merged or has
 * uncommitted changes cannot be read without running Git, which this app never does, so it
 * is not claimed. A worktree holds source code, so it is never offered for cleanup as a
 * whole: its build outputs go through the normal review, and the Git command that removes a
 * worktree is shown for the user to run.
 *
 * Git metadata (`.git` files and folders) is read only with the dependency-folders scan
 * permission (AGENTS.md rule 7); without it a worktree is recognised by lstat alone.
 */

const BUILD_TYPES = new Set([ArtifactType.BUILD_OUTPUT, ArtifactType.DERIVED_DATA]);
const MAX_GIT_FILE_BYTES = 4096;
const MAX_ROWS = 12;

/** Manifests that say how a project is built; only their existence is checked. */
const BUILD_MANIFESTS = [
  ['package.json', 'npm run build'],
  ['Cargo.toml', 'cargo build'],
  ['Package.swift', 'swift build'],
  ['go.mod', 'go build ./...'],
  ['pom.xml', 'mvn package'],
  ['build.gradle', 'gradle build'],
  ['build.gradle.kts', 'gradle build'],
  ['pyproject.toml', 'python -m build']
];

const lstatSafe = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/** A small regular file's text, or null. Never follows a symlink. */
function readSmallFile(p) {
  const st = lstatSafe(p);
  if (!st || !st.isFile() || st.size > MAX_GIT_FILE_BYTES) return null;
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Facts Git keeps about a worktree, read from its metadata files. */
export function readWorktreeGitFacts(root) {
  const facts = { gitDir: null, registered: null, branch: null, detached: false, branchExists: null, repoRoot: null };
  const pointer = readSmallFile(path.join(root, '.git'));
  const match = /^gitdir:\s*(.+)$/m.exec(pointer || '');
  if (!match) return facts;
  const gitDir = path.resolve(root, match[1].trim());
  facts.gitDir = gitDir;
  const gitDirStat = lstatSafe(gitDir);
  if (!gitDirStat || !gitDirStat.isDirectory()) {
    facts.registered = false; // Git no longer knows this worktree (it can be pruned)
    return facts;
  }
  const back = readSmallFile(path.join(gitDir, 'gitdir'));
  facts.registered = Boolean(back) && path.resolve(gitDir, back) === path.join(root, '.git');
  const head = readSmallFile(path.join(gitDir, 'HEAD')) || '';
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) facts.branch = ref[1].trim();
  else facts.detached = /^[0-9a-f]{40,64}$/.test(head);
  const common = path.resolve(gitDir, readSmallFile(path.join(gitDir, 'commondir')) || path.join('..', '..'));
  if (path.basename(common) === '.git') facts.repoRoot = path.dirname(common);
  if (facts.branch && !/(^|\/)\.\.(\/|$)/.test(facts.branch)) {
    const loose = lstatSafe(path.join(common, 'refs', 'heads', ...facts.branch.split('/')));
    const packed = readPackedRefs(path.join(common, 'packed-refs'));
    facts.branchExists = Boolean(loose && loose.isFile()) || packed.has(`refs/heads/${facts.branch}`);
  }
  return facts;
}

function readPackedRefs(p) {
  const refs = new Set();
  const st = lstatSafe(p);
  if (!st || !st.isFile() || st.size > 16 * 1024 * 1024) return refs;
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^[0-9a-f]{40,64} (refs\/\S+)$/.exec(line.trim());
      if (m) refs.add(m[1]);
    }
  } catch {
    // Unreadable: the branch is reported as unknown
  }
  return refs;
}

/** Root of a Claude Code worktree a path lies in (`<repo>/.claude/worktrees/<name>`), or null. */
export function claudeWorktreeRoot(filePath) {
  const parts = filePath.split(path.sep);
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i] === '.claude' && parts[i + 1] === 'worktrees' && parts[i + 2]) {
      return parts.slice(0, i + 3).join(path.sep);
    }
  }
  return null;
}

/** Physical size of a set of artifacts, each inode once. */
function sizeOf(arts) {
  const seen = new Set();
  let bytes = 0;
  for (const a of arts) {
    const key = a.physicalInodeKey || a.canonicalPath;
    if (seen.has(key)) continue;
    seen.add(key);
    bytes += a.sizeBytes || 0;
  }
  return bytes;
}

const isBuildLeftover = (a) => BUILD_TYPES.has(a.artifactType) && a.cleanupClassification !== RiskCategory.PROTECTED;

/**
 * @returns {{ worktrees: object[], buildProjects: object[], lowerBound: boolean, gitMetadataRead: boolean }}
 */
export function summarizeProjectLeftovers(state, { readGitMetadata = false } = {}) {
  const live = (state.artifacts || []).filter((a) => !a.quarantined);
  const scan = state.scan || {};
  const lowerBound = Boolean(scan.truncated || (scan.overflow && scan.overflow.fileCount > 0));
  const bulk = scan.bulkFolders || [];

  // Worktrees: a Git root whose `.git` is a file, or a Claude Code worktree folder
  const roots = new Map();
  for (const a of live) {
    const claude = claudeWorktreeRoot(a.canonicalPath);
    if (claude) roots.set(claude, true);
    const gitRoot = a.gitRepositoryRoot;
    if (gitRoot && !roots.has(gitRoot)) roots.set(gitRoot, null);
  }
  const worktrees = [];
  for (const [root, isClaude] of roots) {
    const gitEntry = lstatSafe(path.join(root, '.git'));
    const hasGitFile = Boolean(gitEntry && gitEntry.isFile());
    if (!hasGitFile && !isClaude) continue;
    const files = live.filter((a) => within(a.canonicalPath, root));
    if (files.length === 0) continue;
    const measured = bulk.filter((f) => within(f.path, root));
    const facts = hasGitFile && readGitMetadata ? readWorktreeGitFacts(root) : null;
    const sessionIds = new Set();
    for (const a of files) for (const sid of a.sessionIds || []) sessionIds.add(sid);
    // Sessions whose recorded working folder is inside this worktree ran in it
    const wsInside = new Set((state.workspaces || []).filter((w) => within(w.canonicalPath, root)).map((w) => w.id));
    for (const s of state.sessions || []) if (s.workspaceId && wsInside.has(s.workspaceId)) sessionIds.add(s.id);
    const build = files.filter(isBuildLeftover);
    let newest = null;
    for (const a of files) if (a.modifiedAt && (!newest || a.modifiedAt > newest)) newest = a.modifiedAt;
    worktrees.push({
      id: `worktree:${root}`,
      path: root,
      name: path.basename(root),
      madeByClaudeCode: Boolean(isClaude),
      isGitWorktree: hasGitFile,
      git: facts,
      fileCount: files.length + measured.reduce((s, f) => s + f.fileCount, 0),
      bytes: sizeOf(files) + measured.reduce((s, f) => s + f.physicalBytes, 0),
      newestChange: newest,
      sessionIds: Array.from(sessionIds),
      // Their stored titles only; the prompt text is read for display elsewhere (rule 6)
      sessions: (state.sessions || []).filter((s) => sessionIds.has(s.id)).map((s) => ({ id: s.id, title: s.title || null })),
      buildOutputs: { count: build.length, bytes: sizeOf(build) },
      removeCommand: facts && facts.registered && facts.repoRoot ? `git -C "${facts.repoRoot}" worktree remove "${root}"` : null
    });
  }
  worktrees.sort((a, b) => b.bytes - a.bytes);

  // Build outputs, by the project (Git root, else project folder) they belong to
  const byProject = new Map();
  const workspacePath = new Map((state.workspaces || []).map((w) => [w.id, w.canonicalPath]));
  for (const a of live) {
    if (!isBuildLeftover(a)) continue;
    const root = a.gitRepositoryRoot || (a.workspaceId && workspacePath.get(a.workspaceId));
    if (!root) continue;
    if (!byProject.has(root)) byProject.set(root, []);
    byProject.get(root).push(a);
  }
  // A worktree's build outputs are offered on its own row above
  const worktreePaths = new Set(worktrees.map((w) => w.path));
  for (const root of worktreePaths) byProject.delete(root);
  const buildProjects = Array.from(byProject, ([root, arts]) => {
    const manifest = BUILD_MANIFESTS.find(([file]) => {
      const st = lstatSafe(path.join(root, file));
      return st && st.isFile();
    });
    return {
      id: `build:${root}`,
      path: root,
      name: path.basename(root),
      count: arts.length,
      bytes: sizeOf(arts),
      manifest: manifest ? manifest[0] : null,
      rebuild: manifest ? manifest[1] : null
    };
  }).sort((a, b) => b.bytes - a.bytes);

  return {
    worktrees: worktrees.slice(0, MAX_ROWS),
    worktreeCount: worktrees.length,
    buildProjects: buildProjects.slice(0, MAX_ROWS),
    buildProjectCount: buildProjects.length,
    lowerBound,
    gitMetadataRead: readGitMetadata
  };
}

/** Ids of the build outputs of one listed worktree or project, for the cleanup review. */
export function projectBuildOutputIds(state, root) {
  return (state.artifacts || [])
    .filter((a) => !a.quarantined && isBuildLeftover(a) && (a.gitRepositoryRoot ? a.gitRepositoryRoot === root : within(a.canonicalPath, root)))
    .map((a) => a.id);
}
