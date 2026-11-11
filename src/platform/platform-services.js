import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const SYSTEM_PROTECTED_PREFIXES = [
  '/System',
  '/bin',
  '/sbin',
  '/usr',
  '/etc',
  '/dev',
  '/proc',
  '/sys',
  '/Library/Apple',
  '/Library/Application Support/com.apple.TCC',
  '/private/var/db',
  '/var/db'
];

const HOME_PROTECTED_RELATIVES = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
  '.config/gcloud',
  'Library/Keychains',
  'Library/Application Support/com.apple.TCC',
  'Library/Safari',
  'Library/Mail',
  'Library/Messages'
];

export class PlatformServices {
  constructor(options = {}) {
    this.homeDir = path.resolve(options.homeDir || os.homedir());
    this.platform = options.platform || process.platform;
  }

  /**
   * Resolves canonical path safely without throwing when path doesn't exist.
   */
  resolveRealPathSafe(targetPath) {
    try {
      return fs.realpathSync(targetPath);
    } catch {
      return path.resolve(targetPath);
    }
  }

  /**
   * Checks whether a candidate path is within at least one authorized root directory.
   */
  isWithinAuthorizedRoots(candidatePath, authorizedRoots = []) {
    const normalizedCandidate = path.resolve(candidatePath);
    for (const root of authorizedRoots) {
      const normalizedRoot = path.resolve(root);
      if (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(normalizedRoot + path.sep)
      ) {
        return true;
      }
      const realRoot = this.resolveRealPathSafe(root);
      if (
        normalizedCandidate === realRoot ||
        normalizedCandidate.startsWith(realRoot + path.sep)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the path falls inside a protected OS or sensitive credential location.
   */
  isProtectedSystemPath(targetPath) {
    const resolved = path.resolve(targetPath);
    if (resolved === '/' || resolved === this.homeDir) {
      return true;
    }

    for (const prefix of SYSTEM_PROTECTED_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + '/')) {
        return true;
      }
    }

    for (const rel of HOME_PROTECTED_RELATIVES) {
      const fullProtected = path.join(this.homeDir, rel);
      if (resolved === fullProtected || resolved.startsWith(fullProtected + path.sep)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Inspects an entry with lstat (does not follow symlinks by default) and validates symlink boundaries.
   */
  inspectEntry(entryPath, authorizedRoots = []) {
    const absPath = path.resolve(entryPath);
    if (this.isProtectedSystemPath(absPath)) {
      return {
        allowed: false,
        reason: 'PROTECTED_SYSTEM_PATH',
        absPath
      };
    }

    let lstat;
    try {
      lstat = fs.lstatSync(absPath);
    } catch (err) {
      return {
        allowed: false,
        reason: err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : 'NOT_FOUND',
        errorCode: err.code || 'UNKNOWN',
        absPath
      };
    }

    if (lstat.isSymbolicLink()) {
      let realTarget;
      try {
        realTarget = fs.realpathSync(absPath);
      } catch {
        return {
          allowed: false,
          isSymlink: true,
          reason: 'BROKEN_SYMLINK',
          absPath
        };
      }

      if (this.isProtectedSystemPath(realTarget)) {
        return {
          allowed: false,
          isSymlink: true,
          realTarget,
          reason: 'SYMLINK_TO_PROTECTED_PATH',
          absPath
        };
      }

      const insideBoundary = this.isWithinAuthorizedRoots(realTarget, authorizedRoots);
      if (!insideBoundary) {
        return {
          allowed: false,
          isSymlink: true,
          realTarget,
          reason: 'SYMLINK_OUTSIDE_BOUNDARY',
          absPath
        };
      }

      return {
        allowed: true,
        isSymlink: true,
        realTarget,
        lstat,
        absPath
      };
    }

    if (authorizedRoots.length > 0 && !this.isWithinAuthorizedRoots(absPath, authorizedRoots)) {
      return {
        allowed: false,
        reason: 'OUTSIDE_AUTHORIZED_BOUNDARY',
        absPath
      };
    }

    return {
      allowed: true,
      isSymlink: false,
      lstat,
      absPath,
      canonicalPath: this.resolveRealPathSafe(absPath),
      physicalInodeKey: `${lstat.dev}:${lstat.ino}`,
      hardlinkCount: Number(lstat.nlink || 1)
    };
  }

  /**
   * Verifies that no ancestor component between an authorized root and targetPath is a symlink.
   */
  hasSymlinkedAncestor(targetPath, authorizedRoots = []) {
    const absTarget = path.resolve(targetPath);
    const matchingRoot = authorizedRoots
      .map((r) => path.resolve(r))
      .find((r) => absTarget === r || absTarget.startsWith(r + path.sep));

    if (!matchingRoot) {
      return false;
    }

    const rel = path.relative(matchingRoot, absTarget);
    if (!rel || rel.startsWith('..')) {
      return false;
    }

    const parts = rel.split(path.sep);
    let current = matchingRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      current = path.join(current, parts[i]);
      try {
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Computes SHA-256 hash of a file up to maxBytes (default 64MB) for quarantine verification.
   */
  computeFileSha256(filePath, maxBytes = 64 * 1024 * 1024) {
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.size > maxBytes) {
      return null;
    }
    const hash = crypto.createHash('sha256');
    const buffer = fs.readFileSync(filePath);
    hash.update(buffer);
    return hash.digest('hex');
  }

  /**
   * Standard macOS Library and dotfile roots for an application identity.
   */
  getStandardMacOSLocations({ bundleId, appName }) {
    const locations = [];
    const libraryDir = path.join(this.homeDir, 'Library');
    if (appName) {
      locations.push(
        { role: 'APP_SUPPORT', path: path.join(libraryDir, 'Application Support', appName) },
        { role: 'LOGS', path: path.join(libraryDir, 'Logs', appName) },
        { role: 'CACHES', path: path.join(libraryDir, 'Caches', appName) }
      );
    }
    if (bundleId) {
      locations.push(
        { role: 'APP_SUPPORT', path: path.join(libraryDir, 'Application Support', bundleId) },
        { role: 'CACHES', path: path.join(libraryDir, 'Caches', bundleId) },
        { role: 'LOGS', path: path.join(libraryDir, 'Logs', bundleId) },
        {
          role: 'SAVED_STATE',
          path: path.join(libraryDir, 'Saved Application State', `${bundleId}.savedState`)
        },
        { role: 'WEBKIT_DATA', path: path.join(libraryDir, 'WebKit', bundleId) }
      );
    }
    return locations;
  }

  /**
   * Reveals a file in Finder on macOS (or returns dry-run action info on non-macOS).
   */
  async revealInFinder(targetPath) {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: 'FILE_NOT_FOUND', path: resolved };
    }
    if (this.platform === 'darwin') {
      return new Promise((resolve) => {
        execFile('/usr/bin/open', ['-R', resolved], (err) => {
          if (err) {
            resolve({ ok: false, error: err.message, path: resolved });
          } else {
            resolve({ ok: true, action: 'OPEN_REVEAL_MACOS', path: resolved });
          }
        });
      });
    }
    return {
      ok: true,
      action: 'REVEAL_SIMULATED_NON_MACOS',
      commandPreview: `open -R ${JSON.stringify(resolved)}`,
      path: resolved
    };
  }
}
