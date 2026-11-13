import {
  NodeType,
  EdgeType,
  ProvenanceConfidence,
  RiskCategory,
  createProvenanceEdgeModel
} from '../models/entities.js';

/** Upper bounds for file marks on the map. Above these the map shows a selection. */
export const MAP_MAX_ARTIFACT_NODES = 320;
export const MAP_MAX_RECORDED_NODES = 160;
export const MAP_MAX_NODES_PER_GROUP = 14;
export const MAP_MAX_OPERATION_NODES = 160;

/**
 * Chooses which files get a mark on the map. Selection only affects drawing: provenance,
 * classification, totals and cleanup always operate on the full artifact list.
 */
export function selectArtifactsForMap(activeArtifacts, artifactGroups = []) {
  if (activeArtifacts.length <= MAP_MAX_ARTIFACT_NODES) {
    return activeArtifacts;
  }
  const bySizeDesc = (a, b) => b.sizeBytes - a.sizeBytes;
  const chosen = new Map();

  // Files a session's ledger names are the most informative marks: keep them first.
  activeArtifacts
    .filter((a) => a.provenanceConfidence === ProvenanceConfidence.VERIFIED)
    .sort(bySizeDesc)
    .slice(0, MAP_MAX_RECORDED_NODES)
    .forEach((a) => chosen.set(a.id, a));

  // Then the largest files of every group, so each kind stays represented.
  const byId = new Map(activeArtifacts.map((a) => [a.id, a]));
  for (const grp of artifactGroups) {
    const members = grp.artifactIds.map((id) => byId.get(id)).filter(Boolean).sort(bySizeDesc);
    for (const art of members.slice(0, MAP_MAX_NODES_PER_GROUP)) {
      if (chosen.size >= MAP_MAX_ARTIFACT_NODES) break;
      chosen.set(art.id, art);
    }
  }

  // Fill what is left with the largest remaining files.
  if (chosen.size < MAP_MAX_ARTIFACT_NODES) {
    for (const art of [...activeArtifacts].sort(bySizeDesc)) {
      if (chosen.size >= MAP_MAX_ARTIFACT_NODES) break;
      if (!chosen.has(art.id)) chosen.set(art.id, art);
    }
  }
  return Array.from(chosen.values());
}

/** How many folder marks the map shows for a large scan, and how many rows Sizes lists. */
export const MAP_MAX_FOLDER_NODES = 24;
export const MAX_FOLDER_ROLLUPS = 40;

function parentOf(dir) {
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? '/' : dir.slice(0, cut);
}

/**
 * Summarizes where the files are: a short list of folders that together hold every file.
 * It starts at the common ancestor of all files and keeps splitting the folder that holds
 * the most files into its subfolders, until the list is detailed enough. A folder that has
 * both subfolders and files of its own keeps a separate "files directly in" entry.
 *
 * Bytes are physical: data shared through hardlinks is counted once. Rollups only describe
 * the scan; cleanup still happens file by file.
 */
export function buildFolderRollups(artifacts, { maxFolders = MAX_FOLDER_ROLLUPS } = {}) {
  if (artifacts.length === 0) {
    return [];
  }
  const dirOf = (a) => a.parentDir || parentOf(a.canonicalPath);

  // Common ancestor of every file's directory
  let common = dirOf(artifacts[0]).split('/');
  for (const art of artifacts) {
    const parts = dirOf(art).split('/');
    let k = 0;
    while (k < common.length && k < parts.length && common[k] === parts[k]) k += 1;
    if (k < common.length) common = common.slice(0, k);
  }
  const root = common.join('/') || '/';

  // Cumulative totals for every directory between a file and the common ancestor
  const stats = new Map();
  const entryFor = (dir) => {
    let entry = stats.get(dir);
    if (!entry) {
      entry = { count: 0, bytes: 0, direct: 0, directBytes: 0, risks: {}, directRisks: {}, children: new Set() };
      stats.set(dir, entry);
    }
    return entry;
  };
  const seenInodes = new Set();
  for (const art of artifacts) {
    const inodeKey = art.physicalInodeKey || art.canonicalPath;
    const bytes = seenInodes.has(inodeKey) ? 0 : art.sizeBytes || 0;
    seenInodes.add(inodeKey);
    const risk = art.cleanupClassification;
    const ownDir = dirOf(art);
    const own = entryFor(ownDir);
    own.direct += 1;
    own.directBytes += bytes;
    own.directRisks[risk] = (own.directRisks[risk] || 0) + 1;
    let dir = ownDir;
    for (;;) {
      const entry = entryFor(dir);
      entry.count += 1;
      entry.bytes += bytes;
      entry.risks[risk] = (entry.risks[risk] || 0) + 1;
      if (dir === root || dir === '/') break;
      const parent = parentOf(dir);
      entryFor(parent).children.add(dir);
      dir = parent;
    }
  }

  // Split the fullest folder until the list is detailed enough
  const total = artifacts.length;
  const splitThreshold = Math.max(200, Math.ceil(total * 0.12));
  let frontier = [{ path: root, directOnly: false }];
  for (let round = 0; round < 400; round++) {
    let pick = -1;
    for (let k = 0; k < frontier.length; k++) {
      const item = frontier[k];
      if (item.directOnly) continue;
      const entry = stats.get(item.path);
      if (entry.children.size === 0) continue;
      const worthSplitting = frontier.length === 1 || entry.count >= splitThreshold;
      if (worthSplitting && (pick === -1 || entry.count > stats.get(frontier[pick].path).count)) {
        pick = k;
      }
    }
    if (pick === -1) break;
    const entry = stats.get(frontier[pick].path);
    const parts = [...entry.children].map((child) => ({ path: child, directOnly: false }));
    if (entry.direct > 0) {
      parts.push({ path: frontier[pick].path, directOnly: true });
    }
    if (frontier.length - 1 + parts.length > maxFolders) break;
    frontier.splice(pick, 1, ...parts);
  }

  const rollupByKey = new Map();
  const rollups = frontier.map((item) => {
    const entry = stats.get(item.path);
    const risks = item.directOnly ? entry.directRisks : entry.risks;
    const relative = item.path === root ? '' : item.path.slice(root === '/' ? 1 : root.length + 1);
    const baseLabel = relative || root.slice(root.lastIndexOf('/') + 1) || '/';
    const rollup = {
      id: `folder:${item.path}${item.directOnly ? ':files' : ''}`,
      path: item.path,
      label: item.directOnly ? `${baseLabel} (files directly inside)` : baseLabel,
      directOnly: item.directOnly,
      artifactCount: item.directOnly ? entry.direct : entry.count,
      bytes: item.directOnly ? entry.directBytes : entry.bytes,
      riskCounts: risks,
      riskCategory: summarizeRisk(risks),
      artifactIds: []
    };
    rollupByKey.set(`${item.path}|${item.directOnly ? 'd' : 'c'}`, rollup);
    return rollup;
  });

  // Assign every file to the rollup that contains it
  for (const art of artifacts) {
    const ownDir = dirOf(art);
    let target = rollupByKey.get(`${ownDir}|d`);
    let dir = ownDir;
    while (!target) {
      target = rollupByKey.get(`${dir}|c`);
      if (target || dir === root || dir === '/') break;
      dir = parentOf(dir);
    }
    if (target) target.artifactIds.push(art.id);
  }

  return rollups.sort((a, b) => b.bytes - a.bytes);
}

// A folder is shown as safe only when every file in it is safe. A mixed folder is "review
// first", unless most of its files are high risk or protected.
export function summarizeRisk(risks) {
  const present = Object.keys(risks).filter((k) => risks[k] > 0);
  if (present.length === 1) return present[0];
  const total = present.reduce((sum, k) => sum + risks[k], 0);
  if ((risks[RiskCategory.HIGH] || 0) * 2 >= total) return RiskCategory.HIGH;
  if ((risks[RiskCategory.PROTECTED] || 0) * 2 >= total) return RiskCategory.PROTECTED;
  return RiskCategory.REVIEW;
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function physicalTotals(artifacts) {
  const seen = new Set();
  let bytes = 0;
  for (const art of artifacts) {
    const key = art.physicalInodeKey || art.canonicalPath;
    if (!seen.has(key)) {
      seen.add(key);
      bytes += art.sizeBytes || 0;
    }
  }
  return { count: artifacts.length, bytes };
}

function largestOf(artifacts) {
  let top = null;
  for (const art of artifacts) {
    if (!top || art.sizeBytes > top.sizeBytes) top = art;
  }
  return top ? { id: top.id, name: top.name, sizeBytes: top.sizeBytes } : null;
}

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
        artifactType: grp.artifactType,
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

    // Which files get a mark is decided here, before tool calls, because a large scan only
    // draws the tool calls that touched a drawn file.
    const activeArtifacts = artifacts.filter((a) => !a.quarantined);
    // A large scan cannot draw every file. The map shows every file a session recorded, then
    // the largest files of each group; totals and the Sizes view always cover all files.
    const shownArtifacts = selectArtifactsForMap(activeArtifacts, artifactGroups);
    const isCapped = shownArtifacts.length < activeArtifacts.length;

    // 5. Operation nodes (tool calls)
    let shownOperations = operations;
    if (isCapped || operations.length > MAP_MAX_OPERATION_NODES) {
      const touched = new Set();
      for (const art of shownArtifacts) {
        for (const opId of art.operationIds || []) touched.add(opId);
      }
      shownOperations = operations.filter((op) => touched.has(op.id)).slice(0, MAP_MAX_OPERATION_NODES);
    }
    shownOperations.forEach((op, idx) => {
      const angle = (idx / Math.max(shownOperations.length, 1)) * Math.PI * 2;
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
    shownArtifacts.forEach((art, idx) => {
      const angle = (idx / Math.max(shownArtifacts.length, 1)) * Math.PI * 2;
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

    // Folder summary. On a large scan the biggest folders also get a mark on the map, so the
    // files that have no mark of their own are still represented.
    const folderRollups = buildFolderRollups(activeArtifacts);
    const folderNodeIds = new Set();
    if (shownArtifacts.length < activeArtifacts.length) {
      folderRollups
        .filter((f) => f.artifactCount >= 10)
        .slice(0, MAP_MAX_FOLDER_NODES)
        .forEach((folder, idx, list) => {
          const angle = (idx / Math.max(list.length, 1)) * Math.PI * 2;
          addNode({
            id: folder.id,
            nodeType: NodeType.FOLDER,
            label: folder.label,
            subtitle: `${folder.artifactCount} files`,
            sizeBytes: folder.bytes,
            confidence: ProvenanceConfidence.VERIFIED,
            riskCategory: folder.riskCategory,
            clusterKey: 'folders',
            x: Math.cos(angle) * 380,
            y: Math.sin(angle) * 380,
            radius: Math.max(16, Math.min(30, 10 + Math.log10(Math.max(folder.artifactCount, 10)) * 5)),
            metadata: {
              path: folder.path,
              directOnly: folder.directOnly,
              artifactCount: folder.artifactCount,
              bytes: folder.bytes,
              riskCounts: folder.riskCounts
            }
          });
          folderNodeIds.add(folder.id);
          if (application && nodeById.has(application.id)) {
            addEdge(
              createProvenanceEdgeModel({
                sourceId: folder.id,
                targetId: application.id,
                edgeType: EdgeType.BELONGS_TO,
                confidence: ProvenanceConfidence.VERIFIED,
                explanation: `Folder '${folder.label}' is inside the data locations scanned for ${application.name}.`
              })
            );
          }
        });
    }

    const treemap = this.buildSpaceTreemap({
      application,
      workspaces,
      sessions,
      artifacts: activeArtifacts,
      artifactGroups
    });
    treemap.byFolder = folderRollups.map((f) => ({
      id: f.id,
      label: f.label,
      path: f.path,
      riskCategory: f.riskCategory,
      bytes: f.bytes,
      artifactCount: f.artifactCount,
      focusNodeId: folderNodeIds.has(f.id) ? f.id : null,
      artifactIds: f.artifactIds
    }));

    return {
      nodes,
      edges,
      treemap,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        artifactCount: activeArtifacts.length,
        shownArtifactCount: shownArtifacts.length,
        hiddenArtifactCount: activeArtifacts.length - shownArtifacts.length,
        sessionCount: sessions.length,
        operationCount: operations.length,
        shownOperationCount: shownOperations.length,
        riskCounts: countBy(activeArtifacts, (a) => a.cleanupClassification),
        largestArtifact: largestOf(activeArtifacts),
        // The application's own folders versus files inside project folders
        scopeTotals: {
          appData: physicalTotals(activeArtifacts.filter((a) => !a.workspaceId)),
          projects: physicalTotals(activeArtifacts.filter((a) => a.workspaceId))
        },
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
