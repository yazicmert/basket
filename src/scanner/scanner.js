import fs from 'node:fs';
import path from 'node:path';
import { ScanStatus, createScanModel } from '../models/entities.js';

/** Dependency and version-control folders that are skipped inside project folders. */
export const PROJECT_BULK_DIRECTORIES = new Set([
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'Pods',
  '.gradle'
]);

export class Scanner {
  constructor({ platformServices, maxFiles = 300000 }) {
    this.platformServices = platformServices;
    this.maxFiles = maxFiles;
  }

  /**
   * Executes a permission-aware, cancellable background scan across authorized roots.
   *
   * @param {Object} params
   * @param {string|null} params.applicationId
   * @param {string[]} params.authorizedRoots
   * @param {AbortSignal} [params.signal]
   * @param {Function} [params.onProgress]
   * @param {boolean} [params.followInBoundarySymlinks=false]
   */
  async scan({
    applicationId = null,
    authorizedRoots = [],
    signal = null,
    onProgress = null,
    followInBoundarySymlinks = false,
    artificialDelayMs = 0,
    projectRoots = [],
    extraFiles = [],
    // 'skip': dependency and Git folders inside project folders are left out.
    // 'measure': they are measured as a whole (file count and size), never listed.
    bulkDirectoryMode = 'skip'
  }) {
    // Inside project folders, dependency and version-control folders are not listed file by
    // file: they can hold hundreds of thousands of files that no cleanup should touch one at
    // a time. They are recorded as skipped so the result says what it left out.
    const normalizedProjectRoots = projectRoots
      .filter(Boolean)
      .map((r) => this.platformServices.resolveRealPathSafe(r));
    const isInsideProject = (dirPath) =>
      normalizedProjectRoots.some((root) => dirPath === root || dirPath.startsWith(root + path.sep));
    const normalizedRoots = Array.from(
      new Set(
        authorizedRoots
          .filter(Boolean)
          .map((r) => this.platformServices.resolveRealPathSafe(r))
      )
    );

    const scanRecord = createScanModel({
      status: ScanStatus.RUNNING,
      applicationId,
      authorizedRoots: normalizedRoots
    });

    const rawEntries = [];
    const seenInodes = new Map(); // physicalInodeKey -> first canonicalPath
    // Inodes of measured files with more than one link, so a hardlinked file is counted once
    // across listed and measured files. Single-link files cannot be seen twice.
    const measuredInodes = new Set();
    let entriesSinceYield = 0;
    const visitedDirectories = new Set();
    const indexedFilePaths = new Set();
    let currentPath = null;
    let lastProgressAt = 0;

    const emitProgress = () => {
      if (typeof onProgress === 'function') {
        onProgress({
          scanId: scanRecord.id,
          status: scanRecord.status,
          currentPath,
          scannedLocationsCount: scanRecord.scannedLocations.length,
          discoveredArtifactCount: scanRecord.discoveredArtifactCount,
          totalLogicalBytes: scanRecord.totalLogicalBytes,
          totalPhysicalBytes: scanRecord.totalPhysicalBytes,
          deduplicatedHardlinkCount: scanRecord.deduplicatedHardlinkCount,
          permissionLimitationsCount: scanRecord.permissionLimitations.length,
          skippedSymlinksCount: scanRecord.skippedSymlinks.length,
          measuredFileCount: scanRecord.measuredFileCount,
          measuredPhysicalBytes: scanRecord.measuredPhysicalBytes,
          truncated: scanRecord.truncated
        });
      }
    };

    // Hitting the file cap must never look like a complete scan: totals and provenance
    // coverage are partial, so the scan record says so explicitly.
    const markTruncated = () => {
      scanRecord.truncated = true;
      scanRecord.maxFilesLimit = this.maxFiles;
    };

    /** Counts a file's size without listing it. Returns the bytes added. */
    const measureFile = (lstat, into) => {
      into.fileCount += 1;
      scanRecord.measuredFileCount += 1;
      if (Number(lstat.nlink || 1) > 1) {
        const key = `${lstat.dev}:${lstat.ino}`;
        if (seenInodes.has(key) || measuredInodes.has(key)) {
          return 0;
        }
        measuredInodes.add(key);
      }
      into.physicalBytes += lstat.size;
      scanRecord.measuredPhysicalBytes += lstat.size;
      return lstat.size;
    };

    const yieldNow = async () => {
      emitProgress();
      await new Promise((r) => setImmediate(r));
    };

    /**
     * Measures a dependency or Git folder as a whole: every file is counted and sized, none is
     * listed, so the folder adds to the total without using the file limit and can never be
     * selected for cleanup. Symlinks are not followed.
     */
    const measureFolder = async (folderPath, projectRoot) => {
      const entry = {
        path: folderPath,
        name: path.basename(folderPath),
        projectRoot,
        fileCount: 0,
        physicalBytes: 0,
        unreadableCount: 0
      };
      currentPath = folderPath;
      const stack = [folderPath];
      while (stack.length > 0) {
        if (signal?.aborted) {
          scanRecord.status = ScanStatus.CANCELLED;
          break;
        }
        const dir = stack.pop();
        let children;
        try {
          children = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          entry.unreadableCount += 1;
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink()) continue;
          const childPath = path.join(dir, child.name);
          if (child.isDirectory()) {
            stack.push(childPath);
          } else if (child.isFile()) {
            const st = fs.lstatSync(childPath, { throwIfNoEntry: false });
            if (st && st.isFile()) measureFile(st, entry);
          }
          if (++entriesSinceYield >= 2000) {
            entriesSinceYield = 0;
            await yieldNow();
          }
        }
      }
      scanRecord.bulkFolders.push(entry);
    };

    const projectRootOf = (dirPath) =>
      normalizedProjectRoots
        .filter((root) => dirPath === root || dirPath.startsWith(root + path.sep))
        .sort((a, b) => b.length - a.length)[0] || null;

    const indexFile = (filePath, fileName, check) => {
      const lstat = check.lstat;
      if (indexedFilePaths.has(check.canonicalPath)) {
        return;
      }
      // Past the file limit a file is still measured, so the total stays complete even
      // though the listing is not
      if (rawEntries.length >= this.maxFiles) {
        markTruncated();
        if ((lstat.mode & 0o400) !== 0) {
          indexedFilePaths.add(check.canonicalPath);
          measureFile(lstat, scanRecord.overflow);
        }
        return;
      }
      // Also check read permission on the file if mode lacks owner read bit
      const hasOwnerRead = (lstat.mode & 0o400) !== 0;
      if (!hasOwnerRead) {
        scanRecord.permissionLimitations.push({
          path: filePath,
          reason: 'File lacks read permissions (mode 000)',
          code: 'EACCES'
        });
        return;
      }
      indexedFilePaths.add(check.canonicalPath);

      const inodeKey = check.physicalInodeKey;
      const isDuplicatePhysicalInode = seenInodes.has(inodeKey) || measuredInodes.has(inodeKey);
      if (!isDuplicatePhysicalInode) {
        seenInodes.set(inodeKey, check.canonicalPath);
        scanRecord.totalPhysicalBytes += lstat.size;
      } else {
        scanRecord.deduplicatedHardlinkCount += 1;
      }

      scanRecord.totalLogicalBytes += lstat.size;
      scanRecord.discoveredArtifactCount += 1;

      rawEntries.push({
        name: fileName,
        canonicalPath: check.canonicalPath,
        parentDir: path.dirname(check.canonicalPath),
        extension: path.extname(fileName).toLowerCase(),
        isDirectory: false,
        sizeBytes: lstat.size,
        physicalInodeKey: inodeKey,
        hardlinkCount: Math.max(check.hardlinkCount, isDuplicatePhysicalInode ? 2 : 1),
        isDuplicatePhysicalInode,
        primaryInodePath: seenInodes.get(inodeKey) || check.canonicalPath,
        mode: lstat.mode,
        createdAt: lstat.birthtime ? lstat.birthtime.toISOString() : lstat.ctime.toISOString(),
        modifiedAt: lstat.mtime.toISOString(),
        mtimeMs: lstat.mtimeMs
      });
    };

    const walkDirectory = async (dirPath) => {
      if (signal?.aborted) {
        scanRecord.status = ScanStatus.CANCELLED;
        return;
      }

      const check = this.platformServices.inspectEntry(dirPath, normalizedRoots);
      if (!check.allowed) {
        if (check.reason === 'PERMISSION_DENIED') {
          scanRecord.permissionLimitations.push({
            path: dirPath,
            reason: 'Permission denied inspecting directory',
            code: check.errorCode || 'EACCES'
          });
        } else if (check.isSymlink) {
          scanRecord.skippedSymlinks.push({
            path: dirPath,
            target: check.realTarget || null,
            reason: check.reason
          });
        }
        return;
      }

      if (check.isSymlink && !followInBoundarySymlinks) {
        scanRecord.skippedSymlinks.push({
          path: dirPath,
          target: check.realTarget || null,
          reason: 'SYMLINK_SKIPPED_BY_POLICY'
        });
        return;
      }

      const dirRealPath = check.canonicalPath || check.realTarget || check.absPath;
      if (visitedDirectories.has(dirRealPath)) {
        return;
      }
      visitedDirectories.add(dirRealPath);
      scanRecord.scannedLocations.push(dirRealPath);

      // Live progress: report the directory being read and yield to the event loop so the
      // progress endpoint and cancellation stay responsive during large scans.
      currentPath = dirRealPath;
      const nowMs = Date.now();
      if (nowMs - lastProgressAt >= 40) {
        lastProgressAt = nowMs;
        emitProgress();
        await new Promise((r) => setImmediate(r));
        if (signal?.aborted) {
          scanRecord.status = ScanStatus.CANCELLED;
          return;
        }
      }

      // Test whether directory is readable (fs.accessSync R_OK + readdirSync)
      let dirEntries = [];
      try {
        fs.accessSync(dirRealPath, fs.constants.R_OK | fs.constants.X_OK);
        dirEntries = fs.readdirSync(dirRealPath, { withFileTypes: true });
      } catch (err) {
        scanRecord.permissionLimitations.push({
          path: dirRealPath,
          reason: 'Cannot list directory contents due to permissions',
          code: err.code || 'EACCES'
        });
        emitProgress();
        return;
      }

      for (const dirent of dirEntries) {
        if (signal?.aborted) {
          scanRecord.status = ScanStatus.CANCELLED;
          return;
        }

        if (artificialDelayMs > 0) {
          await new Promise((r) => setTimeout(r, artificialDelayMs));
          if (signal?.aborted) {
            scanRecord.status = ScanStatus.CANCELLED;
            return;
          }
        }

        const childPath = path.join(dirRealPath, dirent.name);
        const childCheck = this.platformServices.inspectEntry(childPath, normalizedRoots);

        if (!childCheck.allowed) {
          if (childCheck.reason === 'PERMISSION_DENIED') {
            scanRecord.permissionLimitations.push({
              path: childPath,
              reason: 'Permission denied reading entry metadata',
              code: childCheck.errorCode || 'EACCES'
            });
          } else if (childCheck.isSymlink) {
            scanRecord.skippedSymlinks.push({
              path: childPath,
              target: childCheck.realTarget || null,
              reason: childCheck.reason
            });
          }
          continue;
        }

        if (childCheck.isSymlink) {
          scanRecord.skippedSymlinks.push({
            path: childPath,
            target: childCheck.realTarget || null,
            reason: followInBoundarySymlinks ? 'SYMLINK_IN_BOUNDARY' : 'SYMLINK_NOT_FOLLOWED'
          });
          if (!followInBoundarySymlinks) {
            continue;
          }
        }

        const lstat = childCheck.lstat;
        if (lstat.isDirectory()) {
          // Do not descend into .app bundles found inside a workspace
          if (dirent.name.endsWith('.app')) {
            continue;
          }
          if (PROJECT_BULK_DIRECTORIES.has(dirent.name) && isInsideProject(dirRealPath)) {
            if (bulkDirectoryMode === 'measure') {
              await measureFolder(childPath, projectRootOf(dirRealPath));
            } else {
              scanRecord.skippedBulkDirectories.push(childPath);
            }
            continue;
          }
          await walkDirectory(childPath);
        } else if (lstat.isFile()) {
          indexFile(childPath, dirent.name, childCheck);
          if (++entriesSinceYield >= 25) {
            entriesSinceYield = 0;
            await yieldNow();
          }
        }
      }

      emitProgress();
    };

    // Single files named by session tool calls, each checked against itself as its root so
    // nothing beside it is reachable. They are read before any folder is walked: they are the
    // files whose origin is recorded, so a scan that reaches the file limit must not lose them.
    for (const filePath of extraFiles) {
      if (signal?.aborted) {
        scanRecord.status = ScanStatus.CANCELLED;
        break;
      }
      if (rawEntries.length >= this.maxFiles) {
        markTruncated();
        break;
      }
      const resolved = this.platformServices.resolveRealPathSafe(filePath);
      const check = this.platformServices.inspectEntry(resolved, [resolved]);
      if (check.allowed && !check.isSymlink && check.lstat.isFile()) {
        currentPath = path.dirname(resolved);
        indexFile(resolved, path.basename(resolved), check);
        if (rawEntries.length % 200 === 0) {
          emitProgress();
          await new Promise((r) => setImmediate(r));
        }
      }
    }

    for (const root of normalizedRoots) {
      if (signal?.aborted) {
        scanRecord.status = ScanStatus.CANCELLED;
        break;
      }
      if (!fs.existsSync(root)) {
        continue;
      }
      // A root may be a single file (e.g. a preferences .plist attributed to the application)
      const rootCheck = this.platformServices.inspectEntry(root, normalizedRoots);
      if (rootCheck.allowed && !rootCheck.isSymlink && rootCheck.lstat.isFile()) {
        currentPath = root;
        indexFile(root, path.basename(root), rootCheck);
        continue;
      }
      await walkDirectory(root);
    }

    if (scanRecord.status !== ScanStatus.CANCELLED) {
      scanRecord.status = ScanStatus.COMPLETED;
    }
    scanRecord.completedAt = new Date().toISOString();
    currentPath = null;
    emitProgress();

    return {
      scan: scanRecord,
      rawEntries
    };
  }
}
