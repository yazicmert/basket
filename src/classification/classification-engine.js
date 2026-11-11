import {
  ArtifactType,
  RiskCategory,
  ProvenanceConfidence,
  createCleanupRecommendationModel,
  createArtifactGroupModel
} from '../models/entities.js';
import { PlatformServices } from '../platform/platform-services.js';

const CREDENTIAL_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^(id_rsa|id_ed25519|credentials\.json|secrets\.json|\.netrc|\.npmrc)$/i
];

const CONFIG_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'cargo.toml',
  'cargo.lock',
  'package.swift',
  'pyproject.toml',
  'requirements.txt',
  'settings.json',
  'config.json',
  'config.toml',
  'workspace.json',
  '.gitignore',
  'makefile',
  'dockerfile'
]);

const SOURCE_CODE_EXTENSIONS = new Set([
  '.swift',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.sh',
  '.md'
]);

const MODEL_WEIGHT_EXTENSIONS = new Set([
  '.gguf',
  '.safetensors',
  '.onnx',
  '.pt',
  '.pth',
  '.ckpt',
  '.tflite',
  '.mlmodel'
]);

export class ClassificationEngine {
  constructor(options = {}) {
    this.platformServices = options.platformServices || new PlatformServices();
  }

  /**
   * Classifies all artifacts using multi-factor contextual rules (never extension alone)
   * and builds ArtifactGroup aggregations + CleanupRecommendations.
   */
  classifyArtifacts({ artifacts = [], application = null }) {
    const recommendations = [];
    const groupsByKey = new Map();
    const seenInodesPerGroup = new Map();
    const gitRootCache = new Map();

    for (const artifact of artifacts) {
      const result = this.classifySingleArtifact(artifact, gitRootCache);
      artifact.gitRepositoryRoot = result.gitRepositoryRoot;
      artifact.artifactType = result.artifactType;
      artifact.cleanupClassification = result.riskCategory;
      artifact.cleanupExplanation = result.explanation;
      artifact.deletionConsequences = result.consequences;

      const groupKey = `${artifact.applicationId || 'workspace'}:${artifact.artifactType}`;
      if (!groupsByKey.has(groupKey)) {
        groupsByKey.set(
          groupKey,
          createArtifactGroupModel({
            name: formatArtifactTypeLabel(artifact.artifactType),
            categoryKey: groupKey,
            artifactType: artifact.artifactType,
            applicationId: artifact.applicationId || (application ? application.id : null),
            workspaceId: artifact.workspaceId,
            artifactIds: [],
            totalBytes: 0,
            deduplicatedBytes: 0,
            riskSummary: result.riskCategory
          })
        );
        seenInodesPerGroup.set(groupKey, new Set());
      }

      const group = groupsByKey.get(groupKey);
      group.artifactIds.push(artifact.id);
      group.totalBytes += artifact.sizeBytes;
      const groupInodes = seenInodesPerGroup.get(groupKey);
      const inodeKey = artifact.physicalInodeKey || artifact.canonicalPath;
      if (!groupInodes.has(inodeKey)) {
        groupInodes.add(inodeKey);
        group.deduplicatedBytes += artifact.sizeBytes;
      }
      group.riskSummary = elevateRisk(group.riskSummary, result.riskCategory);
      artifact.groupId = group.id;

      recommendations.push(
        createCleanupRecommendationModel({
          artifactId: artifact.id,
          riskCategory: result.riskCategory,
          artifactType: result.artifactType,
          provenanceConfidence: artifact.provenanceConfidence,
          reason: result.explanation,
          consequences: result.consequences,
          sharedDependencyIndicators: artifact.sharedDependencyIndicators
        })
      );
    }

    return {
      artifacts,
      artifactGroups: Array.from(groupsByKey.values()),
      recommendations
    };
  }

  /**
   * Classifies one artifact: contextual rules first, then a final safety clamp that can only
   * raise risk. `LOW` is granted only when every independent signal agrees it is disposable:
   * known (non-UNKNOWN) provenance, no shared/multi-session dependency, not source code inside a
   * workspace or Git repository, and not an arbitrary file inside a Git working tree.
   */
  classifySingleArtifact(artifact, gitRootCache = null) {
    const result = this.classifyByContextRules(artifact);
    const gitRepositoryRoot = this.platformServices.findGitRepositoryRoot(
      artifact.parentDir || artifact.canonicalPath.slice(0, artifact.canonicalPath.lastIndexOf('/')) || '/',
      gitRootCache
    );
    result.gitRepositoryRoot = gitRepositoryRoot;

    if (result.riskCategory !== RiskCategory.LOW) {
      return result;
    }

    const ext = String(artifact.extension || '').toLowerCase();
    const insideProject = Boolean(gitRepositoryRoot || artifact.workspaceId);
    const escalations = [];

    if (artifact.provenanceConfidence === ProvenanceConfidence.UNKNOWN) {
      escalations.push('its provenance is UNKNOWN');
    }
    if ((artifact.sharedDependencyIndicators || []).length > 0 || (artifact.sessionIds || []).length > 1) {
      escalations.push('it is shared across hardlinks or multiple sessions');
    }
    if (SOURCE_CODE_EXTENSIONS.has(ext) && insideProject) {
      escalations.push(
        'it is a source-code file inside a workspace or Git repository (directory name alone does not prove it is disposable)'
      );
    } else if (gitRepositoryRoot && result.artifactType !== ArtifactType.REGENERABLE_CACHE) {
      escalations.push(
        `it lives inside the Git working tree at '${gitRepositoryRoot}' and may be tracked project content`
      );
    }

    if (escalations.length === 0) {
      return result;
    }

    return {
      ...result,
      riskCategory: RiskCategory.REVIEW,
      explanation: `Located in a ${formatArtifactTypeLabel(result.artifactType).toLowerCase()} container, but raised to REVIEW because ${escalations.join('; ')}.`,
      consequences:
        'If this file is project content or still referenced elsewhere, removing it may lose work or interrupt another session; inspect before quarantining.'
    };
  }

  classifyByContextRules(artifact) {
    const canonical = artifact.canonicalPath;
    const lowerPath = canonical.toLowerCase();
    const fileName = artifact.name;
    const lowerName = fileName.toLowerCase();
    const ext = artifact.extension.toLowerCase();
    const hasSharedDeps = artifact.sharedDependencyIndicators.length > 0;
    const isMultiSession = artifact.sessionIds.length > 1;

    // 1. Git repository & Git metadata -> PROTECTED
    if (canonical.includes('/.git/') || lowerName === '.git' || lowerName === '.gitignore') {
      return {
        artifactType: ArtifactType.USER_CONTENT,
        riskCategory: RiskCategory.PROTECTED,
        explanation:
          'Protected Git repository metadata or version-control configuration. Never eligible for automated cleanup.',
        consequences: 'Deleting Git objects or refs will corrupt repository history and uncommitted state.'
      };
    }

    // 2. Credentials & Secrets -> PROTECTED
    if (CREDENTIAL_PATTERNS.some((rx) => rx.test(fileName)) || lowerPath.includes('/.ssh/')) {
      return {
        artifactType: ArtifactType.USER_CONTENT,
        riskCategory: RiskCategory.PROTECTED,
        explanation:
          'Credential, environment secret, or cryptographic key material detected by path and naming policy.',
        consequences: 'Removing credentials can break authentication or permanently lose cryptographic keys.'
      };
    }

    // 3. Configuration files -> PROTECTED
    if (CONFIG_FILENAMES.has(lowerName)) {
      return {
        artifactType: ArtifactType.USER_CONTENT,
        riskCategory: RiskCategory.PROTECTED,
        explanation:
          'Project or application configuration manifest required for builds, dependencies, or workspace state.',
        consequences: 'Removing configuration files breaks workspace resolution or resets user preferences.'
      };
    }

    // 4. Session History (.jsonl transcripts, composer ledgers, chat histories) -> HIGH
    const isSessionDir =
      lowerPath.includes('/.claude/projects/') ||
      lowerPath.includes('/.codex/sessions/') ||
      lowerPath.includes('/workspacestorage/') ||
      lowerName === 'composerdata.json' ||
      lowerName.includes('chat.history');

    if (
      (isSessionDir && (ext === '.jsonl' || lowerName === 'composerdata.json')) ||
      artifact.evidence.some((e) => e.ruleId === 'provenance.verified.session_transcript')
    ) {
      return {
        artifactType: ArtifactType.SESSION_HISTORY,
        riskCategory: RiskCategory.HIGH,
        explanation:
          'Authoritative AI conversation history and tool operation ledger. Contains irreplaceable local session records and provenance ground truth.',
        consequences:
          'Quarantining this file removes local conversation history and breaks verified provenance links for files created in this session.'
      };
    }

    // 5. Model Checkpoints -> HIGH
    const isCheckpointContext =
      lowerPath.includes('/checkpoints/') ||
      lowerPath.includes('/checkpoint-') ||
      lowerPath.includes('/shadow-workspace/') ||
      lowerPath.includes('/snapshots/') ||
      ext === '.ckpt';

    if (isCheckpointContext) {
      return {
        artifactType: ArtifactType.CHECKPOINT,
        riskCategory: RiskCategory.HIGH,
        explanation:
          'Model or workspace state checkpoint snapshot. May be required to roll back AI edits or resume training/evaluation.',
        consequences:
          'Removing checkpoints prevents reverting workspace state to earlier conversation milestones.'
      };
    }

    // 6. Model Weights & Training Datasets -> HIGH
    const isModelContext =
      MODEL_WEIGHT_EXTENSIONS.has(ext) ||
      lowerPath.includes('/models/') ||
      lowerPath.includes('/weights/') ||
      lowerPath.includes('/datasets/');

    if (isModelContext) {
      return {
        artifactType: ArtifactType.MODEL_DATA,
        riskCategory: RiskCategory.HIGH,
        explanation:
          'Local AI model weights, tokenizer blobs, or training/evaluation dataset.',
        consequences:
          'Removing model weights or datasets requires large re-downloads or loses custom local fine-tuning data.'
      };
    }

    // 7. Build Outputs & Derived Data (checked before source code so compiled .js in dist/ is BUILD_OUTPUT)
    const isBuildDir = /\/(dist|build|out|\.next|target|DerivedData)\//.test(canonical);
    if (isBuildDir) {
      const isSourceMapOrIndex = ext === '.map' || lowerName.endsWith('.d.ts');
      return {
        artifactType: isSourceMapOrIndex ? ArtifactType.DERIVED_DATA : ArtifactType.BUILD_OUTPUT,
        riskCategory: RiskCategory.REVIEW,
        explanation:
          'Compiled build output or derived bundle inside a workspace build directory. Usually regenerable via project build commands, but marked REVIEW to confirm no unscripted manual edits exist.',
        consequences:
          'Requires re-running the project build (`npm run build` / `swift build` / `cargo build`) before deployment.'
      };
    }

    // 8. Regenerable Caches (strict directory context check — never extension alone!)
    const isDedicatedCacheDir =
      lowerPath.includes('/library/caches/') ||
      lowerPath.includes('/cacheddata/') ||
      lowerPath.includes('/gpucache/') ||
      lowerPath.includes('/code cache/') ||
      lowerPath.includes('/.claude/statsig/') ||
      lowerPath.includes('/.codex/cache/') ||
      lowerPath.includes('/.cache/') ||
      lowerPath.includes('/__pycache__/');

    if (isDedicatedCacheDir) {
      const risk = hasSharedDeps || isMultiSession ? RiskCategory.REVIEW : RiskCategory.LOW;
      return {
        artifactType: ArtifactType.REGENERABLE_CACHE,
        riskCategory: risk,
        explanation:
          risk === RiskCategory.LOW
            ? 'Located inside a dedicated application cache directory with no shared cross-session dependencies. Can be safely regenerated by the host application.'
            : 'Located in a cache directory, but flagged for review because it shares a physical inode or multi-session reference.',
        consequences:
          'Application may take slightly longer on next launch while rebuilding cached metadata or bytecode.'
      };
    }

    // 9. Application & Session Logs (requires dedicated log directory context for LOW risk!)
    const isDedicatedLogDir =
      lowerPath.includes('/library/logs/') ||
      lowerPath.includes('/.claude/debug/') ||
      lowerPath.includes('/.codex/log/') ||
      lowerPath.includes('/cursor/logs/');

    if (isDedicatedLogDir || ext === '.log') {
      const isSafeLogContainer =
        isDedicatedLogDir &&
        !hasSharedDeps &&
        !isMultiSession &&
        artifact.provenanceConfidence !== ProvenanceConfidence.UNKNOWN;

      return {
        artifactType: ArtifactType.LOG,
        riskCategory: isSafeLogContainer ? RiskCategory.LOW : RiskCategory.REVIEW,
        explanation: isSafeLogContainer
          ? 'Diagnostic log file inside a dedicated application log directory (`Library/Logs` or `.claude/debug`). Safe to quarantine once debugging is complete.'
          : 'Log file located inside a project workspace or lacking dedicated log-container isolation; review before removal because extension `.log` alone does not prove disposability.',
        consequences:
          'Historical diagnostic trace lines in this log file will be moved to quarantine.'
      };
    }

    // 10. Temporary Files (requires dedicated AI tool temp/scratch directory context for LOW risk!)
    const isDedicatedTempDir =
      lowerPath.includes('/.claude/shell-snapshots/') ||
      lowerPath.includes('/.codex/tmp/') ||
      lowerPath.includes('/library/caches/temporaryitems/') ||
      /\/(scratch|temp-work)\//.test(lowerPath);
    const hasTempNaming =
      ext === '.tmp' ||
      ext === '.temp' ||
      ext === '.bak' ||
      lowerName.startsWith('.tmp') ||
      lowerName.endsWith('~');

    if (isDedicatedTempDir || hasTempNaming) {
      // Safety invariant: extension alone (.tmp) outside a dedicated temp directory is REVIEW, never LOW!
      const isSafeTempContainer =
        isDedicatedTempDir &&
        !hasSharedDeps &&
        !isMultiSession &&
        artifact.provenanceConfidence !== ProvenanceConfidence.UNKNOWN;

      return {
        artifactType: ArtifactType.TEMP_FILE,
        riskCategory: isSafeTempContainer ? RiskCategory.LOW : RiskCategory.REVIEW,
        explanation: isSafeTempContainer
          ? 'Transient scratch file inside a dedicated AI tool temporary directory with verified/inferred tool ownership.'
          : 'File exhibits temporary naming (.tmp/.bak) or resides in a workspace folder without dedicated temp-container isolation; manual review required because filename extension alone does not guarantee safe deletion.',
        consequences: isSafeTempContainer
          ? 'No impact on finished sessions; transient shell snapshot or scratch buffer will be reclaimed.'
          : 'If an active process or user script relies on this file, removing it may interrupt an uncompleted task.'
      };
    }

    // 11. Saved Application State / WebKit Derived Data
    if (
      lowerPath.includes('/saved application state/') ||
      lowerPath.includes('/library/webkit/')
    ) {
      return {
        artifactType: ArtifactType.DERIVED_DATA,
        riskCategory: RiskCategory.REVIEW,
        explanation:
          'macOS window restoration state or embedded WebKit storage container.',
        consequences:
          'Resetting saved state clears remembered window geometry or embedded browser local storage.'
      };
    }

    // 12. Source Code & User Content inside Workspaces -> PROTECTED
    if (SOURCE_CODE_EXTENSIONS.has(ext) || lowerPath.includes('/src/') || lowerPath.includes('/sources/')) {
      return {
        artifactType: ArtifactType.USER_CONTENT,
        riskCategory: RiskCategory.PROTECTED,
        explanation: isMultiSession
          ? `Project source code or documentation modified across ${artifact.sessionIds.length} AI sessions. Protected from automated cleanup.`
          : 'Project source code or documentation file inside workspace. Protected from automated cleanup.',
        consequences:
          'Deleting source code or documentation causes immediate loss of application logic and project files.'
      };
    }

    // 13. Fallback: Unknown Artifact Type
    return {
      artifactType: ArtifactType.UNKNOWN,
      riskCategory:
        artifact.provenanceConfidence === ProvenanceConfidence.UNKNOWN || hasSharedDeps
          ? RiskCategory.HIGH
          : RiskCategory.REVIEW,
      explanation:
        'Unclassified file with insufficient structural markers to prove regenerability. Preserved as high-caution by default.',
      consequences:
        'Unknown impact; inspect file contents and provenance before moving to quarantine.'
    };
  }
}

function elevateRisk(current, candidate) {
  const rank = {
    [RiskCategory.LOW]: 1,
    [RiskCategory.REVIEW]: 2,
    [RiskCategory.HIGH]: 3,
    [RiskCategory.PROTECTED]: 4
  };
  return (rank[candidate] || 2) > (rank[current] || 1) ? candidate : current;
}

export function formatArtifactTypeLabel(type) {
  const labels = {
    [ArtifactType.REGENERABLE_CACHE]: 'Regenerable Caches',
    [ArtifactType.TEMP_FILE]: 'Temporary Files',
    [ArtifactType.LOG]: 'Diagnostic Logs',
    [ArtifactType.BUILD_OUTPUT]: 'Build Outputs',
    [ArtifactType.DERIVED_DATA]: 'Derived Data',
    [ArtifactType.SESSION_HISTORY]: 'Session Histories',
    [ArtifactType.USER_CONTENT]: 'Source & User Content',
    [ArtifactType.MODEL_DATA]: 'Model Weights & Datasets',
    [ArtifactType.CHECKPOINT]: 'State Checkpoints',
    [ArtifactType.UNKNOWN]: 'Unclassified Artifacts'
  };
  return labels[type] || 'Artifacts';
}
