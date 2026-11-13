import crypto from 'node:crypto';

export const MODEL_SCHEMA_VERSION = 1;

/**
 * Node types in the Interactive Knowledge Graph (Section 5)
 */
export const NodeType = Object.freeze({
  AI_APPLICATION: 'AI_APPLICATION',
  WORKSPACE: 'WORKSPACE',
  SESSION: 'SESSION',
  OPERATION: 'OPERATION',
  ARTIFACT: 'ARTIFACT',
  ARTIFACT_GROUP: 'ARTIFACT_GROUP',
  FOLDER: 'FOLDER',
  UNKNOWN_ORIGIN: 'UNKNOWN_ORIGIN'
});

/**
 * Edge types in the Interactive Knowledge Graph (Section 5)
 */
export const EdgeType = Object.freeze({
  BELONGS_TO: 'BELONGS_TO',
  CONTAINS: 'CONTAINS',
  CREATED_BY: 'CREATED_BY',
  MODIFIED_BY: 'MODIFIED_BY',
  GENERATED_DURING: 'GENERATED_DURING',
  DERIVED_FROM: 'DERIVED_FROM',
  POSSIBLY_RELATED_TO: 'POSSIBLY_RELATED_TO',
  SHARED_WITH: 'SHARED_WITH'
});

/**
 * Explicit Provenance Confidence Model (Section 7)
 */
export const ProvenanceConfidence = Object.freeze({
  VERIFIED: 'VERIFIED',
  INFERRED: 'INFERRED',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Tool calls that write a file. Only these make a file's origin VERIFIED: a session that
 * read, listed or searched a file did not produce it (AGENTS.md rule 3).
 */
export const WRITE_OPERATION_TYPES = Object.freeze(new Set(['WRITE', 'EDIT', 'PATCH']));

/**
 * Rule-based Artifact Classification Types (Section 8)
 */
export const ArtifactType = Object.freeze({
  REGENERABLE_CACHE: 'REGENERABLE_CACHE',
  TEMP_FILE: 'TEMP_FILE',
  LOG: 'LOG',
  BUILD_OUTPUT: 'BUILD_OUTPUT',
  DERIVED_DATA: 'DERIVED_DATA',
  SESSION_HISTORY: 'SESSION_HISTORY',
  USER_CONTENT: 'USER_CONTENT',
  MODEL_DATA: 'MODEL_DATA',
  CHECKPOINT: 'CHECKPOINT',
  UNKNOWN: 'UNKNOWN'
});

/**
 * Cleanup Risk Categories (Section 8)
 */
export const RiskCategory = Object.freeze({
  LOW: 'LOW',
  REVIEW: 'REVIEW',
  HIGH: 'HIGH',
  PROTECTED: 'PROTECTED'
});

/**
 * Scan Lifecycle States
 */
export const ScanStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED'
});

/**
 * Restoration Conflict Strategies (Section 9)
 */
export const RestoreConflictStrategy = Object.freeze({
  FAIL_IF_EXISTS: 'FAIL_IF_EXISTS',
  RENAME_RESTORED: 'RENAME_RESTORED',
  OVERWRITE_IF_EXPLICIT: 'OVERWRITE_IF_EXPLICIT'
});

export function stableId(prefix, key) {
  const hash = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}

export function createApplicationModel(fields) {
  const bundleOrPath = fields.bundleId || fields.executablePath || fields.bundlePath || fields.name;
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('app', bundleOrPath),
    name: fields.name || 'Unknown Application',
    bundleId: fields.bundleId || null,
    bundlePath: fields.bundlePath || null,
    executablePath: fields.executablePath || null,
    version: fields.version || 'Unknown',
    developerMetadata: fields.developerMetadata || null,
    adapterId: fields.adapterId || 'generic-macos-app',
    isSupportedAIApp: Boolean(fields.isSupportedAIApp),
    recognitionStatus: fields.recognitionStatus || 'GENERIC_SUPPORTED',
    knownDataDirectories: Array.isArray(fields.knownDataDirectories) ? fields.knownDataDirectories : [],
    isKnownAIApp: Boolean(fields.isKnownAIApp),
    unreadableContainers: Array.isArray(fields.unreadableContainers) ? fields.unreadableContainers : [],
    discoveredAt: fields.discoveredAt || new Date().toISOString()
  };
}

export function createWorkspaceModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('ws', fields.canonicalPath),
    name: fields.name || 'Workspace',
    canonicalPath: fields.canonicalPath,
    applicationIds: Array.isArray(fields.applicationIds) ? fields.applicationIds : [],
    hasGitRepository: Boolean(fields.hasGitRepository),
    discoveredAt: fields.discoveredAt || new Date().toISOString()
  };
}

export function createSessionModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('sess', `${fields.applicationId}:${fields.externalSessionId}`),
    externalSessionId: fields.externalSessionId,
    applicationId: fields.applicationId,
    workspaceId: fields.workspaceId || null,
    title: fields.title || `Session ${String(fields.externalSessionId).slice(0, 8)}`,
    startedAt: fields.startedAt || null,
    endedAt: fields.endedAt || null,
    sourcePath: fields.sourcePath || null,
    adapterId: fields.adapterId || 'unknown',
    operationCount: Number(fields.operationCount || 0)
  };
}

export function createOperationModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('op', `${fields.sessionId}:${fields.sequence}:${fields.toolName}:${fields.targetPath || ''}`),
    sessionId: fields.sessionId,
    applicationId: fields.applicationId,
    workspaceId: fields.workspaceId || null,
    sequence: Number(fields.sequence || 0),
    toolName: fields.toolName || 'unknown_tool',
    operationType: fields.operationType || 'TOOL_CALL', // WRITE, EDIT, PATCH, SHELL, READ
    targetPath: fields.targetPath || null,
    timestamp: fields.timestamp || null,
    sourceRecordRef: fields.sourceRecordRef || null,
    confidence: fields.confidence || ProvenanceConfidence.VERIFIED
  };
}

export function createEvidenceModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('ev', `${fields.subjectId}:${fields.sourceType}:${fields.sourceRef}:${fields.confidence}`),
    subjectId: fields.subjectId,
    confidence: fields.confidence || ProvenanceConfidence.UNKNOWN,
    sourceType: fields.sourceType || 'FILESYSTEM_SCAN',
    sourceRef: fields.sourceRef || null,
    ruleId: fields.ruleId || 'rule.unknown',
    summary: fields.summary || 'No direct provenance record available.',
    details: fields.details || {},
    recordedAt: fields.recordedAt || new Date().toISOString()
  };
}

export function createArtifactModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('art', fields.canonicalPath),
    name: fields.name,
    canonicalPath: fields.canonicalPath,
    parentDir: fields.parentDir,
    extension: fields.extension || '',
    isDirectory: Boolean(fields.isDirectory),
    sizeBytes: Number(fields.sizeBytes || 0),
    physicalInodeKey: fields.physicalInodeKey || null,
    hardlinkCount: Number(fields.hardlinkCount || 1),
    isHardlinked: Number(fields.hardlinkCount || 1) > 1,
    mode: Number(fields.mode || 0),
    createdAt: fields.createdAt || null,
    modifiedAt: fields.modifiedAt || null,
    mtimeMs: Number(fields.mtimeMs || 0),
    artifactType: fields.artifactType || ArtifactType.UNKNOWN,
    applicationId: fields.applicationId || null,
    workspaceId: fields.workspaceId || null,
    gitRepositoryRoot: fields.gitRepositoryRoot || null,
    groupId: fields.groupId || null,
    sessionIds: Array.isArray(fields.sessionIds) ? fields.sessionIds : [],
    operationIds: Array.isArray(fields.operationIds) ? fields.operationIds : [],
    provenanceConfidence: fields.provenanceConfidence || ProvenanceConfidence.UNKNOWN,
    evidence: Array.isArray(fields.evidence) ? fields.evidence : [],
    cleanupClassification: fields.cleanupClassification || RiskCategory.REVIEW,
    cleanupExplanation: fields.cleanupExplanation || '',
    deletionConsequences: fields.deletionConsequences || '',
    sharedDependencyIndicators: Array.isArray(fields.sharedDependencyIndicators) ? fields.sharedDependencyIndicators : [],
    scanId: fields.scanId || null,
    quarantined: Boolean(fields.quarantined)
  };
}

export function createArtifactGroupModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('grp', `${fields.applicationId || 'global'}:${fields.categoryKey}`),
    name: fields.name,
    categoryKey: fields.categoryKey,
    artifactType: fields.artifactType || ArtifactType.UNKNOWN,
    applicationId: fields.applicationId || null,
    workspaceId: fields.workspaceId || null,
    artifactIds: Array.isArray(fields.artifactIds) ? fields.artifactIds : [],
    totalBytes: Number(fields.totalBytes || 0),
    deduplicatedBytes: Number(fields.deduplicatedBytes || 0),
    riskSummary: fields.riskSummary || RiskCategory.REVIEW
  };
}

export function createProvenanceEdgeModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('edge', `${fields.sourceId}->${fields.targetId}:${fields.edgeType}`),
    sourceId: fields.sourceId,
    targetId: fields.targetId,
    edgeType: fields.edgeType,
    confidence: fields.confidence || ProvenanceConfidence.VERIFIED,
    evidenceIds: Array.isArray(fields.evidenceIds) ? fields.evidenceIds : [],
    explanation: fields.explanation || ''
  };
}

export function createCleanupRecommendationModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('rec', fields.artifactId),
    artifactId: fields.artifactId,
    riskCategory: fields.riskCategory,
    artifactType: fields.artifactType,
    eligibleForQuarantine: fields.riskCategory !== RiskCategory.PROTECTED,
    eligibleForBulkCleanup: fields.riskCategory === RiskCategory.LOW,
    requiresExplicitHighRiskOverride:
      fields.riskCategory === RiskCategory.HIGH || fields.provenanceConfidence === ProvenanceConfidence.UNKNOWN,
    reason: fields.reason,
    consequences: fields.consequences,
    sharedDependencyIndicators: Array.isArray(fields.sharedDependencyIndicators)
      ? fields.sharedDependencyIndicators
      : []
  };
}

export function createQuarantineEntryModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || stableId('qent', `${fields.batchId}:${fields.originalPath}`),
    batchId: fields.batchId,
    artifactId: fields.artifactId,
    artifactName: fields.artifactName,
    originalPath: fields.originalPath,
    quarantinePath: fields.quarantinePath,
    manifestPath: fields.manifestPath,
    sizeBytes: Number(fields.sizeBytes || 0),
    originalMode: Number(fields.originalMode || 0o644),
    originalMtimeMs: Number(fields.originalMtimeMs || 0),
    originalInodeKey: fields.originalInodeKey || null,
    sha256: fields.sha256 || null,
    riskCategory: fields.riskCategory || RiskCategory.LOW,
    artifactType: fields.artifactType || ArtifactType.UNKNOWN,
    provenanceConfidence: fields.provenanceConfidence || ProvenanceConfidence.UNKNOWN,
    reason: fields.reason || '',
    quarantinedAt: fields.quarantinedAt || new Date().toISOString(),
    restoredAt: fields.restoredAt || null,
    status: fields.status || 'QUARANTINED' // PENDING | QUARANTINED | RESTORED
  };
}

export function createScanModel(fields) {
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    id: fields.id || `scan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    status: fields.status || ScanStatus.PENDING,
    applicationId: fields.applicationId || null,
    authorizedRoots: Array.isArray(fields.authorizedRoots) ? fields.authorizedRoots : [],
    scannedLocations: Array.isArray(fields.scannedLocations) ? fields.scannedLocations : [],
    discoveredArtifactCount: Number(fields.discoveredArtifactCount || 0),
    totalLogicalBytes: Number(fields.totalLogicalBytes || 0),
    totalPhysicalBytes: Number(fields.totalPhysicalBytes || 0),
    deduplicatedHardlinkCount: Number(fields.deduplicatedHardlinkCount || 0),
    permissionLimitations: Array.isArray(fields.permissionLimitations) ? fields.permissionLimitations : [],
    skippedSymlinks: Array.isArray(fields.skippedSymlinks) ? fields.skippedSymlinks : [],
    skippedBulkDirectories: Array.isArray(fields.skippedBulkDirectories) ? fields.skippedBulkDirectories : [],
    // Dependency and Git folders measured as a whole (never listed file by file), and the
    // files past the file limit, which are measured but not listed
    bulkFolders: Array.isArray(fields.bulkFolders) ? fields.bulkFolders : [],
    overflow: fields.overflow || { fileCount: 0, physicalBytes: 0 },
    measuredFileCount: Number(fields.measuredFileCount || 0),
    measuredPhysicalBytes: Number(fields.measuredPhysicalBytes || 0),
    truncated: Boolean(fields.truncated),
    maxFilesLimit: fields.maxFilesLimit ? Number(fields.maxFilesLimit) : null,
    startedAt: fields.startedAt || new Date().toISOString(),
    completedAt: fields.completedAt || null
  };
}
