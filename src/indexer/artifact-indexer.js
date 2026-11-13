import path from 'node:path';
import { createArtifactModel } from '../models/entities.js';

export class ArtifactIndexer {
  /**
   * Indexes raw filesystem scan entries into canonical Artifact models,
   * annotating hardlink/physical inode sharing across paths.
   */
  indexEntries({ rawEntries, scanId, applicationId = null, workspaces = [] }) {
    // Group entries sharing the same physical inode key
    const pathsByInode = new Map();
    for (const entry of rawEntries) {
      const list = pathsByInode.get(entry.physicalInodeKey) || [];
      list.push(entry.canonicalPath);
      pathsByInode.set(entry.physicalInodeKey, list);
    }

    const sortedWorkspaces = [...workspaces].sort(
      (a, b) => b.canonicalPath.length - a.canonicalPath.length
    );

    return rawEntries.map((entry) => {
      const siblingPaths = pathsByInode.get(entry.physicalInodeKey) || [entry.canonicalPath];
      const sharedDependencyIndicators = [];

      if (siblingPaths.length > 1 || entry.hardlinkCount > 1) {
        const others = siblingPaths.filter((p) => p !== entry.canonicalPath);
        sharedDependencyIndicators.push(
          others.length > 0
            ? `Hardlinked physical inode (${entry.physicalInodeKey}) shared with ${others.join(', ')}`
            : `Hardlinked physical inode (${entry.physicalInodeKey}, nlink=${entry.hardlinkCount})`
        );
      }

      const matchedWorkspace = sortedWorkspaces.find(
        (ws) =>
          entry.canonicalPath === ws.canonicalPath ||
          entry.canonicalPath.startsWith(ws.canonicalPath + path.sep)
      );

      return createArtifactModel({
        name: entry.name,
        canonicalPath: entry.canonicalPath,
        parentDir: entry.parentDir,
        extension: entry.extension,
        isDirectory: entry.isDirectory,
        sizeBytes: entry.sizeBytes,
        physicalInodeKey: entry.physicalInodeKey,
        hardlinkCount: Math.max(entry.hardlinkCount, siblingPaths.length),
        mode: entry.mode,
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
        mtimeMs: entry.mtimeMs,
        applicationId,
        workspaceId: matchedWorkspace ? matchedWorkspace.id : null,
        sharedDependencyIndicators,
        scanId
      });
    });
  }
}
