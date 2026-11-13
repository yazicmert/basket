import path from 'node:path';
import { toPathKey } from '../platform/path-keys.js';
import {
  EdgeType,
  ProvenanceConfidence,
  createEvidenceModel,
  createProvenanceEdgeModel,
  stableId,
  WRITE_OPERATION_TYPES
} from '../models/entities.js';

export class ProvenanceEngine {
  /**
   * Resolves provenance for all indexed artifacts against discovered applications,
   * workspaces, sessions, and operations.
   *
   * Never fabricates a session-to-file link from timestamp proximity alone.
   */
  analyzeProvenance({
    artifacts = [],
    application = null,
    workspaces = [],
    sessions = [],
    operations = []
  }) {
    const provenanceEdges = [];
    const allEvidence = [];
    const unknownOriginNodeId = stableId('unk', application ? application.id : 'global');

    // Index operations by canonical targetPath
    const opsByTargetPath = new Map();
    for (const op of operations) {
      // Only tool calls that write a file link it to a session; reading it does not
      if (!op.targetPath || !WRITE_OPERATION_TYPES.has(op.operationType)) {
        continue;
      }
      const list = opsByTargetPath.get(op.targetPath) || [];
      list.push(op);
      opsByTargetPath.set(op.targetPath, list);
    }

    // Index sessions by sourcePath (so the session .jsonl file itself is VERIFIED for that session)
    const sessionsBySourcePath = new Map();
    const sessionsById = new Map();
    for (const sess of sessions) {
      sessionsById.set(sess.id, sess);
      if (sess.sourcePath) {
        const list = sessionsBySourcePath.get(sess.sourcePath) || [];
        list.push(sess);
        sessionsBySourcePath.set(sess.sourcePath, list);
      }
    }

    // Structural edges: Workspace -> Application, Session -> Workspace/Application, Operation -> Session
    for (const ws of workspaces) {
      if (application) {
        provenanceEdges.push(
          createProvenanceEdgeModel({
            sourceId: ws.id,
            targetId: application.id,
            edgeType: EdgeType.BELONGS_TO,
            confidence: ProvenanceConfidence.VERIFIED,
            explanation: `Workspace ${ws.name} is registered in ${application.name} metadata.`
          })
        );
      }
    }

    for (const sess of sessions) {
      if (sess.workspaceId) {
        provenanceEdges.push(
          createProvenanceEdgeModel({
            sourceId: sess.id,
            targetId: sess.workspaceId,
            edgeType: EdgeType.BELONGS_TO,
            confidence: ProvenanceConfidence.VERIFIED,
            explanation: `Session ${sess.title} executed inside workspace.`
          })
        );
      } else if (application) {
        provenanceEdges.push(
          createProvenanceEdgeModel({
            sourceId: sess.id,
            targetId: application.id,
            edgeType: EdgeType.BELONGS_TO,
            confidence: ProvenanceConfidence.VERIFIED,
            explanation: `Session ${sess.title} belongs to ${application.name}.`
          })
        );
      }
    }

    for (const op of operations) {
      provenanceEdges.push(
        createProvenanceEdgeModel({
          sourceId: op.id,
          targetId: op.sessionId,
          edgeType: EdgeType.GENERATED_DURING,
          confidence: ProvenanceConfidence.VERIFIED,
          explanation: `Tool operation ${op.toolName} (#${op.sequence}) recorded in session ledger.`
        })
      );
    }

    const appDataRoots = application
      ? application.knownDataDirectories.map((d) => path.resolve(d.path))
      : [];

    for (const artifact of artifacts) {
      const directOps = opsByTargetPath.get(artifact.canonicalPath) || [];
      const directTranscriptSessions = sessionsBySourcePath.get(artifact.canonicalPath) || [];

      // Case 1: VERIFIED provenance via explicit operation target path in session ledger
      if (directOps.length > 0) {
        const contributingSessionIds = new Set();
        const contributingOpIds = new Set();

        for (const op of directOps) {
          contributingOpIds.add(op.id);
          contributingSessionIds.add(op.sessionId);

          const ev = createEvidenceModel({
            subjectId: artifact.id,
            confidence: ProvenanceConfidence.VERIFIED,
            sourceType: 'SESSION_TOOL_LEDGER',
            sourceRef: op.sourceRecordRef,
            ruleId: 'provenance.verified.tool_operation',
            summary: `Verified ${op.operationType} via tool '${op.toolName}' in session record (${op.sourceRecordRef}).`,
            details: {
              operationId: op.id,
              sessionId: op.sessionId,
              toolName: op.toolName,
              operationType: op.operationType,
              timestamp: op.timestamp
            }
          });
          artifact.evidence.push(ev);
          allEvidence.push(ev);

          const edgeType =
            op.operationType === 'WRITE' ? EdgeType.CREATED_BY : EdgeType.MODIFIED_BY;

          provenanceEdges.push(
            createProvenanceEdgeModel({
              sourceId: artifact.id,
              targetId: op.id,
              edgeType,
              confidence: ProvenanceConfidence.VERIFIED,
              evidenceIds: [ev.id],
              explanation: ev.summary
            })
          );
        }

        artifact.sessionIds = Array.from(contributingSessionIds);
        artifact.operationIds = Array.from(contributingOpIds);
        artifact.provenanceConfidence = ProvenanceConfidence.VERIFIED;

        // Multi-parent / shared session check
        if (artifact.sessionIds.length > 1) {
          const sessionNames = artifact.sessionIds
            .map((sid) => sessionsById.get(sid)?.title || sid)
            .join(', ');
          artifact.sharedDependencyIndicators.push(
            `Shared across ${artifact.sessionIds.length} AI conversations (${sessionNames})`
          );

          for (const sid of artifact.sessionIds) {
            provenanceEdges.push(
              createProvenanceEdgeModel({
                sourceId: artifact.id,
                targetId: sid,
                edgeType: EdgeType.SHARED_WITH,
                confidence: ProvenanceConfidence.VERIFIED,
                explanation: `Artifact co-authored or modified across multiple conversations.`
              })
            );
          }
        }
        continue;
      }

      // Case 2: VERIFIED provenance because the file IS the session history transcript
      if (directTranscriptSessions.length > 0) {
        const sessIds = directTranscriptSessions.map((s) => s.id);
        artifact.sessionIds = sessIds;
        artifact.provenanceConfidence = ProvenanceConfidence.VERIFIED;

        for (const sess of directTranscriptSessions) {
          const ev = createEvidenceModel({
            subjectId: artifact.id,
            confidence: ProvenanceConfidence.VERIFIED,
            sourceType: 'SESSION_TRANSCRIPT_FILE',
            sourceRef: artifact.canonicalPath,
            ruleId: 'provenance.verified.session_transcript',
            summary: `Authoritative local transcript file for session '${sess.title}' (${sess.externalSessionId}).`,
            details: { sessionId: sess.id, externalSessionId: sess.externalSessionId }
          });
          artifact.evidence.push(ev);
          allEvidence.push(ev);

          provenanceEdges.push(
            createProvenanceEdgeModel({
              sourceId: artifact.id,
              targetId: sess.id,
              edgeType: EdgeType.BELONGS_TO,
              confidence: ProvenanceConfidence.VERIFIED,
              evidenceIds: [ev.id],
              explanation: ev.summary
            })
          );
        }
        continue;
      }

      // Case 3: INFERRED provenance when filename explicitly embeds a known externalSessionId
      // (e.g., debug/session-<id>.log or checkpoint-<sessionId>.json)
      const matchedSessionsByIdInName = sessions.filter(
        (s) =>
          s.externalSessionId &&
          s.externalSessionId.length >= 6 &&
          (artifact.name.includes(s.externalSessionId) ||
            artifact.canonicalPath.includes(s.externalSessionId))
      );

      if (matchedSessionsByIdInName.length > 0) {
        artifact.sessionIds = matchedSessionsByIdInName.map((s) => s.id);
        artifact.provenanceConfidence = ProvenanceConfidence.INFERRED;

        for (const sess of matchedSessionsByIdInName) {
          const ev = createEvidenceModel({
            subjectId: artifact.id,
            confidence: ProvenanceConfidence.INFERRED,
            sourceType: 'PATH_IDENTIFIER_CORRELATION',
            sourceRef: artifact.canonicalPath,
            ruleId: 'provenance.inferred.session_id_in_path',
            summary: `Inferred association with session '${sess.title}' because path contains session identifier '${sess.externalSessionId}', though no direct tool-write record exists.`,
            details: { sessionId: sess.id, externalSessionId: sess.externalSessionId }
          });
          artifact.evidence.push(ev);
          allEvidence.push(ev);

          provenanceEdges.push(
            createProvenanceEdgeModel({
              sourceId: artifact.id,
              targetId: sess.id,
              edgeType: EdgeType.GENERATED_DURING,
              confidence: ProvenanceConfidence.INFERRED,
              evidenceIds: [ev.id],
              explanation: ev.summary
            })
          );
        }
        continue;
      }

      // Case 4: INFERRED provenance when artifact is derived from a verified source file in the same workspace
      // (e.g., dist/bundle.js.map or build output matching a verified source stem)
      const isBuildOrDerivedDir = /\/(dist|build|\.next|out|DerivedData|\.cache|\.parcel-cache|__pycache__)\//.test(
        toPathKey(artifact.canonicalPath)
      );
      if (isBuildOrDerivedDir && artifact.workspaceId) {
        const stem = path.basename(artifact.name, artifact.extension).replace(/\.(bundle|min|chunk|js|css)$/i, '');
        const matchingVerifiedSourceArtifact = artifacts.find(
          (other) =>
            other.id !== artifact.id &&
            other.workspaceId === artifact.workspaceId &&
            opsByTargetPath.has(other.canonicalPath) &&
            path.basename(other.name, other.extension) === stem
        );

        if (matchingVerifiedSourceArtifact) {
          const upstreamOps = opsByTargetPath.get(matchingVerifiedSourceArtifact.canonicalPath) || [];
          const upstreamSessions = Array.from(new Set(upstreamOps.map((o) => o.sessionId)));
          artifact.sessionIds = upstreamSessions;
          artifact.provenanceConfidence = ProvenanceConfidence.INFERRED;

          const ev = createEvidenceModel({
            subjectId: artifact.id,
            confidence: ProvenanceConfidence.INFERRED,
            sourceType: 'DERIVED_ARTIFACT_CORRELATION',
            sourceRef: matchingVerifiedSourceArtifact.canonicalPath,
            ruleId: 'provenance.inferred.derived_from_verified_source',
            summary: `Inferred build/derived output from verified source '${matchingVerifiedSourceArtifact.name}' within the same workspace.`,
            details: {
              sourceArtifactId: matchingVerifiedSourceArtifact.id,
              sourcePath: matchingVerifiedSourceArtifact.canonicalPath
            }
          });
          artifact.evidence.push(ev);
          allEvidence.push(ev);

          provenanceEdges.push(
            createProvenanceEdgeModel({
              sourceId: artifact.id,
              targetId: matchingVerifiedSourceArtifact.id,
              edgeType: EdgeType.DERIVED_FROM,
              confidence: ProvenanceConfidence.INFERRED,
              evidenceIds: [ev.id],
              explanation: ev.summary
            })
          );
          continue;
        }
      }

      // Case 5: INFERRED application-level container provenance (inside dedicated app cache/support/log dir)
      const matchingAppRoot = appDataRoots.find(
        (root) =>
          artifact.canonicalPath === root ||
          artifact.canonicalPath.startsWith(root + path.sep)
      );

      if (matchingAppRoot && application) {
        artifact.provenanceConfidence = ProvenanceConfidence.INFERRED;
        const ev = createEvidenceModel({
          subjectId: artifact.id,
          confidence: ProvenanceConfidence.INFERRED,
          sourceType: 'APPLICATION_DATA_CONTAINER',
          sourceRef: matchingAppRoot,
          ruleId: 'provenance.inferred.app_data_directory',
          summary: `Inferred ownership by ${application.name} because artifact resides in known application container '${matchingAppRoot}'. Session-level origin is unrecorded.`,
          details: { applicationId: application.id, containerRoot: matchingAppRoot }
        });
        artifact.evidence.push(ev);
        allEvidence.push(ev);

        provenanceEdges.push(
          createProvenanceEdgeModel({
            sourceId: artifact.id,
            targetId: application.id,
            edgeType: EdgeType.BELONGS_TO,
            confidence: ProvenanceConfidence.INFERRED,
            evidenceIds: [ev.id],
            explanation: ev.summary
          })
        );
        continue;
      }

      // Case 6: UNKNOWN provenance — do NOT fabricate session link from timestamp proximity!
      artifact.provenanceConfidence = ProvenanceConfidence.UNKNOWN;
      const unknownEv = createEvidenceModel({
        subjectId: artifact.id,
        confidence: ProvenanceConfidence.UNKNOWN,
        sourceType: 'UNATTRIBUTED_FILESYSTEM_ENTRY',
        sourceRef: artifact.canonicalPath,
        ruleId: 'provenance.unknown.no_verified_ledger',
        summary:
          'No direct tool operation record or dedicated application container links this file to an AI session. Timestamp correlation alone is not treated as provenance.',
        details: { workspaceId: artifact.workspaceId }
      });
      artifact.evidence.push(unknownEv);
      allEvidence.push(unknownEv);

      provenanceEdges.push(
        createProvenanceEdgeModel({
          sourceId: artifact.id,
          targetId: unknownOriginNodeId,
          edgeType: EdgeType.POSSIBLY_RELATED_TO,
          confidence: ProvenanceConfidence.UNKNOWN,
          evidenceIds: [unknownEv.id],
          explanation: unknownEv.summary
        })
      );

      if (artifact.workspaceId) {
        provenanceEdges.push(
          createProvenanceEdgeModel({
            sourceId: artifact.id,
            targetId: artifact.workspaceId,
            edgeType: EdgeType.CONTAINS,
            confidence: ProvenanceConfidence.VERIFIED,
            explanation: 'File is physically located inside the workspace directory.'
          })
        );
      }
    }

    return {
      artifacts,
      provenanceEdges,
      evidence: allEvidence,
      unknownOriginNodeId
    };
  }
}
