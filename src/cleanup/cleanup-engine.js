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

    // 3b. Reject anything outside the authorized scan roots or inside the Quarantine Vault itself
    if (
      authorizedRoots.length > 0 &&
      !this.platformServices.isWithinAuthorizedRoots(absPath, authorizedRoots)
    ) {
      return {
        valid: false,
        code: 'OUTSIDE_AUTHORIZED_BOUNDARY',
        issues: [`Path '${absPath}' is outside the authorized scan roots.`],
        warnings
      };
    }
    if (absPath === this.quarantineRoot || absPath.startsWith(this.quarantineRoot + path.sep)) {
      return {
        valid: false,
        code: 'QUARANTINE_VAULT_REJECTED',
        issues: ['Path is inside the managed Quarantine Vault.'],
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

    // 6b. Only regular files are ever moved (never directories, sockets, FIFOs, or devices)
    if (!lstat.isFile()) {
      return {
        valid: false,
        code: 'NOT_REGULAR_FILE_REJECTED',
        issues: ['Target path is not a regular file.'],
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
    allowHighRiskSingleOverride = false,
    // How many files the user selected, when some were set aside before this review
    selectionSize = null
  }) {
    const isBulk = (selectionSize ?? artifacts.length) > 1;
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
    allowHighRiskSingleOverride = false,
    selectionSize = null
  }) {
    const review = this.prepareCleanupReview({
      artifacts,
      authorizedRoots,
      allowHighRiskSingleOverride,
      selectionSize
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
    const batchManifestPath = path.join(batchDir, 'batch-manifest.json');

    try {
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

        try {
          const entryModel = this.moveIntoVault({
            batchId,
            batchDir,
            sourcePath: artifact.canonicalPath,
            fields: {
              artifactId: artifact.id,
              artifactName: artifact.name,
              sizeBytes: artifact.sizeBytes,
              originalMode: artifact.mode,
              originalMtimeMs: artifact.mtimeMs,
              originalInodeKey: artifact.physicalInodeKey,
              riskCategory: artifact.cleanupClassification,
              artifactType: artifact.artifactType,
              provenanceConfidence: artifact.provenanceConfidence,
              // The sessions it belonged to (IDs only), so Quarantine can name them later
              sessionIds: artifact.sessionIds || [],
              reason: artifact.cleanupExplanation
            }
          });
          artifact.quarantined = true;
          quarantinedEntries.push(entryModel);
        } catch (err) {
          runtimeBlocked.push({
            artifactId: artifact.id,
            name: artifact.name,
            canonicalPath: artifact.canonicalPath,
            code: 'QUARANTINE_MOVE_FAILED',
            reasons: [`File was left in place; move into quarantine failed (${err.code || err.message}).`]
          });
        }
      }
    } finally {
      // Always write the batch summary, even when an item failed mid-batch
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
    }

    return {
      batchId,
      batchManifestPath,
      quarantinedEntries,
      blockedItems: runtimeBlocked
    };
  }

  /**
   * Moves one regular file into the vault with a crash-safe ordering:
   *   1. hash the source, 2. write manifest.json (status PENDING) durably,
   *   3. move the payload (never clobbering), 4. mark manifest QUARANTINED, 5. commit SQLite.
   * A payload therefore never exists in the vault without its recovery descriptor. If the move
   * fails the source is untouched and the empty entry directory is removed.
   */
  moveIntoVault({ batchId, batchDir, sourcePath, fields }) {
    const entryId = stableId('qent', `${batchId}:${sourcePath}`);
    const entryDir = path.join(batchDir, entryId);
    fs.mkdirSync(entryDir, { recursive: true });

    const payloadPath = path.join(entryDir, 'payload');
    const manifestPath = path.join(entryDir, 'manifest.json');

    let entryModel;
    try {
      const sha256 = this.platformServices.computeFileSha256(sourcePath);
      entryModel = createQuarantineEntryModel({
        ...fields,
        id: entryId,
        batchId,
        originalPath: sourcePath,
        quarantinePath: payloadPath,
        manifestPath,
        sha256,
        status: 'PENDING'
      });
      writeFileDurable(manifestPath, JSON.stringify(entryModel, null, 2));
      this.platformServices.moveFileNoClobber(sourcePath, payloadPath, sha256);
    } catch (err) {
      // The move did not happen: the source is still in place, so drop the empty entry dir
      if (!this.platformServices.entryExists(payloadPath)) {
        fs.rmSync(entryDir, { recursive: true, force: true });
      }
      throw err;
    }

    entryModel.status = 'QUARANTINED';
    writeFileDurable(manifestPath, JSON.stringify(entryModel, null, 2));
    if (this.sqliteStore) {
      this.sqliteStore.saveQuarantineEntry(entryModel);
    }
    return entryModel;
  }

  /**
   * Looks up a quarantine entry in SQLite, falling back to the on-disk manifest.json recovery
   * descriptors when the database record is missing (lost/corrupt DB or interrupted quarantine).
   */
  findQuarantineEntry(entryId) {
    const fromDb = this.sqliteStore ? this.sqliteStore.getQuarantineEntryById(entryId) : null;
    if (fromDb) {
      return fromDb;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(String(entryId || ''))) {
      return null;
    }
    const batchesDir = path.join(this.quarantineRoot, 'batches');
    let batchNames = [];
    try {
      batchNames = fs.readdirSync(batchesDir);
    } catch {
      return null;
    }
    for (const batchName of batchNames) {
      const entryDir = path.join(batchesDir, batchName, entryId);
      const manifestPath = path.join(entryDir, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (manifest.id !== entryId || !manifest.originalPath) {
        continue;
      }
      // Never trust payload locations from the manifest: always use the vault layout
      return createQuarantineEntryModel({
        ...manifest,
        quarantinePath: path.join(entryDir, 'payload'),
        manifestPath,
        status: ['RESTORED', 'PURGED'].includes(manifest.status) ? manifest.status : 'QUARANTINED'
      });
    }
    return null;
  }

  /**
   * Restores a quarantined artifact back to its original path with explicit conflict handling.
   * No strategy ever destroys data: OVERWRITE_IF_EXPLICIT first moves the file currently
   * occupying the destination into the Quarantine Vault as its own recoverable entry.
   */
  restoreQuarantineEntry({
    entryId,
    conflictStrategy = RestoreConflictStrategy.FAIL_IF_EXISTS
  }) {
    if (!Object.values(RestoreConflictStrategy).includes(conflictStrategy)) {
      throw new Error(`Unsupported conflict strategy: ${conflictStrategy}`);
    }

    const entry = this.findQuarantineEntry(entryId);

    if (!entry) {
      throw new Error(`Quarantine entry not found: ${entryId}`);
    }

    if (entry.status === 'RESTORED') {
      throw new Error(`Quarantine entry '${entryId}' has already been restored.`);
    }
    if (entry.status === 'PURGED') {
      throw new Error(`Quarantine entry '${entryId}' was emptied from the Quarantine and cannot be restored.`);
    }

    let payloadStat;
    try {
      payloadStat = fs.lstatSync(entry.quarantinePath);
    } catch {
      throw new Error(`Quarantined payload missing on disk: ${entry.quarantinePath}`);
    }
    if (!payloadStat.isFile()) {
      throw new Error('QUARANTINE_INTEGRITY_MISMATCH: Quarantined payload is not a regular file.');
    }

    // Verify SHA-256 integrity of quarantined payload before restoring
    if (entry.sha256) {
      const currentSha = this.platformServices.computeFileSha256(entry.quarantinePath);
      if (currentSha !== entry.sha256) {
        throw new Error('QUARANTINE_INTEGRITY_MISMATCH: Quarantined payload SHA-256 does not match manifest.');
      }
    }

    let destinationPath = path.resolve(entry.originalPath);
    if (
      this.platformServices.isProtectedSystemPath(destinationPath) ||
      destinationPath === this.quarantineRoot ||
      destinationPath.startsWith(this.quarantineRoot + path.sep)
    ) {
      throw new Error(
        `RESTORE_DESTINATION_REJECTED: '${destinationPath}' is a protected location.`
      );
    }

    // The original path was canonical at scan time. If the nearest existing ancestor now
    // resolves elsewhere, a directory was swapped for a symlink: refuse to write through it.
    let existingAncestor = path.dirname(destinationPath);
    while (!this.platformServices.entryExists(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    let ancestorReal = null;
    try {
      ancestorReal = fs.realpathSync(existingAncestor);
    } catch {
      ancestorReal = null;
    }
    if (ancestorReal !== existingAncestor || !fs.lstatSync(existingAncestor).isDirectory()) {
      throw new Error(
        `RESTORE_PATH_CHANGED: '${existingAncestor}' is no longer a real directory (symlink or file); refusing to restore through it.`
      );
    }

    let displacedEntry = null;
    if (this.platformServices.entryExists(destinationPath)) {
      if (conflictStrategy === RestoreConflictStrategy.FAIL_IF_EXISTS) {
        throw new Error(
          `RESTORE_CONFLICT_EXISTS: A file already exists at '${destinationPath}'. Choose RENAME_RESTORED or OVERWRITE_IF_EXPLICIT.`
        );
      } else if (conflictStrategy === RestoreConflictStrategy.RENAME_RESTORED) {
        const ext = path.extname(destinationPath);
        const base = destinationPath.slice(0, destinationPath.length - ext.length);
        let candidate;
        let attempt = 0;
        do {
          candidate = `${base}.restored-${Date.now()}${attempt ? `-${attempt}` : ''}${ext}`;
          attempt += 1;
        } while (this.platformServices.entryExists(candidate));
        destinationPath = candidate;
      } else {
        // OVERWRITE_IF_EXPLICIT: displace the occupying file into the vault (never destroy it)
        const occupant = fs.lstatSync(destinationPath);
        if (!occupant.isFile()) {
          throw new Error(
            `RESTORE_CONFLICT_NOT_REGULAR_FILE: '${destinationPath}' is occupied by a directory, symlink, or special file; only regular files can be displaced. Choose RENAME_RESTORED.`
          );
        }
        const batchId = `qbatch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const batchDir = path.join(this.quarantineRoot, 'batches', batchId);
        fs.mkdirSync(batchDir, { recursive: true });
        displacedEntry = this.moveIntoVault({
          batchId,
          batchDir,
          sourcePath: destinationPath,
          fields: {
            artifactId: stableId('art', destinationPath),
            artifactName: path.basename(destinationPath),
            sizeBytes: occupant.size,
            originalMode: occupant.mode,
            originalMtimeMs: occupant.mtimeMs,
            originalInodeKey: `${occupant.dev}:${occupant.ino}`,
            riskCategory: RiskCategory.REVIEW,
            artifactType: entry.artifactType,
            provenanceConfidence: ProvenanceConfidence.UNKNOWN,
            reason: `Displaced by explicit-overwrite restore of quarantine entry ${entry.id}; recoverable from the Quarantine Vault.`
          }
        });
        fs.writeFileSync(
          path.join(batchDir, 'batch-manifest.json'),
          JSON.stringify(
            { batchId, createdAt: new Date().toISOString(), entries: [displacedEntry] },
            null,
            2
          ),
          'utf8'
        );
      }
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

    this.platformServices.moveFileNoClobber(entry.quarantinePath, destinationPath, entry.sha256);

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
      displacedEntry,
      restoredAt: entry.restoredAt
    };
  }

  /**
   * Entries that may be emptied from the Quarantine: held there at least PURGE_MIN_AGE_DAYS,
   * with the same date in SQLite and in the manifest, and a payload that is a regular file
   * inside the vault at the place the vault layout gives it. Stored paths are never used.
   */
  listPurgeableEntries({ now = Date.now() } = {}) {
    if (!this.sqliteStore) return [];
    const minAge = PURGE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
    let vaultReal;
    try {
      vaultReal = fs.realpathSync(this.quarantineRoot);
    } catch {
      return [];
    }
    const eligible = [];
    for (const entry of this.sqliteStore.listQuarantineEntries('QUARANTINED')) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(entry.id)) || !/^[A-Za-z0-9_-]+$/.test(String(entry.batchId))) continue;
      const at = Date.parse(entry.quarantinedAt || '');
      if (!Number.isFinite(at) || now - at < minAge) continue;
      const entryDir = path.join(this.quarantineRoot, 'batches', entry.batchId, entry.id);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(entryDir, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      if (manifest.id !== entry.id || manifest.status !== 'QUARANTINED' || manifest.quarantinedAt !== entry.quarantinedAt) continue;
      const payload = path.join(entryDir, 'payload');
      const st = fs.lstatSync(payload, { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      let payloadReal;
      try {
        payloadReal = fs.realpathSync(payload);
      } catch {
        continue;
      }
      if (!payloadReal.startsWith(vaultReal + path.sep)) continue;
      eligible.push({ ...entry, payloadPath: payload, manifestPath: path.join(entryDir, 'manifest.json'), payloadBytes: st.size });
    }
    return eligible;
  }

  /**
   * Deletes the payloads of exactly these entries, each checked again just before. The
   * manifest and the SQLite row stay, marked PURGED, so the Quarantine still shows what was
   * there. This is the only place in the app that deletes a file permanently.
   */
  purgeEntries(entryIds, { now = Date.now() } = {}) {
    const wanted = new Set(entryIds);
    const purged = [];
    for (const entry of this.listPurgeableEntries({ now })) {
      if (!wanted.has(entry.id)) continue;
      fs.unlinkSync(entry.payloadPath);
      const { payloadPath, payloadBytes, ...stored } = entry;
      const updated = { ...stored, status: 'PURGED', purgedAt: new Date(now).toISOString() };
      try {
        const manifest = JSON.parse(fs.readFileSync(entry.manifestPath, 'utf8'));
        writeFileDurable(entry.manifestPath, JSON.stringify({ ...manifest, status: 'PURGED', purgedAt: updated.purgedAt }, null, 2));
      } catch {
        // The row below still records it
      }
      this.sqliteStore.saveQuarantineEntry(updated);
      purged.push({ id: entry.id, sizeBytes: payloadBytes });
    }
    return purged;
  }
}

/** How long a file waits in the Quarantine before it may be emptied (with the user's confirmation). */
export const PURGE_MIN_AGE_DAYS = 30;

/**
 * Writes a file and fsyncs it so the recovery descriptor survives a crash right after the move.
 */
function writeFileDurable(filePath, contents) {
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is unsupported on some filesystems; the write itself still succeeded
    }
  } finally {
    fs.closeSync(fd);
  }
}
