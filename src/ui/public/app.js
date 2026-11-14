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
  animTick: 0,
  // The map level being shown (see src/graph/map-levels.js)
  mapLevel: null
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
// Order of preference: the application's own icon from its bundle, a known logo, a glyph.
function fillAppIcon(el, app) {
  if (!el) return;
  el.classList.remove('has-image');
  const logo = app ? Icons.logoForApp(app) : null;
  if (logo) {
    el.innerHTML = `<i class="app-logo" style="-webkit-mask-image:url(/logos/${logo}.svg);mask-image:url(/logos/${logo}.svg)"></i>`;
  } else {
    el.innerHTML = iconSvg(app ? Icons.forApp(app) : 'folder', 16);
  }
  if (app && app.bundlePath && !app.isDemoFixture) {
    // The image sits in the page from the start so the browser loads it when its row is
    // visible; it replaces the fallback only once it has loaded.
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'app-icon-image';
    img.addEventListener('load', () => {
      el.classList.add('has-image');
      el.replaceChildren(img);
    });
    img.addEventListener('error', () => img.remove());
    img.src = appIconUrl(app.bundlePath);
    el.appendChild(img);
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

function showToast(message, durationMs = 3800) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, durationMs);
}

/* Platform wording: the same window runs inside the macOS app and the Windows app. */
function isWindows() {
  return uiState.bootstrap?.platform === 'win32';
}

function deviceName() {
  return isWindows() ? 'this PC' : 'this Mac';
}

function fileManagerName() {
  return isWindows() ? 'File Explorer' : 'Finder';
}

/** Last segment of a path written with either separator. */
function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function appNameFromPath(appPath) {
  // The picker knows the application's name; a typed path only has its file name
  const listed = (uiState.bootstrap?.availableBundles || []).find((b) => b.bundlePath === appPath);
  return listed ? listed.name : baseName(appPath).replace(/\.(app|lnk|exe)$/i, '');
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
      requestScan({
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

  // Permissions are asked when a scan of a real application starts (see requestScan), and
  // can be changed afterwards in the Permissions window.
  await loadBootstrap();
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
      ? `AI apps on ${deviceName()}`
      : 'Sample apps';
    applyPlatformWording();
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

/* The Permissions window has two uses. Opened from the title bar it shows and changes the
   permissions. Opened by a scan ("pre-scan") it asks the same questions before anything on
   the real disk is read, and its main button starts the scan. */
function renderPermissionsModal(payload) {
  const granted = homeScanGranted(payload.permissions);
  const isLive = payload.mode === 'live';
  const pending = uiState.pendingScan;
  const where = payload.platform === 'win32' ? 'this PC' : 'this Mac';

  document.getElementById('permissions-modal-title').textContent = pending
    ? `Before scanning ${pending.label}`
    : 'Permissions';
  document.getElementById('permissions-intro').textContent = pending
    ? `Choose what this scan may read. Nothing about your files leaves ${where}. You can change these later under Permissions.`
    : !payload.canSwitchMode
      ? `The home folder is fixed by the command line to ${payload.liveHomeDir}.`
      : isLive
        ? `Artifact Atlas can read your home folder. Nothing about your files leaves ${where}, and files are only moved to Quarantine after you confirm.`
        : `You are looking at sample data. To see what the apps on ${where} left behind, allow Artifact Atlas to read your home folder.`;

  const list = document.getElementById('permissions-list');
  list.innerHTML = '';
  const sections = [
    { title: 'Access', kinds: ['IN_APP_CONSENT'] },
    { title: 'What a scan counts', kinds: ['SCAN_SCOPE'] },
    { title: 'macOS privacy settings', kinds: ['MACOS_PRIVACY'] }
  ];
  for (const section of sections) {
    // Permissions that do not exist on this system are left out
    const perms = payload.permissions.filter(
      (p) => section.kinds.includes(p.kind) && p.status !== 'NOT_APPLICABLE'
    );
    if (perms.length === 0) continue;
    const heading = document.createElement('div');
    heading.className = 'permissions-section-title';
    heading.textContent = section.title;
    list.appendChild(heading);
    for (const perm of perms) {
      list.appendChild(renderPermissionCard(perm, payload));
    }
  }

  const done = document.getElementById('done-permissions-modal-btn');
  if (pending) {
    done.textContent = 'Scan';
    done.disabled = !granted && payload.canSwitchMode;
    done.title = done.disabled ? 'Allow the home folder scan first' : '';
  } else {
    done.textContent = granted || !payload.canSwitchMode ? 'Done' : 'Use Sample Data';
    done.disabled = false;
    done.title = '';
  }
}

function renderPermissionCard(perm, payload) {
  const label =
    perm.kind === 'SCAN_SCOPE'
      ? perm.status === 'GRANTED' ? 'Included' : 'Left out'
      : PERMISSION_STATUS_LABELS[perm.status] || perm.status;
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
  if (perm.kind === 'SCAN_SCOPE') {
    actions.push(
      perm.status === 'GRANTED'
        ? '<button class="secondary-btn" data-action="scope-off" type="button">Leave Out</button>'
        : '<button class="secondary-btn" data-action="scope-on" type="button">Include</button>'
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
      } else if (action === 'scope-on' || action === 'scope-off') {
        await setScanScope(perm.id, action === 'scope-on');
      }
    });
  });
  return card;
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

function closePermissionsModal() {
  uiState.pendingScan = null;
  document.getElementById('permissions-modal').classList.add('hidden');
}

async function setHomeScanConsent(granted) {
  try {
    const payload = await apiRequest('/api/permissions/home-folder-scan', 'POST', { granted });
    // The data scope changed: reload the app list. A scan that is waiting for an answer stays
    // waiting; it starts from the Scan button.
    const pending = uiState.pendingScan;
    const sampleFolder = uiState.bootstrap?.defaultWorkspacePath || '';
    resetToEmptyWorkspace();
    await loadBootstrap();
    uiState.pendingScan = pending;
    if (pending) {
      uiState.pendingBundlePath = pending.bundlePath;
      // The sample project folder belongs to the sample data, not to a real scan
      if (sampleFolder && pending.workspacePath === sampleFolder) pending.workspacePath = '';
    }
    renderPermissionsModal(payload);
    if (!pending) {
      showToast(granted ? 'Ready. Choose an app to see what it left behind.' : 'Back to sample data.');
    }
  } catch (err) {
    showToast(`Could not change permission: ${err.message}`);
  }
}

async function setScanScope(id, granted) {
  try {
    const payload = await apiRequest('/api/permissions/scan-scope', 'POST', { id, granted });
    if (uiState.bootstrap) uiState.bootstrap.scanScope = payload.scanScope;
    renderPermissionsModal(payload);
    if (!uiState.pendingScan && uiState.activeState && !uiState.activeState.isDemoEnvironment) {
      showToast('Saved. Scan again to see the change.');
    }
  } catch (err) {
    showToast(`Could not change permission: ${err.message}`);
  }
}

/**
 * Every scan starts here. A scan of a real application first asks for the permissions it
 * needs: always while the home folder scan is not allowed, and once more the first time so
 * the user chooses what a scan counts. Sample apps are scanned without questions.
 */
async function requestScan({ bundlePath = null, workspacePath = null }) {
  const boot = uiState.bootstrap || {};
  const isSampleApp = (boot.availableBundles || []).some(
    (b) => b.isDemoFixture && b.bundlePath === bundlePath
  );
  const sampleScan = boot.mode !== 'live' && (isSampleApp || !bundlePath);
  if (sampleScan) {
    await executeScan({ bundlePath, workspacePath });
    return;
  }
  if (boot.mode !== 'live' && !boot.canSwitchMode) {
    showToast('This window only shows sample data.');
    return;
  }
  if (boot.mode !== 'live' || !boot.scanPermissionsReviewed) {
    uiState.pendingScan = {
      bundlePath,
      workspacePath,
      label: bundlePath ? appNameFromPath(bundlePath) : baseName(workspacePath) || 'this folder'
    };
    document.getElementById('app-picker-modal').classList.add('hidden');
    await openPermissionsModal();
    return;
  }
  await executeScan({ bundlePath, workspacePath });
}

/** The Scan button of the pre-scan questions. */
async function startPendingScan() {
  const pending = uiState.pendingScan;
  if (!pending) return;
  try {
    const payload = await apiRequest('/api/permissions/reviewed', 'POST', {});
    closePermissionsModal();
    if (uiState.bootstrap) {
      uiState.bootstrap.scanPermissionsReviewed = payload.scanPermissionsReviewed;
      uiState.bootstrap.mode = payload.mode;
    }
    await executeScan({ bundlePath: pending.bundlePath, workspacePath: pending.workspacePath });
  } catch (err) {
    showToast(`Could not start the scan: ${err.message}`);
  }
}

/* Text that names the system: the Mac wording is in the markup, Windows replaces it. */
function applyPlatformWording() {
  const win = isWindows();
  document.getElementById('live-env-badge').textContent = win ? 'Your PC' : 'Your Mac';
  document.getElementById('ctx-reveal-finder-btn').textContent = `Show in ${fileManagerName()}`;
  document.getElementById('dropzone-how').textContent = win
    ? 'Pick an app from the list below, or use Choose App to enter the path of a program, a shortcut or its folder.'
    : 'Drag an app from the Applications folder in Finder. Apps cannot be dragged out of the Dock; pick one from the list below instead.';
  document.getElementById('dropzone-headline').textContent = win
    ? 'Choose an app to see what it left behind.'
    : 'Drop an app to see what it left behind.';
  document.getElementById('custom-bundle-path-input').placeholder = win
    ? 'C:\\Users\\you\\AppData\\Local\\Programs\\cursor\\Cursor.exe'
    : '/Applications/Claude.app';
  document.getElementById('custom-workspace-path-input').placeholder = win
    ? 'C:\\Users\\you\\Projects\\my-project'
    : '/Users/you/Projects/my-project';
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
  const close = closePermissionsModal;
  document.getElementById('permissions-btn').addEventListener('click', () => {
    uiState.pendingScan = null;
    openPermissionsModal();
  });
  document.getElementById('close-permissions-modal-btn').addEventListener('click', close);
  document.getElementById('done-permissions-modal-btn').addEventListener('click', () => {
    if (uiState.pendingScan) startPendingScan();
    else close();
  });
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

// What a row says about where the app is: the sample, its install path, or the data folder
// that was found for a known app that is not installed
function bundleMeta(b) {
  if (b.isDemoFixture) return 'Sample';
  if (b.dataOnly) return `Data only: ${shortPath(b.evidencePath)}`;
  return b.bundlePath;
}

// Apps whose sessions and prompts are traced, by their known profile
const TRACED_PROFILES = new Set(['claude', 'codex', 'cursor']);

// The start screen keeps rows quiet: the name, and a tag only where it says something
function dockTag(b) {
  if (b.isDemoFixture) return '<span class="bundle-pill-meta">Sample</span>';
  if (TRACED_PROFILES.has(b.profileId)) return '<span class="bundle-pill-tag">Sessions and prompts</span>';
  return '';
}

function renderDraggableBundles(bundles) {
  const dockList = document.getElementById('draggable-bundles-list');
  const modalList = document.getElementById('modal-bundles-list');
  dockList.innerHTML = '';
  modalList.innerHTML = '';

  // With real applications the dock shows installed AI apps first and stays short; known
  // apps that are not installed but left data follow under their own caption. The full
  // list remains available in the picker.
  // The start screen lists only AI apps installed on this computer. Known apps that are not
  // installed but left data stay in the Choose App list, marked as such.
  const realScan = bundles.some((b) => !b.isDemoFixture);
  const dockBundles = realScan ? bundles.filter((b) => b.isKnownAIApp && !b.dataOnly).slice(0, 12) : bundles;
  if (bundles.length > 0 && dockBundles.length === 0) {
    dockList.innerHTML =
      '<div class="empty-note">No known AI apps are installed. Drop any app here, or use Choose App.</div>';
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
      ${dockTag(b)}
    `;
    fillAppIcon(pill.querySelector('.app-icon'), b.dataOnly ? null : b);

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
      <span class="bundle-pill-meta">${escapeHtml(bundleMeta(b))}</span>
    `;
    fillAppIcon(item.querySelector('.app-icon'), b.dataOnly ? null : b);
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

    if (droppedPath && !/[\\/]/.test(droppedPath)) {
      // A browser only reveals the file name. Match it against the listed applications.
      const wanted = droppedPath.trim().toLowerCase();
      const match = (uiState.bootstrap?.availableBundles || []).find(
        (b) => baseName(b.bundlePath).toLowerCase() === wanted
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
  try {
    uiState.pendingBundlePath = bundlePath;
    await requestScan({ bundlePath, workspacePath: uiState.pendingWorkspacePath });
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

/* Live map while scanning: the app in the middle, and a mark for every top-level folder the
   scan walks into. A mark appears when its folder is first read and grows as more of it is
   read. It is a picture of progress only; the real map is built when the scan finishes. */
const scanViz = {
  running: false,
  nodes: new Map(),
  appName: '',
  home: '',
  current: null,
  lastCount: 0,

  start(appName) {
    this.nodes = new Map();
    this.appName = appName;
    this.home = uiState.bootstrap?.homeDir || '';
    this.current = null;
    this.lastCount = 0;
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(() => this.frame());
  },

  stop() {
    this.running = false;
  },

  // The folder key: up to three path segments below the home folder
  keyFor(dirPath) {
    let rel = dirPath;
    if (this.home && (dirPath.startsWith(this.home + '/') || dirPath.startsWith(this.home + '\\'))) {
      rel = dirPath.slice(this.home.length + 1);
    }
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const depth = parts[0] === 'Library' || parts[0] === 'AppData' ? 3 : 2;
    return parts.slice(0, depth).join('/') || rel;
  },

  visit(dirPath, totalCount) {
    const key = this.keyFor(dirPath);
    let node = this.nodes.get(key);
    if (!node && this.nodes.size < 28) {
      const index = this.nodes.size;
      const angle = index * 2.399963; // golden angle spreads marks evenly as they arrive
      const ring = 150 + (index % 3) * 62;
      node = { key, label: key.split('/').slice(-2).join('/'), tx: Math.cos(angle) * ring, ty: Math.sin(angle) * ring * 0.72, born: performance.now(), files: 0 };
      this.nodes.set(key, node);
    }
    if (node) {
      node.files += Math.max(0, (totalCount || 0) - this.lastCount);
      this.current = key;
    }
    this.lastCount = totalCount || 0;
  },

  frame() {
    if (!this.running) return;
    const canvas = document.getElementById('scan-live-canvas');
    if (canvas && !document.getElementById('scanning-view').classList.contains('hidden')) {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }
      const ctx = canvas.getContext('2d');
      const colors = themeColors();
      const now = performance.now();
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);
      // The map sits above the progress card
      ctx.translate(rect.width / 2, rect.height * 0.36);
      const fit = Math.min(1, rect.width / 760, (rect.height * 0.62) / 420);
      ctx.scale(fit, fit);

      for (const node of this.nodes.values()) {
        const t = still ? 1 : Math.max(0, Math.min(1, (now - node.born) / 520));
        const eased = 1 - Math.pow(1 - t, 3);
        const x = node.tx * eased;
        const y = node.ty * eased;
        const active = node.key === this.current;
        const r = Math.max(11, Math.min(26, 9 + Math.log10(node.files + 10) * 4.2));

        ctx.globalAlpha = (active ? 0.9 : 0.3) * eased;
        ctx.strokeStyle = active ? colors.ink : colors.ink3;
        ctx.lineWidth = active ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(x, y);
        ctx.stroke();

        ctx.globalAlpha = eased;
        ctx.beginPath();
        ctx.roundRect(x - r, y - r, r * 2, r * 2, 6);
        ctx.fillStyle = colors.surface;
        ctx.fill();
        ctx.strokeStyle = active ? colors.ink : colors.ink3;
        ctx.lineWidth = active ? 1.8 : 1.2;
        ctx.stroke();
        if (Icons) Icons.draw(ctx, 'folder', x, y, r * 1.05, active ? colors.ink : colors.ink2);
        if (active && !still) {
          // A soft ring around the folder being read right now
          const pulse = (now % 1100) / 1100;
          ctx.globalAlpha = (1 - pulse) * 0.5;
          ctx.beginPath();
          ctx.roundRect(x - r - 4 - pulse * 8, y - r - 4 - pulse * 8, (r + 4 + pulse * 8) * 2, (r + 4 + pulse * 8) * 2, 9);
          ctx.strokeStyle = colors.ink;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = eased * (active ? 1 : 0.75);
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillStyle = active ? colors.ink : colors.ink2;
        ctx.textAlign = 'center';
        ctx.fillText(node.label.length > 26 ? '…' + node.label.slice(-25) : node.label, x, y + r + 14);
        if (node.files > 0) {
          ctx.font = '10px -apple-system, sans-serif';
          ctx.fillStyle = colors.ink3;
          ctx.fillText(`${node.files.toLocaleString()} files`, x, y + r + 26);
        }
      }

      // The application in the middle
      ctx.globalAlpha = 1;
      ctx.beginPath();
      if (uiState.appIconImage) {
        ctx.drawImage(uiState.appIconImage, -26, -26, 52, 52);
      } else {
        ctx.arc(0, 0, 24, 0, Math.PI * 2);
        ctx.fillStyle = colors.ink;
        ctx.fill();
        if (uiState.appLogoImage) ctx.drawImage(uiState.appLogoImage, -14, -14, 28, 28);
        else if (Icons) Icons.draw(ctx, Icons.forApp({ name: this.appName }), 0, 0, 26, colors.surface);
      }
      ctx.font = '600 12px -apple-system, sans-serif';
      ctx.fillStyle = colors.ink;
      ctx.textAlign = 'center';
      ctx.fillText(this.appName, 0, 44);
      ctx.restore();
    }
    requestAnimationFrame(() => this.frame());
  }
};

async function executeScan({ bundlePath, workspacePath }) {
  document.getElementById('app-picker-modal').classList.add('hidden');
  document.getElementById('empty-workspace-view').classList.add('hidden');
  document.getElementById('explorer-view').classList.add('hidden');
  document.getElementById('scanning-view').classList.remove('hidden');

  document.getElementById('scan-status-title').textContent = `Scanning ${
    bundlePath ? appNameFromPath(bundlePath) : 'folder'
  }…`;
  document.getElementById('scan-current-path').textContent = 'Preparing…';
  const scannedBundle = (uiState.bootstrap?.availableBundles || []).find((b) => b.bundlePath === bundlePath);
  loadGraphAppIcon(scannedBundle || (bundlePath ? { name: appNameFromPath(bundlePath), bundlePath } : null));
  scanViz.start(bundlePath ? appNameFromPath(bundlePath) : 'Folder');
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
            scanViz.visit(prog.currentPath, prog.discoveredArtifactCount);
          }
          document.getElementById('scan-metric-roots').textContent = String(prog.scannedLocationsCount);
          document.getElementById('scan-metric-count').textContent = String(
            (prog.discoveredArtifactCount || 0) + (prog.measuredFileCount || 0)
          );
          document.getElementById('scan-metric-bytes').textContent = formatBytes(
            (prog.totalPhysicalBytes || 0) + (prog.measuredPhysicalBytes || 0)
          );
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
    document.getElementById('scan-metric-count').textContent = String(
      res.state.scan.discoveredArtifactCount + (res.state.scan.measuredFileCount || 0)
    );
    document.getElementById('scan-metric-bytes').textContent =
      formatBytes(scanTotalBytes(res.state.scan));

    transitionToExplorerView();
  } catch (err) {
    document.getElementById('scanning-view').classList.add('hidden');
    document.getElementById('empty-workspace-view').classList.remove('hidden');
    showToast(`Scan failed: ${err.message}`);
  } finally {
    pollingProgress = false;
    scanViz.stop();
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
    `${pluralize(state.scan.discoveredArtifactCount, 'file')} · ${formatBytes(scanTotalBytes(state.scan))}`;

  renderScanNoticesBanner(state);
  uiState.sessionLabels = null;
  runScanSearch();
  loadMapLevel('root');
  renderGlobalInspectorSummary();
  renderTreemapView();
  renderQuarantineVaultView();
  updateContextualToolbar();
  updateQuarantineCountPill();
}

// A path with the home folder written as ~, for notices
function shortPath(filePath) {
  const home = uiState.bootstrap?.homeDir || '';
  const value = String(filePath || '');
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
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
    const folders = state.application.unreadableContainers;
    notices.push(
      `${folders.length === 1 ? `${shortPath(folders[0])} could not be read` : `${folders.length} folders could not be read (${folders.slice(0, 2).map(shortPath).join(', ')}${folders.length > 2 ? ', …' : ''})`}, so some files may be missing. ${isWindows() ? 'Check Permissions and scan again.' : 'Allow Full Disk Access under Permissions and scan again.'}`
    );
  }
  if (state.application && state.scan.discoveredArtifactCount === 0) {
    notices.push(`No data folders were found for ${state.application.name}.`);
  }
  if (state.scan.status === 'CANCELLED') {
    notices.push('You cancelled this scan. It shows only what was read before that; totals are partial. Scan again for the full picture.');
  }
  if (state.scan.truncated) {
    const over = state.scan.overflow || { fileCount: 0, physicalBytes: 0 };
    notices.push(
      over.fileCount > 0
        ? `The first ${state.scan.maxFilesLimit.toLocaleString()} files are listed. ${pluralize(over.fileCount, 'more file')} (${formatBytes(over.physicalBytes)}) were measured and are in the total, but are not on the map or offered for cleanup.`
        : `The scan stopped at ${state.scan.maxFilesLimit.toLocaleString()} files. Results and sizes are partial.`
    );
  }
  if (state.scan.bulkFolderCount > 0) {
    notices.push(
      `${pluralize(state.scan.bulkFolderCount, 'dependency or Git folder')} ${state.scan.bulkFolderCount === 1 ? 'was' : 'were'} measured as a whole (Dependencies & Git on the map). They are never cleaned up from here.`
    );
  }
  if (state.scan.skippedBulkDirectoryCount > 0) {
    notices.push(
      `${pluralize(state.scan.skippedBulkDirectoryCount, 'dependency or Git folder')} inside project folders ${state.scan.skippedBulkDirectoryCount === 1 ? 'was' : 'were'} left out (node_modules, .git and similar). They are never cleaned up from here.`
    );
  }
  if (state.scan.permissionLimitations.length > 0) {
    notices.push(
      `${pluralize(state.scan.permissionLimitations.length, 'item')} could not be read and ${state.scan.permissionLimitations.length === 1 ? 'was' : 'were'} skipped (first: ${shortPath(state.scan.permissionLimitations[0].path)}), so the total is smaller than what is on disk.`
    );
  }

  if (notices.length === 0) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.textContent = notices.join(' ');
    // Anything that could not be read can usually be fixed under Permissions
    const unreadable =
      (state.application?.unreadableContainers || []).length > 0 || state.scan.permissionLimitations.length > 0;
    if (unreadable && uiState.bootstrap?.canSwitchMode !== false) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn banner-action';
      btn.textContent = 'Open Permissions';
      btn.addEventListener('click', () => {
        uiState.pendingScan = null;
        openPermissionsModal();
      });
      banner.appendChild(btn);
    }
  }
}

/* =========================================================================
   INTERACTIVE KNOWLEDGE GRAPH ENGINE (Section 5)
   ========================================================================= */

/* Map levels: the map shows one level at a time. Clicking a kind, a session or a folder
   opens it; the breadcrumb and Escape go back up. */
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const anyDialogOpen = [...document.querySelectorAll('.modal-backdrop')].some((m) => !m.classList.contains('hidden'));
  if (typing || anyDialogOpen || uiState.activeTab !== 'graph' || !uiState.mapLevel?.parentId) return;
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault();
    loadMapLevel(uiState.mapLevel.parentId);
  }
});

async function loadMapLevel(levelId) {
  try {
    const res = await apiRequest('/api/map/level', 'POST', { levelId });
    showMapLevel(res.level);
  } catch (err) {
    if (levelId !== 'root') {
      // The level may have emptied (for example after a cleanup): fall back to the top
      await loadMapLevel('root');
    } else {
      showToast(`Could not load the map: ${err.message}`);
    }
  }
}

function reloadMapLevel() {
  return loadMapLevel(uiState.mapLevel?.id || 'root');
}

function showMapLevel(level) {
  uiState.mapLevel = level;
  uiState.selectedNodeId = null;
  uiState.activeTrace = null;
  uiState.hoveredNode = null;
  document.getElementById('graph-hover-tooltip')?.classList.add('hidden');
  loadGraphFromState(level);
  renderMapBreadcrumb();
  const center = uiState.nodes.find((n) => n.pinned);
  if (center && level.parentId) {
    renderNodeInspector(center, null);
  } else {
    document.getElementById('inspector-detail-content').classList.add('hidden');
    document.getElementById('inspector-empty-state').classList.remove('hidden');
  }
}

// Ways to split the scan at the top of the map (see GROUPINGS in src/graph/map-levels.js)
const MAP_GROUPINGS = [
  ['kind', 'Kind'],
  ['risk', 'Cleanup risk'],
  ['origin', 'Origin'],
  ['age', 'Last change'],
  ['type', 'File type']
];

function renderMapBreadcrumb() {
  const nav = document.getElementById('map-breadcrumb');
  const level = uiState.mapLevel;
  if (!nav || !level) return;
  const crumbs = level.breadcrumb
    .map((crumb, i) =>
      i === level.breadcrumb.length - 1
        ? `<span class="crumb current" aria-current="page">${escapeHtml(crumb.title)}</span>`
        : `<button class="crumb" type="button" data-level="${escapeHtml(crumb.id)}">${escapeHtml(crumb.title)}</button>`
    )
    .join('<span class="crumb-sep" aria-hidden="true">/</span>');
  nav.innerHTML = `
    ${level.parentId ? `<button class="crumb-up" type="button" data-level="${escapeHtml(level.parentId)}" title="Up one level (Esc)">←</button>` : ''}
    <div class="crumbs">${crumbs}</div>
    ${level.note ? `<span class="crumb-note">${escapeHtml(level.note)}</span>` : '<span class="crumb-note">Click a mark to open it.</span>'}
    <label class="map-group-by">
      <span>Group by</span>
      <select id="map-group-by" class="filter-select">
        ${MAP_GROUPINGS.map(([value, label]) => `<option value="${value}"${level.grouping === value ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
    </label>
  `;
  nav.querySelectorAll('[data-level]').forEach((btn) => {
    btn.addEventListener('click', () => loadMapLevel(btn.dataset.level));
  });
  nav.querySelector('#map-group-by').addEventListener('change', (e) => {
    loadMapLevel(e.target.value === 'kind' ? 'root' : `root:${e.target.value}`);
  });
}

function loadGraphFromState(graphData) {
  if (!graphData) return;
  uiState.nodes = graphData.nodes.map((n) => ({
    ...n,
    vx: 0,
    vy: 0
  }));
  uiState.edges = graphData.edges.map((e) => ({ ...e }));
  // A level arrives already laid out. Its marks grow out of the middle one, then rest.
  const origin = uiState.nodes.find((n) => n.pinned) || { x: 0, y: 0 };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const now = performance.now();
  uiState.nodes.forEach((n, i) => {
    n.toX = n.x;
    n.toY = n.y;
    n.enterStart = now + (n.pinned ? 0 : 60 + Math.min(i, 30) * 14);
    n.enter = reduceMotion || n.pinned ? 1 : 0;
    if (!reduceMotion && !n.pinned) {
      n.x = origin.x;
      n.y = origin.y;
    }
  });
  uiState.enterUntil = reduceMotion ? 0 : now + 60 + 30 * 14 + ENTER_MS;
  fitCameraToGraph();
  uiState.fitCameraAtTick = null;
  uiState.layoutSettlesAtTick = uiState.animTick;

  const canvas = document.getElementById('knowledge-graph-canvas');
  if (canvas) {
    resizeCanvas();
  }
}

// The application's own icon for its node on the map, when the bundle has a readable one.
function loadGraphAppIcon(app) {
  uiState.appIconImage = null;
  uiState.appLogoImage = null;
  if (!app) return;
  // A known logo, tinted to sit on the ink disc, in case the app's own icon cannot be read
  const logo = Icons.logoForApp(app);
  if (logo) {
    const logoImg = new Image();
    logoImg.addEventListener('load', () => {
      const tinted = document.createElement('canvas');
      tinted.width = 128;
      tinted.height = 128;
      const tctx = tinted.getContext('2d');
      tctx.drawImage(logoImg, 0, 0, 128, 128);
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = themeColors().surface;
      tctx.fillRect(0, 0, 128, 128);
      uiState.appLogoImage = tinted;
      uiState.lastDrawnSignature = null;
    });
    logoImg.src = `/logos/${logo}.svg`;
  }
  if (!app.bundlePath || app.isDemoFixture) return;
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
  // Focus keeps the files linked to the selected one. Marks that stand for many files (the
  // level's centre, kinds, folders, sessions) stay, so the level keeps its shape.
  if (uiState.focusMode && uiState.activeTrace && node.nodeType === 'ARTIFACT' && node.id !== uiState.selectedNodeId) {
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
    if (s !== uiState.draggingNode && !s.pinned) {
      s.vx += fx;
      s.vy += fy;
    }
    if (t !== uiState.draggingNode && !t.pinned) {
      t.vx -= fx;
      t.vy -= fy;
    }
  }

  // Apply velocity & damping
  for (const n of nodes) {
    if (n === uiState.draggingNode || n.pinned) {
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
    // Marks that are still animating in are measured where they will come to rest
    const x = n.toX ?? n.x;
    const y = n.toY ?? n.y;
    minX = Math.min(minX, x - n.radius - 60);
    maxX = Math.max(maxX, x + n.radius + 60);
    minY = Math.min(minY, y - n.radius - 40);
    maxY = Math.max(maxY, y + n.radius + 46);
  }
  const scale = Math.min(
    (rect.width - 96) / Math.max(1, maxX - minX),
    (rect.height - 120) / Math.max(1, maxY - minY),
    1.1
  );
  const fitted = Math.max(MIN_ZOOM, scale);
  uiState.camera = {
    scale: fitted,
    x: -((minX + maxX) / 2) * fitted,
    y: -((minY + maxY) / 2) * fitted - 10
  };
}

const ENTER_MS = 420;

// Moves entering marks from the middle to their place with an ease-out.
function stepEntrance() {
  const now = performance.now();
  for (const n of uiState.nodes) {
    if (n.enter >= 1 || n.toX === undefined) continue;
    const t = Math.max(0, Math.min(1, (now - n.enterStart) / ENTER_MS));
    const eased = 1 - Math.pow(1 - t, 3);
    const origin = uiState.nodes.find((m) => m.pinned) || { x: 0, y: 0 };
    n.enter = eased;
    n.x = origin.x + (n.toX - origin.x) * eased;
    n.y = origin.y + (n.toY - origin.y) * eased;
  }
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;

// Everything a drawn frame depends on, apart from node positions while the layout moves.
function mapSignature() {
  const cam = uiState.camera;
  const canvas = document.getElementById('knowledge-graph-canvas');
  return [
    uiState.nodes.length,
    uiState.mapLevel?.id,
    cam.x.toFixed(1),
    cam.y.toFixed(1),
    cam.scale.toFixed(4),
    uiState.hoveredNode?.id,
    uiState.selectedNodeId,
    uiState.selectedArtifactIds.size,
    uiState.activeTrace ? uiState.activeTrace.highlightedNodeIds?.length : -1,
    uiState.searchQuery,
    uiState.filterRisk,
    uiState.filterConfidence,
    uiState.filterNodeType,
    uiState.focusMode,
    canvas ? `${canvas.width}x${canvas.height}` : '',
    cachedThemeColors ? 1 : 0,
    uiState.appIconImage ? 1 : 0,
    uiState.appLogoImage ? 1 : 0
  ].join('|');
}

function renderGraphCanvas() {
  uiState.animTick += 1;
  if (uiState.fitCameraAtTick && uiState.animTick >= uiState.fitCameraAtTick && uiState.activeTab === 'graph') {
    uiState.fitCameraAtTick = null;
    fitCameraToGraph();
  }
  if (uiState.activeTab === 'graph' && uiState.nodes.length > 0) {
    // The layout runs until it has settled, then rests; dragging a mark wakes it up. A map
    // at rest is only redrawn when something it shows has changed.
    const entering = performance.now() < (uiState.enterUntil || 0);
    if (entering) {
      stepEntrance();
    }
    const moving = entering || uiState.draggingNode || uiState.animTick < uiState.layoutSettlesAtTick;
    if (!entering && (uiState.draggingNode || uiState.animTick < uiState.layoutSettlesAtTick)) {
      stepGraphPhysics();
    }
    const signature = mapSignature();
    if (moving || signature !== uiState.lastDrawnSignature) {
      uiState.lastDrawnSignature = signature;
      drawGraph();
    }
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
    ctx.globalAlpha =
      (isDimmed ? 0.1 : isHighlighted ? 1 : 0.4) * Math.min(source.enter ?? 1, target.enter ?? 1);
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
  const showFileLabels =
    uiState.camera.scale >= 0.95 || uiState.nodes.filter((n) => n.nodeType === 'ARTIFACT').length <= 14;
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
    ctx.globalAlpha = (isDimmed ? 0.15 : 1) * (node.enter ?? 1);

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
      } else if (isApp && uiState.appLogoImage) {
        const side = r * 1.15;
        ctx.drawImage(uiState.appLogoImage, node.x - side / 2, node.y - side / 2, side, side);
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
      const summary = !isFile ? node.metadata?.summary : null;
      // Kinds, sessions and folders carry a thin bar with their share of each risk level
      const barGap = summary ? 9 / uiState.camera.scale : 0;
      if (summary && summary.artifactCount > 0) {
        const px = 1 / uiState.camera.scale;
        const barWidth = Math.max(r * 2, 44 * px);
        const barHeight = 3 * px;
        let x = node.x - barWidth / 2;
        const y = node.y + r + 5 * px;
        for (const risk of ['LOW', 'REVIEW', 'HIGH', 'PROTECTED']) {
          const share = (summary.riskCounts?.[risk] || 0) / summary.artifactCount;
          if (share <= 0) continue;
          ctx.fillStyle = colors[risk];
          ctx.fillRect(x, y, Math.max(px, barWidth * share - px), barHeight);
          x += barWidth * share;
        }
      }
      ctx.fillStyle = isStructural || isSelected ? colors.ink : colors.ink2;
      ctx.fillText(node.label, node.x, node.y + r + 3 + labelPx + barGap);
      if (summary && (isStructural || isSelected)) {
        const metaPx = 10 / uiState.camera.scale;
        ctx.font = `${metaPx}px -apple-system, sans-serif`;
        ctx.fillStyle = colors.ink3;
        ctx.fillText(
          `${Number(summary.artifactCount).toLocaleString()} files · ${formatBytes(summary.bytes)}`,
          node.x,
          node.y + r + 5 + labelPx + metaPx + barGap
        );
      }
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
          hit.sizeBytes ? formatBytes(hit.sizeBytes) : null,
          hit.metadata?.session?.endedAt ? `last active ${formatDate(hit.metadata.session.endedAt)}` : null,
          hit.metadata?.cost ? `cost at least ${formatBytes(hit.metadata.cost.costBytes)}` : null
        ].filter(Boolean);
        const firstPrompt = hit.metadata?.firstPrompt;
        tooltip.innerHTML = `
          <div>${escapeHtml(hit.label)}</div>
          <div class="tooltip-meta">${escapeHtml(tooltipMeta.join(' · '))}</div>
          ${firstPrompt && firstPrompt !== hit.label ? `<div class="tooltip-prompt">${escapeHtml(firstPrompt)}</div>` : ''}
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
      if (hit && hit.drillId && !e.shiftKey && !e.metaKey) {
        await loadMapLevel(hit.drillId);
      } else if (hit) {
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
      uiState.fitCameraAtTick = null;
      // Proportional to the scroll distance, so trackpads and pinch zoom feel even, and
      // anchored on the pointer so the point under it stays put.
      const step = Math.max(-0.5, Math.min(0.5, -e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
      const cam = uiState.camera;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.scale * Math.exp(step)));
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width / 2;
      const sy = e.clientY - rect.top - rect.height / 2;
      const wx = (sx - cam.x) / cam.scale;
      const wy = (sy - cam.y) / cam.scale;
      cam.scale = next;
      cam.x = sx - wx * next;
      cam.y = sy - wy * next;
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

  // Marks that stand for many files (kinds, folders, measured folders) have no trace of
  // their own; their details are already on the mark
  if (node.metadata?.summary && node.nodeType !== 'ARTIFACT') {
    uiState.activeTrace = null;
    renderNodeInspector(node, null);
    updateContextualToolbar();
    return;
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
/* Everything the scan found: listed files plus folders and files that were measured as a
   whole (dependency and Git folders, and files past the file limit). */
function scanTotalBytes(scan) {
  return (scan?.totalPhysicalBytes || 0) + (scan?.measuredPhysicalBytes || 0);
}

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
    // The risk bar covers listed files; measured folders have no risk of their own
    totalBytes: uiState.activeState.scan?.totalPhysicalBytes || 0,
    allBytes: scanTotalBytes(uiState.activeState.scan),
    measuredFileCount: uiState.activeState.scan?.measuredFileCount || 0,
    risks: [
      { key: 'LOW', count: countByRisk.LOW, bytes: tm.reclaimablePhysicalBytes || 0 },
      { key: 'REVIEW', count: countByRisk.REVIEW, bytes: tm.reviewPhysicalBytes || 0 },
      { key: 'HIGH', count: countByRisk.HIGH, bytes: tm.highRiskPhysicalBytes || 0 },
      { key: 'PROTECTED', count: countByRisk.PROTECTED, bytes: tm.protectedOrUncertainPhysicalBytes ?? null }
    ],
    origins: [
      { key: 'VERIFIED', label: 'Recorded by a session', count: g.stats.verifiedArtifactCount },
      { key: 'INFERRED', label: 'Likely from this app', count: g.stats.inferredArtifactCount },
      ...(g.stats.unknownInProjectsCount > 0
        ? [
            { key: 'UNKNOWN', label: 'Unknown, in your project folders', count: g.stats.unknownInProjectsCount },
            { key: 'UNKNOWN', label: 'Unknown, elsewhere', count: g.stats.unknownArtifactCount - g.stats.unknownInProjectsCount }
          ].filter((o) => o.count > 0)
        : [{ key: 'UNKNOWN', label: 'Unknown origin', count: g.stats.unknownArtifactCount }])
    ],
    kinds: [...(tm.byGroup || [])].sort((x, y) => y.bytes - x.bytes),
    sessionCount: g.stats.sessionCount || 0,
    largest
  };
}

// How much of the listed files can be traced to a session, and so to the prompt that started it
function traceTotalsHtml(costs) {
  if (!costs || !costs.totals || (uiState.activeState?.graph?.stats?.sessionCount || 0) === 0) return '';
  const t = costs.totals;
  const row = (label, part) =>
    part.count > 0
      ? `<div class="kv-item"><span class="kv-key">${escapeHtml(label)}</span><span class="kv-val">${pluralize(part.count, 'file')} · ${formatBytes(part.bytes)}</span></div>`
      : '';
  return `
    <div class="inspector-section">
      <div class="inspector-section-title">Traced to a prompt</div>
      <div class="kv-list">
        ${row('From a session', t.traced)}
        ${row('The app as a whole', t.appWide)}
        ${row('Your project files', t.projects)}
      </div>
      <div class="inspector-note">Open Sessions on the map: each is named by the prompt that started it and shows what it cost. Caches, updates and plug-ins belong to the app as a whole, not to one prompt.</div>
    </div>`;
}

// Lines for what was measured but not listed, so the parts add up to the total
function measuredRows(scan) {
  const rows = [];
  const bulkBytes = (scan?.measuredPhysicalBytes || 0) - (scan?.overflow?.physicalBytes || 0);
  const bulkFiles = (scan?.measuredFileCount || 0) - (scan?.overflow?.fileCount || 0);
  if (scan?.bulkFolderCount > 0) {
    rows.push(`<div class="kv-item"><span class="kv-key">Dependency and Git folders, measured</span><span class="kv-val">${pluralize(bulkFiles, 'file')} · ${formatBytes(bulkBytes)}</span></div>`);
  }
  if (scan?.overflow?.fileCount > 0) {
    rows.push(`<div class="kv-item"><span class="kv-key">Past the file limit, measured</span><span class="kv-val">${pluralize(scan.overflow.fileCount, 'file')} · ${formatBytes(scan.overflow.physicalBytes)}</span></div>`);
  }
  return rows.join('');
}

// One sentence on what the scan counted inside project folders
function scopeNote(scan) {
  const scope = scan?.scope || {};
  const leftOut = (scope.projectFoldersLeftOut || []).length;
  if (scope.projectFolders) {
    return `Project folders are counted in full${
      scope.dependencyFolders ? ', with dependency and Git folders' : ', without dependency and Git folders'
    }.${leftOut > 0 ? ` ${pluralize(leftOut, 'folder')} too broad to walk (such as the home folder) ${leftOut === 1 ? 'was' : 'were'} left out.` : ''} They hold your own work.`;
  }
  return "Project folders are your own work. Only files a session's tool calls named are counted there, so this total is smaller than the folders themselves.";
}

function renderGlobalInspectorSummary() {
  const box = document.getElementById('inspector-global-stats');
  const sum = summarizeScan();
  if (!sum) return;
  const g = uiState.activeState.graph;

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
        <span class="scan-total-value">${formatBytes(sum.allBytes)}</span>
        <span class="scan-total-meta">${pluralize(sum.fileCount, 'file')}${sum.measuredFileCount > 0 ? ` listed, ${sum.measuredFileCount.toLocaleString()} measured` : ''} · ${pluralize(sum.sessionCount, 'session')}</span>
      </div>
      <div class="scan-share-bar" role="img" aria-label="Share of disk space by cleanup risk">
        <span class="dot-safe" style="width:${share(sum.risks[0].bytes)}%"></span>
        <span class="dot-review" style="width:${share(sum.risks[1].bytes)}%"></span>
        <span class="dot-high" style="width:${share(sum.risks[2].bytes)}%"></span>
      </div>
    </div>
    ${
      g.stats.scopeTotals
        ? `<div class="inspector-section">
      <div class="inspector-section-title">Where it is</div>
      <div class="kv-list">
        <div class="kv-item"><span class="kv-key">${escapeHtml(uiState.activeState.application?.name || 'App')}'s own folders</span><span class="kv-val">${pluralize(g.stats.scopeTotals.appData.count, 'file')} · ${formatBytes(g.stats.scopeTotals.appData.bytes)}</span></div>
        <div class="kv-item"><span class="kv-key">In project folders</span><span class="kv-val">${pluralize(g.stats.scopeTotals.projects.count, 'file')} · ${formatBytes(g.stats.scopeTotals.projects.bytes)}</span></div>
        ${measuredRows(uiState.activeState.scan)}
      </div>
      <div class="inspector-note">${escapeHtml(scopeNote(uiState.activeState.scan))} <button id="scope-open-permissions-btn" class="link-btn" type="button">Change under Permissions</button></div>
    </div>`
        : ''
    }
    ${traceTotalsHtml(uiState.activeState.promptCosts)}
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
  const scopeBtn = document.getElementById('scope-open-permissions-btn');
  if (scopeBtn) {
    scopeBtn.addEventListener('click', () => {
      uiState.pendingScan = null;
      openPermissionsModal();
    });
  }
}

const COST_PART_LABELS = {
  output: ['Its output', 'Files it wrote into your projects, and existing files it changed. The work it delivered; never offered as a leftover.'],
  scratch: ['Created elsewhere', 'Files a tool call of the session created outside your projects: screenshots, tests, temporary scripts.'],
  kept: ['Kept by the app for it', 'Files the application stores for the session: tool results, subagent files, todo lists, debug logs.'],
  record: ['Its own record', 'The conversation record. It links the prompt to every file here, so it is never offered with the leftovers.']
};

/* What one session (named by the prompt that started it) left behind, and what it cost
   beyond the work it delivered. These are lower bounds: files made by commands it ran,
   such as installs and builds, are not named in its record. */
function sessionCostHtml(meta) {
  const cost = meta.cost;
  if (!meta.session || !cost) return '';
  const rows = ['output', 'scratch', 'kept', 'record']
    .map((part) => {
      const p = cost.parts[part];
      const [label, hint] = COST_PART_LABELS[part];
      const value =
        part === 'output' && p.count === 0 && cost.recordedOperations === 0
          ? 'Not recorded'
          : `${pluralize(p.count, 'file')} · ${formatBytes(p.bytes)}`;
      return `<div class="kv-item" title="${escapeHtml(hint)}"><span class="kv-key">${escapeHtml(label)}</span><span class="kv-val">${value}</span></div>`;
    })
    .join('');
  const truncated = uiState.activeState?.scan?.truncated;
  const action = cost.possiblyRunning
    ? `<div class="inspector-note">This session changed in the last hour or has no date, so it may still be running. Its files are not offered for removal.</div>`
    : `<button id="select-session-leftovers-btn" class="secondary-btn" type="button">Select What It Left Behind</button>
       <div class="inspector-note">Selects files it created outside your projects and files the app keeps for this session only. Its record, your project files and files shared with other sessions stay. Every file is reviewed before it moves.</div>`;
  return `
    <div class="inspector-section">
      <div class="inspector-section-title">What this prompt cost</div>
      <div class="cost-headline">
        <span class="cost-value">${formatBytes(cost.costBytes)}</span>
        <span class="cost-meta">at least ${pluralize(cost.costCount, 'file')} beyond its output${cost.shared > 0 ? ` · ${cost.shared} shared with other sessions` : ''}</span>
      </div>
      <div class="kv-list">${rows}</div>
      <div class="inspector-note">At least: files made by commands it ran (installs, builds) are not named in its record.${truncated ? ' This scan reached the file limit, so files past it are not counted here.' : ''}</div>
      ${action}
    </div>`;
}

// What a kind is made of, by file type, largest first
function breakdownHtml(breakdown) {
  if (!breakdown || !Array.isArray(breakdown.types) || breakdown.types.length === 0) return '';
  const rows = breakdown.types
    .map(
      (t) => `<div class="kv-item"><span class="kv-key mono">${escapeHtml(t.type)}</span><span class="kv-val">${pluralize(t.count, 'file')} · ${formatBytes(t.bytes)}</span></div>`
    )
    .join('');
  return `
    <div class="inspector-section">
      <div class="inspector-section-title">Largest file types</div>
      <div class="kv-list">${rows}</div>
      ${breakdown.otherTypes > 0 ? `<div class="inspector-note">And ${pluralize(breakdown.otherTypes, 'other type')}. Open the kind on the map to see its folders.</div>` : ''}
    </div>`;
}

const PROMPT_UNAVAILABLE_REASONS = {
  NOT_RECORDED_FOR_THIS_APP: 'Prompts cannot be read from this app\'s session records.',
  NO_PROMPT_IN_TRANSCRIPT: 'No prompt was found at the start of this session\'s record.',
  TRANSCRIPT_NOT_FOUND: 'The session\'s record is no longer on disk.',
  TRANSCRIPT_NOT_READABLE: 'The session\'s record could not be read. See Permissions.'
};

/* The prompt that started the session(s) behind the selected item. It is read from the
   session's own record when the item is selected and is not kept by Artifact Atlas. */
async function loadNodePrompts(node) {
  const box = document.getElementById('inspector-prompt-section');
  if (!box) return;
  let res;
  try {
    res = await apiRequest('/api/node/prompt', 'POST', { nodeId: node.id });
  } catch {
    return;
  }
  // The selection may have changed while the request was running
  const current = document.getElementById('inspector-prompt-section');
  if (current !== box || uiState.inspectedNodeId !== node.id || !res.prompts || res.prompts.length === 0) {
    return;
  }
  const many = res.sessionCount > 1;
  const cards = res.prompts
    .map(
      (p) => `
      <div class="prompt-card">
        <div class="prompt-card-head">
          <strong>${escapeHtml(p.title || 'Session')}</strong>
          <span>${escapeHtml(formatDate(p.startedAt) || '')}</span>
        </div>
        ${
          p.available
            ? `<pre class="prompt-text">${escapeHtml(p.text)}${p.truncated ? '…' : ''}</pre>`
            : `<div class="row-detail">${escapeHtml(PROMPT_UNAVAILABLE_REASONS[p.reason] || 'Not available.')}</div>`
        }
      </div>`
    )
    .join('');
  box.innerHTML = `
    <div class="inspector-section">
      <div class="inspector-section-title">${many ? 'Starting prompts' : 'Starting prompt'}</div>
      ${cards}
      ${
        res.sessionCount > res.prompts.length
          ? `<div class="inspector-note">Showing the first ${res.prompts.length} of ${res.sessionCount} sessions linked to this item.</div>`
          : ''
      }
      <div class="inspector-note">Read from the session's own record just now. Artifact Atlas does not keep it.</div>
    </div>`;
}

function renderNodeInspector(node, trace) {
  uiState.inspectedNodeId = node.id;
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
          meta.summary
            ? `
          <div class="kv-item"><span class="kv-key">Files</span><span class="kv-val">${Number(meta.summary.artifactCount || 0).toLocaleString()}</span></div>
          <div class="kv-item"><span class="kv-key">Size</span><span class="kv-val">${formatBytes(meta.summary.bytes || 0)}</span></div>
          ${['LOW', 'REVIEW', 'HIGH', 'PROTECTED']
            .filter((risk) => meta.summary.riskCounts?.[risk] > 0)
            .map(
              (risk) =>
                `<div class="kv-item"><span class="kv-key"><span class="legend-dot ${RISK_DOT_CLASS[risk]}"></span> ${escapeHtml(RISK_LABELS[risk])}</span><span class="kv-val">${pluralize(meta.summary.riskCounts[risk], 'file')}</span></div>`
            )
            .join('')}
          ${meta.path && !meta.session ? `<div class="kv-item"><span class="kv-key">Path</span><span class="kv-val mono">${escapeHtml(meta.path)}</span></div>` : ''}
        `
            : ''
        }
      </div>
      ${
        meta.measuredOnly
          ? `<div class="inspector-note">${node.drillId ? 'Click it on the map to open it. ' : ''}Dependency and Git folders are measured as a whole: counted and sized, never listed file by file. They are never offered for cleanup; remove them with your package manager or Git.</div>`
          : meta.summary && node.nodeType !== 'AI_APPLICATION' && !meta.cost
          ? `<div class="inspector-note">${node.drillId ? 'Click it on the map to open it. ' : ''}Cleanup moves files one by one; protected files are never moved.</div>
             <button id="select-level-files-btn" class="secondary-btn" type="button">Select These ${pluralize(meta.summary.artifactCount, 'File')}</button>`
          : ''
      }
    </div>

    ${sessionCostHtml(meta)}
    <div id="inspector-prompt-section"></div>

    ${breakdownHtml(meta.breakdown)}
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

  loadNodePrompts(node);

  const leftoversBtn = document.getElementById('select-session-leftovers-btn');
  if (leftoversBtn) {
    leftoversBtn.addEventListener('click', async () => {
      try {
        const count = await selectByDescription({ kind: 'session-leftovers', sessionId: meta.session.id });
        showToast(
          count > 0
            ? `Selected ${pluralize(count, 'file')} this session left behind. Review ${count === 1 ? 'it' : 'them'} before moving.`
            : 'Nothing this session left behind can be offered for removal.'
        );
      } catch (err) {
        showToast(`Could not select files: ${err.message}`);
      }
    });
  }

  const folderBtn = document.getElementById('select-level-files-btn');
  if (folderBtn) {
    folderBtn.addEventListener('click', async () => {
      try {
        const count = await selectByDescription({
          kind: 'level',
          levelId: node.drillId || uiState.mapLevel?.id || 'root'
        });
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

/* Search and the risk and origin filters look through every file of the scan. The marks on
   the open level are dimmed as before; the matches are listed in the details panel. */
let scanSearchTimer = null;
function scheduleScanSearch() {
  clearTimeout(scanSearchTimer);
  scanSearchTimer = setTimeout(runScanSearch, 250);
}

function scanSearchActive() {
  return Boolean(uiState.searchQuery) || uiState.filterRisk !== 'ALL' || uiState.filterConfidence !== 'ALL';
}

async function runScanSearch() {
  const box = document.getElementById('search-results');
  if (!box) return;
  if (!scanSearchActive() || !uiState.activeState) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const description = { query: uiState.searchQuery, risk: uiState.filterRisk, origin: uiState.filterConfidence };
  let res;
  try {
    res = await apiRequest('/api/search', 'POST', description);
  } catch (err) {
    showToast(`Could not search: ${err.message}`);
    return;
  }
  // A newer search may have started meanwhile
  if (description.query !== uiState.searchQuery || description.risk !== uiState.filterRisk || description.origin !== uiState.filterConfidence) return;
  box.classList.remove('hidden');
  const rows = res.results
    .map(
      (n, i) => `
      <button type="button" class="search-row" data-index="${i}">
        <span class="legend-dot ${RISK_DOT_CLASS[n.riskCategory] || ''}"></span>
        <span class="search-row-name">${escapeHtml(n.label)}</span>
        <span class="search-row-size">${formatBytes(n.sizeBytes)}</span>
        <span class="search-row-path mono">${escapeHtml(shortPath(n.metadata.canonicalPath))}</span>
      </button>`
    )
    .join('');
  box.innerHTML = `
    <div class="inspector-section">
      <div class="search-head">
        <div class="inspector-section-title">${res.total === 0 ? 'No files match' : `${pluralize(res.total, 'file')} match · ${formatBytes(res.bytes)}`}</div>
        <button type="button" class="link-btn" id="search-clear-btn">Clear</button>
      </div>
      ${res.total > res.results.length ? `<div class="inspector-note">Showing the ${res.results.length} largest. Narrow the search or the filters to see others.</div>` : ''}
      <div class="search-list">${rows}</div>
      ${res.total > 0 ? `<button id="search-select-all-btn" class="secondary-btn" type="button">Select All ${pluralize(res.total, 'File')}</button>` : ''}
    </div>`;
  box.querySelectorAll('.search-row').forEach((row) => {
    row.addEventListener('click', () => selectNodeInGraph(res.results[Number(row.dataset.index)]));
  });
  document.getElementById('search-clear-btn').addEventListener('click', () => {
    uiState.searchQuery = '';
    uiState.filterRisk = 'ALL';
    uiState.filterConfidence = 'ALL';
    document.getElementById('graph-search-input').value = '';
    document.getElementById('filter-risk').value = 'ALL';
    document.getElementById('filter-confidence').value = 'ALL';
    runScanSearch();
  });
  const selectAll = document.getElementById('search-select-all-btn');
  if (selectAll) {
    selectAll.addEventListener('click', async () => {
      const count = await selectByDescription({ kind: 'search', ...description });
      showToast(`Selected ${pluralize(count, 'file')}. Every file is reviewed before it moves.`);
    });
  }
}

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
    scheduleScanSearch();
  });

  document.getElementById('filter-confidence').addEventListener('change', (e) => {
    uiState.filterConfidence = e.target.value;
    scheduleScanSearch();
  });

  document.getElementById('filter-risk').addEventListener('change', (e) => {
    uiState.filterRisk = e.target.value;
    scheduleScanSearch();
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

// Session names as the map shows them, for the Sizes tab
async function loadSessionLabels() {
  try {
    const res = await apiRequest('/api/map/level', 'POST', { levelId: 'sessions' });
    uiState.sessionLabels = new Map(
      res.level.nodes
        .filter((n) => n.metadata?.session?.id)
        .map((n) => [n.metadata.session.id, n.label])
    );
  } catch {
    uiState.sessionLabels = new Map();
  }
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
        <span class="metric-label">${uiState.activeState?.scan?.measuredPhysicalBytes > 0 ? `Listed files (plus ${formatBytes(uiState.activeState.scan.measuredPhysicalBytes)} measured)` : 'Total'}</span>
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

  // Sessions are named by their prompt, as on the map (labels come with the sessions level)
  const sessionLabels = uiState.treemapGroupBy === 'bySession' ? uiState.sessionLabels || null : null;
  if (uiState.treemapGroupBy === 'bySession' && !uiState.sessionLabels) {
    loadSessionLabels().then(() => {
      if (uiState.treemapGroupBy === 'bySession') renderTreemapView();
    });
  }

  cells.forEach((rawCell) => {
    const cell = sessionLabels && sessionLabels.has(rawCell.id) ? { ...rawCell, label: sessionLabels.get(rawCell.id) } : rawCell;
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
      const levelId =
        uiState.treemapGroupBy === 'byGroup'
          ? `group:${cell.id}`
          : uiState.treemapGroupBy === 'bySession' && !cell.id.startsWith('__')
            ? `session:${cell.id}`
            : uiState.treemapGroupBy === 'byFolder' && cell.path
              ? `dir:all::${cell.path}`
              : null;
      if (levelId) {
        await loadMapLevel(levelId);
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

// Which prompt a quarantined file came from, by the session names the map uses
function quarantineOriginHtml(entry) {
  const ids = entry.sessionIds || [];
  if (ids.length === 0) return '';
  if (!uiState.sessionLabels) {
    loadSessionLabels().then(() => renderQuarantineVaultView());
    return '';
  }
  const names = ids.map((id) => uiState.sessionLabels.get(id)).filter(Boolean);
  if (names.length === 0) return '';
  return `<div class="quarantine-row-origin">From ${names.length === 1 ? 'the session' : 'the sessions'} <strong>${names.map(escapeHtml).join('</strong>, <strong>')}</strong></div>`;
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
        ${quarantineOriginHtml(entry)}
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
        reloadMapLevel();
        renderGlobalInspectorSummary();
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
          ? `Show in ${fileManagerName()}: ${res.commandPreview}`
          : `Showing ${selectionSummary.firstName} in ${fileManagerName()}`
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
    await requestScan({
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
      reloadMapLevel();
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
      <div class="kv-item"><span class="kv-key">Showing</span><span class="kv-val">${isLive ? (isWindows() ? 'Your PC' : 'Your Mac') : 'Sample data'}</span></div>
      <div class="kv-item"><span class="kv-key">Home folder</span><span class="kv-val mono">${escapeHtml(boot.homeDir || '')}</span></div>
      <div class="kv-item"><span class="kv-key">Quarantine folder</span><span class="kv-val mono">${escapeHtml(boot.quarantineVaultLocation || '')}</span></div>
    </div>
    <p class="inspector-note">Nothing about you or your files leaves ${deviceName()}. Apps you choose are read, never opened. Removed files go to Quarantine and can be put back.</p>
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
      <p class="inspector-note">${
        isWindows()
          ? 'The check asks GitHub for the latest release number and sends nothing about you or your files. When a new version is out, the update button opens its download page. This is the only time the app uses the network.'
          : 'The check asks GitHub for the latest release number and sends nothing about you or your files. A new version is downloaded only when you click the update button; it is checked against its published SHA-256 before it replaces this copy. These are the only times the app uses the network.'
      }</p>
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

const UPDATE_BLOCKED_REASONS = {
  FOLDER_NOT_WRITABLE: 'This copy is in a folder you cannot change, and neither Applications folder can be written to',
  TRANSLOCATED: 'macOS is running this copy from a temporary location and no Applications folder can be written to',
  RUNNING_FROM_DISK_IMAGE: 'This copy runs from the disk image and no Applications folder can be written to',
  NOT_PACKAGED: 'This copy runs from source',
  NOT_MACOS: null
};

// Shows a button in the title bar when a newer version has been released.
function renderUpdatePill() {
  const pill = document.getElementById('update-available-btn');
  const update = uiState.update;
  if (!pill) return;
  if (update && update.enabled && update.updateAvailable) {
    const phase = update.install?.phase;
    const canInstall = Boolean(update.install?.ok);
    const where = update.install?.relocates ? ' in Applications' : '';
    pill.disabled = phase === 'downloading' || phase === 'verifying' || phase === 'restarting';
    pill.textContent =
      phase === 'downloading'
        ? update.install.total > 0
          ? `Downloading ${update.latestVersion}… ${Math.round((update.install.received / update.install.total) * 100)}%`
          : `Downloading ${update.latestVersion}…`
        : phase === 'verifying'
          ? 'Checking the download…'
          : phase === 'restarting'
            ? 'Restarting…'
            : phase === 'failed'
              ? 'Update failed. Open download page'
              : uiState.updateArmed
                ? `Install ${update.latestVersion}${where} and restart?`
                : `Update available: ${update.latestVersion}`;
    pill.title = canInstall
      ? `You have ${update.currentVersion}. Click to download, check and install the new version${where}.`
      : `You have ${update.currentVersion}. Open the download page.`;
    pill.classList.toggle('armed', Boolean(uiState.updateArmed));
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

// The update button: the first click asks, the second downloads, checks and installs, then
// the app restarts. A copy that cannot be replaced where it is goes into Applications. Only
// when nothing can be installed from here does the button open the download page, and it
// says why first.
async function installOrOpenUpdate() {
  const update = uiState.update;
  if (update?.install?.phase === 'failed') {
    openSystemTarget('update:latest');
    return;
  }
  if (!update?.install?.ok) {
    const why = UPDATE_BLOCKED_REASONS[update?.install?.reason];
    if (why) showToast(`${why}, so the update cannot be installed from here. Opening the download page.`, 12000);
    openSystemTarget('update:latest');
    return;
  }
  if (!uiState.updateArmed) {
    uiState.updateArmed = true;
    renderUpdatePill();
    setTimeout(() => {
      if (uiState.updateArmed) {
        uiState.updateArmed = false;
        renderUpdatePill();
      }
    }, 8000);
    return;
  }
  uiState.updateArmed = false;
  uiState.updateInstalling = true;
  uiState.update = { ...update, install: { ...update.install, phase: 'downloading' } };
  renderUpdatePill();
  const poll = setInterval(async () => {
    try {
      const res = await apiRequest('/api/update');
      if (uiState.updateInstalling && res.update.install?.phase && res.update.install.phase !== 'idle') {
        uiState.update = res.update;
        renderUpdatePill();
      }
    } catch {
      // The backend stops while the app restarts
    }
  }, 500);
  try {
    await apiRequest('/api/update/install', 'POST', {});
    uiState.update = { ...uiState.update, install: { ...update.install, phase: 'restarting' } };
    renderUpdatePill();
    showToast(`Installing ${update.latestVersion}. Artifact Atlas will reopen in a moment.`);
  } catch (err) {
    clearInterval(poll);
    uiState.updateInstalling = false;
    uiState.update = { ...update, install: { ...update.install, phase: 'failed' } };
    renderUpdatePill();
    // The reason stays on screen; the button now leads to the download page
    showToast(`The update could not be installed (${err.message}). Nothing was changed.`, 12000);
  }
}

async function checkForAppUpdate() {
  if (uiState.updateInstalling) return;
  uiState.updateCheckedAt = Date.now();
  try {
    const res = await apiRequest('/api/update');
    if (uiState.updateInstalling) return;
    const firstLook = !uiState.update;
    uiState.update = res.update;
    renderUpdatePill();
    // An update started before this launch did not finish: say so once
    if (firstLook && res.update.install?.lastFailure) {
      const failure = res.update.install.lastFailure;
      showToast(`Version ${failure.version} could not be installed: ${failure.detail}. This is still ${res.update.currentVersion}.`, 12000);
    }
  } catch {
    // Offline or blocked: stay quiet
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initApp();
  document.getElementById('update-available-btn').addEventListener('click', installOrOpenUpdate);
  checkForAppUpdate();
  // A window that stays open keeps looking, so a new version shows up without a restart.
  // The backend asks GitHub at most once every half hour however often it is asked.
  setInterval(checkForAppUpdate, 30 * 60 * 1000);
  const checkWhenBack = () => {
    if (!document.hidden && Date.now() - (uiState.updateCheckedAt || 0) > 10 * 60 * 1000) {
      checkForAppUpdate();
    }
  };
  document.addEventListener('visibilitychange', checkWhenBack);
  window.addEventListener('focus', checkWhenBack);
});
