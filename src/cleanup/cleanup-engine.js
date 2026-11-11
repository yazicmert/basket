import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RiskCategory,
  ProvenanceConfidence,
  RestoreConflictStrategy,
  createQuarantineEntryModel,
  stableId
} from '../models/entities.js';

export class CleanupEngine {
  constructor({ platformServices, sqliteStore, quarantineRoot }) {
    this.platformServices = platformServices;
    this.sqliteStore = sqliteStore;
    this.quarantineRoot = path.resolve(
      quarantineRoot || path.join(platformServices.homeDir, '.artifact-atlas', 'quarantine')
    );
  }

  /**
   * Performs pre-flight verification on a single artifact right before review or execution.
   */
  verifyArtifactPreFlight(artifact, authorizedRoots = []) {
    const issues = [];
    const warnings = [];

    if (!artifact || !artifact.canonicalPath) {
      return {
        valid: false,
        code: 'INVALID_ARTIFACT',
        issues: ['Artifact record or canonical path is missing.'],
        warnings
      };
    }

    // 1. Reject path traversal tokens in raw path
    if (String(artifact.canonicalPath).split(path.sep).includes('..')) {
      return {
        valid: false,
        code: 'PATH_TRAVERSAL_REJECTED',
        issues: ['Path contains parent traversal segment (..).'],
        warnings
      };
    }

    const absPath = path.resolve(artifact.canonicalPath);

    // 2. Reject protected system or credential locations
    if (this.platformServices.isProtectedSystemPath(absPath)) {
      return {
        valid: false,
        code: 'PROTECTED_LOCATION_REJECTED',
        issues: [`Path '${absPath}' is inside a protected system or credential location.`],
        warnings
      };
    }

    // 3. Reject PROTECTED risk category
    if (artifact.cleanupClassification === RiskCategory.PROTECTED) {
      return {
        valid: false,
        code: 'PROTECTED_ARTIFACT_REJECTED',
        issues: [
          `Artifact '${artifact.name}' is classified as PROTECTED (${artifact.cleanupExplanation}).`
        ],
        warnings
      };
    }

    // 4. Reject symlinked ancestor directories inside authorized roots
    if (
      authorizedRoots.length > 0 &&
      this.platformServices.hasSymlinkedAncestor(absPath, authorizedRoots)
    ) {
      return {
        valid: false,
        code: 'SYMLINK_ANCESTOR_REJECTED',
        issues: ['An ancestor directory along the path was replaced by a symbolic link.'],
        warnings
      };
    }

    // 5. Re-stat exact file on disk without following symlinks
    let lstat;
    try {
      lstat = fs.lstatSync(absPath);
    } catch (err) {
      return {
        valid: false,
        code: err.code === 'ENOENT' ? 'FILE_MISSING_ON_DISK' : 'PERMISSION_CHANGED_OR_DENIED',
        issues: [`Cannot stat file on disk (${err.code || err.message}).`],
        warnings
      };
    }

    // 6. Reject symbolic links directly
    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        code: 'SYMLINK_TARGET_REJECTED',
        issues: ['Target path is a symbolic link; Artifact Atlas refuses to quarantine symlinks.'],
        warnings
      };
    }

    // 7. Verify canonical realpath matches scan record
    let realNow;
    try {
      realNow = fs.realpathSync(absPath);
    } catch {
      return {
        valid: false,
        code: 'REALPATH_RESOLUTION_FAILED',
        issues: ['Could not verify canonical realpath of file.'],
        warnings
      };
    }

    if (realNow !== artifact.canonicalPath) {
      return {
        valid: false,
        code: 'CANONICAL_PATH_CHANGED',
        issues: [
          `Canonical path changed since scan (expected '${artifact.canonicalPath}', found '${realNow}').`
        ],
        warnings
      };
    }

    // 8. Check whether inode identity, size, modification timestamp, or permissions changed since scan
    const currentInodeKey = `${lstat.dev}:${lstat.ino}`;
    if (artifact.physicalInodeKey && currentInodeKey !== artifact.physicalInodeKey) {
      issues.push(
        `Physical inode changed since scan (${artifact.physicalInodeKey} -> ${currentInodeKey}).`
      );
    }
    if (lstat.size !== artifact.sizeBytes) {
      issues.push(
        `File size changed since scan (${artifact.sizeBytes} bytes -> ${lstat.size} bytes).`
      );
    }
    if (artifact.mtimeMs && Math.abs(lstat.mtimeMs - artifact.mtimeMs) > 5) {
      issues.push('File modification timestamp changed since scan.');
    }
    if (artifact.mode && lstat.mode !== artifact.mode) {
      issues.push(
        `File permissions/mode changed since scan (${artifact.mode.toString(8)} -> ${lstat.mode.toString(8)}).`
      );
    }

    if (issues.length > 0) {
      return {
        valid: false,
        code: 'FILE_CHANGED_SINCE_SCAN',
        issues,
        warnings
      };
    }

    // 9. Shared dependencies & multi-session warnings
    if (artifact.sharedDependencyIndicators && artifact.sharedDependencyIndicators.length > 0) {
      warnings.push(...artifact.sharedDependencyIndicators);
    }
    if (lstat.nlink > 1) {
      warnings.push(
        `File has ${lstat.nlink} physical hardlinks; moving this path into quarantine detaches it from its directory without freeing disk blocks until all hardlinks are removed.`
      );
    }

    return {
      valid: true,
      code: 'OK',
      lstat,
      issues: [],
      warnings
    };
  }

  /**
   * Builds a structured review dialog payload and deterministic confirmation token.
   * Blocks bulk cleanup of HIGH-risk or UNKNOWN-provenance items by default.
   */
  prepareCleanupReview({
    artifacts = [],
    authorizedRoots = [],
    allowHighRiskSingleOverride = false
  }) {
    const isBulk = artifacts.length > 1;
    const eligibleItems = [];
    const blockedItems = [];
    let totalReclaimableBytes = 0;
    const seenInodes = new Set();

    for (const art of artifacts) {
      // Enforce bulk cleanup safety rule (Section 9):
      // "Do not enable bulk cleanup for high-risk or unknown artifacts by default."
      if (
        isBulk &&
        (art.cleanupClassification === RiskCategory.HIGH ||
          art.provenanceConfidence === ProvenanceConfidence.UNKNOWN)
      ) {
        blockedItems.push({
          artifactId: art.id,
          name: art.name,
          canonicalPath: art.canonicalPath,
          riskCategory: art.cleanupClassification,
          provenanceConfidence: art.provenanceConfidence,
          code: 'BULK_HIGH_RISK_OR_UNKNOWN_BLOCKED',
          reasons: [
            'Bulk cleanup is disabled for HIGH-risk or UNKNOWN-provenance artifacts. Select and review this item individually if you still wish to quarantine it.'
          ]
        });
        continue;
      }

      if (
        !isBulk &&
        (art.cleanupClassification === RiskCategory.HIGH ||
          art.provenanceConfidence === ProvenanceConfidence.UNKNOWN) &&
        !allowHighRiskSingleOverride
      ) {
        blockedItems.push({
          artifactId: art.id,
          name: art.name,
          canonicalPath: art.canonicalPath,
          riskCategory: art.cleanupClassification,
          provenanceConfidence: art.provenanceConfidence,
          code: 'HIGH_RISK_CONFIRMATION_REQUIRED',
          reasons: [
            'This artifact is HIGH risk or has UNKNOWN provenance. Explicit high-risk acknowledgment is required.'
          ]
        });
        continue;
      }

      const preflight = this.verifyArtifactPreFlight(art, authorizedRoots);
      if (!preflight.valid) {
        blockedItems.push({
          artifactId: art.id,
          name: art.name,
          canonicalPath: art.canonicalPath,
          riskCategory: art.cleanupClassification,
          provenanceConfidence: art.provenanceConfidence,
          code: preflight.code,
          reasons: preflight.issues
        });
        continue;
      }

      eligibleItems.push({
        artifactId: art.id,
        name: art.name,
        canonicalPath: art.canonicalPath,
        sizeBytes: art.sizeBytes,
        artifactType: art.artifactType,
        riskCategory: art.cleanupClassification,
        provenanceConfidence: art.provenanceConfidence,
        explanation: art.cleanupExplanation,
        consequences: art.deletionConsequences,
        warnings: preflight.warnings
      });

      const inodeKey = art.physicalInodeKey || art.canonicalPath;
      if (!seenInodes.has(inodeKey)) {
        seenInodes.add(inodeKey);
        totalReclaimableBytes += art.sizeBytes;
      }
    }

    const tokenSeed = eligibleItems
      .map((i) => `${i.artifactId}:${i.canonicalPath}:${i.sizeBytes}`)
      .sort()
      .join('|');
    const confirmationToken =
      eligibleItems.length > 0
        ? `confirm_${crypto.createHash('sha256').update(tokenSeed).digest('hex').slice(0, 20)}`
        : null;

    return {
      operationLabel: 'Move to Recoverable Quarantine',
      quarantineVaultLocation: this.quarantineRoot,
      isBulkRequest: isBulk,
      eligibleItems,
      blockedItems,
      totalEligibleCount: eligibleItems.length,
      totalBlockedCount: blockedItems.length,
      totalReclaimableBytes,
      confirmationToken
    };
  }

  /**
   * Moves verified artifacts into the managed Quarantine Vault after re-running all 10 safety checks
   * and validating the explicit confirmation token.
   */
  executeQuarantine({
    artifacts = [],
    authorizedRoots = [],
    confirmationToken = null,
    allowHighRiskSingleOverride = false
  }) {
    const review = this.prepareCleanupReview({
      artifacts,
      authorizedRoots,
      allowHighRiskSingleOverride
    });

    if (!review.confirmationToken || confirmationToken !== review.confirmationToken) {
      throw new Error(
        'EXPLICIT_CONFIRMATION_REQUIRED: Valid confirmationToken from review dialog is required before moving files to quarantine.'
      );
    }

    if (review.eligibleItems.length === 0) {
      return {
        batchId: null,
        quarantinedEntries: [],
        blockedItems: review.blockedItems
      };
    }

    const batchId = `qbatch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const batchDir = path.join(this.quarantineRoot, 'batches', batchId);
    fs.mkdirSync(batchDir, { recursive: true });

    const artifactById = new Map(artifacts.map((a) => [a.id, a]));
    const quarantinedEntries = [];
    const runtimeBlocked = [...review.blockedItems];

    for (const item of review.eligibleItems) {
      const artifact = artifactById.get(item.artifactId);
      // Re-run preflight right before atomic move (TOCTOU guard)
      const finalCheck = this.verifyArtifactPreFlight(artifact, authorizedRoots);
      if (!finalCheck.valid) {
        runtimeBlocked.push({
          artifactId: artifact.id,
          name: artifact.name,
          canonicalPath: artifact.canonicalPath,
          code: finalCheck.code,
          reasons: finalCheck.issues
        });
        continue;
      }

      const entryId = stableId('qent', `${batchId}:${artifact.canonicalPath}`);
      const entryDir = path.join(batchDir, entryId);
      fs.mkdirSync(entryDir, { recursive: true });

      const payloadPath = path.join(entryDir, 'payload');
      const manifestPath = path.join(entryDir, 'manifest.json');
      const sha256 = this.platformServices.computeFileSha256(artifact.canonicalPath);

      // Move file into quarantine (fallback to copy+unlink if across mount points EXDEV)
      try {
        fs.renameSync(artifact.canonicalPath, payloadPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          fs.copyFileSync(artifact.canonicalPath, payloadPath);
          fs.unlinkSync(artifact.canonicalPath);
        } else {
          throw err;
        }
      }

      const entryModel = createQuarantineEntryModel({
        id: entryId,
        batchId,
        artifactId: artifact.id,
        artifactName: artifact.name,
        originalPath: artifact.canonicalPath,
        quarantinePath: payloadPath,
        manifestPath,
        sizeBytes: artifact.sizeBytes,
        originalMode: artifact.mode,
        originalMtimeMs: artifact.mtimeMs,
        originalInodeKey: artifact.physicalInodeKey,
        sha256,
        riskCategory: artifact.cleanupClassification,
        artifactType: artifact.artifactType,
        provenanceConfidence: artifact.provenanceConfidence,
        reason: artifact.cleanupExplanation,
        status: 'QUARANTINED'
      });

      // Write durable on-disk manifest.json before committing SQLite record
      fs.writeFileSync(manifestPath, JSON.stringify(entryModel, null, 2), 'utf8');

      artifact.quarantined = true;
      if (this.sqliteStore) {
        this.sqliteStore.saveQuarantineEntry(entryModel);
      }
      quarantinedEntries.push(entryModel);
    }

    // Write batch summary manifest
    const batchManifestPath = path.join(batchDir, 'batch-manifest.json');
    fs.writeFileSync(
      batchManifestPath,
      JSON.stringify(
        {
          batchId,
          createdAt: new Date().toISOString(),
          entries: quarantinedEntries
        },
        null,
        2
      ),
      'utf8'
    );

    return {
      batchId,
      batchManifestPath,
      quarantinedEntries,
      blockedItems: runtimeBlocked
    };
  }

  /**
   * Restores a quarantined artifact back to its original path with explicit conflict handling.
   */
  restoreQuarantineEntry({
    entryId,
    conflictStrategy = RestoreConflictStrategy.FAIL_IF_EXISTS
  }) {
    let entry = this.sqliteStore ? this.sqliteStore.getQuarantineEntryById(entryId) : null;

    if (!entry) {
      throw new Error(`Quarantine entry not found: ${entryId}`);
    }

    if (entry.status === 'RESTORED') {
      throw new Error(`Quarantine entry '${entryId}' has already been restored.`);
    }

    if (!fs.existsSync(entry.quarantinePath)) {
      throw new Error(`Quarantined payload missing on disk: ${entry.quarantinePath}`);
    }

    // Verify SHA-256 integrity of quarantined payload before restoring
    if (entry.sha256) {
      const currentSha = this.platformServices.computeFileSha256(entry.quarantinePath);
      if (currentSha && currentSha !== entry.sha256) {
        throw new Error('QUARANTINE_INTEGRITY_MISMATCH: Quarantined payload SHA-256 does not match manifest.');
      }
    }

    let destinationPath = entry.originalPath;
    if (fs.existsSync(destinationPath)) {
      if (conflictStrategy === RestoreConflictStrategy.FAIL_IF_EXISTS) {
        throw new Error(
          `RESTORE_CONFLICT_EXISTS: A file already exists at '${destinationPath}'. Choose RENAME_RESTORED or OVERWRITE_IF_EXPLICIT.`
        );
      } else if (conflictStrategy === RestoreConflictStrategy.RENAME_RESTORED) {
        const ext = path.extname(destinationPath);
        const base = destinationPath.slice(0, destinationPath.length - ext.length);
        destinationPath = `${base}.restored-${Date.now()}${ext}`;
      } else if (conflictStrategy !== RestoreConflictStrategy.OVERWRITE_IF_EXPLICIT) {
        throw new Error(`Unsupported conflict strategy: ${conflictStrategy}`);
      }
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    try {
      fs.renameSync(entry.quarantinePath, destinationPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        fs.copyFileSync(entry.quarantinePath, destinationPath);
        fs.unlinkSync(entry.quarantinePath);
      } else {
        throw err;
      }
    }

    if (entry.originalMode) {
      try {
        fs.chmodSync(destinationPath, entry.originalMode & 0o777);
      } catch {
        // Ignore chmod errors on non-POSIX mounts
      }
    }

    entry.status = 'RESTORED';
    entry.restoredAt = new Date().toISOString();
    if (fs.existsSync(entry.manifestPath)) {
      fs.writeFileSync(entry.manifestPath, JSON.stringify(entry, null, 2), 'utf8');
    }
    if (this.sqliteStore) {
      this.sqliteStore.saveQuarantineEntry(entry);
    }

    return {
      restored: true,
      entryId: entry.id,
      restoredToPath: destinationPath,
      conflictStrategyUsed: conflictStrategy,
      restoredAt: entry.restoredAt
    };
  }
}
