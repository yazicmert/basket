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
  '/private/etc',
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

/** Windows system locations, relative to the system drive. Compared without regard to case. */
const WINDOWS_PROTECTED_RELATIVES = [
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData\\Microsoft',
  'System Volume Information',
  '$Recycle.Bin',
  'Recovery'
];

const WINDOWS_HOME_PROTECTED_RELATIVES = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  'AppData\\Roaming\\gnupg',
  'AppData\\Roaming\\Microsoft\\Credentials',
  'AppData\\Roaming\\Microsoft\\Protect',
  'AppData\\Roaming\\Microsoft\\Crypto',
  'AppData\\Roaming\\Microsoft\\SystemCertificates',
  'AppData\\Local\\Microsoft\\Credentials',
  'AppData\\Local\\Microsoft\\Vault'
];

const isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p);

/** True when `candidate` is `base` or inside it; Windows paths compare without case. */
function isSameOrInside(candidate, base, separator, ignoreCase) {
  const a = ignoreCase ? candidate.toLowerCase() : candidate;
  const b = ignoreCase ? base.toLowerCase() : base;
  return a === b || a.startsWith(b.endsWith(separator) ? b : b + separator);
}

export class PlatformServices {
  constructor(options = {}) {
    const rawHome = path.resolve(options.homeDir || os.homedir());
    try {
      this.homeDir = fs.realpathSync(rawHome);
    } catch {
      this.homeDir = rawHome;
    }
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
    const realCandidate = this.resolveRealPathSafe(candidatePath);
    for (const root of authorizedRoots) {
      const normalizedRoot = path.resolve(root);
      const realRoot = this.resolveRealPathSafe(root);
      if (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(normalizedRoot + path.sep) ||
        normalizedCandidate === realRoot ||
        normalizedCandidate.startsWith(realRoot + path.sep) ||
        realCandidate === normalizedRoot ||
        realCandidate.startsWith(normalizedRoot + path.sep) ||
        realCandidate === realRoot ||
        realCandidate.startsWith(realRoot + path.sep)
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
    // A filesystem or drive root, or the home folder itself
    if (path.parse(resolved).root === resolved || resolved === this.homeDir) {
      return true;
    }

    if (isWindowsPath(resolved)) {
      if (resolved.toLowerCase() === this.homeDir.toLowerCase()) {
        return true;
      }
      const drive = resolved.slice(0, 3);
      for (const rel of WINDOWS_PROTECTED_RELATIVES) {
        if (isSameOrInside(resolved, drive + rel, '\\', true)) {
          return true;
        }
      }
      for (const rel of WINDOWS_HOME_PROTECTED_RELATIVES) {
        if (isSameOrInside(resolved, `${this.homeDir}\\${rel}`, '\\', true)) {
          return true;
        }
      }
      return false;
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
    const realTarget = this.resolveRealPathSafe(targetPath);
    const matchingRoot = authorizedRoots
      .map((r) => path.resolve(r))
      .find((r) => {
        const realRoot = this.resolveRealPathSafe(r);
        return (
          absTarget === r ||
          absTarget.startsWith(r + path.sep) ||
          realTarget === realRoot ||
          realTarget.startsWith(realRoot + path.sep)
        );
      });

    if (!matchingRoot) {
      return false;
    }

    const effectiveRoot = this.resolveRealPathSafe(matchingRoot);
    const effectiveTarget = absTarget.startsWith(effectiveRoot + path.sep) ? absTarget : realTarget;
    const rel = path.relative(effectiveRoot, effectiveTarget);
    if (!rel || rel.startsWith('..')) {
      return false;
    }

    const parts = rel.split(path.sep);
    let current = effectiveRoot;
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
   * Computes the SHA-256 hash of a regular file using bounded-memory chunked reads.
   * There is no size cutoff: every quarantined payload (including multi-GB model weights)
   * gets an integrity digest. Returns null only when the path is not a regular file.
   */
  computeFileSha256(filePath) {
    const st = fs.lstatSync(filePath);
    if (!st.isFile()) {
      return null;
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, 'r');
    try {
      let bytesRead;
      while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }

  /**
   * lstat-based existence check: true for dangling symlinks too (fs.existsSync follows links
   * and would report them as absent, letting a rename silently replace them).
   */
  entryExists(targetPath) {
    try {
      fs.lstatSync(targetPath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Moves a regular file without ever overwriting an existing destination and without losing
   * the source: same-volume moves are an atomic rename; cross-volume moves (EXDEV) copy with
   * COPYFILE_EXCL, verify the copy's SHA-256 against the source digest, and only then unlink
   * the source. A failed or mismatching copy is removed and the source is left untouched.
   */
  moveFileNoClobber(sourcePath, destinationPath, expectedSha256 = null) {
    if (this.entryExists(destinationPath)) {
      const err = new Error(`MOVE_DESTINATION_EXISTS: '${destinationPath}' already exists.`);
      err.code = 'EEXIST';
      throw err;
    }
    try {
      fs.renameSync(sourcePath, destinationPath);
      return { method: 'RENAME' };
    } catch (err) {
      if (err.code !== 'EXDEV') {
        throw err;
      }
    }

    const sourceStat = fs.lstatSync(sourcePath);
    const sourceSha = expectedSha256 || this.computeFileSha256(sourcePath);
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    let copySha = null;
    try {
      copySha = this.computeFileSha256(destinationPath);
    } catch {
      copySha = null;
    }
    if (!sourceSha || copySha !== sourceSha) {
      fs.rmSync(destinationPath, { force: true });
      const err = new Error(
        'MOVE_COPY_VERIFICATION_FAILED: Cross-volume copy did not match the source SHA-256; source left in place.'
      );
      err.code = 'ECOPYVERIFY';
      throw err;
    }
    try {
      fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
      fs.chmodSync(destinationPath, sourceStat.mode & 0o7777);
    } catch {
      // Metadata preservation is best-effort on non-POSIX mounts
    }
    fs.unlinkSync(sourcePath);
    return { method: 'COPY_VERIFY_UNLINK' };
  }

  /**
   * Returns the nearest ancestor directory (inclusive) that contains a `.git` entry
   * (directory, or gitfile for worktrees/submodules), or null. Uses lstat only.
   */
  findGitRepositoryRoot(startDir, cache = null) {
    const visited = [];
    let current = path.resolve(startDir);
    let found = null;
    for (;;) {
      if (cache && cache.has(current)) {
        found = cache.get(current);
        break;
      }
      visited.push(current);
      try {
        fs.lstatSync(path.join(current, '.git'));
        found = current;
        break;
      } catch {
        // No .git here; keep walking up
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    if (cache) {
      for (const dir of visited) {
        cache.set(dir, found);
      }
    }
    return found;
  }

  /** True when this home folder is laid out the Windows way (AppData instead of Library). */
  get isWindowsLayout() {
    return this.platform === 'win32';
  }

  /** Per-user application data folders on Windows: Roaming, Local and LocalLow. */
  getWindowsAppDataDirs() {
    const appData = path.join(this.homeDir, 'AppData');
    return {
      roaming: path.join(appData, 'Roaming'),
      local: path.join(appData, 'Local'),
      localLow: path.join(appData, 'LocalLow')
    };
  }

  /** Standard per-user data locations for an application, by its name, on Windows. */
  getStandardWindowsLocations({ appName }) {
    if (!appName) {
      return [];
    }
    const dirs = this.getWindowsAppDataDirs();
    return [
      { role: 'APP_SUPPORT', path: path.join(dirs.roaming, appName) },
      { role: 'LOCAL_APP_DATA', path: path.join(dirs.local, appName) },
      { role: 'LOCAL_APP_DATA', path: path.join(dirs.localLow, appName) }
    ];
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
    if (this.platform === 'win32' && process.platform === 'win32') {
      return new Promise((resolve) => {
        // File Explorer selects the file; it reports a non-zero exit code even when it worked
        execFile('explorer.exe', [`/select,${resolved}`], () => {
          resolve({ ok: true, action: 'EXPLORER_SELECT_WINDOWS', path: resolved });
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
