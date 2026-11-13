const uiState = {
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

const RISK_LABELS = {
  LOW: 'Safe to remove',
  REVIEW: 'Review first',
  HIGH: 'High risk',
  PROTECTED: 'Protected'
};
const ORIGIN_LABELS = {
  VERIFIED: 'Recorded by a session',
  INFERRED: 'Likely from this app',
  UNKNOWN: 'Unknown origin'
};
const NODE_TYPE_LABELS = {
  AI_APPLICATION: 'App',
  WORKSPACE: 'Project folder',
  SESSION: 'Session',
  OPERATION: 'Tool call',
  ARTIFACT: 'File',
  ARTIFACT_GROUP: 'Group',
  FOLDER: 'Folder',
  UNKNOWN_ORIGIN: 'Unknown origin'
};
const RISK_DOT_CLASS = {
  LOW: 'dot-safe',
  REVIEW: 'dot-review',
  HIGH: 'dot-high',
  PROTECTED: 'dot-protected'
};

/** "REGENERABLE_CACHE" -> "Regenerable cache" */
/* Icons. `AtlasIcons` comes from icons.js. An application shows its own icon when its
   bundle has one that can be read; the glyph underneath is the fallback. */
const Icons = window.AtlasIcons;

function iconSvg(name, size = 16) {
  return Icons ? Icons.svg(name, size) : '';
}

function appIconUrl(bundlePath) {
  return `/api/app/icon?bundlePath=${encodeURIComponent(bundlePath)}`;
}

// Fills an `.app-icon` element for an application ({ name, adapterId, bundlePath, isDemoFixture }).
function fillAppIcon(el, app) {
  if (!el) return;
  el.innerHTML = iconSvg(app ? Icons.forApp(app) : 'folder', 16);
  el.classList.remove('has-image');
  if (app && app.bundlePath && !app.isDemoFixture) {
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      el.classList.add('has-image');
      el.replaceChildren(img);
    });
    img.src = appIconUrl(app.bundlePath);
  }
}

function sentenceCase(value) {
  const text = String(value || '').replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function riskBadge(risk) {
  if (!RISK_LABELS[risk]) return '';
  return `<span class="badge badge-${risk}">${RISK_LABELS[risk]}</span>`;
}

const ORIGIN_SHORT_LABELS = { VERIFIED: 'Recorded', INFERRED: 'Likely', UNKNOWN: 'Unknown' };

function originShortBadge(confidence) {
  if (!ORIGIN_SHORT_LABELS[confidence]) return '';
  return `<span class="badge">${ORIGIN_SHORT_LABELS[confidence]}</span>`;
}

/** Explanations from the engine use inline code marks; show them as plain text. */
function plain(text) {
  return escapeHtml(String(text || '').replace(/`/g, ''));
}

function originBadge(confidence) {
  if (!ORIGIN_LABELS[confidence]) return '';
  return `<span class="badge">${ORIGIN_LABELS[confidence]}</span>`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Canvas colors come from the same CSS tokens as the rest of the UI, in both themes. */
let cachedThemeColors = null;
function themeColors() {
  if (!cachedThemeColors) {
    const css = getComputedStyle(document.documentElement);
    const read = (name) => css.getPropertyValue(name).trim();
    cachedThemeColors = {
      surface: read('--surface'),
      ink: read('--ink'),
      ink2: read('--ink-2'),
      ink3: read('--ink-3'),
      line: read('--line-strong'),
      LOW: read('--risk-safe'),
      REVIEW: read('--risk-review'),
      HIGH: read('--risk-high'),
      PROTECTED: read('--risk-protected')
    };
  }
  return cachedThemeColors;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  cachedThemeColors = null;
});

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

  bindPermissionsEvents();

  // Inside the macOS app (WKWebView) the real window controls overlap the top-left corner
  if (/AppleWebKit/.test(navigator.userAgent) && !/Safari\//.test(navigator.userAgent)) {
    document.documentElement.classList.add('native-shell');
  }

  const boot = await loadBootstrap();
  // First launch: explain the permissions before anything on the real disk is read
  if (boot && boot.canSwitchMode && boot.mode === 'demo' && !homeScanGranted(boot.permissions)) {
    openPermissionsModal();
  }
}

/**
 * (Re)loads server state. Called at startup and whenever the data scope changes.
 */
async function loadBootstrap() {
  try {
    const boot = await apiRequest('/api/bootstrap');
    uiState.bootstrap = boot;
    uiState.quarantineEntries = boot.quarantineEntries || [];
    uiState.pendingWorkspacePath = boot.defaultWorkspacePath || '';
    uiState.pendingBundlePath = null;

    const isLive = boot.mode === 'live';
    document.getElementById('demo-env-badge').classList.toggle('hidden', isLive);
    document.getElementById('live-env-badge').classList.toggle('hidden', !isLive);
    document.getElementById('bundle-dock-caption').textContent = isLive
      ? 'AI apps on this Mac'
      : 'Sample apps';
    document.getElementById('custom-bundle-path-input').value = '';

    renderDraggableBundles(boot.availableBundles || []);
    updateQuarantineCountPill();
    return boot;
  } catch (err) {
    showToast(`Could not start: ${err.message}`);
    return null;
  }
}

/* =========================================================================
   PERMISSIONS & DATA SCOPE
   ========================================================================= */

const PERMISSION_STATUS_LABELS = {
  GRANTED: 'Allowed',
  NOT_GRANTED: 'Not allowed',
  ASKED_ON_DEMAND: 'macOS asks when needed',
  COVERED_BY_FULL_DISK_ACCESS: 'Covered by Full Disk Access',
  NOT_APPLICABLE: 'Not needed on this system',
  UNKNOWN: 'Could not be checked'
};

function homeScanGranted(permissions = []) {
  return permissions.some((p) => p.id === 'home-folder-scan' && p.status === 'GRANTED');
}

async function openSystemTarget(target) {
  try {
    const res = await apiRequest('/api/system/open', 'POST', { target });
    if (!res.opened && res.url && /^https:/.test(res.url)) {
      window.open(res.url, '_blank', 'noopener');
    } else if (!res.opened) {
      showToast('System Settings can only be opened on macOS.');
    }
  } catch (err) {
    showToast(`Could not open: ${err.message}`);
  }
}

function renderPermissionsModal(payload) {
  const granted = homeScanGranted(payload.permissions);
  const isLive = payload.mode === 'live';

  document.getElementById('permissions-intro').textContent = !payload.canSwitchMode
    ? `The home folder is fixed by the command line to ${payload.liveHomeDir}.`
    : isLive
      ? 'Artifact Atlas can read your home folder. Nothing about your files leaves this Mac, and files are only moved to Quarantine after you confirm.'
      : uiState.bundleAwaitingConsent
        ? `To scan ${uiState.bundleAwaitingConsent.split('/').pop().replace(/\.app$/, '')}, allow Artifact Atlas to read your home folder. The scan starts as soon as you allow it.`
        : 'You are looking at sample data. To see what the apps on this Mac left behind, allow Artifact Atlas to read your home folder.';

  const list = document.getElementById('permissions-list');
  list.innerHTML = '';
  for (const perm of payload.permissions) {
    const label = PERMISSION_STATUS_LABELS[perm.status] || perm.status;
    const isGranted = perm.status === 'GRANTED' || perm.status === 'COVERED_BY_FULL_DISK_ACCESS';
    const card = document.createElement('div');
    card.className = 'permission-card';
    card.dataset.permissionId = perm.id;

    const actions = [];
    if (perm.id === 'home-folder-scan' && payload.canSwitchMode) {
      actions.push(
        perm.status === 'GRANTED'
          ? '<button class="secondary-btn" data-action="revoke-home" type="button">Stop Scanning</button>'
          : '<button class="primary-btn" data-action="grant-home" type="button">Allow</button>'
      );
    }
    if (perm.settingsUrl && payload.platform === 'darwin') {
      actions.push('<button class="secondary-btn" data-action="open-settings" type="button">Open System Settings</button>');
    }
    actions.push('<button class="ghost-btn" data-action="open-docs" type="button">Learn More</button>');

    card.innerHTML = `
      <div class="permission-card-head">
        <span class="permission-card-title">${escapeHtml(perm.title)}<span class="permission-tag">${perm.required ? 'Required' : 'Optional'}</span></span>
        <span class="permission-status ${isGranted ? 'is-granted' : ''}">${escapeHtml(label)}</span>
      </div>
      <p class="permission-card-summary">${escapeHtml(perm.summary)}</p>
      <div class="permission-card-actions">${actions.join('')}</div>
    `;

    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'open-docs') {
          await openSystemTarget(`docs:${perm.id}`);
        } else if (action === 'open-settings') {
          await openSystemTarget(`settings:${perm.id}`);
        } else if (action === 'grant-home' || action === 'revoke-home') {
          await setHomeScanConsent(action === 'grant-home');
        }
      });
    });
    list.appendChild(card);
  }

  document.getElementById('done-permissions-modal-btn').textContent =
    granted || !payload.canSwitchMode ? 'Done' : 'Use Sample Data';
}

async function openPermissionsModal() {
  try {
    const payload = await apiRequest('/api/permissions');
    renderPermissionsModal(payload);
    document.getElementById('permissions-modal').classList.remove('hidden');
  } catch (err) {
    showToast(`Could not load permissions: ${err.message}`);
  }
}

async function setHomeScanConsent(granted) {
  try {
    const payload = await apiRequest('/api/permissions/home-folder-scan', 'POST', { granted });
    renderPermissionsModal(payload);
    resetToEmptyWorkspace();
    await loadBootstrap();

    // An app was dropped before permission was given: scan it now
    const waiting = uiState.bundleAwaitingConsent;
    uiState.bundleAwaitingConsent = null;
    if (granted && waiting && uiState.bootstrap?.mode === 'live') {
      await handleDroppedOrSelectedBundle(waiting);
      return;
    }
    showToast(
      granted
        ? 'Ready. Drop an app to see what it left behind.'
        : 'Back to sample data.'
    );
  } catch (err) {
    showToast(`Could not change permission: ${err.message}`);
  }
}

function resetToEmptyWorkspace() {
  uiState.activeState = null;
  uiState.selectedNodeId = null;
  uiState.selectedArtifactIds.clear();
  uiState.activeTrace = null;
  document.getElementById('explorer-view').classList.add('hidden');
  document.getElementById('scanning-view').classList.add('hidden');
  document.getElementById('empty-workspace-view').classList.remove('hidden');
  document.getElementById('back-to-dropzone-btn').classList.add('hidden');
}

function bindPermissionsEvents() {
  const close = () => document.getElementById('permissions-modal').classList.add('hidden');
  document.getElementById('permissions-btn').addEventListener('click', openPermissionsModal);
  document.getElementById('close-permissions-modal-btn').addEventListener('click', close);
  document.getElementById('done-permissions-modal-btn').addEventListener('click', close);
  document.getElementById('permissions-recheck-btn').addEventListener('click', openPermissionsModal);
  document.getElementById('permissions-overview-btn').addEventListener('click', () =>
    openSystemTarget('docs:overview')
  );
}

function bindTopBarEvents() {
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

  // With real applications the dock shows known AI apps first and stays short;
  // the full list remains available in the picker.
  const dockBundles = bundles.some((b) => !b.isDemoFixture)
    ? bundles.filter((b) => b.isKnownAIApp).slice(0, 12)
    : bundles;
  if (bundles.length > 0 && dockBundles.length === 0) {
    dockList.innerHTML =
      '<div class="empty-note">No known AI apps found. Drop any app here, or use Choose App.</div>';
  }

  bundles.forEach((b) => {
    // Dock draggable pill
    const pill = document.createElement('div');
    pill.className = 'bundle-pill';
    pill.draggable = true;
    pill.setAttribute('role', 'listitem');
    pill.dataset.bundlePath = b.bundlePath;
    pill.innerHTML = `
      <span class="app-icon" aria-hidden="true"></span>
      <span class="bundle-pill-name">${escapeHtml(b.name)}</span>
      <span class="bundle-pill-meta">${escapeHtml(b.isDemoFixture ? 'Sample' : b.bundlePath)}</span>
    `;
    fillAppIcon(pill.querySelector('.app-icon'), b);

    pill.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', b.bundlePath);
      e.dataTransfer.setData('application/x-artifact-atlas-bundle', b.bundlePath);
    });

    pill.addEventListener('click', () => {
      handleDroppedOrSelectedBundle(b.bundlePath);
    });

    if (dockBundles.includes(b)) {
      dockList.appendChild(pill);
    }

    // Modal picker item
    const item = document.createElement('div');
    item.className = 'modal-bundle-item';
    item.dataset.bundlePath = b.bundlePath;
    item.innerHTML = `
      <span class="app-icon" aria-hidden="true"></span>
      <span class="bundle-pill-name">${escapeHtml(b.name)}</span>
      <span class="bundle-pill-meta">${escapeHtml(b.isDemoFixture ? 'Sample' : b.bundlePath)}</span>
    `;
    fillAppIcon(item.querySelector('.app-icon'), b);
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

    if (droppedPath && !droppedPath.includes('/')) {
      // A browser only reveals the file name. Match it against the listed applications.
      const wanted = droppedPath.trim().toLowerCase();
      const match = (uiState.bootstrap?.availableBundles || []).find(
        (b) => b.bundlePath.split('/').pop().toLowerCase() === wanted
      );
      droppedPath = match ? match.bundlePath : '';
      if (!match) {
        showToast('Could not tell where that app is. Use Choose App instead.');
      }
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
  // While the app shows sample data it must not scan a real application. Ask for the
  // home-folder permission first and start the scan as soon as it is granted.
  const boot = uiState.bootstrap || {};
  const isSampleApp = (boot.availableBundles || []).some(
    (b) => b.isDemoFixture && b.bundlePath === bundlePath
  );
  if (boot.mode !== 'live' && !isSampleApp) {
    if (!boot.canSwitchMode) {
      showToast('This window only shows sample data.');
      return;
    }
    uiState.bundleAwaitingConsent = bundlePath;
    await openPermissionsModal();
    return;
  }
  uiState.bundleAwaitingConsent = null;
  document.getElementById('permissions-modal').classList.add('hidden');

  try {
    uiState.pendingBundlePath = bundlePath;
    await executeScan({
      bundlePath,
      workspacePath: uiState.pendingWorkspacePath
    });
  } catch (err) {
    showToast(`Could not read this app: ${err.message}`);
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
    const folderCount = app.knownDataDirectories.filter((d) => d.matchedBy || d.role).length;
    previewEl.innerHTML = `
      <strong>${escapeHtml(app.name)} ${escapeHtml(app.version)}</strong>
      <div class="kv-list">
        <div class="kv-item"><span class="kv-key">Identifier</span><span class="kv-val mono">${escapeHtml(app.bundleId || 'None')}</span></div>
        <div class="kv-item"><span class="kv-key">Data folders to check</span><span class="kv-val">${folderCount}</span></div>
        <div class="kv-item"><span class="kv-key">Session tracing</span><span class="kv-val">${app.isSupportedAIApp ? 'Supported' : 'Not available for this app'}</span></div>
      </div>
    `;
  } catch (err) {
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = `<div>${escapeHtml(err.message)}</div>`;
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

  document.getElementById('scan-status-title').textContent = `Scanning ${
    bundlePath ? bundlePath.split('/').pop().replace(/\.app$/, '') : 'folder'
  }…`;
  document.getElementById('scan-current-path').textContent = 'Preparing…';
  document.getElementById('scan-metric-roots').textContent = '0';
  document.getElementById('scan-metric-count').textContent = '0';
  document.getElementById('scan-metric-bytes').textContent = '0 B';

  // Live progress: show the folder being scanned right now and running totals
  let pollingProgress = true;
  const pollProgress = async () => {
    while (pollingProgress) {
      try {
        const res = await apiRequest('/api/scan/progress');
        if (pollingProgress && res.progress) {
          const prog = res.progress;
          const title = document.getElementById('scan-status-title');
          if (prog.phase === 'analyzing') {
            title.textContent = `Analyzing ${Number(prog.discoveredArtifactCount || 0).toLocaleString()} files…`;
          } else if (prog.phase === 'saving') {
            title.textContent = 'Saving the index…';
          }
          if (prog.currentPath) {
            document.getElementById('scan-current-path').textContent = prog.currentPath;
          }
          document.getElementById('scan-metric-roots').textContent = String(prog.scannedLocationsCount);
          document.getElementById('scan-metric-count').textContent = String(prog.discoveredArtifactCount);
          document.getElementById('scan-metric-bytes').textContent = formatBytes(prog.totalPhysicalBytes);
        }
      } catch {
        // Progress is best-effort; the scan request itself reports failures
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  pollProgress();

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
      String(res.state.scan.scannedLocationsCount);
    document.getElementById('scan-metric-count').textContent =
      String(res.state.scan.discoveredArtifactCount);
    document.getElementById('scan-metric-bytes').textContent =
      formatBytes(res.state.scan.totalPhysicalBytes);

    transitionToExplorerView();
  } catch (err) {
    document.getElementById('scanning-view').classList.add('hidden');
    document.getElementById('empty-workspace-view').classList.remove('hidden');
    showToast(`Scan failed: ${err.message}`);
  } finally {
    pollingProgress = false;
  }
}

function transitionToExplorerView() {
  document.getElementById('scanning-view').classList.add('hidden');
  document.getElementById('explorer-view').classList.remove('hidden');
  document.getElementById('back-to-dropzone-btn').classList.remove('hidden');

  const state = uiState.activeState;
  const app = state.application;

  document.getElementById('active-app-name').textContent = app ? app.name : 'Project folder';
  const appBundle = app
    ? { ...app, isDemoFixture: Boolean(state.isDemoEnvironment) }
    : null;
  fillAppIcon(document.getElementById('active-app-icon'), appBundle);
  loadGraphAppIcon(appBundle);
  document.getElementById('active-app-meta').textContent =
    `${pluralize(state.scan.discoveredArtifactCount, 'file')} · ${formatBytes(state.scan.totalPhysicalBytes)}`;

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
      `Files are linked to ${state.application.name} as a whole. Linking them to individual sessions is not available for this app.`
    );
  }
  if (state.application && (state.application.unreadableContainers || []).length > 0) {
    notices.push(
      `${pluralize(state.application.unreadableContainers.length, 'folder')} could not be read, so some files may be missing. Allow Full Disk Access under Permissions and scan again.`
    );
  }
  if (state.application && state.scan.discoveredArtifactCount === 0) {
    notices.push(`No data folders were found for ${state.application.name}.`);
  }
  if (state.scan.truncated) {
    notices.push(
      `The scan stopped at ${state.scan.maxFilesLimit.toLocaleString()} files. Results and sizes are partial.`
    );
  }
  if (state.scan.skippedBulkDirectoryCount > 0) {
    notices.push(
      `${pluralize(state.scan.skippedBulkDirectoryCount, 'dependency or Git folder')} inside project folders ${state.scan.skippedBulkDirectoryCount === 1 ? 'was' : 'were'} left out (node_modules, .git and similar). They are never cleaned up from here.`
    );
  }
  const hiddenOnMap = state.graph?.stats?.hiddenArtifactCount || 0;
  if (hiddenOnMap > 0) {
    notices.push(
      `The map shows ${state.graph.stats.shownArtifactCount.toLocaleString()} of ${state.graph.stats.artifactCount.toLocaleString()} files: every file a session recorded and the largest of each kind. Totals and Sizes cover all of them.`
    );
  }
  if (state.scan.permissionLimitations.length > 0) {
    notices.push(
      `${pluralize(state.scan.permissionLimitations.length, 'item')} could not be read and ${state.scan.permissionLimitations.length === 1 ? 'was' : 'were'} skipped.`
    );
  }

  if (notices.length === 0) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.textContent = notices.join(' ');
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
  // Fit the whole map into view once the layout has settled, unless the user moves it first
  uiState.fitCameraAtTick = uiState.animTick + 150;
  uiState.layoutSettlesAtTick = uiState.animTick + 420;

  const canvas = document.getElementById('knowledge-graph-canvas');
  if (canvas) {
    resizeCanvas();
  }
}

// The application's own icon for its node on the map, when the bundle has a readable one.
function loadGraphAppIcon(app) {
  uiState.appIconImage = null;
  if (!app || !app.bundlePath || app.isDemoFixture) return;
  const img = new Image();
  img.addEventListener('load', () => {
    uiState.appIconImage = img;
  });
  img.src = appIconUrl(app.bundlePath);
}

// Glyph color on a risk-colored file mark: dark on amber, light on the others.
function glyphColorOnRisk(risk) {
  return risk === 'REVIEW' ? '#1b1b1a' : '#ffffff';
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

/** Centers and scales the map so every visible item fits inside the canvas. */
function fitCameraToGraph() {
  const canvas = document.getElementById('knowledge-graph-canvas');
  const nodes = uiState.nodes.filter(isNodeVisibleByFilter);
  if (!canvas || nodes.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.radius);
    maxX = Math.max(maxX, n.x + n.radius);
    minY = Math.min(minY, n.y - n.radius);
    maxY = Math.max(maxY, n.y + n.radius + 30);
  }
  const scale = Math.min(
    (rect.width - 96) / Math.max(1, maxX - minX),
    (rect.height - 120) / Math.max(1, maxY - minY),
    1.1
  );
  uiState.camera = {
    scale: Math.max(0.2, scale),
    x: -((minX + maxX) / 2) * Math.max(0.2, scale),
    y: -((minY + maxY) / 2) * Math.max(0.2, scale) - 10
  };
}

function renderGraphCanvas() {
  uiState.animTick += 1;
  if (uiState.fitCameraAtTick && uiState.animTick >= uiState.fitCameraAtTick && uiState.activeTab === 'graph') {
    uiState.fitCameraAtTick = null;
    fitCameraToGraph();
  }
  if (uiState.activeTab === 'graph' && uiState.nodes.length > 0) {
    // The layout runs until it has settled, then rests; dragging a mark wakes it up.
    if (uiState.draggingNode || uiState.animTick < uiState.layoutSettlesAtTick) {
      stepGraphPhysics();
    }
    drawGraph();
  }
  requestAnimationFrame(renderGraphCanvas);
}

/**
 * Map drawing. Color means cleanup risk and nothing else: files are filled with their risk
 * color, everything structural (app, folders, sessions, tool calls) is drawn in neutral ink.
 * Line style shows how a link is known: solid = recorded, dashed = likely, dotted = unknown.
 */
function drawGraph() {
  const canvas = document.getElementById('knowledge-graph-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const colors = themeColors();

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

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

  // Links
  for (const edge of uiState.edges) {
    if (!visibleNodeIds.has(edge.sourceId) || !visibleNodeIds.has(edge.targetId)) {
      continue;
    }
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    const isHighlighted = highlightedEdges ? highlightedEdges.has(edge.id) : false;
    const isDimmed = highlightedEdges && !isHighlighted;

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.1 : isHighlighted ? 1 : 0.4;
    ctx.strokeStyle = isHighlighted ? colors.ink : colors.ink3;
    ctx.lineWidth = isHighlighted ? 1.6 : 1;
    ctx.setLineDash(
      edge.confidence === 'VERIFIED' ? [] : edge.confidence === 'INFERRED' ? [6, 4] : [1.5, 4]
    );
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();

    if (isHighlighted) {
      ctx.setLineDash([]);
      ctx.font = `${10 / uiState.camera.scale}px -apple-system, sans-serif`;
      ctx.fillStyle = colors.ink2;
      ctx.textAlign = 'center';
      ctx.fillText(
        String(edge.edgeType || '').replace(/_/g, ' ').toLowerCase(),
        (source.x + target.x) / 2,
        (source.y + target.y) / 2 - 5
      );
    }
    ctx.restore();
  }

  // Items
  const showFileLabels = uiState.camera.scale >= 0.95;
  for (const node of uiState.nodes) {
    if (!visibleNodeIds.has(node.id)) continue;

    const isSelected =
      uiState.selectedNodeId === node.id || uiState.selectedArtifactIds.has(node.id);
    const isHighlighted = highlightedNodes ? highlightedNodes.has(node.id) : true;
    const isDimmed = highlightedNodes && !isHighlighted;
    const isFile = node.nodeType === 'ARTIFACT';
    // Marks keep a minimum on-screen size so the glyph inside stays readable when zoomed out.
    const minScreenRadius =
      node.nodeType === 'AI_APPLICATION' ? 14 : isFile ? 8 : node.nodeType === 'OPERATION' ? 0 : 11;
    const r = Math.max(node.radius, minScreenRadius / uiState.camera.scale);

    ctx.save();
    ctx.globalAlpha = isDimmed ? 0.15 : 1;

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (isFile && node.metadata?.sessionIds?.length > 1) {
      // Shared by more than one session
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = colors.ink3;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    const isSquare =
      node.nodeType === 'WORKSPACE' || node.nodeType === 'ARTIFACT_GROUP' || node.nodeType === 'FOLDER';
    if (isSquare) {
      ctx.roundRect(node.x - r, node.y - r, r * 2, r * 2, 5);
    } else {
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    }

    const isHollow =
      isSquare || node.nodeType === 'UNKNOWN_ORIGIN' || node.nodeType === 'OPERATION';
    if (isHollow) {
      ctx.fillStyle = colors.surface;
      ctx.fill();
      ctx.strokeStyle = node.nodeType === 'WORKSPACE' ? colors.ink : colors.ink3;
      ctx.lineWidth = 1.5;
      if (node.nodeType === 'UNKNOWN_ORIGIN') ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = isFile
        ? colors[node.riskCategory] || colors.PROTECTED
        : node.nodeType === 'AI_APPLICATION'
          ? uiState.appIconImage
            ? colors.surface
            : colors.ink
          : node.nodeType === 'SESSION'
            ? colors.ink2
            : colors.ink3;
      ctx.fill();
      // Surface-colored ring keeps overlapping marks separate
      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Glyph inside the mark. Skipped when the mark is too small on screen to read.
    if (Icons && r * uiState.camera.scale >= 6) {
      const isApp = node.nodeType === 'AI_APPLICATION';
      if (isApp && uiState.appIconImage) {
        const side = r * 2.1;
        ctx.drawImage(uiState.appIconImage, node.x - side / 2, node.y - side / 2, side, side);
      } else {
        const glyphColor = isFile
          ? glyphColorOnRisk(node.riskCategory)
          : isHollow
            ? node.nodeType === 'WORKSPACE'
              ? colors.ink
              : colors.ink2
            : colors.surface;
        ctx.setLineDash([]);
        Icons.draw(ctx, Icons.forNode(node), node.x, node.y, r * (isFile ? 1.2 : 1.1), glyphColor);
      }
    }

    const isStructural = !isFile && node.nodeType !== 'OPERATION';
    const showLabel =
      isStructural ||
      isSelected ||
      uiState.hoveredNode === node ||
      (highlightedNodes && isHighlighted) ||
      showFileLabels;
    if (showLabel) {
      // Labels keep a constant on-screen size at any zoom level
      const labelPx = (node.nodeType === 'AI_APPLICATION' ? 12 : 11) / uiState.camera.scale;
      ctx.font = `${node.nodeType === 'AI_APPLICATION' ? '600 ' : ''}${labelPx}px -apple-system, sans-serif`;
      ctx.fillStyle = isStructural || isSelected ? colors.ink : colors.ink2;
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + r + 3 + labelPx);
    }

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
      uiState.fitCameraAtTick = null;
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
        const tooltipMeta = [
          NODE_TYPE_LABELS[hit.nodeType] || sentenceCase(hit.nodeType),
          hit.nodeType === 'ARTIFACT' ? RISK_LABELS[hit.riskCategory] : null,
          hit.sizeBytes ? formatBytes(hit.sizeBytes) : null
        ].filter(Boolean);
        tooltip.innerHTML = `
          <div>${escapeHtml(hit.label)}</div>
          <div class="tooltip-meta">${escapeHtml(tooltipMeta.join(' · '))}</div>
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
      uiState.fitCameraAtTick = null;
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
    showToast(`Could not load details: ${err.message}`);
  }
}

function clearNodeSelection() {
  uiState.selectedNodeId = null;
  uiState.selectedArtifactIds.clear();
  uiState.activeTrace = null;
  uiState.focusMode = false;
  document.getElementById('toggle-focus-mode-btn').classList.remove('active');
  document.getElementById('inspector-detail-content').classList.add('hidden');
  document.getElementById('inspector-empty-state').classList.remove('hidden');
  updateContextualToolbar();
}

/* =========================================================================
   PROVENANCE & EVIDENCE INSPECTOR (Sections 5, 7, 8, 9)
   ========================================================================= */

// Totals for the finished scan. Sizes are physical (hardlinked data counted once) and come
// from the server; counts are taken from the files on the map.
function summarizeScan() {
  const g = uiState.activeState?.graph;
  if (!g) return null;
  const tm = g.treemap || {};
  // Counts cover every file in the scan, including files that have no mark on the map.
  const countByRisk = { LOW: 0, REVIEW: 0, HIGH: 0, PROTECTED: 0, ...(g.stats.riskCounts || {}) };
  const largest = g.stats.largestArtifact
    ? { label: g.stats.largestArtifact.name, sizeBytes: g.stats.largestArtifact.sizeBytes }
    : null;
  return {
    fileCount: g.stats.artifactCount,
    totalBytes: uiState.activeState.scan?.totalPhysicalBytes || 0,
    risks: [
      { key: 'LOW', count: countByRisk.LOW, bytes: tm.reclaimablePhysicalBytes || 0 },
      { key: 'REVIEW', count: countByRisk.REVIEW, bytes: tm.reviewPhysicalBytes || 0 },
      { key: 'HIGH', count: countByRisk.HIGH, bytes: tm.highRiskPhysicalBytes || 0 },
      { key: 'PROTECTED', count: countByRisk.PROTECTED, bytes: null }
    ],
    origins: [
      { key: 'VERIFIED', label: 'Recorded by a session', count: g.stats.verifiedArtifactCount },
      { key: 'INFERRED', label: 'Likely from this app', count: g.stats.inferredArtifactCount },
      { key: 'UNKNOWN', label: 'Unknown origin', count: g.stats.unknownArtifactCount }
    ],
    kinds: [...(tm.byGroup || [])].sort((x, y) => y.bytes - x.bytes),
    sessionCount: g.stats.sessionCount || 0,
    largest
  };
}

function renderGlobalInspectorSummary() {
  const box = document.getElementById('inspector-global-stats');
  const sum = summarizeScan();
  if (!sum) return;

  const share = (bytes) => (sum.totalBytes > 0 ? Math.max(0, (bytes / sum.totalBytes) * 100) : 0);
  const riskRows = sum.risks
    .map(
      (r) => `
        <div class="kv-item">
          <span class="kv-key"><span class="legend-dot ${RISK_DOT_CLASS[r.key]}"></span>${escapeHtml(RISK_LABELS[r.key])}</span>
          <span class="kv-val">${pluralize(r.count, 'file')}${r.bytes === null ? '' : ` · ${formatBytes(r.bytes)}`}</span>
        </div>`
    )
    .join('');
  const originRows = sum.origins
    .map(
      (o) => `
        <div class="kv-item">
          <span class="kv-key"><span class="origin-line origin-${o.key}"></span>${escapeHtml(o.label)}</span>
          <span class="kv-val">${pluralize(o.count, 'file')}</span>
        </div>`
    )
    .join('');
  const kindRows = sum.kinds
    .map(
      (k) => `
        <div class="kv-item">
          <span class="kv-key">${iconSvg(Icons.forArtifactType(k.artifactType), 14)}${escapeHtml(k.label)}</span>
          <span class="kv-val">${pluralize(k.artifactCount, 'file')} · ${formatBytes(k.bytes)}</span>
        </div>`
    )
    .join('');

  box.innerHTML = `
    <div class="inspector-section">
      <div class="inspector-section-title">This scan</div>
      <div class="scan-total">
        <span class="scan-total-value">${formatBytes(sum.totalBytes)}</span>
        <span class="scan-total-meta">${pluralize(sum.fileCount, 'file')} · ${pluralize(sum.sessionCount, 'session')}</span>
      </div>
      <div class="scan-share-bar" role="img" aria-label="Share of disk space by cleanup risk">
        <span class="dot-safe" style="width:${share(sum.risks[0].bytes)}%"></span>
        <span class="dot-review" style="width:${share(sum.risks[1].bytes)}%"></span>
        <span class="dot-high" style="width:${share(sum.risks[2].bytes)}%"></span>
      </div>
    </div>
    <div class="inspector-section">
      <div class="inspector-section-title">By cleanup risk</div>
      <div class="kv-list">${riskRows}</div>
    </div>
    <div class="inspector-section">
      <div class="inspector-section-title">By origin</div>
      <div class="kv-list">${originRows}</div>
    </div>
    <div class="inspector-section">
      <div class="inspector-section-title">By kind</div>
      <div class="kv-list">${kindRows}</div>
    </div>
    ${
      sum.largest
        ? `<div class="inspector-section">
            <div class="inspector-section-title">Largest file</div>
            <div class="kv-list"><div class="kv-item">
              <span class="kv-key kv-key-wrap">${escapeHtml(sum.largest.label)}</span>
              <span class="kv-val">${formatBytes(sum.largest.sizeBytes)}</span>
            </div></div>
          </div>`
        : ''
    }
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
              <span>${escapeHtml(sentenceCase(ev.sourceType))}</span>
              ${originShortBadge(ev.confidence)}
            </div>
            <div class="row-detail">${plain(ev.summary)}</div>
            ${ev.sourceRef ? `<div class="row-path mono">${escapeHtml(ev.sourceRef)}</div>` : ''}
          </div>
        `
          )
          .join('')
      : '';

  const hopsHtml =
    trace?.provenanceHops?.length > 0
      ? trace.provenanceHops
          .map(
            (hop) => `
          <div class="hop-card">
            <div class="hop-card-header">
              <span>${escapeHtml(sentenceCase(hop.edgeType))} ${escapeHtml(hop.toNodeLabel)}</span>
              ${originShortBadge(hop.confidence)}
            </div>
            ${hop.explanation ? `<div class="row-detail">${plain(hop.explanation)}</div>` : ''}
          </div>
        `
          )
          .join('')
      : '';

  const sharedHtml =
    isArtifact && Array.isArray(meta.sharedDependencyIndicators) && meta.sharedDependencyIndicators.length > 0
      ? `
      <div class="inspector-section">
        <div class="inspector-section-title">Also used elsewhere</div>
        ${meta.sharedDependencyIndicators
          .map((ind) => `<div class="inspector-note">${escapeHtml(ind)}</div>`)
          .join('')}
      </div>
    `
      : '';

  const cleanupSectionHtml = isArtifact
    ? `
      <div class="inspector-section">
        <div class="inspector-section-title">If you remove it</div>
        <div class="inspector-note">${plain(meta.cleanupExplanation)}</div>
        <div class="inspector-note">${plain(meta.deletionConsequences)}</div>
      </div>
    `
    : '';

  detail.innerHTML = `
    <div class="inspector-head">
      <div>
        <div class="inspector-kicker">${iconSvg(Icons ? Icons.forNode(node) : 'unknown', 14)}${escapeHtml(
          isArtifact
            ? sentenceCase(meta.artifactType)
            : NODE_TYPE_LABELS[node.nodeType] || sentenceCase(node.nodeType)
        )}</div>
        <h3 class="inspector-title">${escapeHtml(node.label)}</h3>
      </div>
      ${
        isArtifact
          ? `<div class="badge-row">${riskBadge(meta.cleanupClassification)}${originBadge(meta.provenanceConfidence)}</div>`
          : ''
      }
      <div class="kv-list">
        ${
          isArtifact
            ? `
          <div class="kv-item"><span class="kv-key">Size</span><span class="kv-val">${formatBytes(meta.sizeBytes)}</span></div>
          <div class="kv-item"><span class="kv-key">Modified</span><span class="kv-val">${escapeHtml(formatDate(meta.modifiedAt) || 'Unknown')}</span></div>
          <div class="kv-item"><span class="kv-key">Sessions</span><span class="kv-val">${meta.sessionIds?.length || 0}</span></div>
        `
            : ''
        }
        ${
          meta.canonicalPath
            ? `<div class="kv-item"><span class="kv-key">Path</span><span class="kv-val mono">${escapeHtml(meta.canonicalPath)}</span></div>`
            : ''
        }
        ${
          node.nodeType === 'FOLDER'
            ? `
          <div class="kv-item"><span class="kv-key">Files</span><span class="kv-val">${Number(meta.artifactCount || 0).toLocaleString()}</span></div>
          <div class="kv-item"><span class="kv-key">Size</span><span class="kv-val">${formatBytes(meta.bytes || 0)}</span></div>
          ${['LOW', 'REVIEW', 'HIGH', 'PROTECTED']
            .filter((risk) => meta.riskCounts?.[risk] > 0)
            .map(
              (risk) =>
                `<div class="kv-item"><span class="kv-key">${escapeHtml(RISK_LABELS[risk])}</span><span class="kv-val">${pluralize(meta.riskCounts[risk], 'file')}</span></div>`
            )
            .join('')}
          <div class="kv-item"><span class="kv-key">Path</span><span class="kv-val mono">${escapeHtml(meta.path || '')}</span></div>
        `
            : ''
        }
      </div>
      ${
        node.nodeType === 'FOLDER'
          ? `<div class="inspector-note">This folder stands for all of its files. Cleanup still moves files one by one, and protected files stay where they are.</div>
             <button id="select-folder-files-btn" class="secondary-btn" type="button">Select Files in This Folder</button>`
          : ''
      }
    </div>

    ${cleanupSectionHtml}
    ${sharedHtml}

    ${
      evidenceHtml
        ? `<div class="inspector-section">
      <div class="inspector-section-title">How we know</div>
      ${evidenceHtml}
    </div>`
        : ''
    }

    ${
      hopsHtml
        ? `<div class="inspector-section">
      <div class="inspector-section-title">Where it came from</div>
      ${hopsHtml}
    </div>`
        : ''
    }
  `;

  const folderBtn = document.getElementById('select-folder-files-btn');
  if (folderBtn) {
    folderBtn.addEventListener('click', async () => {
      try {
        const count = await selectByDescription({ kind: 'cell', groupBy: 'byFolder', cellId: node.id });
        showToast(`Selected ${pluralize(count, 'file')} in ${node.label}.`);
      } catch (err) {
        showToast(`Could not select files: ${err.message}`);
      }
    });
  }
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

  document.getElementById('filter-confidence').addEventListener('change', (e) => {
    uiState.filterConfidence = e.target.value;
  });

  document.getElementById('filter-risk').addEventListener('change', (e) => {
    uiState.filterRisk = e.target.value;
  });

  document.getElementById('toggle-focus-mode-btn').addEventListener('click', (e) => {
    if (!uiState.activeTrace) {
      showToast('Select an item on the map first.');
      return;
    }
    uiState.focusMode = !uiState.focusMode;
    e.currentTarget.classList.toggle('active', uiState.focusMode);
  });

  document.getElementById('select-low-risk-btn').addEventListener('click', async () => {
    if (!uiState.activeState) return;
    try {
      const count = await selectByDescription({ kind: 'safe' });
      showToast(
        count > 0
          ? `Selected ${pluralize(count, 'file')} that ${count === 1 ? 'is' : 'are'} safe to remove.`
          : 'Nothing here is marked safe to remove.'
      );
    } catch (err) {
      showToast(`Could not select files: ${err.message}`);
    }
  });

  document.getElementById('reset-camera-btn').addEventListener('click', () => {
    fitCameraToGraph();
  });

  document.getElementById('treemap-group-by').addEventListener('change', (e) => {
    uiState.treemapGroupBy = e.target.value;
    renderTreemapView();
  });

  document.getElementById('cancel-scan-btn').addEventListener('click', async () => {
    await apiRequest('/api/scan/cancel', 'POST');
    showToast('Scan canceled.');
  });
}

function renderTreemapView() {
  const tm = uiState.activeState?.graph?.treemap;
  if (!tm) return;

  const keepBytes = tm.highRiskPhysicalBytes + tm.protectedOrUncertainPhysicalBytes;
  const shares = [
    ['dot-safe', tm.reclaimablePhysicalBytes, 'Safe to remove'],
    ['dot-review', tm.reviewPhysicalBytes, 'Review first'],
    ['dot-high', keepBytes, 'High risk or protected']
  ].filter(([, bytes]) => bytes > 0);

  const strip = document.getElementById('treemap-summary-strip');
  strip.innerHTML = `
    <div class="size-totals">
      <div class="size-total">
        <span class="metric-value">${formatBytes(tm.totalPhysicalBytes)}</span>
        <span class="metric-label">Total</span>
      </div>
      <div class="size-total">
        <span class="metric-value">${formatBytes(tm.reclaimablePhysicalBytes)}</span>
        <span class="badge badge-LOW">Safe to remove</span>
      </div>
      <div class="size-total">
        <span class="metric-value">${formatBytes(tm.reviewPhysicalBytes)}</span>
        <span class="badge badge-REVIEW">Review first</span>
      </div>
      <div class="size-total">
        <span class="metric-value">${formatBytes(keepBytes)}</span>
        <span class="badge badge-HIGH">High risk or protected</span>
      </div>
    </div>
    <div class="risk-share-bar" role="img" aria-label="Share of disk space by risk">
      ${shares
        .map(
          ([cls, bytes, label]) =>
            `<span class="${cls}" style="flex:${bytes} 1 0" title="${label}: ${formatBytes(bytes)}"></span>`
        )
        .join('')}
    </div>
  `;

  const grid = document.getElementById('treemap-grid-container');
  grid.innerHTML = '';

  const cells = [...(tm[uiState.treemapGroupBy] || tm.byGroup || [])].sort(
    (a, b) => b.bytes - a.bytes
  );
  const maxBytes = Math.max(1, ...cells.map((c) => c.bytes));

  cells.forEach((cell) => {
    const risk = cell.riskCategory || 'REVIEW';
    const tile = document.createElement('div');
    tile.className = 'treemap-tile';
    tile.title = `${cell.label}: ${formatBytes(cell.bytes)} · ${RISK_LABELS[risk] || ''}`;
    tile.innerHTML = `
      <div class="size-row-label">
        <div class="size-row-name">${
          cell.artifactType ? iconSvg(Icons.forArtifactType(cell.artifactType), 15) : ''
        }${escapeHtml(cell.label)}</div>
        <div class="size-row-count">${pluralize(cell.artifactCount, 'file')}</div>
      </div>
      <div class="size-row-track">
        <div class="size-row-bar ${RISK_DOT_CLASS[risk] || 'dot-review'}" style="width:${Math.max(0.5, (cell.bytes / maxBytes) * 100)}%"></div>
      </div>
      <div class="size-row-value">${formatBytes(cell.bytes)}</div>
    `;

    // Clicking a row selects its files on the map
    tile.addEventListener('click', async () => {
      document.getElementById('tab-graph-btn').click();
      const node = cell.focusNodeId ? uiState.nodes.find((n) => n.id === cell.focusNodeId) : null;
      if (node) {
        await selectNodeInGraph(node, false);
      } else {
        clearNodeSelection();
      }
      try {
        const count = await selectByDescription({
          kind: 'cell',
          groupBy: uiState.treemapGroupBy,
          cellId: cell.id
        });
        showToast(`Selected ${pluralize(count, 'file')} in ${cell.label}.`);
      } catch (err) {
        showToast(`Could not select files: ${err.message}`);
      }
    });

    grid.appendChild(tile);
  });
}

function renderQuarantineVaultView() {
  const listEl = document.getElementById('quarantine-entries-list');
  if (!listEl) return;

  if (!uiState.quarantineEntries || uiState.quarantineEntries.length === 0) {
    listEl.innerHTML = `<div class="empty-note">Nothing in Quarantine. Select files on the map and choose Move to Quarantine.</div>`;
    return;
  }

  listEl.innerHTML = '';
  uiState.quarantineEntries.forEach((entry) => {
    const isHeld = entry.status === 'QUARANTINED';
    const row = document.createElement('div');
    row.className = 'quarantine-row-card';
    row.title = `SHA-256 ${entry.sha256 || 'not recorded'}`;
    row.innerHTML = `
      <div class="quarantine-row-main">
        <div class="quarantine-row-title">
          <strong>${escapeHtml(entry.artifactName)}</strong>
          <span>${formatBytes(entry.sizeBytes)}</span>
          <span class="metric-label">${
            isHeld
              ? `Removed ${escapeHtml(formatDate(entry.quarantinedAt))}`
              : `Restored ${escapeHtml(formatDate(entry.restoredAt))}`
          }</span>
        </div>
        <div class="quarantine-row-path mono">${escapeHtml(entry.originalPath)}</div>
      </div>
      ${
        isHeld
          ? `<button class="secondary-btn restore-entry-btn" data-entry-id="${escapeHtml(entry.id)}" type="button">Put Back</button>`
          : ''
      }
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
        showToast(
          res.displacedEntry
            ? 'Put back. The file that was there is now in Quarantine.'
            : 'Put back.'
        );
      } catch (err) {
        showToast(`Could not put it back: ${err.message}`);
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

// Count, size and first path of the current selection. The file list lives on the server,
// so the summary is requested whenever the selection changes; the latest request wins.
let selectionSummary = { count: 0, physicalBytes: 0, firstName: null, firstPath: null };
let selectionSummaryRequest = 0;

function updateContextualToolbar(knownSummary = null) {
  const toolbar = document.getElementById('contextual-toolbar');
  const count = uiState.selectedArtifactIds.size;

  if (count === 0) {
    toolbar.classList.add('hidden');
    selectionSummary = { count: 0, physicalBytes: 0, firstName: null, firstPath: null };
    selectionSummaryRequest += 1;
    return;
  }

  toolbar.classList.remove('hidden');
  document.getElementById('selected-count-badge').textContent = `${pluralize(count, 'file')} selected`;

  const show = (summary) => {
    selectionSummary = summary;
    document.getElementById('selected-size-label').textContent = formatBytes(summary.physicalBytes);
  };
  const request = ++selectionSummaryRequest;
  if (knownSummary) {
    show(knownSummary);
    return;
  }
  apiRequest('/api/selection/summary', 'POST', { artifactIds: Array.from(uiState.selectedArtifactIds) })
    .then((res) => {
      if (request === selectionSummaryRequest) show(res.summary);
    })
    .catch(() => {
      // The size label is informative only; the review step recomputes everything
    });
}

// Replaces the selection with files chosen by description (all safe files, a Sizes row).
async function selectByDescription(description) {
  const res = await apiRequest('/api/selection/resolve', 'POST', description);
  uiState.selectedArtifactIds = new Set(res.artifactIds);
  updateContextualToolbar(res.summary);
  return res.artifactIds.length;
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
    if (!firstId || !selectionSummary.firstPath) return;
    try {
      const res = await apiRequest('/api/finder/reveal', 'POST', {
        path: selectionSummary.firstPath
      });
      showToast(
        res.commandPreview
          ? `Reveal in Finder: ${res.commandPreview}`
          : `Revealed ${selectionSummary.firstName} in Finder`
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
      showToast(`Added ${pluralize(uiState.activeTrace.relatedArtifactIds.length, 'related file')}.`);
    } else {
      showToast('No related files found.');
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

    const eligibleHtml = review.eligibleItems
      .map(
        (item) => `
            <div class="evidence-card">
              <div class="evidence-card-header">
                <span>${escapeHtml(item.name)}</span>
                <span>${formatBytes(item.sizeBytes)}</span>
              </div>
              <div class="badge-row">${riskBadge(item.riskCategory)}${originBadge(item.provenanceConfidence)}</div>
              <div class="row-path mono">${escapeHtml(item.canonicalPath)}</div>
              <div class="row-detail">${plain(item.explanation)}</div>
              ${
                item.warnings?.length > 0
                  ? `<div class="row-warning">Note: ${escapeHtml(item.warnings.join(' '))}</div>`
                  : ''
              }
            </div>
          `
      )
      .join('');

    const blockedHtml =
      review.blockedItems.length > 0
        ? `
        <div>
          <div class="field-label">Not moved (${review.totalBlockedCount})</div>
          ${review.blockedItems
            .map(
              (b) => `
              <div class="evidence-card">
                <div class="evidence-card-header">
                  <span>${escapeHtml(b.name)}</span>
                  ${riskBadge(b.riskCategory)}
                </div>
                <div class="row-detail">${plain((b.reasons || []).join(' '))}</div>
                ${
                  b.code === 'HIGH_RISK_CONFIRMATION_REQUIRED' && !review.isBulkRequest
                    ? `<div><button id="override-high-risk-btn" class="secondary-btn" type="button">Move It Anyway</button></div>`
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
      <div class="review-summary">
        <div class="review-summary-head">
          <span>${pluralize(review.totalEligibleCount, 'file')} will be moved${
            review.totalEligibleCount > review.eligibleItems.length
              ? ` (first ${review.eligibleItems.length} listed)`
              : ''
          }</span>
          <span>${formatBytes(review.totalReclaimableBytes)}</span>
        </div>
        <div class="row-detail">Each file is checked again right before it moves. You can put files back from Quarantine at any time.</div>
      </div>

      ${
        eligibleHtml
          ? `<div>
        <div class="field-label">To be moved</div>
        ${eligibleHtml}
      </div>`
          : ''
      }

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
    showToast(`Could not prepare the review: ${err.message}`);
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

      showToast(`Moved ${pluralize(res.quarantinedEntries.length, 'file')} to Quarantine.`);
    } catch (err) {
      showToast(`Could not move to Quarantine: ${err.message}`);
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
      showToast('Sample data reset.');
    } catch (err) {
      showToast(`Could not reset: ${err.message}`);
    }
  });
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const body = document.getElementById('settings-modal-body');
  const boot = uiState.bootstrap || {};

  const isLive = boot.mode === 'live';
  document.getElementById('reset-demo-sandbox-btn').classList.toggle('hidden', isLive);
  body.innerHTML = `
    <div class="kv-list">
      <div class="kv-item"><span class="kv-key">Showing</span><span class="kv-val">${isLive ? 'Your Mac' : 'Sample data'}</span></div>
      <div class="kv-item"><span class="kv-key">Home folder</span><span class="kv-val mono">${escapeHtml(boot.homeDir || '')}</span></div>
      <div class="kv-item"><span class="kv-key">Quarantine folder</span><span class="kv-val mono">${escapeHtml(boot.quarantineVaultLocation || '')}</span></div>
    </div>
    <p class="inspector-note">Nothing about you or your files leaves this Mac. Apps you drop are read, never opened. Removed files go to Quarantine and can be put back.</p>
    <div class="inspector-section">
      <div class="inspector-section-title">Updates</div>
      <div class="kv-list">
        <div class="kv-item"><span class="kv-key">This version</span><span class="kv-val" id="settings-current-version">…</span></div>
        <div class="kv-item"><span class="kv-key">Latest version</span><span class="kv-val" id="settings-latest-version">…</span></div>
      </div>
      <label class="settings-check">
        <input type="checkbox" id="settings-update-check" />
        <span>Check for new versions</span>
      </label>
      <p class="inspector-note">The check asks GitHub for the latest release number. It is the only time the app uses the network, and it sends nothing about you or your files. Nothing is downloaded automatically.</p>
    </div>
  `;
  modal.classList.remove('hidden');

  const checkbox = document.getElementById('settings-update-check');
  const showUpdate = (update) => {
    uiState.update = update;
    checkbox.checked = Boolean(update.enabled);
    document.getElementById('settings-current-version').textContent = update.currentVersion || 'Unknown';
    document.getElementById('settings-latest-version').textContent = !update.enabled
      ? 'Not checked'
      : update.latestVersion
        ? update.updateAvailable
          ? `${update.latestVersion} is available`
          : `${update.latestVersion} (up to date)`
        : 'Could not check';
    renderUpdatePill();
  };
  checkbox.addEventListener('change', async () => {
    try {
      const res = await apiRequest('/api/update', 'POST', { enabled: checkbox.checked, checkNow: true });
      showUpdate(res.update);
    } catch (err) {
      showToast(`Could not change the setting: ${err.message}`);
    }
  });
  apiRequest('/api/update')
    .then((res) => showUpdate(res.update))
    .catch(() => {});
}

// Shows a button in the title bar when a newer version has been released.
function renderUpdatePill() {
  const pill = document.getElementById('update-available-btn');
  const update = uiState.update;
  if (!pill) return;
  if (update && update.enabled && update.updateAvailable) {
    pill.textContent = `Update available: ${update.latestVersion}`;
    pill.title = `You have ${update.currentVersion}. Open the download page.`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

async function checkForAppUpdate() {
  try {
    const res = await apiRequest('/api/update');
    uiState.update = res.update;
    renderUpdatePill();
  } catch {
    // Offline or blocked: stay quiet
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initApp();
  document.getElementById('update-available-btn').addEventListener('click', () => {
    openSystemTarget('update:latest');
  });
  checkForAppUpdate();
  // A long-running window checks again a few times a day
  setInterval(checkForAppUpdate, 6 * 60 * 60 * 1000);
});
