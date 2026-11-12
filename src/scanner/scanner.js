import fs from 'node:fs';
import path from 'node:path';
import { ScanStatus, createScanModel } from '../models/entities.js';

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
    artificialDelayMs = 0
  }) {
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

    const indexFile = (filePath, fileName, check) => {
      const lstat = check.lstat;
      if (indexedFilePaths.has(check.canonicalPath)) {
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
      const isDuplicatePhysicalInode = seenInodes.has(inodeKey);
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
        primaryInodePath: seenInodes.get(inodeKey),
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

      if (rawEntries.length >= this.maxFiles) {
        markTruncated();
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

        if (rawEntries.length >= this.maxFiles) {
          markTruncated();
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
          await walkDirectory(childPath);
        } else if (lstat.isFile()) {
          indexFile(childPath, dirent.name, childCheck);
          if (scanRecord.discoveredArtifactCount % 25 === 0) {
            emitProgress();
            await new Promise((r) => setImmediate(r));
          }
        }
      }

      emitProgress();
    };

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
        if (rawEntries.length >= this.maxFiles) {
          markTruncated();
        } else {
          currentPath = root;
          indexFile(root, path.basename(root), rootCheck);
        }
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
