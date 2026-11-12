// Interactive preview of the Artifact Atlas map for the project site.
// Everything here is built-in sample data. Nothing is read from the visitor's disk and
// nothing leaves the page.
(function () {
  'use strict';

  var root = document.getElementById('demo');
  var Icons = window.AtlasIcons;
  if (!root || !document.createElementNS || !Icons) return;
  var mac = document.getElementById('mac');
  var desktop = document.getElementById('mac-desktop');

  var SVG = 'http://www.w3.org/2000/svg';
  var RISK = {
    safe: 'Safe to remove',
    review: 'Review first',
    high: 'High risk',
    protected: 'Protected'
  };

  // kind: app | workspace | session | group | unknown | file
  var nodes = [
    { id: 'app', kind: 'app', label: 'Claude Code', x: 430, y: 300 },
    { id: 'ws', kind: 'workspace', label: 'neural-search-engine', x: 500, y: 96 },
    { id: 'sA', kind: 'session', label: 'Session Alpha', x: 596, y: 262 },
    { id: 'sB', kind: 'session', label: 'Session Beta', x: 318, y: 176 },
    { id: 'unk', kind: 'unknown', label: 'Unknown origin', x: 150, y: 96 },
    { id: 'gLogs', kind: 'group', type: 'LOG', label: 'Diagnostic Logs', x: 708, y: 238 },
    { id: 'gCache', kind: 'group', type: 'REGENERABLE_CACHE', label: 'Regenerable Caches', x: 372, y: 446 },
    { id: 'gTmp', kind: 'group', type: 'TEMP_FILE', label: 'Temporary Files', x: 612, y: 404 },
    { id: 'gHist', kind: 'group', type: 'SESSION_HISTORY', label: 'Session Histories', x: 232, y: 366 },
    { id: 'gBuild', kind: 'group', type: 'BUILD_OUTPUT', label: 'Build Outputs', x: 176, y: 250 },
    { id: 'gSrc', kind: 'group', type: 'USER_CONTENT', label: 'Source & User Content', x: 690, y: 110 },

    { id: 'f1', kind: 'file', label: 'mcp-transport-sess_alpha_01.log', x: 806, y: 300, size: 14848, risk: 'safe',
      group: 'gLogs', sessions: [['sA', 'likely']],
      why: 'A log inside the tool’s own log folder, used by one session.' },
    { id: 'f2', kind: 'file', label: 'embeddings-cache.bin', x: 290, y: 520, size: 98509, risk: 'safe',
      group: 'gCache', sessions: [['sB', 'recorded']],
      why: 'A cache inside the tool’s own cache folder. It is rebuilt on the next run.' },
    { id: 'f3', kind: 'file', label: 'tokenizer-cache.json', x: 452, y: 528, size: 18842, risk: 'safe',
      group: 'gCache', sessions: [['sA', 'recorded']],
      why: 'A cache inside the tool’s own cache folder. It is rebuilt on the next run.' },
    { id: 'f4', kind: 'file', label: 'scratch-plan.tmp', x: 716, y: 468, size: 2150, risk: 'safe',
      group: 'gTmp', sessions: [['sA', 'recorded']],
      why: 'A temporary file inside the tool’s own scratch folder, used by one session.' },
    { id: 'f5', kind: 'file', label: 'patch-preview.diff', x: 574, y: 500, size: 6451, risk: 'review',
      group: 'gTmp', sessions: [['sA', 'recorded'], ['sB', 'recorded']],
      why: 'Temporary, but two sessions wrote to it. Shared files are never marked safe.' },
    { id: 'f6', kind: 'file', label: 'index.bundle.js', x: 64, y: 316, size: 49152, risk: 'review',
      group: 'gBuild', sessions: [['sB', 'recorded']],
      why: 'A build output inside the workspace. Usually regenerable, but check for manual edits.' },
    { id: 'f7', kind: 'file', label: 'sess_alpha_01.jsonl', x: 124, y: 440, size: 32461, risk: 'high',
      group: 'gHist', sessions: [['sA', 'recorded']],
      why: 'A session transcript. Removing it erases the record of what the session did.' },
    { id: 'f8', kind: 'file', label: 'sess_beta_02.jsonl', x: 262, y: 462, size: 23450, risk: 'high',
      group: 'gHist', sessions: [['sB', 'recorded']],
      why: 'A session transcript. Removing it erases the record of what the session did.' },
    { id: 'f9', kind: 'file', label: 'vector_index.rs', x: 808, y: 76, size: 10035, risk: 'protected',
      group: 'gSrc', sessions: [['sA', 'recorded']],
      why: 'Source code inside a Git repository. Protected files cannot be moved to quarantine.' },
    { id: 'f10', kind: 'file', label: 'notes-export.md', x: 56, y: 150, size: 4096, risk: 'review',
      group: null, sessions: [],
      why: 'No session record names this file. Unknown origin is never marked safe.' },
    { id: 'f11', kind: 'file', label: 'old-run.log', x: 214, y: 34, size: 8602, risk: 'review',
      group: null, sessions: [],
      why: 'A log outside a dedicated log folder, with no session record. The extension alone decides nothing.' }
  ];

  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  // A file has the artifact type of its group. The two files of unknown origin are typed here.
  var LOOSE_TYPES = { f10: 'UNKNOWN', f11: 'LOG' };
  nodes.forEach(function (n) {
    if (n.kind === 'file') n.type = n.group ? byId[n.group].type : LOOSE_TYPES[n.id];
  });

  // Sample apps the opening screen offers, as in the real app.
  var KIND_LABELS = {
    REGENERABLE_CACHE: 'Regenerable caches', TEMP_FILE: 'Temporary files', LOG: 'Logs',
    BUILD_OUTPUT: 'Build outputs', SESSION_HISTORY: 'Session histories',
    USER_CONTENT: 'Source and user content', UNKNOWN: 'Unclassified'
  };
  var SAMPLE_APPS = [['Claude Code', 'terminal'], ['Cursor', 'pointer'], ['Codex CLI', 'braces'], ['NebulaSketch', 'app']];

  function iconOf(n) {
    if (n.kind === 'app') return Icons.forApp({ name: n.label });
    if (n.kind === 'workspace') return 'folder';
    if (n.kind === 'session') return 'session';
    if (n.kind === 'unknown') return 'unknown';
    return Icons.forArtifactType(n.type);
  }

  function iconEl(name, size) {
    var span = document.createElement('span');
    span.className = 'demo-icon';
    span.innerHTML = Icons.svg(name, size || 14);
    return span;
  }

  // An application tile: a glyph on an ink square, like the app's own fallback icon.
  function appTileEl(icon, size) {
    var t = document.createElement('span');
    t.className = 'demo-appicon';
    t.innerHTML = Icons.svg(icon, size || 15);
    return t;
  }
  var files = nodes.filter(function (n) { return n.kind === 'file'; });

  // Edges: [from, to, strength]
  var edges = [
    ['app', 'ws', 'recorded'],
    ['ws', 'sA', 'recorded'],
    ['ws', 'sB', 'recorded'],
    ['app', 'sA', 'recorded'],
    ['app', 'sB', 'recorded']
  ];
  nodes.forEach(function (n) {
    if (n.kind === 'group') edges.push(['app', n.id, 'recorded']);
  });
  files.forEach(function (f) {
    if (f.group) edges.push([f.group, f.id, 'recorded']);
    f.sessions.forEach(function (s) { edges.push([s[0], f.id, s[1]]); });
    if (!f.sessions.length) edges.push(['unk', f.id, 'unknown']);
  });

  var state = { selected: 'f1', view: 'map', quarantined: [], armed: null };

  function el(name, attrs, text) {
    var node = document.createElementNS(SVG, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }

  function html(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }

  function isQuarantined(id) {
    return state.quarantined.indexOf(id) !== -1;
  }

  function filesOf(node) {
    return files.filter(function (f) {
      if (isQuarantined(f.id)) return false;
      if (node.kind === 'app' || node.kind === 'workspace') return f.sessions.length > 0;
      if (node.kind === 'group') return f.group === node.id;
      if (node.kind === 'session') return f.sessions.some(function (s) { return s[0] === node.id; });
      if (node.kind === 'unknown') return !f.sessions.length;
      return false;
    });
  }

  // The set of node ids that stay lit for the current selection.
  function litSet() {
    var lit = {};
    var sel = byId[state.selected];
    if (!sel) return null;
    lit[sel.id] = true;
    if (sel.kind === 'file') {
      if (sel.group) { lit[sel.group] = true; lit.app = true; }
      sel.sessions.forEach(function (s) { lit[s[0]] = true; lit.ws = true; lit.app = true; });
      if (!sel.sessions.length) lit.unk = true;
    } else {
      filesOf(sel).forEach(function (f) { lit[f.id] = true; });
      if (sel.kind === 'session') { lit.ws = true; lit.app = true; }
      if (sel.kind === 'group' || sel.kind === 'workspace') lit.app = true;
    }
    return lit;
  }

  // ---------- Skeleton ----------

  root.textContent = '';
  var bar = html('div', 'demo-bar');
  var appName = html('div', 'demo-app');
  appName.appendChild(appTileEl('terminal', 15));
  appName.appendChild(html('strong', null, 'Claude Code'));
  var totals = html('span', 'demo-muted');
  appName.appendChild(totals);
  bar.appendChild(appName);

  var tabs = html('div', 'demo-tabs');
  tabs.setAttribute('role', 'tablist');
  var tabMap = html('button', null, 'Map');
  var tabQuarantine = html('button');
  [tabMap, tabQuarantine].forEach(function (b) { b.type = 'button'; b.setAttribute('role', 'tab'); tabs.appendChild(b); });
  tabMap.id = 'demo-tab-map';
  tabQuarantine.id = 'demo-tab-quarantine';
  bar.appendChild(tabs);
  bar.appendChild(html('span', 'demo-badge', 'Sample data'));
  var replay = html('button', 'demo-replay', 'Replay');
  replay.type = 'button';
  replay.id = 'demo-replay';
  bar.appendChild(replay);
  root.appendChild(bar);

  // The walkthrough is a real sequence, so its steps are numbered.
  var STEPS = ['Drop an app', 'Scan', 'See the totals', 'Trace a file', 'Quarantine', 'Restore'];
  var stepper = html('ol', 'demo-steps');
  var stepEls = STEPS.map(function (label) {
    var li = html('li', null, label);
    stepper.appendChild(li);
    return li;
  });
  root.appendChild(stepper);

  var body = html('div', 'demo-body');
  var stage = html('div', 'demo-stage');
  var scroller = html('div', 'demo-scroll');
  var svg = el('svg', { viewBox: '0 0 880 560', role: 'group', 'aria-label': 'Provenance map of sample files' });
  var edgeLayer = el('g', {});
  var nodeLayer = el('g', {});
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);
  scroller.appendChild(svg);
  stage.appendChild(scroller);
  var list = html('div', 'demo-list');
  stage.appendChild(list);
  var action = html('div', 'demo-action');
  stage.appendChild(action);
  body.appendChild(stage);
  var panel = html('aside', 'demo-panel');
  panel.setAttribute('aria-live', 'polite');
  body.appendChild(panel);

  // Opening screens of the app, shown only while the walkthrough plays.
  var intro = html('div', 'demo-intro');
  intro.hidden = true;
  intro.setAttribute('aria-hidden', 'true');

  var dropView = html('div', 'demo-drop');
  var dropzone = html('div', 'demo-dropzone');
  dropzone.appendChild(html('strong', 'demo-drop-title', 'Drop an app to see what it left behind.'));
  dropzone.appendChild(html('span', 'demo-muted', 'Apps are read, never run.'));
  var fakeButtons = html('div', 'demo-drop-buttons');
  fakeButtons.appendChild(html('span', 'demo-btn', 'Choose App\u2026'));
  fakeButtons.appendChild(html('span', 'demo-btn ghost', 'Scan a project folder'));
  dropzone.appendChild(fakeButtons);
  dropView.appendChild(dropzone);
  var sampleList = html('div', 'demo-samples');
  SAMPLE_APPS.forEach(function (app) {
    var row = html('div', 'demo-sample');
    row.appendChild(appTileEl(app[1], 13));
    row.appendChild(html('span', null, app[0]));
    sampleList.appendChild(row);
  });
  dropzone.appendChild(sampleList);

  // The Mac around the window: a Finder window to drag from, the Dock, and the dragged icon.
  var finderSource = null;
  var tile = html('div', 'demo-tile');
  tile.hidden = true;
  tile.setAttribute('aria-hidden', 'true');
  tile.appendChild(appTileEl('terminal', 24));
  tile.appendChild(html('span', 'demo-tile-name', 'Claude Code'));
  var cursor = el('svg', { viewBox: '0 0 16 20', 'class': 'demo-cursor' });
  cursor.appendChild(el('path', { d: 'M1 1v15l4-3.6 2.7 6 2.4-1.1-2.7-5.9H13z' }));
  tile.appendChild(cursor);

  if (desktop) {
    var finder = html('div', 'finder');
    finder.setAttribute('aria-hidden', 'true');
    var finderBar = html('div', 'window-bar');
    finderBar.innerHTML = '<i></i><i></i><i></i><span>Applications</span>';
    finder.appendChild(finderBar);
    var finderGrid = html('div', 'finder-grid');
    SAMPLE_APPS.forEach(function (app, i) {
      var item = html('div', 'finder-item');
      var icon = appTileEl(app[1], 22);
      item.appendChild(icon);
      item.appendChild(html('span', null, app[0]));
      finderGrid.appendChild(item);
      if (i === 0) finderSource = icon;
    });
    finder.appendChild(finderGrid);
    desktop.appendChild(finder);
    desktop.appendChild(tile);

    var dock = document.getElementById('mac-dock');
    if (dock) {
      [['folder', ''], ['terminal', ''], ['pointer', ''], ['braces', ''], ['atlas', 'running']].forEach(function (d) {
        var slot = html('span', 'dock-item ' + d[1]);
        slot.appendChild(appTileEl(d[0], 20));
        dock.appendChild(slot);
      });
    }
    var clock = document.getElementById('mac-clock');
    if (clock) {
      try {
        var now = new Date();
        clock.textContent = now.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' +
          now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      } catch (err) { /* keep the static text */ }
    }
  }
  intro.appendChild(dropView);

  var scanView = html('div', 'demo-scan');
  var scanTitle = html('strong', 'demo-scan-title');
  scanTitle.appendChild(appTileEl('terminal', 15));
  scanTitle.appendChild(document.createTextNode('Scanning Claude Code\u2026'));
  scanView.appendChild(scanTitle);
  scanView.appendChild(html('span', 'demo-muted', 'Reading folder'));
  var scanPath = html('code', 'demo-scan-path', 'Preparing\u2026');
  scanView.appendChild(scanPath);
  var scanTrack = html('div', 'demo-scan-track');
  var scanFill = html('i');
  scanTrack.appendChild(scanFill);
  scanView.appendChild(scanTrack);
  var scanMetrics = html('span', 'demo-muted demo-scan-metrics', '0 folders \u00b7 0 files \u00b7 0 B');
  scanView.appendChild(scanMetrics);
  intro.appendChild(scanView);

  body.appendChild(intro);
  root.appendChild(body);

  // ---------- Map ----------

  var edgeEls = edges.map(function (e) {
    var a = byId[e[0]];
    var b = byId[e[1]];
    var line = el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'class': 'demo-edge ' + e[2] });
    edgeLayer.appendChild(line);
    return { from: e[0], to: e[1], line: line };
  });

  var nodeEls = {};
  nodes.forEach(function (n) {
    var g = el('g', { 'class': 'demo-node ' + n.kind + (n.risk ? ' ' + n.risk : ''), tabindex: '0', role: 'button' });
    g.setAttribute('aria-label', n.label + (n.risk ? ', ' + RISK[n.risk] : ''));
    var shape;
    var glyphSize;
    if (n.kind === 'app') { shape = el('circle', { cx: n.x, cy: n.y, r: 15 }); glyphSize = 17; }
    else if (n.kind === 'session') { shape = el('circle', { cx: n.x, cy: n.y, r: 10.5 }); glyphSize = 12.5; }
    else if (n.kind === 'unknown') { shape = el('circle', { cx: n.x, cy: n.y, r: 11 }); glyphSize = 13; }
    else if (n.kind === 'file') { shape = el('circle', { cx: n.x, cy: n.y, r: 9.5 }); glyphSize = 11.5; }
    else { shape = el('rect', { x: n.x - 11, y: n.y - 11, width: 22, height: 22, rx: n.kind === 'group' ? 6 : 3 }); glyphSize = 14; }
    g.appendChild(el('circle', { cx: n.x, cy: n.y, r: 21, 'class': 'demo-hit' }));
    g.appendChild(shape);
    var glyph = el('g', {
      'class': 'demo-glyph',
      transform: 'translate(' + (n.x - glyphSize / 2) + ' ' + (n.y - glyphSize / 2) + ') scale(' + (glyphSize / 24) + ')'
    });
    Icons.paths[iconOf(n)].forEach(function (d) { glyph.appendChild(el('path', { d: d })); });
    g.appendChild(glyph);
    var anchor = n.x > 700 ? 'end' : n.x < 130 ? 'start' : 'middle';
    var tx = anchor === 'end' ? n.x + 12 : anchor === 'start' ? n.x - 12 : n.x;
    g.appendChild(el('text', { x: tx, y: n.y + (n.kind === 'app' ? 33 : 29), 'text-anchor': anchor }, n.label));
    g.addEventListener('click', function () { select(n.id); });
    g.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); }
    });
    nodeLayer.appendChild(g);
    nodeEls[n.id] = g;
  });

  function select(id) {
    state.selected = id;
    state.armed = null;
    render();
  }

  // ---------- Panel ----------

  function evidenceRow(title, strength, text) {
    var row = html('div', 'demo-evidence');
    var head = html('div', 'demo-evidence-head');
    head.appendChild(html('strong', null, title));
    head.appendChild(html('span', 'demo-strength ' + strength,
      strength === 'recorded' ? 'Recorded' : strength === 'likely' ? 'Likely' : 'Unknown'));
    row.appendChild(head);
    row.appendChild(html('p', null, text));
    return row;
  }

  function riskLine(risk) {
    var line = html('div', 'demo-risk');
    line.appendChild(html('i', 'dot ' + risk));
    line.appendChild(html('span', null, RISK[risk]));
    return line;
  }

  // Totals for the scan, shown while nothing is selected.
  function statRow(lead, label, value) {
    var row = html('div', 'demo-stat');
    row.appendChild(lead);
    row.appendChild(html('span', 'demo-stat-label', label));
    row.appendChild(html('span', 'demo-muted', value));
    return row;
  }

  function countAndSize(list) {
    var bytes = list.reduce(function (sum, f) { return sum + f.size; }, 0);
    return list.length + (list.length === 1 ? ' file' : ' files') + ' \u00b7 ' + formatBytes(bytes);
  }

  function renderStats() {
    var live = files.filter(function (f) { return !isQuarantined(f.id); });
    var total = live.reduce(function (sum, f) { return sum + f.size; }, 0);
    panel.appendChild(html('div', 'demo-kind', 'This scan'));
    var head = html('div', 'demo-total');
    head.appendChild(html('strong', null, formatBytes(total)));
    head.appendChild(html('span', 'demo-muted', live.length + ' files \u00b7 2 sessions'));
    panel.appendChild(head);

    var bar = html('div', 'demo-share');
    ['safe', 'review', 'high'].forEach(function (risk) {
      var bytes = live.filter(function (f) { return f.risk === risk; })
        .reduce(function (sum, f) { return sum + f.size; }, 0);
      var seg = html('i', 'dot ' + risk);
      seg.style.width = (total ? (bytes / total) * 100 : 0) + '%';
      bar.appendChild(seg);
    });
    panel.appendChild(bar);

    panel.appendChild(html('h4', 'demo-sub', 'By cleanup risk'));
    ['safe', 'review', 'high', 'protected'].forEach(function (risk) {
      var list = live.filter(function (f) { return f.risk === risk; });
      panel.appendChild(statRow(html('i', 'dot ' + risk), RISK[risk], countAndSize(list)));
    });

    panel.appendChild(html('h4', 'demo-sub', 'By origin'));
    [['recorded', 'Recorded by a session'], ['likely', 'Likely from this app'], ['unknown', 'Unknown origin']].forEach(function (o) {
      var list = live.filter(function (f) {
        if (!f.sessions.length) return o[0] === 'unknown';
        var recorded = f.sessions.some(function (x) { return x[1] === 'recorded'; });
        return o[0] === (recorded ? 'recorded' : 'likely');
      });
      panel.appendChild(statRow(html('i', 'demo-line ' + o[0]), o[1], list.length + (list.length === 1 ? ' file' : ' files')));
    });

    panel.appendChild(html('h4', 'demo-sub', 'By kind'));
    var kinds = {};
    live.forEach(function (f) { (kinds[f.type] = kinds[f.type] || []).push(f); });
    Object.keys(kinds).sort(function (a, b) {
      var size = function (k) { return kinds[k].reduce(function (sum, f) { return sum + f.size; }, 0); };
      return size(b) - size(a);
    }).forEach(function (type) {
      panel.appendChild(statRow(iconEl(Icons.forArtifactType(type), 14), KIND_LABELS[type], countAndSize(kinds[type])));
    });
  }

  function renderPanel() {
    panel.textContent = '';
    var sel = byId[state.selected];
    if (!sel) {
      renderStats();
      return;
    }
    var kindLabel = { app: 'Application', workspace: 'Workspace', session: 'Session', group: 'Group', unknown: 'Origin', file: 'File' };
    var kind = html('div', 'demo-kind');
    kind.appendChild(iconEl(iconOf(sel), 14));
    kind.appendChild(document.createTextNode(kindLabel[sel.kind]));
    panel.appendChild(kind);
    panel.appendChild(html('h3', 'demo-title', sel.label));

    if (sel.kind !== 'file') {
      var own = filesOf(sel);
      var bytes = own.reduce(function (sum, f) { return sum + f.size; }, 0);
      panel.appendChild(html('p', 'demo-muted', own.length + (own.length === 1 ? ' file' : ' files') + ' · ' + formatBytes(bytes)));
      var hint = sel.kind === 'unknown'
        ? 'Files that no session record names are attached here. They are never linked to a session by timestamp.'
        : 'The highlighted files are linked to this ' + kindLabel[sel.kind].toLowerCase() + '. Select one to see the evidence.';
      panel.appendChild(html('p', 'demo-note', hint));
      return;
    }

    var meta = html('div', 'demo-meta');
    meta.appendChild(riskLine(sel.risk));
    meta.appendChild(html('span', 'demo-muted', formatBytes(sel.size)));
    panel.appendChild(meta);
    panel.appendChild(html('p', 'demo-note', sel.why));

    panel.appendChild(html('h4', 'demo-sub', 'Where it came from'));
    if (sel.group) {
      panel.appendChild(evidenceRow('In ' + byId[sel.group].label, 'recorded',
        'The file sits in a folder that belongs to Claude Code.'));
    }
    sel.sessions.forEach(function (s) {
      var name = byId[s[0]].label;
      if (s[1] === 'recorded') {
        panel.appendChild(evidenceRow('Written by ' + name, 'recorded',
          'The session’s tool ledger has a write call that targets this exact path.'));
      } else {
        panel.appendChild(evidenceRow('Generated during ' + name, 'likely',
          'The path contains the session identifier, but no tool call names the file.'));
      }
    });
    if (!sel.sessions.length) {
      panel.appendChild(evidenceRow('No session found', 'unknown',
        'No ledger entry or workspace mapping names this file. A matching timestamp is not treated as evidence.'));
    }
  }

  // ---------- Action bar ----------

  function renderAction() {
    action.textContent = '';
    var sel = byId[state.selected];
    if (state.view !== 'map' || !sel || sel.kind !== 'file') {
      action.hidden = true;
      return;
    }
    action.hidden = false;
    var info = html('div', 'demo-action-info');
    info.appendChild(html('strong', null, '1 file selected'));
    info.appendChild(html('span', 'demo-muted', formatBytes(sel.size)));
    action.appendChild(info);

    var button = html('button', 'demo-btn');
    button.type = 'button';
    button.id = 'demo-quarantine-button';
    if (sel.risk === 'protected') {
      button.textContent = 'Protected, cannot be moved';
      button.disabled = true;
    } else if ((sel.risk === 'high' || !sel.sessions.length) && state.armed !== sel.id) {
      button.textContent = 'Move to Quarantine…';
      button.addEventListener('click', function () { state.armed = sel.id; renderAction(); });
    } else if (state.armed === sel.id) {
      button.textContent = sel.risk === 'high' ? 'Confirm: move high-risk file' : 'Confirm: origin is unknown';
      button.classList.add('confirm');
      button.addEventListener('click', function () { quarantine(sel.id); });
    } else {
      button.textContent = 'Move to Quarantine';
      button.addEventListener('click', function () { quarantine(sel.id); });
    }
    action.appendChild(button);
    if (state.armed === sel.id && !tour.running) button.focus();
  }

  function quarantine(id) {
    state.quarantined.push(id);
    state.selected = null;
    state.armed = null;
    state.view = 'quarantine';
    render();
    if (!tour.running) tabQuarantine.focus();
  }

  function restore(id) {
    state.quarantined = state.quarantined.filter(function (q) { return q !== id; });
    state.selected = id;
    state.view = 'map';
    render();
  }

  // ---------- Quarantine list ----------

  function renderList() {
    list.textContent = '';
    if (!state.quarantined.length) {
      list.appendChild(html('p', 'demo-empty', 'Quarantine is empty. Select a file on the map and move it here. Nothing is deleted.'));
      return;
    }
    state.quarantined.forEach(function (id) {
      var f = byId[id];
      var row = html('div', 'demo-qrow');
      row.appendChild(iconEl(iconOf(f), 18));
      var text = html('div', 'demo-qtext');
      text.appendChild(html('strong', null, f.label));
      text.appendChild(html('span', 'demo-muted', formatBytes(f.size) + ' · manifest written, SHA-256 recorded'));
      row.appendChild(text);
      var button = html('button', 'demo-btn ghost', 'Restore');
      button.type = 'button';
      button.addEventListener('click', function () { restore(id); });
      row.appendChild(button);
      list.appendChild(row);
    });
  }

  // ---------- Render ----------

  function render() {
    var live = files.filter(function (f) { return !isQuarantined(f.id); });
    var bytes = live.reduce(function (sum, f) { return sum + f.size; }, 0);
    totals.textContent = live.length + ' files · ' + formatBytes(bytes);
    tabQuarantine.textContent = 'Quarantine ' + state.quarantined.length;
    tabMap.setAttribute('aria-selected', String(state.view === 'map'));
    tabQuarantine.setAttribute('aria-selected', String(state.view === 'quarantine'));
    scroller.hidden = state.view !== 'map';
    list.hidden = state.view !== 'quarantine';

    var lit = litSet();
    nodes.forEach(function (n) {
      var g = nodeEls[n.id];
      g.classList.toggle('gone', isQuarantined(n.id));
      g.classList.toggle('dim', !!lit && !lit[n.id]);
      g.classList.toggle('lit', !!lit && !!lit[n.id]);
      g.classList.toggle('selected', state.selected === n.id);
      g.setAttribute('aria-pressed', String(state.selected === n.id));
    });
    edgeEls.forEach(function (e) {
      var gone = isQuarantined(e.from) || isQuarantined(e.to);
      e.line.classList.toggle('gone', gone);
      e.line.classList.toggle('lit', !!lit && !!lit[e.from] && !!lit[e.to]);
      e.line.classList.toggle('dim', !!lit && !(lit[e.from] && lit[e.to]));
    });

    renderPanel();
    renderAction();
    renderList();

    // On narrow screens the map scrolls sideways; keep the selection in view.
    var sel = byId[state.selected];
    if (sel && state.view === 'map' && scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = (sel.x / 880) * scroller.scrollWidth - scroller.clientWidth / 2;
    }
  }

  tabMap.addEventListener('click', function () { state.view = 'map'; render(); });
  tabQuarantine.addEventListener('click', function () { state.view = 'quarantine'; state.armed = null; render(); });
  svg.addEventListener('click', function (ev) {
    if (ev.target === svg) select(null);
  });

  // ---------- Walkthrough ----------

  var SCAN_PATHS = [
    '~/.claude/projects/neural-search-engine',
    '~/.claude/logs',
    '~/.claude/cache',
    '~/.claude/tmp',
    '~/Library/Application Support/Claude',
    '~/Library/Caches/claude-code',
    '~/Library/Logs/Claude',
    '~/Projects/neural-search-engine/dist',
    '~/Projects/neural-search-engine/src'
  ];
  var TOTAL_BYTES = files.reduce(function (sum, f) { return sum + f.size; }, 0);
  var tour = { running: false, timers: [], drag: null };

  // Moves the app icon from the Finder window (or the desktop corner) into the drop zone.
  function playDrag() {
    if (!desktop || !tile.animate) return;
    tile.hidden = false;
    var d = desktop.getBoundingClientRect();
    var to = dropzone.getBoundingClientRect();
    var from = finderSource && finderSource.offsetParent ? finderSource.getBoundingClientRect() : null;
    var w = tile.offsetWidth;
    var x0 = (from ? from.left + from.width / 2 : d.left + d.width * 0.14) - d.left - w / 2;
    var y0 = (from ? from.top + from.height / 2 : d.top + d.height * 0.9) - d.top - 20;
    var x1 = to.left + to.width / 2 - d.left - w / 2;
    var y1 = to.top + to.height / 2 - d.top - 20;
    var at = function (x, y, scale) { return 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'; };
    tour.drag = tile.animate([
      { transform: at(x0, y0, 0.85), opacity: 0, offset: 0 },
      { transform: at(x0, y0, 1.08), opacity: 1, offset: 0.12 },
      { transform: at(x1, y1, 1.08), opacity: 1, offset: 0.7 },
      { transform: at(x1, y1, 1), opacity: 1, offset: 0.84 },
      { transform: at(x1, y1, 0.5), opacity: 0, offset: 1 }
    ], { duration: 2300, easing: 'ease-in-out', fill: 'forwards' });
  }

  function later(ms, fn) {
    tour.timers.push(setTimeout(fn, ms));
  }

  function setStep(index) {
    stepEls.forEach(function (li, i) {
      li.classList.toggle('current', i === index);
      li.classList.toggle('done', index != null && i < index);
    });
  }

  function showIntro(view) {
    intro.hidden = view == null;
    intro.className = 'demo-intro' + (view ? ' ' + view : '');
  }

  function stopTour() {
    tour.timers.forEach(clearTimeout);
    tour.timers = [];
    tour.running = false;
    if (tour.drag) { tour.drag.cancel(); tour.drag = null; }
    tile.hidden = true;
    if (mac) mac.classList.remove('finder-open');
    showIntro(null);
    svg.classList.remove('reveal');
    root.classList.remove('touring');
    setStep(null);
  }

  function playTour() {
    stopTour();
    tour.running = true;
    root.classList.add('touring');
    state.quarantined = [];
    state.selected = null;
    state.armed = null;
    state.view = 'map';
    render();

    // 1. The opening screen: an app is dragged from Finder onto the window.
    setStep(0);
    showIntro('drop');
    if (mac) mac.classList.add('finder-open');
    later(450, playDrag);
    later(1950, function () { intro.classList.add('over'); });
    later(2750, function () { if (mac) mac.classList.remove('finder-open'); });

    // 2. The scan reports the folder being read, with running totals.
    later(3000, function () {
      setStep(1);
      tile.hidden = true;
      showIntro('scan');
      var ticks = SCAN_PATHS.length;
      SCAN_PATHS.forEach(function (path, i) {
        later(i * 300, function () {
          var done = (i + 1) / ticks;
          var seen = Math.round(files.length * done);
          scanPath.textContent = path;
          scanFill.style.width = Math.round(done * 100) + '%';
          scanMetrics.textContent = (i + 1) + (i ? ' folders' : ' folder') + ' \u00b7 ' + seen +
            (seen === 1 ? ' file' : ' files') + ' \u00b7 ' + formatBytes(Math.round(TOTAL_BYTES * done));
        });
      });
    });

    // 3 and 4. Results: the map draws itself beside the scan totals, then one file is traced.
    later(6000, function () {
      setStep(2);
      showIntro(null);
      svg.classList.add('reveal');
    });
    later(7900, function () { svg.classList.remove('reveal'); });
    later(9400, function () {
      setStep(3);
      state.selected = 'f1';
      render();
    });

    // 4 and 5. The file goes to quarantine and comes back.
    later(12200, function () {
      setStep(4);
      quarantine('f1');
    });
    later(14800, function () {
      setStep(5);
      restore('f1');
    });
    later(17100, stopTour);
  }

  // Any interaction hands control to the visitor.
  ['pointerdown', 'keydown', 'wheel'].forEach(function (type) {
    root.addEventListener(type, function (ev) {
      if (tour.running && !replay.contains(ev.target)) stopTour();
    }, { capture: true, passive: true });
  });
  replay.addEventListener('click', playTour);

  // Stagger the map's entrance: origin first, files last.
  var order = { app: 0, workspace: 1, session: 2, unknown: 2, group: 3, file: 4 };
  nodes.forEach(function (n, i) {
    nodeEls[n.id].style.setProperty('--d', (order[n.kind] * 0.22 + (i % 5) * 0.05) + 's');
  });
  edgeEls.forEach(function (e) {
    e.line.style.setProperty('--d', (order[byId[e.to].kind] * 0.22) + 's');
  });

  root.classList.add('ready');
  render();

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    replay.textContent = 'Play walkthrough';
  } else if ('IntersectionObserver' in window) {
    var seen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        seen.disconnect();
        playTour();
      }
    }, { threshold: 0.35 });
    seen.observe(root);
  }
})();
