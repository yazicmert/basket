import fs from 'node:fs';
import path from 'node:path';
import { storePackageNames } from './windows-apps.js';

/**
 * Generic, adapter-independent discovery of where a macOS application keeps its data.
 *
 * Works for any `.app` (not only the applications with a session adapter) by matching the
 * bundle identifier and application name against the well-known per-user container locations,
 * including hidden dot-directories in the home folder. Matching is deliberately strict
 * (exact name, or bundle-identifier prefix) so that a directory is only attributed to an
 * application on structural evidence; attribution stays INFERRED, never VERIFIED.
 *
 * Nothing here executes the application or reads file contents: it only lists directory names.
 */

/** Per-user Library containers whose direct children are named after an app or bundle id. */
const LIBRARY_CONTAINERS = [
  { rel: 'Application Support', role: 'APP_SUPPORT' },
  { rel: 'Caches', role: 'CACHES' },
  { rel: 'Logs', role: 'LOGS' },
  { rel: 'Preferences', role: 'PREFERENCES' },
  { rel: 'Preferences/ByHost', role: 'PREFERENCES' },
  { rel: 'Saved Application State', role: 'SAVED_STATE' },
  { rel: 'WebKit', role: 'WEBKIT_DATA' },
  { rel: 'HTTPStorages', role: 'HTTP_STORAGE' },
  { rel: 'Cookies', role: 'COOKIES' },
  { rel: 'Containers', role: 'SANDBOX_CONTAINER' },
  { rel: 'Group Containers', role: 'GROUP_CONTAINER' },
  { rel: 'Application Scripts', role: 'APP_SCRIPTS' },
  { rel: 'LaunchAgents', role: 'LAUNCH_AGENT' }
];

/** Hidden / XDG-style parents in the home folder that hold `<app-slug>` children. */
const HOME_SLUG_PARENTS = [
  { rel: '', prefix: '.', role: 'HOME_DOT_DIRECTORY' },
  { rel: '.config', prefix: '', role: 'XDG_CONFIG' },
  { rel: '.cache', prefix: '', role: 'XDG_CACHE' },
  { rel: '.local/share', prefix: '', role: 'XDG_DATA' },
  { rel: '.local/state', prefix: '', role: 'XDG_STATE' }
];

/** Windows per-user data folders whose direct children are named after an application. */
const WINDOWS_APPDATA_CONTAINERS = [
  { rel: 'AppData/Roaming', role: 'APP_SUPPORT' },
  { rel: 'AppData/Local', role: 'LOCAL_APP_DATA' },
  { rel: 'AppData/LocalLow', role: 'LOCAL_APP_DATA' },
  { rel: 'AppData/Local/Packages', role: 'LOCAL_APP_DATA', storePackages: true }
];

/** Folder name endings an application adds to its own name on Windows ("cursor-updater"). */
const WINDOWS_NAME_SUFFIXES = ['-updater', '-nightly', '.exe'];

const STRIPPABLE_SUFFIXES = ['.savedstate', '.binarycookies', '.plist.lockfile', '.plist'];

/** Names too generic to attribute a shared directory to one application. */
const GENERIC_NAME_TOKENS = new Set([
  'app',
  'application',
  'helper',
  'data',
  'cache',
  'caches',
  'logs',
  'log',
  'temp',
  'tmp',
  'apple',
  'google',
  'microsoft',
  'electron',
  'node',
  'python',
  'java'
]);

/**
 * Applications with data in places the generic name / bundle-id matching cannot derive.
 * `ai: true` only drives ordering in the application picker; it never affects provenance.
 */
export const KNOWN_APP_PROFILES = [
  {
    id: 'claude',
    ai: true,
    bundleIdPrefixes: ['com.anthropic.'],
    names: ['claude', 'claude code'],
    extraLocations: ['.claude', '.claude.json', '.config/claude'],
    windowsLocations: ['AppData/Roaming/Claude', 'AppData/Local/claude-cli-nodejs']
  },
  {
    id: 'cursor',
    ai: true,
    bundleIdPrefixes: ['com.todesktop.230313mzl4w4u92'],
    names: ['cursor'],
    extraLocations: ['.cursor'],
    windowsLocations: ['AppData/Roaming/Cursor', 'AppData/Local/cursor-updater']
  },
  {
    id: 'codex',
    ai: true,
    bundleIdPrefixes: ['com.openai.codex'],
    // The Codex app became the new ChatGPT desktop app in July 2026 (Chat, Work and Codex in
    // one app); the Codex CLI is separate. An app is matched to this profile by the Codex
    // app's bundle identifier or the name Codex, never by the name ChatGPT alone, which
    // ChatGPT Classic also uses. Whether the new ChatGPT app keeps the Codex app's bundle
    // identifier has not been confirmed on a real install.
    names: ['codex', 'codex cli'],
    extraLocations: ['.codex']
  },
  {
    id: 'chatgpt',
    ai: true,
    bundleIdPrefixes: ['com.openai.chat'],
    // ChatGPT Classic: the earlier ChatGPT desktop app, renamed in July 2026
    names: ['chatgpt', 'chatgpt classic'],
    extraLocations: []
  },
  {
    id: 'windsurf',
    ai: true,
    bundleIdPrefixes: ['com.exafunction.windsurf'],
    // Renamed Devin Desktop (Devin.app) in June 2026. It writes new data under Devin paths and
    // still reads the Windsurf and Codeium ones, which old installs keep.
    names: ['windsurf', 'devin', 'devin desktop'],
    extraLocations: ['.codeium', '.windsurf', '.devin']
  },
  {
    id: 'vscode',
    ai: false,
    bundleIdPrefixes: ['com.microsoft.vscode'],
    names: ['visual studio code', 'code'],
    extraLocations: ['.vscode', 'Library/Application Support/Code'],
    windowsLocations: ['AppData/Roaming/Code']
  },
  {
    id: 'ollama',
    ai: true,
    bundleIdPrefixes: ['com.electron.ollama', 'com.ollama.'],
    names: ['ollama'],
    extraLocations: ['.ollama']
  },
  {
    id: 'lmstudio',
    ai: true,
    bundleIdPrefixes: ['ai.elementlabs.lmstudio'],
    names: ['lm studio'],
    extraLocations: ['.lmstudio', '.cache/lm-studio'],
    windowsLocations: ['AppData/Roaming/LM Studio']
  },
  {
    id: 'gpt4all',
    ai: true,
    bundleIdPrefixes: ['io.gpt4all.'],
    names: ['gpt4all'],
    extraLocations: ['Library/Application Support/nomic.ai'],
    windowsLocations: ['AppData/Roaming/nomic.ai', 'AppData/Local/nomic.ai']
  },
  { id: 'zed', ai: true, bundleIdPrefixes: ['dev.zed.'], names: ['zed'], extraLocations: [] },
  { id: 'gemini', ai: true, bundleIdPrefixes: [], names: ['gemini', 'antigravity'], extraLocations: ['.gemini'] },
  // Microsoft's own Copilot app is a different product; its Store package is not GitHub Copilot
  { id: 'copilot', ai: true, bundleIdPrefixes: [], names: ['copilot', 'github copilot'], extraLocations: ['.config/github-copilot'], notStorePublishers: ['microsoft'] },
  { id: 'jan', ai: true, bundleIdPrefixes: ['jan.ai.'], names: ['jan'], extraLocations: [] },
  { id: 'perplexity', ai: true, bundleIdPrefixes: ['ai.perplexity.'], names: ['perplexity'], extraLocations: [] },
  { id: 'msty', ai: true, bundleIdPrefixes: [], names: ['msty'], extraLocations: [] },
  { id: 'continue', ai: true, bundleIdPrefixes: [], names: ['continue'], extraLocations: ['.continue'] },
  { id: 'aider', ai: true, bundleIdPrefixes: [], names: ['aider'], extraLocations: ['.aider'] },
  { id: 'trae', ai: true, bundleIdPrefixes: [], names: ['trae'], extraLocations: ['.trae'] },
  { id: 'kiro', ai: true, bundleIdPrefixes: [], names: ['kiro'], extraLocations: ['.kiro'] }
];

/** Every location a known application may keep data in, for the given home layout. */
export function profileLocations(profile, isWindowsLayout) {
  return [...profile.extraLocations, ...(isWindowsLayout ? profile.windowsLocations || [] : [])];
}

/** "lm studio" -> "LM Studio"-like display name for a known application. */
export function profileDisplayName(profile) {
  const special = {
    claude: 'Claude Code',
    chatgpt: 'ChatGPT',
    codex: 'Codex',
    windsurf: 'Devin Desktop (Windsurf)',
    lmstudio: 'LM Studio',
    gpt4all: 'GPT4All',
    vscode: 'Visual Studio Code',
    copilot: 'GitHub Copilot'
  };
  return special[profile.id] || profile.names[0].replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Known applications that have data in this home folder. Command-line tools (Claude Code,
 * Codex, Ollama) have no application to drop; they are offered by the data they left.
 * Only the existence of each location is checked.
 */
export function listKnownApplicationsWithData({ platformServices }) {
  const found = [];
  for (const profile of KNOWN_APP_PROFILES) {
    for (const rel of profileLocations(profile, platformServices.isWindowsLayout)) {
      const location = path.join(platformServices.homeDir, rel);
      if (holdsData(location)) {
        // The folder that matched is shown to the user as the evidence
        found.push({ profileId: profile.id, name: profileDisplayName(profile), ai: profile.ai, location });
        break;
      }
    }
  }
  return found;
}

/** A real (not symlinked) folder with something in it, or a non-empty file. */
function holdsData(location) {
  const st = lstatSafe(location);
  if (!st || st.isSymbolicLink()) return false;
  if (st.isFile()) return st.size > 0;
  if (!st.isDirectory()) return false;
  try {
    return fs.readdirSync(location).some((name) => name !== '.DS_Store');
  } catch {
    // Unreadable: it exists, and the scan will report it
    return true;
  }
}

/** Whether a Store data folder belongs to the application named by these tokens. */
export function storePackageMatches(folderName, nameTokens, profile = null) {
  const names = storePackageNames(folderName);
  if (names.length === 0) return false;
  const publisher = names[0].includes('.') ? names[0].slice(0, names[0].indexOf('.')) : '';
  if (profile && (profile.notStorePublishers || []).includes(publisher)) return false;
  return names.some((n) => nameTokens.has(n));
}

/** The known application a Store package belongs to, or null. */
export function findStorePackageProfile(folderName) {
  return (
    KNOWN_APP_PROFILES.find((profile) => storePackageMatches(folderName, new Set(profile.names), profile)) || null
  );
}

export function findKnownAppProfile({ name = '', bundleId = '' }) {
  const lowerName = String(name || '').trim().toLowerCase();
  const lowerBundle = String(bundleId || '').trim().toLowerCase();
  return (
    KNOWN_APP_PROFILES.find(
      (profile) =>
        (lowerBundle && profile.bundleIdPrefixes.some((prefix) => lowerBundle.startsWith(prefix))) ||
        (lowerName && profile.names.includes(lowerName))
    ) || null
  );
}

/**
 * Name variants an application may use for its own directories:
 * "LM Studio" -> ["lm studio", "lmstudio", "lm-studio", "lm_studio"].
 */
export function deriveNameTokens(...names) {
  const tokens = new Set();
  for (const raw of names) {
    const lower = String(raw || '').trim().toLowerCase();
    if (lower.length < 3 || GENERIC_NAME_TOKENS.has(lower)) {
      continue;
    }
    tokens.add(lower);
    if (/\s/.test(lower)) {
      tokens.add(lower.replace(/\s+/g, ''));
      tokens.add(lower.replace(/\s+/g, '-'));
      tokens.add(lower.replace(/\s+/g, '_'));
    }
  }
  return tokens;
}

/**
 * Returns how a container entry name matches the application, or null.
 */
export function matchContainerEntry(entryName, { nameTokens, bundleId }) {
  const lower = String(entryName).toLowerCase();
  const candidates = [lower];
  for (const suffix of STRIPPABLE_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      candidates.push(lower.slice(0, -suffix.length));
      break;
    }
  }

  const lowerBundle = String(bundleId || '').toLowerCase();
  if (lowerBundle) {
    for (const candidate of candidates) {
      if (
        candidate === lowerBundle ||
        candidate.startsWith(`${lowerBundle}.`) ||
        candidate.endsWith(`.${lowerBundle}`) ||
        candidate.includes(`.${lowerBundle}.`)
      ) {
        return 'BUNDLE_IDENTIFIER';
      }
    }
  }
  for (const candidate of candidates) {
    if (nameTokens.has(candidate)) {
      return 'APPLICATION_NAME';
    }
  }
  return null;
}

/** Windows: the folder is named after the application, optionally with a known ending. */
function matchWindowsEntry(entryName, nameTokens, { storePackages = false } = {}, profile = null) {
  if (storePackages) {
    // Store data folders: "<Publisher>.<Name>_<hash>"; matched by the name part only
    return storePackageMatches(entryName, nameTokens, profile) ? 'APPLICATION_NAME' : null;
  }
  const lower = String(entryName).toLowerCase();
  if (nameTokens.has(lower)) {
    return 'APPLICATION_NAME';
  }
  for (const suffix of WINDOWS_NAME_SUFFIXES) {
    if (lower.endsWith(suffix) && nameTokens.has(lower.slice(0, -suffix.length))) {
      return 'APPLICATION_NAME';
    }
  }
  return null;
}

function lstatSafe(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Discovers existing data locations for an application under the given home directory.
 *
 * @returns {{ locations: Array<{role:string,path:string,matchedBy:string}>, unreadableContainers: string[] }}
 */
export function discoverApplicationFootprint({
  name,
  bundleId,
  bundleFileName = null,
  platformServices
}) {
  const homeDir = platformServices.homeDir;
  const profile = findKnownAppProfile({ name, bundleId });
  const nameTokens = deriveNameTokens(name, bundleFileName, ...(profile ? profile.names : []));
  const locations = new Map();
  const unreadableContainers = [];

  const add = (role, candidatePath, matchedBy) => {
    if (platformServices.isProtectedSystemPath(candidatePath)) {
      return;
    }
    const st = lstatSafe(candidatePath);
    // Regular files and real directories only: symlinked containers are never followed.
    if (!st || st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) {
      return;
    }
    if (!locations.has(candidatePath)) {
      locations.set(candidatePath, { role, path: candidatePath, matchedBy });
    }
  };

  // 1 (Windows). AppData folders: one directory listing each, matched by application name
  for (const container of platformServices.isWindowsLayout ? WINDOWS_APPDATA_CONTAINERS : []) {
    const containerDir = path.join(homeDir, container.rel);
    let entries;
    try {
      entries = fs.readdirSync(containerDir);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        unreadableContainers.push(containerDir);
      }
      continue;
    }
    for (const entry of entries) {
      const matchedBy = matchWindowsEntry(entry, nameTokens, container, profile);
      if (matchedBy) {
        add(container.role, path.join(containerDir, entry), matchedBy);
      }
    }
  }

  // 1. Library containers: one directory listing each, matched by bundle id / app name
  for (const container of platformServices.isWindowsLayout ? [] : LIBRARY_CONTAINERS) {
    const containerDir = path.join(homeDir, 'Library', container.rel);
    let entries;
    try {
      entries = fs.readdirSync(containerDir);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        unreadableContainers.push(containerDir);
      }
      continue;
    }
    for (const entry of entries) {
      const matchedBy = matchContainerEntry(entry, { nameTokens, bundleId });
      if (matchedBy) {
        add(container.role, path.join(containerDir, entry), matchedBy);
      }
    }
  }

  // 2. Hidden dot-directories and XDG-style locations in the home folder
  for (const parent of HOME_SLUG_PARENTS) {
    for (const token of nameTokens) {
      if (/\s/.test(token)) {
        continue;
      }
      add(parent.role, path.join(homeDir, parent.rel, `${parent.prefix}${token}`), 'APPLICATION_NAME');
    }
  }

  // 3. Locations known for this specific application
  if (profile) {
    for (const rel of profileLocations(profile, platformServices.isWindowsLayout)) {
      add('KNOWN_APP_LOCATION', path.join(homeDir, rel), 'KNOWN_APP_PROFILE');
    }
  }

  return {
    profileId: profile ? profile.id : null,
    isKnownAIApp: Boolean(profile && profile.ai),
    locations: Array.from(locations.values()),
    unreadableContainers
  };
}
