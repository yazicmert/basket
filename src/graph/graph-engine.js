import {
  NodeType,
  EdgeType,
  ProvenanceConfidence,
  RiskCategory,
  createProvenanceEdgeModel
} from '../models/entities.js';

export class GraphEngine {
  /**
   * Constructs the complete interactive Knowledge Graph and Space Treemap
   * from analyzed domain entities.
   */
  buildKnowledgeGraph({
    application = null,
    workspaces = [],
    sessions = [],
    operations = [],
    artifacts = [],
    artifactGroups = [],
    provenanceEdges = [],
    unknownOriginNodeId = 'unk_global'
  }) {
    const nodes = [];
    const nodeById = new Map();
    const edges = [];
    const edgeById = new Map();

    const addNode = (node) => {
      if (!nodeById.has(node.id)) {
        nodeById.set(node.id, node);
        nodes.push(node);
      }
    };

    const addEdge = (edge) => {
      if (!edgeById.has(edge.id) && nodeById.has(edge.sourceId) && nodeById.has(edge.targetId)) {
        edgeById.set(edge.id, edge);
        edges.push(edge);
      }
    };

    // 1. AI Application node (center anchor)
    if (application) {
      addNode({
        id: application.id,
        nodeType: NodeType.AI_APPLICATION,
        label: application.name,
        subtitle: application.bundleId || application.adapterId,
        sizeBytes: 0,
        confidence: ProvenanceConfidence.VERIFIED,
        riskCategory: RiskCategory.PROTECTED,
        clusterKey: 'core',
        x: 0,
        y: 0,
        radius: 30,
        metadata: application
      });
    }

    // 2. Workspace nodes (inner ring)
    workspaces.forEach((ws, idx) => {
      const angle = (idx / Math.max(workspaces.length, 1)) * Math.PI * 1.4 - Math.PI * 0.7;
      addNode({
        id: ws.id,
        nodeType: NodeType.WORKSPACE,
        label: ws.name,
        subtitle: ws.canonicalPath,
        sizeBytes: 0,
        confidence: ProvenanceConfidence.VERIFIED,
        riskCategory: RiskCategory.PROTECTED,
        clusterKey: ws.id,
        x: Math.cos(angle) * 190,
        y: Math.sin(angle) * 190,
        radius: 23,
        metadata: ws
      });
    });

    // 3. Artifact Group nodes
    artifactGroups.forEach((grp, idx) => {
      const angle = (idx / Math.max(artifactGroups.length, 1)) * Math.PI * 2;
      addNode({
        id: grp.id,
        nodeType: NodeType.ARTIFACT_GROUP,
        label: grp.name,
        subtitle: `${grp.artifactIds.length} items`,
        sizeBytes: grp.deduplicatedBytes,
        confidence: ProvenanceConfidence.VERIFIED,
        riskCategory: grp.riskSummary,
        clusterKey: grp.categoryKey,
        x: Math.cos(angle) * 260,
        y: Math.sin(angle) * 260,
        radius: 19,
        metadata: grp
      });
    });

    // 4. Session nodes (middle ring)
    sessions.forEach((sess, idx) => {
      const angle = (idx / Math.max(sessions.length, 1)) * Math.PI * 1.8 - Math.PI * 0.9;
      addNode({
        id: sess.id,
        nodeType: NodeType.SESSION,
        label: sess.title,
        subtitle: sess.externalSessionId,
        sizeBytes: 0,
        confidence: ProvenanceConfidence.VERIFIED,
        riskCategory: RiskCategory.HIGH,
        clusterKey: sess.workspaceId || 'sessions',
        x: Math.cos(angle) * 330,
        y: Math.sin(angle) * 330,
        radius: 20,
        metadata: sess
      });
    });

    // 5. Operation nodes (tool calls)
    operations.forEach((op, idx) => {
      const angle = (idx / Math.max(operations.length, 1)) * Math.PI * 2;
      addNode({
        id: op.id,
        nodeType: NodeType.OPERATION,
        label: `${op.toolName} (#${op.sequence})`,
        subtitle: op.operationType,
        sizeBytes: 0,
        confidence: op.confidence,
        riskCategory: RiskCategory.REVIEW,
        clusterKey: op.sessionId,
        x: Math.cos(angle) * 430,
        y: Math.sin(angle) * 430,
        radius: 14,
        metadata: op
      });
    });

    // 6. Unknown Origin node (only added if at least one artifact has UNKNOWN provenance)
    const hasUnknownArtifacts = artifacts.some(
      (a) => a.provenanceConfidence === ProvenanceConfidence.UNKNOWN
    );
    if (hasUnknownArtifacts) {
      addNode({
        id: unknownOriginNodeId,
        nodeType: NodeType.UNKNOWN_ORIGIN,
        label: 'Unknown / Unverified Origin',
        subtitle: 'No session ledger record',
        sizeBytes: 0,
        confidence: ProvenanceConfidence.UNKNOWN,
        riskCategory: RiskCategory.HIGH,
        clusterKey: 'unknown_origin',
        x: 340,
        y: 260,
        radius: 22,
        metadata: {
          explanation:
            'Artifacts linked here lack direct tool-invocation or application-container evidence. Artifact Atlas never fabricates conversation provenance from timestamp proximity alone.'
        }
      });
    }

    // 7. Artifact nodes (outer ring clustered near their group or session)
    const activeArtifacts = artifacts.filter((a) => !a.quarantined);
    activeArtifacts.forEach((art, idx) => {
      const angle = (idx / Math.max(activeArtifacts.length, 1)) * Math.PI * 2;
      const ringRadius = 540 + (idx % 3) * 48;
      const logRadius = Math.max(10, Math.min(22, 10 + Math.log10(Math.max(art.sizeBytes, 100)) * 1.8));
      addNode({
        id: art.id,
        nodeType: NodeType.ARTIFACT,
        label: art.name,
        subtitle: art.artifactType,
        sizeBytes: art.sizeBytes,
        confidence: art.provenanceConfidence,
        riskCategory: art.cleanupClassification,
        artifactType: art.artifactType,
        clusterKey: art.groupId || art.workspaceId || 'artifacts',
        x: Math.cos(angle) * ringRadius,
        y: Math.sin(angle) * ringRadius,
        radius: logRadius,
        metadata: art
      });
    });

    // Add provenance edges produced by ProvenanceEngine
    for (const pe of provenanceEdges) {
      addEdge(pe);
    }

    // Add group containment edges (ArtifactGroup -> CONTAINS -> Artifact, Group -> BELONGS_TO -> App)
    for (const grp of artifactGroups) {
      if (application && nodeById.has(application.id)) {
        addEdge(
          createProvenanceEdgeModel({
            sourceId: grp.id,
            targetId: application.id,
            edgeType: EdgeType.BELONGS_TO,
            confidence: ProvenanceConfidence.VERIFIED,
            explanation: `Artifact group '${grp.name}' belongs to ${application.name}.`
          })
        );
      }
      for (const artId of grp.artifactIds) {
        if (nodeById.has(artId)) {
          addEdge(
            createProvenanceEdgeModel({
              sourceId: grp.id,
              targetId: artId,
              edgeType: EdgeType.CONTAINS,
              confidence: ProvenanceConfidence.VERIFIED,
              explanation: `Group '${grp.name}' contains artifact.`
            })
          );
        }
      }
    }

    const treemap = this.buildSpaceTreemap({
      application,
      workspaces,
      sessions,
      artifacts: activeArtifacts,
      artifactGroups
    });

    return {
      nodes,
      edges,
      treemap,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        artifactCount: activeArtifacts.length,
        verifiedArtifactCount: activeArtifacts.filter(
          (a) => a.provenanceConfidence === ProvenanceConfidence.VERIFIED
        ).length,
        inferredArtifactCount: activeArtifacts.filter(
          (a) => a.provenanceConfidence === ProvenanceConfidence.INFERRED
        ).length,
        unknownArtifactCount: activeArtifacts.filter(
          (a) => a.provenanceConfidence === ProvenanceConfidence.UNKNOWN
        ).length
      }
    };
  }

  /**
   * Traces upstream and downstream provenance paths for any selected node ID.
   * Returns highlighted nodes, highlighted edges, dimmed nodes, and related artifacts.
   */
  traceProvenancePaths(graph, selectedNodeId) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const selectedNode = nodeById.get(selectedNodeId);
    if (!selectedNode) {
      return null;
    }

    const highlightedNodeIds = new Set([selectedNodeId]);
    const highlightedEdgeIds = new Set();
    const provenanceHops = [];

    // Build adjacency lists excluding purely cosmetic group CONTAINS edges when tracing an artifact's origin,
    // except keep direct group membership for context.
    const outgoingBySource = new Map();
    const incomingByTarget = new Map();

    for (const edge of graph.edges) {
      const out = outgoingBySource.get(edge.sourceId) || [];
      out.push(edge);
      outgoingBySource.set(edge.sourceId, out);

      const inc = incomingByTarget.get(edge.targetId) || [];
      inc.push(edge);
      incomingByTarget.set(edge.targetId, inc);
    }

    // Upstream traversal: Artifact -> Operation / Source Artifact / Session / Workspace / Application / Unknown Origin
    const queue = [{ nodeId: selectedNodeId, depth: 0 }];
    const visitedUpstream = new Set([selectedNodeId]);

    while (queue.length > 0) {
      const { nodeId, depth } = queue.shift();
      if (depth >= 6) {
        continue;
      }

      const outEdges = outgoingBySource.get(nodeId) || [];
      for (const edge of outEdges) {
        highlightedEdgeIds.add(edge.id);
        highlightedNodeIds.add(edge.targetId);

        const targetNode = nodeById.get(edge.targetId);
        provenanceHops.push({
          depth: depth + 1,
          direction: 'UPSTREAM',
          edgeId: edge.id,
          edgeType: edge.edgeType,
          confidence: edge.confidence,
          fromNodeId: edge.sourceId,
          toNodeId: edge.targetId,
          toNodeLabel: targetNode ? targetNode.label : edge.targetId,
          toNodeType: targetNode ? targetNode.nodeType : 'UNKNOWN',
          explanation: edge.explanation
        });

        // Do not recurse through ARTIFACT_GROUP to unrelated artifacts during upstream provenance trace
        if (
          targetNode &&
          targetNode.nodeType !== NodeType.ARTIFACT_GROUP &&
          !visitedUpstream.has(edge.targetId)
        ) {
          visitedUpstream.add(edge.targetId);
          queue.push({ nodeId: edge.targetId, depth: depth + 1 });
        }
      }

      // Direct group containment edge if selectedNode is an artifact
      if (nodeId === selectedNodeId) {
        const incEdges = incomingByTarget.get(nodeId) || [];
        for (const edge of incEdges) {
          highlightedEdgeIds.add(edge.id);
          highlightedNodeIds.add(edge.sourceId);
          const sourceNode = nodeById.get(edge.sourceId);
          provenanceHops.push({
            depth: 1,
            direction: 'DOWNSTREAM',
            edgeId: edge.id,
            edgeType: edge.edgeType,
            confidence: edge.confidence,
            fromNodeId: edge.sourceId,
            toNodeId: edge.targetId,
            toNodeLabel: sourceNode ? sourceNode.label : edge.sourceId,
            toNodeType: sourceNode ? sourceNode.nodeType : 'UNKNOWN',
            explanation: edge.explanation
          });
        }
      }
    }

    // If user clicked a Session, Operation, Workspace, or Group node, also highlight downstream artifacts
    if (selectedNode.nodeType !== NodeType.ARTIFACT) {
      const downQueue = [{ nodeId: selectedNodeId, depth: 0 }];
      const visitedDown = new Set([selectedNodeId]);
      while (downQueue.length > 0) {
        const { nodeId, depth } = downQueue.shift();
        if (depth >= 4) {
          continue;
        }
        const incEdges = incomingByTarget.get(nodeId) || [];
        for (const edge of incEdges) {
          highlightedEdgeIds.add(edge.id);
          highlightedNodeIds.add(edge.sourceId);
          if (!visitedDown.has(edge.sourceId)) {
            visitedDown.add(edge.sourceId);
            downQueue.push({ nodeId: edge.sourceId, depth: depth + 1 });
          }
        }
      }
    }

    // Related artifacts: artifacts sharing a session, operation, or group with the selected node
    const relatedArtifactIds = new Set();
    if (selectedNode.nodeType === NodeType.ARTIFACT) {
      const art = selectedNode.metadata;
      for (const node of graph.nodes) {
        if (node.nodeType !== NodeType.ARTIFACT || node.id === selectedNodeId) {
          continue;
        }
        const candidate = node.metadata;
        const sharesSession =
          art.sessionIds.length > 0 &&
          art.sessionIds.some((sid) => candidate.sessionIds.includes(sid));
        const sharesGroup = art.groupId && art.groupId === candidate.groupId;
        if (sharesSession || ( art.sessionIds.length === 0 && sharesGroup )) {
          relatedArtifactIds.add(node.id);
        }
      }
    } else {
      for (const nid of highlightedNodeIds) {
        const n = nodeById.get(nid);
        if (n && n.nodeType === NodeType.ARTIFACT) {
          relatedArtifactIds.add(n.id);
        }
      }
    }

    const dimmedNodeIds = graph.nodes
      .filter((n) => !highlightedNodeIds.has(n.id))
      .map((n) => n.id);

    return {
      selectedNodeId,
      selectedNode,
      highlightedNodeIds: Array.from(highlightedNodeIds),
      highlightedEdgeIds: Array.from(highlightedEdgeIds),
      dimmedNodeIds,
      provenanceHops,
      relatedArtifactIds: Array.from(relatedArtifactIds)
    };
  }

  /**
   * Builds deduplicated space-usage Treemap breakdowns (Section 6).
   * Never double-counts physical inodes even when an artifact belongs to multiple sessions.
   */
  buildSpaceTreemap({
    application = null,
    workspaces = [],
    sessions = [],
    artifacts = [],
    artifactGroups = []
  }) {
    const globalInodes = new Set();
    let totalPhysicalBytes = 0;
    let reclaimablePhysicalBytes = 0;
    let reviewPhysicalBytes = 0;
    let highRiskPhysicalBytes = 0;
    let protectedOrUncertainPhysicalBytes = 0;

    for (const art of artifacts) {
      const inodeKey = art.physicalInodeKey || art.canonicalPath;
      if (globalInodes.has(inodeKey)) {
        continue;
      }
      globalInodes.add(inodeKey);
      totalPhysicalBytes += art.sizeBytes;

      if (art.cleanupClassification === RiskCategory.LOW) {
        reclaimablePhysicalBytes += art.sizeBytes;
      } else if (art.cleanupClassification === RiskCategory.REVIEW) {
        reviewPhysicalBytes += art.sizeBytes;
      } else if (art.cleanupClassification === RiskCategory.HIGH) {
        highRiskPhysicalBytes += art.sizeBytes;
      } else {
        protectedOrUncertainPhysicalBytes += art.sizeBytes;
      }
    }

    // 1. Breakdown by Artifact Group
    const byGroup = artifactGroups
      .map((grp) => ({
        id: grp.id,
        label: grp.name,
        category: grp.artifactType,
        riskCategory: grp.riskSummary,
        bytes: grp.deduplicatedBytes,
        artifactType: grp.artifactType,
        artifactCount: grp.artifactIds.length,
        focusNodeId: grp.id,
        artifactIds: grp.artifactIds
      }))
      .filter((cell) => cell.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    // 2. Breakdown by Workspace (deduplicated per workspace)
    const wsMap = new Map(workspaces.map((w) => [w.id, w]));
    const byWorkspaceBuckets = new Map();
    for (const art of artifacts) {
      const wsKey = art.workspaceId || '__app_container__';
      if (!byWorkspaceBuckets.has(wsKey)) {
        const wsObj = wsMap.get(wsKey);
        byWorkspaceBuckets.set(wsKey, {
          id: wsKey,
          label: wsObj ? `Workspace: ${wsObj.name}` : `${application?.name || 'Application'} Data Containers`,
          inodes: new Set(),
          bytes: 0,
          artifactIds: [],
          focusNodeId: wsObj ? wsObj.id : application?.id || null
        });
      }
      const bucket = byWorkspaceBuckets.get(wsKey);
      bucket.artifactIds.push(art.id);
      const inodeKey = art.physicalInodeKey || art.canonicalPath;
      if (!bucket.inodes.has(inodeKey)) {
        bucket.inodes.add(inodeKey);
        bucket.bytes += art.sizeBytes;
      }
    }
    const byWorkspace = Array.from(byWorkspaceBuckets.values())
      .map(({ inodes, ...rest }) => ({ ...rest, artifactCount: rest.artifactIds.length }))
      .filter((c) => c.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    // 3. Breakdown by Session Attribution (deduplicated globally across sessions so shared files aren't double-counted!)
    const sessMap = new Map(sessions.map((s) => [s.id, s]));
    const sessionBuckets = new Map();
    const countedSessionInodes = new Set();

    for (const art of artifacts) {
      const inodeKey = art.physicalInodeKey || art.canonicalPath;
      const isAlreadyCountedPhysical = countedSessionInodes.has(inodeKey);
      countedSessionInodes.add(inodeKey);

      let bucketKey;
      let bucketLabel;
      let focusNodeId = null;

      if (art.sessionIds.length > 1) {
        bucketKey = '__shared_multi_session__';
        bucketLabel = `Shared Across Multiple Sessions (${art.sessionIds.length})`;
        focusNodeId = art.id;
      } else if (art.sessionIds.length === 1) {
        const s = sessMap.get(art.sessionIds[0]);
        bucketKey = art.sessionIds[0];
        bucketLabel = s ? s.title : `Session ${art.sessionIds[0]}`;
        focusNodeId = art.sessionIds[0];
      } else {
        bucketKey = '__unattributed_session__';
        bucketLabel = 'Unattributed / Application-Level Only';
        focusNodeId = application?.id || null;
      }

      if (!sessionBuckets.has(bucketKey)) {
        sessionBuckets.set(bucketKey, {
          id: bucketKey,
          label: bucketLabel,
          bytes: 0,
          artifactIds: [],
          focusNodeId
        });
      }
      const b = sessionBuckets.get(bucketKey);
      b.artifactIds.push(art.id);
      if (!isAlreadyCountedPhysical) {
        b.bytes += art.sizeBytes;
      }
    }

    const bySession = Array.from(sessionBuckets.values())
      .map((b) => ({ ...b, artifactCount: b.artifactIds.length }))
      .filter((c) => c.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);

    return {
      totalPhysicalBytes,
      reclaimablePhysicalBytes,
      reviewPhysicalBytes,
      highRiskPhysicalBytes,
      protectedOrUncertainPhysicalBytes,
      byGroup,
      byWorkspace,
      bySession
    };
  }
}
