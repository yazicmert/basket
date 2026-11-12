import fs from 'node:fs';
import path from 'node:path';

/**
 * Permission model for scanning the user's real home folder.
 *
 * Each permission has a stable id, a documentation page on the project site, and (on macOS) the
 * System Settings pane where the user grants it. Status is determined passively: no probe here
 * triggers a macOS consent prompt or reads file contents.
 */

export const SITE_BASE_URL = 'https://yazicmert.github.io/basket';

export const PermissionStatus = Object.freeze({
  GRANTED: 'GRANTED',
  NOT_GRANTED: 'NOT_GRANTED',
  ASKED_ON_DEMAND: 'ASKED_ON_DEMAND',
  COVERED_BY_FULL_DISK_ACCESS: 'COVERED_BY_FULL_DISK_ACCESS',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN'
});

const DEFINITIONS = [
  {
    id: 'home-folder-scan',
    title: 'Scan my home folder',
    kind: 'IN_APP_CONSENT',
    required: true,
    summary:
      'Lets Artifact Atlas read file names, sizes and timestamps in the data folders of the application you drop, including hidden folders such as ~/.claude and ~/Library. Without it the app only shows built-in sample data.',
    docsPath: '/permissions/home-folder-scan/',
    settingsUrl: null
  },
  {
    id: 'full-disk-access',
    title: 'Full Disk Access',
    kind: 'MACOS_PRIVACY',
    required: false,
    summary:
      'A macOS privacy setting. Recommended: it lets the scan read other applications\' sandbox containers and protected Library folders without repeated prompts, so no leftovers are missed.',
    docsPath: '/permissions/full-disk-access/',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
  },
  {
    id: 'app-data',
    title: 'Data from other apps',
    kind: 'MACOS_PRIVACY',
    required: false,
    summary:
      'On macOS 14 and newer, macOS asks before one app reads another app\'s sandbox container (~/Library/Containers). Needed for sandboxed AI apps; covered automatically by Full Disk Access.',
    docsPath: '/permissions/app-data/',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy'
  },
  {
    id: 'files-and-folders',
    title: 'Desktop, Documents and Downloads',
    kind: 'MACOS_PRIVACY',
    required: false,
    summary:
      'macOS asks the first time a scan reaches a project stored in Desktop, Documents or Downloads. Needed only when an AI session worked in those folders; covered automatically by Full Disk Access.',
    docsPath: '/permissions/files-and-folders/',
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'
  }
];

export function listPermissionDefinitions() {
  return DEFINITIONS.map((d) => ({ ...d, docsUrl: `${SITE_BASE_URL}${d.docsPath}` }));
}

/**
 * Detects Full Disk Access without prompting: the per-user TCC directory is only listable by
 * processes that hold it. Reading a directory listing never raises a consent dialog.
 */
export function probeFullDiskAccess({ platform, homeDir }) {
  if (platform !== 'darwin') {
    return PermissionStatus.NOT_APPLICABLE;
  }
  try {
    fs.readdirSync(path.join(homeDir, 'Library', 'Application Support', 'com.apple.TCC'));
    return PermissionStatus.GRANTED;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return PermissionStatus.NOT_GRANTED;
    }
    return PermissionStatus.UNKNOWN;
  }
}

/**
 * Current status of every permission for the given home folder.
 */
export function describePermissions({ platform, homeDir, homeScanConsentAt = null }) {
  const fullDiskAccess = probeFullDiskAccess({ platform, homeDir });
  const coveredOrOnDemand =
    platform !== 'darwin'
      ? PermissionStatus.NOT_APPLICABLE
      : fullDiskAccess === PermissionStatus.GRANTED
        ? PermissionStatus.COVERED_BY_FULL_DISK_ACCESS
        : PermissionStatus.ASKED_ON_DEMAND;

  const statusById = {
    'home-folder-scan': homeScanConsentAt ? PermissionStatus.GRANTED : PermissionStatus.NOT_GRANTED,
    'full-disk-access': fullDiskAccess,
    'app-data': coveredOrOnDemand,
    'files-and-folders': coveredOrOnDemand
  };

  return listPermissionDefinitions().map((definition) => ({
    ...definition,
    status: statusById[definition.id],
    grantedAt: definition.id === 'home-folder-scan' ? homeScanConsentAt : null
  }));
}

/**
 * Resolves an allowlisted "open" target to a URL. The UI can only ask for a permission's
 * documentation page or its System Settings pane, never an arbitrary URL or path.
 */
export function resolveOpenTarget(target) {
  const [kind, id] = String(target || '').split(':');
  const definition = listPermissionDefinitions().find((d) => d.id === id);
  if (kind === 'docs' && id === 'overview') {
    return `${SITE_BASE_URL}/permissions/`;
  }
  if (!definition) {
    return null;
  }
  if (kind === 'docs') {
    return definition.docsUrl;
  }
  if (kind === 'settings') {
    return definition.settingsUrl;
  }
  return null;
}
