const uiState = {
  theme: 'dark',
  bootstrap: null,
  activeState: null,
  quarantineEntries: [],
  selectedNodeId: null,
  selectedArtifactIds: new Set(),
  activeTrace: null,
  focusMode: false,
  searchQuery: '',
  filterNodeType: 'ALL',
  filterConfidence: 'ALL',
  filterRisk: 'ALL',
  activeTab: 'graph', // 'graph' | 'treemap' | 'quarantine'
  treemapGroupBy: 'byGroup',
  pendingBundlePath: null,
  pendingWorkspacePath: '',
  pendingReview: null,
  allowHighRiskSingleOverride: false,
  // Canvas graph camera & physics
  camera: { x: 0, y: 0, scale: 0.72 },
  nodes: [],
  edges: [],
  hoveredNode: null,
  draggingNode: null,
  isPanning: false,
  panStart: { x: 0, y: 0 },
  animTick: 0
};

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3800);
}

function getLocalApiToken() {
  const meta = document.querySelector('meta[name="atlas-api-token"]');
  if (meta && meta.content) {
    return meta.content;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

async function apiRequest(path, method = 'GET', body = null) {
  const token = getLocalApiToken();
  const opts = { method, headers: {} };
  if (token) {
    opts.headers['X-Atlas-Token'] = token;
  }
  if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

/* =========================================================================
   INITIALIZATION & BOOTSTRAP
   ========================================================================= */

async function initApp() {
  // Expose hooks for the native macOS SwiftUI + WKWebView host application
  window.handleNativeMacOSAppDrop = (bundlePath) => {
    if (bundlePath) {
      handleDroppedOrSelectedBundle(String(bundlePath).trim());
    }
  };
  window.handleNativeMacOSWorkspacePicked = (workspacePath) => {
    if (workspacePath) {
      uiState.pendingWorkspacePath = String(workspacePath).trim();
      executeScan({
        bundlePath: uiState.pendingBundlePath || null,
        workspacePath: uiState.pendingWorkspacePath
      });
    }
  };

  bindTopBarEvents();
  bindDropzoneEvents();
  bindExplorerControls();
  bindContextualToolbarEvents();
  bindModalEvents();
  initGraphCanvas();

  try {
    const boot = await apiRequest('/api/bootstrap');
    uiState.bootstrap = boot;
    uiState.quarantineEntries = boot.quarantineEntries || [];
    uiState.pendingWorkspacePath = boot.defaultWorkspacePath || '';

    if (boot.isDemoEnvironment) {
      document.getElementById('demo-env-badge').classList.remove('hidden');
    }

    renderDraggableBundles(boot.availableBundles || []);
    updateQuarantineCountPill();
  } catch (err) {
    showToast(`Failed to bootstrap: ${err.message}`);
  }
}

function bindTopBarEvents() {
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    uiState.theme = uiState.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', uiState.theme);
    document.getElementById('theme-icon-label').textContent =
      uiState.theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  });

  document.getElementById('back-to-dropzone-btn').addEventListener('click', () => {
    document.getElementById('explorer-view').classList.add('hidden');
    document.getElementById('scanning-view').classList.add('hidden');
    document.getElementById('empty-workspace-view').classList.remove('hidden');
    document.getElementById('back-to-dropzone-btn').classList.add('hidden');
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    openSettingsModal();
  });
}

/* =========================================================================
   EMPTY WORKSPACE & DRAG-AND-DROP RECOGNITION (Sections 4.1 & 4.2)
   ========================================================================= */

function renderDraggableBundles(bundles) {
  const dockList = document.getElementById('draggable-bundles-list');
  const modalList = document.getElementById('modal-bundles-list');
  dockList.innerHTML = '';
  modalList.innerHTML = '';

  bundles.forEach((b) => {
    // Dock draggable pill
    const pill = document.createElement('div');
    pill.className = 'bundle-pill';
    pill.draggable = true;
    pill.setAttribute('role', 'listitem');
    pill.dataset.bundlePath = b.bundlePath;
    pill.innerHTML = `
      <span class="bundle-pill-name">${escapeHtml(b.name)}.app</span>
      <span class="bundle-pill-meta">${escapeHtml(b.bundleId || b.version)}</span>
    `;

    pill.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', b.bundlePath);
      e.dataTransfer.setData('application/x-artifact-atlas-bundle', b.bundlePath);
    });

    pill.addEventListener('click', () => {
      handleDroppedOrSelectedBundle(b.bundlePath);
    });

    dockList.appendChild(pill);

    // Modal picker item
    const item = document.createElement('div');
    item.className = 'modal-bundle-item';
    item.dataset.bundlePath = b.bundlePath;
    item.innerHTML = `
      <div>
        <div style="font-weight:600">${escapeHtml(b.name)}.app <span style="font-weight:400;color:var(--text-muted)">v${escapeHtml(b.version)}</span></div>
        <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml(b.description || b.bundlePath)}</div>
      </div>
      <code>${escapeHtml(b.bundleId || 'macOS Bundle')}</code>
    `;
    item.addEventListener('click', async () => {
      document.getElementById('custom-bundle-path-input').value = b.bundlePath;
      await previewIdentifiedBundleInModal(b.bundlePath);
    });
    modalList.appendChild(item);
  });
}

function bindDropzoneEvents() {
  const dropzone = document.getElementById('app-dropzone');

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');

    let droppedPath =
      e.dataTransfer.getData('application/x-artifact-atlas-bundle') ||
      e.dataTransfer.getData('text/plain');

    if (!droppedPath && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const f = e.dataTransfer.files[0];
      droppedPath = f.path || f.name;
    }

    if (droppedPath) {
      await handleDroppedOrSelectedBundle(droppedPath.trim());
    }
  });

  document.getElementById('choose-app-btn').addEventListener('click', () => {
    openAppPickerModal();
  });

  document.getElementById('choose-workspace-btn').addEventListener('click', () => {
    openAppPickerModal(true);
  });
}

async function handleDroppedOrSelectedBundle(bundlePath) {
  try {
    uiState.pendingBundlePath = bundlePath;
    await executeScan({
      bundlePath,
      workspacePath: uiState.pendingWorkspacePath
    });
  } catch (err) {
    showToast(`Bundle Recognition Error: ${err.message}`);
  }
}

async function openAppPickerModal(focusWorkspace = false) {
  const modal = document.getElementById('app-picker-modal');
  modal.classList.remove('hidden');

  const bundleInput = document.getElementById('custom-bundle-path-input');
  const wsInput = document.getElementById('custom-workspace-path-input');
  wsInput.value = uiState.pendingWorkspacePath || '';

  if (!bundleInput.value && uiState.bootstrap?.availableBundles?.length > 0) {
    bundleInput.value = uiState.bootstrap.availableBundles[0].bundlePath;
    await previewIdentifiedBundleInModal(bundleInput.value);
  }

  if (focusWorkspace) {
    wsInput.focus();
  } else {
    bundleInput.focus();
  }
}

async function previewIdentifiedBundleInModal(bundlePath) {
  const previewEl = document.getElementById('identified-app-preview');
  try {
    const res = await apiRequest('/api/app/identify', 'POST', { bundlePath });
    const app = res.application;
    uiState.pendingBundlePath = app.bundlePath;
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>${escapeHtml(app.name)} (v${escapeHtml(app.version)})</strong>
        <span class="badge ${app.isSupportedAIApp ? 'badge-VERIFIED' : 'badge-INFERRED'}">
          ${escapeHtml(app.recognitionStatus)}
        </span>
      </div>
      <div class="kv-list">
        <div class="kv-item"><span class="kv-key">Bundle Identifier:</span><span class="kv-val">${escapeHtml(app.bundleId || 'None')}</span></div>
        <div class="kv-item"><span class="kv-key">Executable Path (Not Executed):</span><span class="kv-val">${escapeHtml(app.executablePath || 'N/A')}</span></div>
        <div class="kv-item"><span class="kv-key">Adapter:</span><span class="kv-val">${escapeHtml(app.adapterId)}</span></div>
        <div class="kv-item"><span class="kv-key">Candidate Data Roots:</span><span class="kv-val">${app.knownDataDirectories.length} locations</span></div>
      </div>
    `;
  } catch (err) {
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = `<div style="color:var(--accent-coral)">${escapeHtml(err.message)}</div>`;
  }
}

/* =========================================================================
   SCANNING WORKFLOW (Section 4.3)
   ========================================================================= */

async function executeScan({ bundlePath, workspacePath }) {
  document.getElementById('app-picker-modal').classList.add('hidden');
  document.getElementById('empty-workspace-view').classList.add('hidden');
  document.getElementById('explorer-view').classList.add('hidden');
  document.getElementById('scanning-view').classList.remove('hidden');

  document.getElementById('scan-status-title').textContent =
    `Identifying ${bundlePath ? bundlePath.split('/').pop() : 'Workspace'} & Scanning…`;

  try {
    const res = await apiRequest('/api/scan/start', 'POST', {
      bundlePath,
      workspacePaths: workspacePath ? [workspacePath] : []
    });

    uiState.activeState = res.state;
    uiState.quarantineEntries = res.quarantineEntries || [];
    uiState.selectedNodeId = null;
    uiState.selectedArtifactIds.clear();
    uiState.activeTrace = null;

    document.getElementById('scan-metric-roots').textContent =
      String(res.state.scan.scannedLocations.length);
    document.getElementById('scan-metric-count').textContent =
      String(res.state.scan.discoveredArtifactCount);
    document.getElementById('scan-metric-bytes').textContent =
      formatBytes(res.state.scan.totalPhysicalBytes);

    transitionToExplorerView();
  } catch (err) {
    document.getElementById('scanning-view').classList.add('hidden');
    document.getElementById('empty-workspace-view').classList.remove('hidden');
    showToast(`Scan failed: ${err.message}`);
  }
}

function transitionToExplorerView() {
  document.getElementById('scanning-view').classList.add('hidden');
  document.getElementById('explorer-view').classList.remove('hidden');
  document.getElementById('back-to-dropzone-btn').classList.remove('hidden');

  const state = uiState.activeState;
  const app = state.application;

  document.getElementById('active-app-name').textContent = app
    ? app.name
    : 'Workspace Analysis';
  document.getElementById('active-app-meta').textContent = app
    ? `${app.bundleId || app.adapterId} • v${app.version} • ${state.scan.discoveredArtifactCount} artifacts (${formatBytes(state.scan.totalPhysicalBytes)} physical)`
    : `${state.scan.discoveredArtifactCount} artifacts (${formatBytes(state.scan.totalPhysicalBytes)} physical)`;

  renderScanNoticesBanner(state);
  loadGraphFromState(state.graph);
  renderGlobalInspectorSummary();
  renderTreemapView();
  renderQuarantineVaultView();
  updateContextualToolbar();
  updateQuarantineCountPill();
}

function renderScanNoticesBanner(state) {
  const banner = document.getElementById('scan-notices-banner');
  const notices = [];

  if (state.application && !state.application.isSupportedAIApp) {
    notices.push(
      `Generic macOS Adapter active for ${state.application.name}: application-level caches and saved state were discovered, while conversation-level provenance is marked UNKNOWN.`
    );
  }
  if (state.scan.permissionLimitations.length > 0) {
    notices.push(
      `${state.scan.permissionLimitations.length} protected/unreadable path(s) skipped due to permissions.`
    );
  }
  if (state.scan.skippedSymlinks.length > 0) {
    notices.push(
      `${state.scan.skippedSymlinks.length} symlink(s) outside authorized boundaries safely skipped.`
    );
  }
  if (state.scan.deduplicatedHardlinkCount > 0) {
    notices.push(
      `${state.scan.deduplicatedHardlinkCount} physical hardlink(s) deduplicated (${formatBytes(state.scan.totalLogicalBytes)} logical → ${formatBytes(state.scan.totalPhysicalBytes)} physical).`
    );
  }

  if (notices.length === 0) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.innerHTML = `<span>${escapeHtml(notices.join('  •  '))}</span>`;
  }
}

/* =========================================================================
   INTERACTIVE KNOWLEDGE GRAPH ENGINE (Section 5)
   ========================================================================= */

function loadGraphFromState(graphData) {
  if (!graphData) return;
  uiState.nodes = graphData.nodes.map((n) => ({
    ...n,
    vx: 0,
    vy: 0
  }));
  uiState.edges = graphData.edges.map((e) => ({ ...e }));

  const canvas = document.getElementById('knowledge-graph-canvas');
  if (canvas) {
    resizeCanvas();
  }
}

function resizeCanvas() {
  const canvas = document.getElementById('knowledge-graph-canvas');
  const parent = canvas.parentElement;
  if (!parent) return;
  const rect = parent.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(300, rect.width) * dpr;
  canvas.height = Math.max(300, rect.height) * dpr;
}

function isNodeVisibleByFilter(node) {
  if (uiState.focusMode && uiState.activeTrace) {
    if (!uiState.activeTrace.highlightedNodeIds.includes(node.id)) {
      return false;
    }
  }

  if (uiState.filterNodeType !== 'ALL' && node.nodeType !== uiState.filterNodeType) {
    return false;
  }

  if (uiState.filterConfidence !== 'ALL' && node.confidence !== uiState.filterConfidence) {
    return false;
  }

  if (uiState.filterRisk !== 'ALL' && node.riskCategory !== uiState.filterRisk) {
    return false;
  }

  if (uiState.searchQuery) {
    const q = uiState.searchQuery.toLowerCase();
    const matchLabel = String(node.label || '').toLowerCase().includes(q);
    const matchSub = String(node.subtitle || '').toLowerCase().includes(q);
    const matchPath = String(node.metadata?.canonicalPath || '').toLowerCase().includes(q);
    if (!matchLabel && !matchSub && !matchPath) {
      return false;
    }
  }

  return true;
}

function stepGraphPhysics() {
  const nodes = uiState.nodes;
  const edges = uiState.edges;
  if (nodes.length === 0) return;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Gentle repulsion between nodes
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = Math.max(120, dx * dx + dy * dy);
      if (distSq > 95000) continue;
      const force = 420 / distSq;
      const fx = dx * force;
      const fy = dy * force;
      if (a !== uiState.draggingNode) {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (b !== uiState.draggingNode) {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // Spring attraction along edges
  for (const edge of edges) {
    const s = nodeMap.get(edge.sourceId);
    const t = nodeMap.get(edge.targetId);
    if (!s || !t) continue;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const targetDist = edge.edgeType === 'CONTAINS' ? 140 : 175;
    const delta = (dist - targetDist) * 0.004;
    const fx = (dx / dist) * delta;
    const fy = (dy / dist) * delta;
    if (s !== uiState.draggingNode && s.nodeType !== 'AI_APPLICATION') {
      s.vx += fx;
      s.vy += fy;
    }
    if (t !== uiState.draggingNode && t.nodeType !== 'AI_APPLICATION') {
      t.vx -= fx;
      t.vy -= fy;
    }
  }

  // Apply velocity & damping
  for (const n of nodes) {
    if (n === uiState.draggingNode || n.nodeType === 'AI_APPLICATION') {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.x += n.vx;
    n.y += n.vy;
    n.vx *= 0.82;
    n.vy *= 0.82;
  }
}

function getNodeColor(node) {
  switch (node.nodeType) {
    case 'AI_APPLICATION':
      return '#38bdf8';
    case 'WORKSPACE':
      return '#60a5fa';
    case 'SESSION':
      return '#2dd4bf';
    case 'OPERATION':
      return '#a3e635';
    case 'ARTIFACT_GROUP':
      return '#e2e8f0';
    case 'UNKNOWN_ORIGIN':
      return '#94a3b8';
    case 'ARTIFACT':
      if (node.riskCategory === 'LOW') return '#34d399';
      if (node.riskCategory === 'REVIEW') return '#fbbf24';
      return '#f87171';
    default:
      return '#94a3b8';
  }
}

function getEdgeStyle(edge, isHighlighted) {
  if (edge.confidence === 'VERIFIED') {
    return {
      color: isHighlighted ? '#34d399' : 'rgba(52, 211, 153, 0.35)',
      dash: [],
      width: isHighlighted ? 2.6 : 1.2
    };
  }
  if (edge.confidence === 'INFERRED') {
    return {
      color: isHighlighted ? '#fbbf24' : 'rgba(251, 191, 36, 0.35)',
      dash: [6, 4],
      width: isHighlighted ? 2.4 : 1.2
    };
  }
  return {
    color: isHighlighted ? '#f87171' : 'rgba(248, 113, 113, 0.35)',
    dash: [2, 4],
    width: isHighlighted ? 2.4 : 1.2
  };
}

function renderGraphCanvas() {
  uiState.animTick += 1;
  if (uiState.activeTab === 'graph' && uiState.nodes.length > 0) {
    stepGraphPhysics();
    drawGraph();
  }
  requestAnimationFrame(renderGraphCanvas);
}

function drawGraph() {
  const canvas = document.getElementById('knowledge-graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const isLight = uiState.theme === 'light';
  const visibleNodeIds = new Set(
    uiState.nodes.filter(isNodeVisibleByFilter).map((n) => n.id)
  );
  const nodeMap = new Map(uiState.nodes.map((n) => [n.id, n]));

  const highlightedNodes = uiState.activeTrace
    ? new Set(uiState.activeTrace.highlightedNodeIds)
    : null;
  const highlightedEdges = uiState.activeTrace
    ? new Set(uiState.activeTrace.highlightedEdgeIds)
    : null;

  ctx.translate(width / 2 + uiState.camera.x, height / 2 + uiState.camera.y);
  ctx.scale(uiState.camera.scale, uiState.camera.scale);

  // 1. Draw Edges
  for (const edge of uiState.edges) {
    if (!visibleNodeIds.has(edge.sourceId) || !visibleNodeIds.has(edge.targetId)) {
      continue;
    }
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    const isHighlighted = highlightedEdges ? highlightedEdges.has(edge.id) : false;
    const isDimmed = highlightedEdges && !isHighlighted;

    const style = getEdgeStyle(edge, isHighlighted);
    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.12 : 1.0;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash);

    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();

    // Animated provenance flow particle along highlighted edges
    if (isHighlighted) {
      const t = ((uiState.animTick * 0.012) % 1);
      const px = source.x + (target.x - source.x) * t;
      const py = source.y + (target.y - source.y) * t;
      ctx.setLineDash([]);
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();

      // Edge semantic label at midpoint
      const mx = (source.x + target.x) / 2;
      const my = (source.y + target.y) / 2;
      ctx.font = '600 9.5px "SF Mono", monospace';
      ctx.fillStyle = isLight ? '#0f172a' : '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.fillText(edge.edgeType, mx, my - 5);
    }

    ctx.restore();
  }

  // 2. Draw Nodes
  for (const node of uiState.nodes) {
    if (!visibleNodeIds.has(node.id)) continue;

    const isSelected =
      uiState.selectedNodeId === node.id || uiState.selectedArtifactIds.has(node.id);
    const isHighlighted = highlightedNodes ? highlightedNodes.has(node.id) : true;
    const isDimmed = highlightedNodes && !isHighlighted;
    const color = getNodeColor(node);

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.18 : 1.0;

    // Outer glow ring for selected or multi-session shared artifacts
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#2dd4bf';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (
      node.nodeType === 'ARTIFACT' &&
      node.metadata?.sessionIds?.length > 1
    ) {
      // Multi-parent shared artifact double ring
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#fbbf24';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Node body
    ctx.beginPath();
    if (node.nodeType === 'WORKSPACE' || node.nodeType === 'ARTIFACT_GROUP') {
      const r = node.radius;
      ctx.roundRect(node.x - r, node.y - r, r * 2, r * 2, 6);
    } else {
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isLight ? '#ffffff' : '#090d16';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Node label
    ctx.font =
      node.nodeType === 'AI_APPLICATION' || node.nodeType === 'SESSION'
        ? '600 11.5px -apple-system, sans-serif'
        : '500 10.5px -apple-system, sans-serif';
    ctx.fillStyle = isLight ? '#0f172a' : '#f1f5f9';
    ctx.textAlign = 'center';
    ctx.fillText(node.label, node.x, node.y + node.radius + 14);

    ctx.restore();
  }

  ctx.restore();
}

function screenToWorld(clientX, clientY) {
  const canvas = document.getElementById('knowledge-graph-canvas');
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left - rect.width / 2 - uiState.camera.x;
  const cy = clientY - rect.top - rect.height / 2 - uiState.camera.y;
  return {
    x: cx / uiState.camera.scale,
    y: cy / uiState.camera.scale
  };
}

function findNodeAtWorld(wx, wy) {
  const visibleNodes = uiState.nodes.filter(isNodeVisibleByFilter);
  for (let i = visibleNodes.length - 1; i >= 0; i--) {
    const n = visibleNodes[i];
    const dist = Math.hypot(wx - n.x, wy - n.y);
    if (dist <= n.radius + 5) {
      return n;
    }
  }
  return null;
}

function initGraphCanvas() {
  const canvas = document.getElementById('knowledge-graph-canvas');
  const tooltip = document.getElementById('graph-hover-tooltip');

  window.addEventListener('resize', resizeCanvas);

  let pointerDownPos = { x: 0, y: 0 };

  canvas.addEventListener('mousedown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
    const world = screenToWorld(e.clientX, e.clientY);
    const hit = findNodeAtWorld(world.x, world.y);

    if (hit) {
      uiState.draggingNode = hit;
    } else {
      uiState.isPanning = true;
      uiState.panStart = {
        x: e.clientX - uiState.camera.x,
        y: e.clientY - uiState.camera.y
      };
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (uiState.draggingNode) {
      const world = screenToWorld(e.clientX, e.clientY);
      uiState.draggingNode.x = world.x;
      uiState.draggingNode.y = world.y;
      return;
    }

    if (uiState.isPanning) {
      uiState.camera.x = e.clientX - uiState.panStart.x;
      uiState.camera.y = e.clientY - uiState.panStart.y;
      return;
    }

    if (e.target === canvas) {
      const world = screenToWorld(e.clientX, e.clientY);
      const hit = findNodeAtWorld(world.x, world.y);
      uiState.hoveredNode = hit;
      if (hit) {
        const rect = canvas.getBoundingClientRect();
        tooltip.classList.remove('hidden');
        tooltip.style.left = `${Math.min(rect.width - 260, e.clientX - rect.left + 14)}px`;
        tooltip.style.top = `${Math.max(12, e.clientY - rect.top + 14)}px`;
        tooltip.innerHTML = `
          <div style="font-weight:600;margin-bottom:2px;">${escapeHtml(hit.label)}</div>
          <div style="color:var(--text-muted);font-family:var(--font-mono);font-size:10.5px;">
            ${escapeHtml(hit.nodeType)} • ${escapeHtml(hit.confidence)}
            ${hit.sizeBytes ? ' • ' + formatBytes(hit.sizeBytes) : ''}
          </div>
        `;
      } else {
        tooltip.classList.add('hidden');
      }
    }
  });

  window.addEventListener('mouseup', async (e) => {
    const movedDist = Math.hypot(
      e.clientX - pointerDownPos.x,
      e.clientY - pointerDownPos.y
    );

    if (movedDist < 6 && e.target === canvas) {
      const world = screenToWorld(e.clientX, e.clientY);
      const hit = findNodeAtWorld(world.x, world.y);
      if (hit) {
        await selectNodeInGraph(hit, e.shiftKey || e.metaKey);
      } else {
        clearNodeSelection();
      }
    }

    uiState.draggingNode = null;
    uiState.isPanning = false;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      uiState.camera.scale = Math.max(0.22, Math.min(2.6, uiState.camera.scale * factor));
    },
    { passive: false }
  );

  requestAnimationFrame(renderGraphCanvas);
}

async function selectNodeInGraph(node, multiSelect = false) {
  uiState.selectedNodeId = node.id;

  if (node.nodeType === 'ARTIFACT') {
    if (!multiSelect) {
      uiState.selectedArtifactIds.clear();
    }
    uiState.selectedArtifactIds.add(node.id);
  } else if (!multiSelect) {
    uiState.selectedArtifactIds.clear();
  }

  try {
    const res = await apiRequest('/api/graph/trace', 'POST', { nodeId: node.id });
    uiState.activeTrace = res.trace;
    renderNodeInspector(node, res.trace);
    updateContextualToolbar();
  } catch (err) {
    showToast(`Trace error: ${err.message}`);
  }
}

function clearNodeSelection() {
  uiState.selectedNodeId = null;
  uiState.selectedArtifactIds.clear();
  uiState.activeTrace = null;
  uiState.focusMode = false;
  document.getElementById('toggle-focus-mode-btn').textContent = 'Focus Mode: Off';
  document.getElementById('toggle-focus-mode-btn').classList.remove('active');
  document.getElementById('inspector-detail-content').classList.add('hidden');
  document.getElementById('inspector-empty-state').classList.remove('hidden');
  updateContextualToolbar();
}

/* =========================================================================
   PROVENANCE & EVIDENCE INSPECTOR (Sections 5, 7, 8, 9)
   ========================================================================= */

function renderGlobalInspectorSummary() {
  const box = document.getElementById('inspector-global-stats');
  const g = uiState.activeState?.graph;
  if (!g) return;

  box.innerHTML = `
    <div class="inspector-section">
      <div class="inspector-section-title">Current Knowledge Graph Summary</div>
      <div class="kv-list">
        <div class="kv-item"><span class="kv-key">Total Graph Nodes:</span><span class="kv-val">${g.stats.totalNodes}</span></div>
        <div class="kv-item"><span class="kv-key">Total Provenance Edges:</span><span class="kv-val">${g.stats.totalEdges}</span></div>
        <div class="kv-item"><span class="kv-key">Verified Provenance:</span><span class="kv-val">${g.stats.verifiedArtifactCount} artifacts</span></div>
        <div class="kv-item"><span class="kv-key">Inferred Provenance:</span><span class="kv-val">${g.stats.inferredArtifactCount} artifacts</span></div>
        <div class="kv-item"><span class="kv-key">Unknown Origin:</span><span class="kv-val">${g.stats.unknownArtifactCount} artifacts</span></div>
        <div class="kv-item"><span class="kv-key">Low-Risk Reclaimable:</span><span class="kv-val">${formatBytes(g.treemap.reclaimablePhysicalBytes)}</span></div>
      </div>
    </div>
  `;
}

function renderNodeInspector(node, trace) {
  document.getElementById('inspector-empty-state').classList.add('hidden');
  const detail = document.getElementById('inspector-detail-content');
  detail.classList.remove('hidden');

  const meta = node.metadata || {};
  const isArtifact = node.nodeType === 'ARTIFACT';

  const evidenceHtml =
    isArtifact && Array.isArray(meta.evidence) && meta.evidence.length > 0
      ? meta.evidence
          .map(
            (ev) => `
          <div class="evidence-card">
            <div class="evidence-card-header">
              <span>${escapeHtml(ev.sourceType)}</span>
              <span class="badge badge-${escapeHtml(ev.confidence)}">${escapeHtml(ev.confidence)}</span>
            </div>
            <div style="color:var(--text-secondary);margin-bottom:4px;">${escapeHtml(ev.summary)}</div>
            ${ev.sourceRef ? `<div><code>${escapeHtml(ev.sourceRef)}</code></div>` : ''}
          </div>
        `
          )
          .join('')
      : `<div style="color:var(--text-muted)">Direct node metadata record.</div>`;

  const hopsHtml =
    trace?.provenanceHops?.length > 0
      ? trace.provenanceHops
          .map(
            (hop) => `
          <div class="hop-card">
            <div class="hop-card-header">
              <span>${escapeHtml(hop.edgeType)} → ${escapeHtml(hop.toNodeLabel)}</span>
              <span class="badge badge-${escapeHtml(hop.confidence)}">${escapeHtml(hop.confidence)}</span>
            </div>
            <div style="color:var(--text-secondary);font-size:11.5px;">${escapeHtml(hop.explanation || hop.toNodeType)}</div>
          </div>
        `
          )
          .join('')
      : `<div style="color:var(--text-muted)">Root anchor node.</div>`;

  const sharedHtml =
    isArtifact && Array.isArray(meta.sharedDependencyIndicators) && meta.sharedDependencyIndicators.length > 0
      ? `
      <div class="inspector-section">
        <div class="inspector-section-title">Shared Dependencies &amp; Multi-Session Links</div>
        ${meta.sharedDependencyIndicators
          .map(
            (ind) =>
              `<div class="evidence-card" style="border-color:var(--accent-amber)">${escapeHtml(ind)}</div>`
          )
          .join('')}
      </div>
    `
      : '';

  const cleanupSectionHtml = isArtifact
    ? `
      <div class="inspector-section">
        <div class="inspector-section-title">Cleanup Classification &amp; Impact</div>
        <div class="badge-row">
          <span class="badge badge-${escapeHtml(meta.cleanupClassification)}">Risk: ${escapeHtml(meta.cleanupClassification)}</span>
          <span class="badge badge-${escapeHtml(meta.provenanceConfidence)}">Origin: ${escapeHtml(meta.provenanceConfidence)}</span>
          <span class="badge">${escapeHtml(meta.artifactType)}</span>
        </div>
        <p style="margin-bottom:8px;color:var(--text-primary);">${escapeHtml(meta.cleanupExplanation)}</p>
        <p style="color:var(--text-secondary);font-size:12px;">
          <strong>Deletion Consequence:</strong> ${escapeHtml(meta.deletionConsequences)}
        </p>
      </div>
    `
    : '';

  detail.innerHTML = `
    <div>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(node.nodeType)}</div>
      <h3 style="font-size:16px;font-weight:600;word-break:break-all;margin:2px 0 6px;">${escapeHtml(node.label)}</h3>
      <div class="badge-row">
        <span class="badge badge-${escapeHtml(node.confidence)}">${escapeHtml(node.confidence)}</span>
        <span class="badge badge-${escapeHtml(node.riskCategory)}">${escapeHtml(node.riskCategory)}</span>
      </div>
      <div class="kv-list">
        ${
          meta.canonicalPath
            ? `<div class="kv-item"><span class="kv-key">Canonical Path:</span><span class="kv-val">${escapeHtml(meta.canonicalPath)}</span></div>`
            : ''
        }
        ${
          isArtifact
            ? `
          <div class="kv-item"><span class="kv-key">Physical Size:</span><span class="kv-val">${formatBytes(meta.sizeBytes)}</span></div>
          <div class="kv-item"><span class="kv-key">Inode Identity:</span><span class="kv-val">${escapeHtml(meta.physicalInodeKey || 'N/A')} (nlink=${meta.hardlinkCount || 1})</span></div>
          <div class="kv-item"><span class="kv-key">Modified:</span><span class="kv-val">${escapeHtml(meta.modifiedAt || 'Unknown')}</span></div>
          <div class="kv-item"><span class="kv-key">Sessions Linked:</span><span class="kv-val">${meta.sessionIds?.length || 0}</span></div>
        `
            : ''
        }
      </div>
    </div>

    ${cleanupSectionHtml}
    ${sharedHtml}

    <div class="inspector-section">
      <div class="inspector-section-title">Provenance Evidence Records</div>
      ${evidenceHtml}
    </div>

    <div class="inspector-section">
      <div class="inspector-section-title">Traced Provenance Path (${trace?.provenanceHops?.length || 0} Hops)</div>
      ${hopsHtml}
    </div>
  `;
}

/* =========================================================================
   EXPLORER CONTROLS, TREEMAP VIEW & QUARANTINE VAULT (Sections 6 & 9)
   ========================================================================= */

function bindExplorerControls() {
  const switchTab = (tab) => {
    uiState.activeTab = tab;
    document.getElementById('tab-graph-btn').classList.toggle('active', tab === 'graph');
    document.getElementById('tab-treemap-btn').classList.toggle('active', tab === 'treemap');
    document.getElementById('tab-quarantine-btn').classList.toggle('active', tab === 'quarantine');

    document.getElementById('panel-graph').classList.toggle('hidden', tab !== 'graph');
    document.getElementById('panel-treemap').classList.toggle('hidden', tab !== 'treemap');
    document.getElementById('panel-quarantine').classList.toggle('hidden', tab !== 'quarantine');

    if (tab === 'graph') resizeCanvas();
    if (tab === 'treemap') renderTreemapView();
    if (tab === 'quarantine') renderQuarantineVaultView();
  };

  document.getElementById('tab-graph-btn').addEventListener('click', () => switchTab('graph'));
  document.getElementById('tab-treemap-btn').addEventListener('click', () => switchTab('treemap'));
  document.getElementById('tab-quarantine-btn').addEventListener('click', () => switchTab('quarantine'));

  document.getElementById('graph-search-input').addEventListener('input', (e) => {
    uiState.searchQuery = e.target.value.trim();
  });

  document.getElementById('filter-node-type').addEventListener('change', (e) => {
    uiState.filterNodeType = e.target.value;
  });

  document.getElementById('filter-confidence').addEventListener('change', (e) => {
    uiState.filterConfidence = e.target.value;
  });

  document.getElementById('filter-risk').addEventListener('change', (e) => {
    uiState.filterRisk = e.target.value;
  });

  document.getElementById('toggle-focus-mode-btn').addEventListener('click', (e) => {
    if (!uiState.activeTrace) {
      showToast('Select a node in the graph first to enable Focus Mode.');
      return;
    }
    uiState.focusMode = !uiState.focusMode;
    e.currentTarget.textContent = `Focus Mode: ${uiState.focusMode ? 'On' : 'Off'}`;
    e.currentTarget.classList.toggle('active', uiState.focusMode);
  });

  document.getElementById('select-low-risk-btn').addEventListener('click', () => {
    if (!uiState.activeState) return;
    const lowRiskArtifacts = uiState.activeState.artifacts.filter(
      (a) => !a.quarantined && a.cleanupClassification === 'LOW'
    );
    uiState.selectedArtifactIds = new Set(lowRiskArtifacts.map((a) => a.id));
    updateContextualToolbar();
    showToast(`Selected ${lowRiskArtifacts.length} low-risk regenerable artifact(s).`);
  });

  document.getElementById('reset-camera-btn').addEventListener('click', () => {
    uiState.camera = { x: 0, y: 0, scale: 0.72 };
  });

  document.getElementById('treemap-group-by').addEventListener('change', (e) => {
    uiState.treemapGroupBy = e.target.value;
    renderTreemapView();
  });

  document.getElementById('cancel-scan-btn').addEventListener('click', async () => {
    await apiRequest('/api/scan/cancel', 'POST');
    showToast('Scan cancelled.');
  });
}

function renderTreemapView() {
  const tm = uiState.activeState?.graph?.treemap;
  if (!tm) return;

  const strip = document.getElementById('treemap-summary-strip');
  strip.innerHTML = `
    <div class="treemap-stat-card">
      <span class="metric-label">Total Physical Usage</span>
      <span class="metric-value">${formatBytes(tm.totalPhysicalBytes)}</span>
    </div>
    <div class="treemap-stat-card">
      <span class="metric-label">Reclaimable (LOW Risk)</span>
      <span class="metric-value" style="color:var(--accent-emerald)">${formatBytes(tm.reclaimablePhysicalBytes)}</span>
    </div>
    <div class="treemap-stat-card">
      <span class="metric-label">Review Required</span>
      <span class="metric-value" style="color:var(--accent-amber)">${formatBytes(tm.reviewPhysicalBytes)}</span>
    </div>
    <div class="treemap-stat-card">
      <span class="metric-label">High Risk / Protected</span>
      <span class="metric-value" style="color:var(--accent-coral)">${formatBytes(tm.highRiskPhysicalBytes + tm.protectedOrUncertainPhysicalBytes)}</span>
    </div>
  `;

  const grid = document.getElementById('treemap-grid-container');
  grid.innerHTML = '';

  const cells = tm[uiState.treemapGroupBy] || tm.byGroup || [];
  const totalBytes = Math.max(1, tm.totalPhysicalBytes);

  cells.forEach((cell) => {
    const sharePct = Math.max(14, Math.min(100, Math.round((cell.bytes / totalBytes) * 100)));
    const tile = document.createElement('div');
    tile.className = `treemap-tile risk-${cell.riskCategory || 'REVIEW'}`;
    tile.style.flex = `${sharePct} 1 ${Math.max(180, sharePct * 3.5)}px`;
    tile.innerHTML = `
      <div>
        <div style="font-weight:600;font-size:13.5px;margin-bottom:4px;">${escapeHtml(cell.label)}</div>
        <div style="font-size:11.5px;color:var(--text-secondary)">${cell.artifactCount} artifact(s)</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:12px;">
        <span style="font-family:var(--font-mono);font-size:15px;font-weight:600;">${formatBytes(cell.bytes)}</span>
        <span style="font-size:11px;color:var(--text-muted)">${ ((cell.bytes / totalBytes) * 100).toFixed(1) }%</span>
      </div>
    `;

    // Clicking a Treemap region focuses the corresponding nodes in the Knowledge Graph (Section 6)
    tile.addEventListener('click', async () => {
      document.getElementById('tab-graph-btn').click();
      const targetNodeId =
        cell.focusNodeId || (Array.isArray(cell.artifactIds) && cell.artifactIds[0]);
      const node = uiState.nodes.find((n) => n.id === targetNodeId);
      if (node) {
        await selectNodeInGraph(node, false);
        if (Array.isArray(cell.artifactIds)) {
          uiState.selectedArtifactIds = new Set(cell.artifactIds);
          updateContextualToolbar();
        }
      }
    });

    grid.appendChild(tile);
  });
}

function renderQuarantineVaultView() {
  const listEl = document.getElementById('quarantine-entries-list');
  if (!listEl) return;

  if (!uiState.quarantineEntries || uiState.quarantineEntries.length === 0) {
    listEl.innerHTML = `
      <div class="evidence-card" style="padding:20px;text-align:center;color:var(--text-secondary)">
        No artifacts are currently in quarantine. Select low-risk artifacts in the Knowledge Graph and choose <strong>Delete (Move to Quarantine)</strong> to safely reclaim space.
      </div>
    `;
    return;
  }

  listEl.innerHTML = '';
  uiState.quarantineEntries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'quarantine-row-card';
    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="font-size:13.5px;">${escapeHtml(entry.artifactName)}</strong>
          <span class="badge badge-${escapeHtml(entry.riskCategory)}">${escapeHtml(entry.riskCategory)}</span>
          <span class="badge">${escapeHtml(entry.status)}</span>
          <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--text-secondary)">${formatBytes(entry.sizeBytes)}</span>
        </div>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);word-break:break-all;">
          Original Path: ${escapeHtml(entry.originalPath)}
        </div>
        <div style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);margin-top:2px;">
          Manifest: ${escapeHtml(entry.manifestPath)} • SHA-256: ${escapeHtml((entry.sha256 || '').slice(0, 16))}…
        </div>
      </div>
      <div>
        ${
          entry.status === 'QUARANTINED'
            ? `<button class="primary-btn restore-entry-btn" data-entry-id="${escapeHtml(entry.id)}" type="button">Restore to Original Path</button>`
            : `<span style="font-size:11.5px;color:var(--text-muted)">Restored ${escapeHtml(entry.restoredAt || '')}</span>`
        }
      </div>
    `;
    listEl.appendChild(row);
  });

  listEl.querySelectorAll('.restore-entry-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const entryId = btn.dataset.entryId;
      const strategy = document.getElementById('restore-conflict-strategy').value;
      try {
        const res = await apiRequest('/api/cleanup/restore', 'POST', {
          entryId,
          conflictStrategy: strategy
        });
        uiState.activeState = res.activeState;
        uiState.quarantineEntries = res.quarantineEntries || [];
        loadGraphFromState(res.activeState.graph);
        renderQuarantineVaultView();
        renderTreemapView();
        updateQuarantineCountPill();
        showToast(`Restored artifact to ${res.restoredToPath}`);
      } catch (err) {
        showToast(`Restore blocked: ${err.message}`);
      }
    });
  });
}

function updateQuarantineCountPill() {
  const activeCount = (uiState.quarantineEntries || []).filter(
    (e) => e.status === 'QUARANTINED'
  ).length;
  document.getElementById('quarantine-count-pill').textContent = String(activeCount);
}

/* =========================================================================
   BOTTOM CONTEXTUAL ACTION TOOLBAR & CLEANUP REVIEW MODAL (Section 9)
   ========================================================================= */

function updateContextualToolbar() {
  const toolbar = document.getElementById('contextual-toolbar');
  const count = uiState.selectedArtifactIds.size;

  if (count === 0) {
    toolbar.classList.add('hidden');
    return;
  }

  toolbar.classList.remove('hidden');
  document.getElementById('selected-count-badge').textContent = `${count} artifact${count > 1 ? 's' : ''} selected`;

  const seenInodes = new Set();
  let physicalBytes = 0;
  for (const id of uiState.selectedArtifactIds) {
    const art = uiState.activeState?.artifacts?.find((a) => a.id === id);
    if (art) {
      const key = art.physicalInodeKey || art.canonicalPath;
      if (!seenInodes.has(key)) {
        seenInodes.add(key);
        physicalBytes += art.sizeBytes;
      }
    }
  }
  document.getElementById('selected-size-label').textContent = `${formatBytes(physicalBytes)} physical`;
}

function bindContextualToolbarEvents() {
  document.getElementById('ctx-inspect-btn').addEventListener('click', async () => {
    const firstId = Array.from(uiState.selectedArtifactIds)[0];
    const node = uiState.nodes.find((n) => n.id === firstId);
    if (node) {
      await selectNodeInGraph(node, true);
    }
  });

  document.getElementById('ctx-reveal-finder-btn').addEventListener('click', async () => {
    const firstId = Array.from(uiState.selectedArtifactIds)[0];
    const art = uiState.activeState?.artifacts?.find((a) => a.id === firstId);
    if (!art) return;
    try {
      const res = await apiRequest('/api/finder/reveal', 'POST', {
        path: art.canonicalPath
      });
      showToast(
        res.commandPreview
          ? `Reveal in Finder: ${res.commandPreview}`
          : `Revealed ${art.name} in Finder`
      );
    } catch (err) {
      showToast(`Reveal failed: ${err.message}`);
    }
  });

  document.getElementById('ctx-select-related-btn').addEventListener('click', () => {
    if (uiState.activeTrace?.relatedArtifactIds?.length > 0) {
      for (const id of uiState.activeTrace.relatedArtifactIds) {
        uiState.selectedArtifactIds.add(id);
      }
      updateContextualToolbar();
      showToast(`Added ${uiState.activeTrace.relatedArtifactIds.length} related artifact(s) to selection.`);
    } else {
      showToast('No additional related artifacts found for this node.');
    }
  });

  document.getElementById('ctx-clear-selection-btn').addEventListener('click', () => {
    clearNodeSelection();
  });

  document.getElementById('ctx-delete-quarantine-btn').addEventListener('click', async () => {
    await openCleanupReviewModal(false);
  });
}

async function openCleanupReviewModal(allowHighRiskSingleOverride = false) {
  const artifactIds = Array.from(uiState.selectedArtifactIds);
  if (artifactIds.length === 0) return;

  try {
    uiState.allowHighRiskSingleOverride = allowHighRiskSingleOverride;
    const res = await apiRequest('/api/cleanup/review', 'POST', {
      artifactIds,
      allowHighRiskSingleOverride
    });
    const review = res.review;
    uiState.pendingReview = review;

    const modal = document.getElementById('cleanup-review-modal');
    const body = document.getElementById('cleanup-review-modal-body');
    const confirmBtn = document.getElementById('confirm-quarantine-btn');

    confirmBtn.disabled = review.totalEligibleCount === 0;

    const eligibleHtml =
      review.eligibleItems.length > 0
        ? review.eligibleItems
            .map(
              (item) => `
            <div class="evidence-card" style="border-left:3px solid var(--accent-emerald)">
              <div class="evidence-card-header">
                <span>${escapeHtml(item.name)} (${formatBytes(item.sizeBytes)})</span>
                <span class="badge badge-${escapeHtml(item.riskCategory)}">${escapeHtml(item.riskCategory)}</span>
              </div>
              <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);margin-bottom:4px;">${escapeHtml(item.canonicalPath)}</div>
              <div style="color:var(--text-secondary)">${escapeHtml(item.explanation)}</div>
              ${
                item.warnings?.length > 0
                  ? `<div style="color:var(--accent-amber);margin-top:4px;">Warning: ${escapeHtml(item.warnings.join('; '))}</div>`
                  : ''
              }
            </div>
          `
            )
            .join('')
        : `<div style="color:var(--text-muted)">No eligible artifacts in current selection.</div>`;

    const blockedHtml =
      review.blockedItems.length > 0
        ? `
        <div>
          <div class="field-label" style="color:var(--accent-coral);margin-bottom:6px;">
            Blocked by Safety Policy (${review.totalBlockedCount} item${review.totalBlockedCount > 1 ? 's' : ''}):
          </div>
          ${review.blockedItems
            .map(
              (b) => `
              <div class="evidence-card" style="border-left:3px solid var(--accent-coral)">
                <div class="evidence-card-header">
                  <span>${escapeHtml(b.name)}</span>
                  <span class="badge badge-HIGH">${escapeHtml(b.code)}</span>
                </div>
                <div style="color:var(--text-secondary)">${escapeHtml((b.reasons || []).join(' '))}</div>
                ${
                  b.code === 'HIGH_RISK_CONFIRMATION_REQUIRED' && !review.isBulkRequest
                    ? `<button id="override-high-risk-btn" class="danger-outline-btn" style="margin-top:8px;" type="button">Acknowledge High-Risk &amp; Allow Single-File Quarantine</button>`
                    : ''
                }
              </div>
            `
            )
            .join('')}
        </div>
      `
        : '';

    body.innerHTML = `
      <div class="identified-app-preview">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>Operation: ${escapeHtml(review.operationLabel)}</strong>
          <span style="font-family:var(--font-mono);font-weight:600;color:var(--accent-emerald)">
            ${review.totalEligibleCount} eligible • ${formatBytes(review.totalReclaimableBytes)}
          </span>
        </div>
        <div style="font-size:11.5px;color:var(--text-secondary);margin-top:4px;">
          Files are verified via 10 pre-flight checks (inode, mtime, size, symlink boundary, and permission guards) and moved to <code>${escapeHtml(review.quarantineVaultLocation)}</code> with a durable recovery manifest.
        </div>
      </div>

      <div>
        <div class="field-label" style="margin-bottom:6px;">Eligible for Recoverable Quarantine (${review.totalEligibleCount}):</div>
        ${eligibleHtml}
      </div>

      ${blockedHtml}
    `;

    const overrideBtn = document.getElementById('override-high-risk-btn');
    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        openCleanupReviewModal(true);
      });
    }

    modal.classList.remove('hidden');
  } catch (err) {
    showToast(`Cleanup review error: ${err.message}`);
  }
}

/* =========================================================================
   MODAL DIALOG HANDLERS
   ========================================================================= */

function bindModalEvents() {
  const closePicker = () =>
    document.getElementById('app-picker-modal').classList.add('hidden');
  document.getElementById('close-picker-modal-btn').addEventListener('click', closePicker);
  document.getElementById('cancel-picker-modal-btn').addEventListener('click', closePicker);

  document.getElementById('identify-custom-bundle-btn').addEventListener('click', async () => {
    const val = document.getElementById('custom-bundle-path-input').value.trim();
    if (val) {
      await previewIdentifiedBundleInModal(val);
    }
  });

  document.getElementById('authorize-start-scan-btn').addEventListener('click', async () => {
    const bundlePath = document.getElementById('custom-bundle-path-input').value.trim();
    const wsPath = document.getElementById('custom-workspace-path-input').value.trim();
    uiState.pendingWorkspacePath = wsPath;
    await executeScan({
      bundlePath: bundlePath || null,
      workspacePath: wsPath || null
    });
  });

  const closeCleanup = () =>
    document.getElementById('cleanup-review-modal').classList.add('hidden');
  document.getElementById('close-cleanup-modal-btn').addEventListener('click', closeCleanup);
  document.getElementById('cancel-cleanup-modal-btn').addEventListener('click', closeCleanup);

  document.getElementById('confirm-quarantine-btn').addEventListener('click', async () => {
    if (!uiState.pendingReview?.confirmationToken) return;
    try {
      const res = await apiRequest('/api/cleanup/quarantine', 'POST', {
        artifactIds: Array.from(uiState.selectedArtifactIds),
        confirmationToken: uiState.pendingReview.confirmationToken,
        allowHighRiskSingleOverride: uiState.allowHighRiskSingleOverride
      });

      closeCleanup();
      uiState.activeState = res.activeState;
      uiState.quarantineEntries = res.quarantineEntries || [];
      clearNodeSelection();
      loadGraphFromState(res.activeState.graph);
      renderGlobalInspectorSummary();
      renderTreemapView();
      renderQuarantineVaultView();
      updateQuarantineCountPill();

      showToast(
        `Moved ${res.quarantinedEntries.length} artifact(s) to Quarantine Vault (Batch ${res.batchId}).`
      );
    } catch (err) {
      showToast(`Quarantine error: ${err.message}`);
    }
  });

  const closeSettings = () =>
    document.getElementById('settings-modal').classList.add('hidden');
  document.getElementById('close-settings-modal-btn').addEventListener('click', closeSettings);
  document.getElementById('done-settings-modal-btn').addEventListener('click', closeSettings);

  document.getElementById('reset-demo-sandbox-btn').addEventListener('click', async () => {
    try {
      const res = await apiRequest('/api/demo/reset', 'POST');
      renderDraggableBundles(res.availableBundles || []);
      closeSettings();
      document.getElementById('back-to-dropzone-btn').click();
      showToast('Sandbox fixtures reset to initial state.');
    } catch (err) {
      showToast(`Reset error: ${err.message}`);
    }
  });
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const body = document.getElementById('settings-modal-body');
  const boot = uiState.bootstrap || {};

  body.innerHTML = `
    <div class="kv-list">
      <div class="kv-item"><span class="kv-key">Privacy &amp; Telemetry:</span><span class="kv-val">100% Local-First (Zero Network / Zero Telemetry)</span></div>
      <div class="kv-item"><span class="kv-key">Application Execution Policy:</span><span class="kv-val">Never Execute Dropped .app Binaries</span></div>
      <div class="kv-item"><span class="kv-key">Symlink Boundary Policy:</span><span class="kv-val">Reject Out-of-Boundary Symlinks (lstat + realpath)</span></div>
      <div class="kv-item"><span class="kv-key">Hardlink Accounting:</span><span class="kv-val">Deduplicate by Physical Inode (dev:ino)</span></div>
      <div class="kv-item"><span class="kv-key">Active Home Scope:</span><span class="kv-val">${escapeHtml(boot.homeDir || '')}</span></div>
      <div class="kv-item"><span class="kv-key">Quarantine Vault Path:</span><span class="kv-val">${escapeHtml(boot.quarantineVaultLocation || '')}</span></div>
    </div>
  `;
  modal.classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded', initApp);
