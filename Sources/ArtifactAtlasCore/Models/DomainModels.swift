import Foundation

public let kArtifactAtlasModelSchemaVersion: Int = 1

public enum NodeType: String, Codable, CaseIterable, Sendable {
    case aiApplication = "AI_APPLICATION"
    case workspace = "WORKSPACE"
    case session = "SESSION"
    case operation = "OPERATION"
    case artifact = "ARTIFACT"
    case artifactGroup = "ARTIFACT_GROUP"
    case unknownOrigin = "UNKNOWN_ORIGIN"
}

public enum EdgeType: String, Codable, CaseIterable, Sendable {
    case belongsTo = "BELONGS_TO"
    case contains = "CONTAINS"
    case createdBy = "CREATED_BY"
    case modifiedBy = "MODIFIED_BY"
    case generatedDuring = "GENERATED_DURING"
    case derivedFrom = "DERIVED_FROM"
    case possiblyRelatedTo = "POSSIBLY_RELATED_TO"
    case sharedWith = "SHARED_WITH"
}

public enum ProvenanceConfidence: String, Codable, CaseIterable, Sendable {
    case verified = "VERIFIED"
    case inferred = "INFERRED"
    case unknown = "UNKNOWN"
}

public enum ArtifactType: String, Codable, CaseIterable, Sendable {
    case regenerableCache = "REGENERABLE_CACHE"
    case tempFile = "TEMP_FILE"
    case log = "LOG"
    case buildOutput = "BUILD_OUTPUT"
    case derivedData = "DERIVED_DATA"
    case sessionHistory = "SESSION_HISTORY"
    case userContent = "USER_CONTENT"
    case modelData = "MODEL_DATA"
    case checkpoint = "CHECKPOINT"
    case unknown = "UNKNOWN"
}

public enum RiskCategory: String, Codable, CaseIterable, Sendable {
    case low = "LOW"
    case review = "REVIEW"
    case high = "HIGH"
    case protected = "PROTECTED"
}

public enum ScanStatus: String, Codable, Sendable {
    case pending = "PENDING"
    case running = "RUNNING"
    case completed = "COMPLETED"
    case cancelled = "CANCELLED"
    case failed = "FAILED"
}

public enum RestoreConflictStrategy: String, Codable, CaseIterable, Sendable {
    case failIfExists = "FAIL_IF_EXISTS"
    case renameRestored = "RENAME_RESTORED"
    case overwriteIfExplicit = "OVERWRITE_IF_EXPLICIT"
}

public struct CandidateDataDirectory: Codable, Equatable, Sendable {
    public let role: String
    public let path: String

    public init(role: String, path: String) {
        self.role = role
        self.path = path
    }
}

public struct ApplicationModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let name: String
    public let bundleId: String?
    public let bundlePath: String?
    public let executablePath: String?
    public let version: String
    public let copyright: String?
    public let adapterId: String
    public let isSupportedAIApp: Bool
    public let recognitionStatus: String
    public let knownDataDirectories: [CandidateDataDirectory]
    public let discoveredAt: Date

    public init(
        id: String,
        name: String,
        bundleId: String?,
        bundlePath: String?,
        executablePath: String?,
        version: String,
        copyright: String?,
        adapterId: String,
        isSupportedAIApp: Bool,
        recognitionStatus: String,
        knownDataDirectories: [CandidateDataDirectory],
        discoveredAt: Date = Date()
    ) {
        self.schemaVersion = kArtifactAtlasModelSchemaVersion
        self.id = id
        self.name = name
        self.bundleId = bundleId
        self.bundlePath = bundlePath
        self.executablePath = executablePath
        self.version = version
        self.copyright = copyright
        self.adapterId = adapterId
        self.isSupportedAIApp = isSupportedAIApp
        self.recognitionStatus = recognitionStatus
        self.knownDataDirectories = knownDataDirectories
        self.discoveredAt = discoveredAt
    }
}

public struct WorkspaceModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let name: String
    public let canonicalPath: String
    public let applicationIds: [String]
    public let hasGitRepository: Bool

    public init(
        id: String,
        name: String,
        canonicalPath: String,
        applicationIds: [String],
        hasGitRepository: Bool
    ) {
        self.schemaVersion = kArtifactAtlasModelSchemaVersion
        self.id = id
        self.name = name
        self.canonicalPath = canonicalPath
        self.applicationIds = applicationIds
        self.hasGitRepository = hasGitRepository
    }
}

public struct SessionModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let externalSessionId: String
    public let applicationId: String
    public var workspaceId: String?
    public let title: String
    public let sourcePath: String?
    public let adapterId: String
    public var operationCount: Int

    public init(
        id: String,
        externalSessionId: String,
        applicationId: String,
        workspaceId: String?,
        title: String,
        sourcePath: String?,
        adapterId: String,
        operationCount: Int = 0
    ) {
        self.schemaVersion = kArtifactAtlasModelSchemaVersion
        self.id = id
        self.externalSessionId = externalSessionId
        self.applicationId = applicationId
        self.workspaceId = workspaceId
        self.title = title
        self.sourcePath = sourcePath
        self.adapterId = adapterId
        self.operationCount = operationCount
    }
}

public struct OperationModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let sessionId: String
    public let applicationId: String
    public let workspaceId: String?
    public let sequence: Int
    public let toolName: String
    public let operationType: String
    public let targetPath: String?
    public let sourceRecordRef: String?
    public let confidence: ProvenanceConfidence

    public init(
        id: String,
        sessionId: String,
        applicationId: String,
        workspaceId: String?,
        sequence: Int,
        toolName: String,
        operationType: String,
        targetPath: String?,
        sourceRecordRef: String?,
        confidence: ProvenanceConfidence
    ) {
        self.schemaVersion = kArtifactAtlasModelSchemaVersion
        self.id = id
        self.sessionId = sessionId
        self.applicationId = applicationId
        self.workspaceId = workspaceId
        self.sequence = sequence
        self.toolName = toolName
        self.operationType = operationType
        self.targetPath = targetPath
        self.sourceRecordRef = sourceRecordRef
        self.confidence = confidence
    }
}

public struct EvidenceModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let subjectId: String
    public let confidence: ProvenanceConfidence
    public let sourceType: String
    public let sourceRef: String?
    public let ruleId: String
    public let summary: String

    public init(
        id: String,
        subjectId: String,
        confidence: ProvenanceConfidence,
        sourceType: String,
        sourceRef: String?,
        ruleId: String,
        summary: String
    ) {
        self.schemaVersion = kArtifactAtlasModelSchemaVersion
        self.id = id
        self.subjectId = subjectId
        self.confidence = confidence
        self.sourceType = sourceType
        self.sourceRef = sourceRef
        self.ruleId = ruleId
        self.summary = summary
    }
}

public struct ArtifactModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let name: String
    public let canonicalPath: String
    public let parentDir: String
    public let fileExtension: String
    public let sizeBytes: Int64
    public let physicalInodeKey: String
    public let hardlinkCount: Int
    public let mode: UInt16
    public let mtimeSeconds: Double
    public var artifactType: ArtifactType
    public var applicationId: String?
    public var workspaceId: String?
    public var sessionIds: [String]
    public var operationIds: [String]
    public var provenanceConfidence: ProvenanceConfidence
    public var evidence: [EvidenceModel]
    public var cleanupClassification: RiskCategory
    public var cleanupExplanation: String
    public var deletionConsequences: String
    public var sharedDependencyIndicators: [String]
    public var quarantined: Bool
}

public struct ProvenanceEdgeModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let sourceId: String
    public let targetId: String
    public let edgeType: EdgeType
    public let confidence: ProvenanceConfidence
    public let explanation: String
}

public struct QuarantineEntryModel: Codable, Identifiable, Equatable, Sendable {
    public let schemaVersion: Int
    public let id: String
    public let batchId: String
    public let artifactId: String
    public let artifactName: String
    public let originalPath: String
    public let quarantinePath: String
    public let manifestPath: String
    public let sizeBytes: Int64
    public let originalMode: UInt16
    public let originalMtimeSeconds: Double
    public let originalInodeKey: String
    public let riskCategory: RiskCategory
    public let artifactType: ArtifactType
    public let provenanceConfidence: ProvenanceConfidence
    public let quarantinedAt: String
    public var restoredAt: String?
    public var status: String
}
