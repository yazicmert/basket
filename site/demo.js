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
  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var RISK = {
    safe: 'Safe to remove',
    review: 'Review first',
    high: 'High risk',
    protected: 'Protected'
  };

  // kind: app | workspace | session | group | unknown | file
  var nodes = [
    { id: 'app', kind: 'app', label: 'Claude Code', x: 430, y: 300 },
    { id: 'sA', kind: 'session', label: 'Set up the core vector…', x: 596, y: 262,
      prompt: 'Set up the core vector index and a query router for the search service.' },
    { id: 'sB', kind: 'session', label: 'Speed up vector search…', x: 318, y: 176,
      prompt: 'Speed up vector search with SIMD and shrink the production bundle.' },
    { id: 'gLogs', kind: 'group', type: 'LOG', label: 'Diagnostic Logs', x: 708, y: 238 },
    { id: 'gCache', kind: 'group', type: 'REGENERABLE_CACHE', label: 'Regenerable Caches', x: 372, y: 446 },
    { id: 'gTmp', kind: 'group', type: 'TEMP_FILE', label: 'Temporary Files', x: 612, y: 404 },
    { id: 'gHist', kind: 'group', type: 'SESSION_HISTORY', label: 'Session Histories', x: 232, y: 366 },
    { id: 'gBuild', kind: 'group', type: 'BUILD_OUTPUT', label: 'Build Outputs', x: 176, y: 250 },
    { id: 'gSrc', kind: 'group', type: 'USER_CONTENT', label: 'Source & User Content', x: 690, y: 110 },
    { id: 'gUnk', kind: 'group', type: 'UNKNOWN', label: 'Unclassified', x: 0, y: 0 },

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
      group: 'gUnk', sessions: [],
      why: 'No session record names this file. Unknown origin is never marked safe.' },
    { id: 'f11', kind: 'file', label: 'old-run.log', x: 214, y: 34, size: 8602, risk: 'review',
      group: 'gUnk', sessions: [],
      why: 'A log outside a dedicated log folder, with no session record. The extension alone decides nothing.' }
  ];

  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  // What a file is to the session it belongs to, as in the app: its output in the project,
  // a file the app keeps for it, or its own record
  var PART_OF_GROUP = { gSrc: 'output', gBuild: 'output', gHist: 'record' };
  nodes.forEach(function (n) {
    if (n.kind === 'file') n.part = PART_OF_GROUP[n.group] || 'kept';
  });
  // A file has the artifact type of its group, except the stray log among the unclassified.
  nodes.forEach(function (n) {
    if (n.kind === 'file') n.type = n.id === 'f11' ? 'LOG' : byId[n.group].type;
  });

  // Sample apps the opening screen offers, as in the real app.
  var KIND_LABELS = {
    REGENERABLE_CACHE: 'Regenerable caches', TEMP_FILE: 'Temporary files', LOG: 'Logs',
    BUILD_OUTPUT: 'Build outputs', SESSION_HISTORY: 'Session histories',
    USER_CONTENT: 'Source and user content', UNKNOWN: 'Unclassified'
  };
  var SAMPLE_APPS = [['Claude Code', 'logo:claudecode'], ['Cursor', 'logo:cursor'], ['Codex CLI', 'braces'], ['NebulaSketch', 'app']];
  // The Claude Code mark as path data, for the app's node inside the SVG map.
  var APP_LOGO_PATH = 'M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z';

  function iconOf(n) {
    if (n.kind === 'app') return Icons.forApp({ name: n.label });
    if (n.kind === 'bucket') return 'folder';
    if (n.kind === 'session' || n.kind === 'sessions') return 'session';
    return Icons.forArtifactType(n.type);
  }

  function iconEl(name, size) {
    var span = document.createElement('span');
    span.className = 'demo-icon';
    span.innerHTML = Icons.svg(name, size || 14);
    return span;
  }

  // An application tile: a glyph on an ink square, like the app's own fallback icon.
  // `icon` is a glyph name, or `logo:<slug>` for a product logo in site/logos/.
  function appTileEl(icon, size) {
    var t = document.createElement('span');
    t.className = 'demo-appicon';
    if (icon.indexOf('logo:') === 0) {
      var mark = document.createElement('i');
      var url = 'url(logos/' + icon.slice(5) + '.svg)';
      mark.className = 'demo-logo';
      mark.style.webkitMaskImage = url;
      mark.style.maskImage = url;
      t.appendChild(mark);
    } else {
      t.innerHTML = Icons.svg(icon, size || 15);
    }
    return t;
  }
  var files = nodes.filter(function (n) { return n.kind === 'file'; });

  // level: which part of the map is open (see buildLevel); selected: a file id or null
  var state = { level: 'root', selected: null, view: 'map', quarantined: [], armed: null };

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

  function liveFiles() {
    return files.filter(function (f) { return !isQuarantined(f.id); });
  }

  function originOf(f) {
    if (!f.sessions.length) return 'unknown';
    return f.sessions.some(function (s) { return s[1] === 'recorded'; }) ? 'recorded' : 'likely';
  }

  function summarize(list) {
    var risks = {};
    var bytes = 0;
    list.forEach(function (f) { risks[f.risk] = (risks[f.risk] || 0) + 1; bytes += f.size; });
    return { count: list.length, bytes: bytes, risks: risks };
  }

  var GROUPINGS = {
    risk: { label: 'Cleanup risk', buckets: [['safe', 'Safe to remove'], ['review', 'Review first'], ['high', 'High risk'], ['protected', 'Protected']], keyOf: function (f) { return f.risk; } },
    origin: { label: 'Origin', buckets: [['recorded', 'Recorded by a session'], ['likely', 'Likely from this app'], ['unknown', 'Unknown origin']], keyOf: originOf }
  };

  // The map is explored one level at a time, as in the app: the application with its kinds
  // and sessions; then one kind, one session or one bucket with its files.
  function buildLevel(levelId) {
    var live = liveFiles();
    var appCrumb = { id: 'root', title: 'Claude Code' };
    var summaryNode = function (id, kind, label, list, extra) {
      var n = { id: id, kind: kind, label: label, summary: summarize(list), drill: id };
      for (var k in extra || {}) n[k] = extra[k];
      return n;
    };
    var fileNode = function (f, strength) {
      return { id: f.id, kind: 'file', label: f.label, risk: f.risk, type: f.type, file: f, strength: strength || 'recorded' };
    };
    var appCenter = { id: 'app', kind: 'app', label: 'Claude Code', summary: summarize(live) };

    if (levelId === 'root') {
      var kinds = nodes.filter(function (n) { return n.kind === 'group'; }).map(function (g) {
        return summaryNode('group:' + g.id, 'group', g.label, live.filter(function (f) { return f.group === g.id; }), { type: g.type });
      }).filter(function (n) { return n.summary.count > 0; });
      kinds.sort(function (a, b) { return b.summary.bytes - a.summary.bytes; });
      kinds.push(summaryNode('sessions', 'sessions', 'Sessions (2)', live.filter(function (f) { return f.sessions.length; })));
      return { id: 'root', grouping: 'kind', parent: null, crumbs: [appCrumb], center: appCenter, children: kinds };
    }
    if (levelId.indexOf('root:') === 0 && GROUPINGS[levelId.slice(5)]) {
      var gname = levelId.slice(5);
      var def = GROUPINGS[gname];
      var buckets = def.buckets.map(function (b) {
        return summaryNode('bucket:' + gname + ':' + b[0], 'bucket', b[1], live.filter(function (f) { return def.keyOf(f) === b[0]; }));
      }).filter(function (n) { return n.summary.count > 0; });
      return { id: levelId, grouping: gname, parent: null, crumbs: [{ id: levelId, title: 'Claude Code' }], center: appCenter, children: buckets };
    }
    if (levelId === 'sessions') {
      var sess = nodes.filter(function (n) { return n.kind === 'session'; }).map(function (sn) {
        return summaryNode('session:' + sn.id, 'session', sn.label, live.filter(function (f) { return f.sessions.some(function (x) { return x[0] === sn.id; }); }));
      });
      return { id: 'sessions', grouping: 'kind', parent: 'root', crumbs: [appCrumb, { id: 'sessions', title: 'Sessions' }],
        center: { id: 'sessions-center', kind: 'sessions', label: 'Sessions (2)', summary: summarize(live.filter(function (f) { return f.sessions.length; })) }, children: sess };
    }
    var parts = levelId.split(':');
    if (parts[0] === 'group' && byId[parts[1]]) {
      var grp = byId[parts[1]];
      var inGroup = live.filter(function (f) { return f.group === grp.id; });
      return { id: levelId, grouping: 'kind', parent: 'root', crumbs: [appCrumb, { id: levelId, title: grp.label }],
        center: { id: levelId + '-center', kind: 'group', type: grp.type, label: grp.label, summary: summarize(inGroup) },
        children: inGroup.map(function (f) { return fileNode(f, originOf(f) === 'unknown' ? 'unknown' : 'recorded'); }) };
    }
    if (parts[0] === 'session' && byId[parts[1]]) {
      var sn2 = byId[parts[1]];
      var linked = live.filter(function (f) { return f.sessions.some(function (x) { return x[0] === sn2.id; }); });
      return { id: levelId, grouping: 'kind', parent: 'sessions', crumbs: [appCrumb, { id: 'sessions', title: 'Sessions' }, { id: levelId, title: sn2.label }],
        center: { id: levelId + '-center', kind: 'session', label: sn2.label, summary: summarize(linked) },
        children: linked.map(function (f) {
          return fileNode(f, f.sessions.filter(function (x) { return x[0] === sn2.id; })[0][1]);
        }) };
    }
    if (parts[0] === 'bucket' && GROUPINGS[parts[1]]) {
      var def2 = GROUPINGS[parts[1]];
      var found = def2.buckets.filter(function (b) { return b[0] === parts[2]; })[0];
      if (found) {
        var inBucket = live.filter(function (f) { return def2.keyOf(f) === parts[2]; });
        return { id: levelId, grouping: parts[1], parent: 'root:' + parts[1],
          crumbs: [{ id: 'root:' + parts[1], title: 'Claude Code' }, { id: levelId, title: found[1] }],
          center: { id: levelId + '-center', kind: 'bucket', label: found[1], summary: summarize(inBucket) },
          children: inBucket.map(function (f) { return fileNode(f, originOf(f)); }) };
      }
    }
    return buildLevel('root');
  }

  // The level that shows a file: its kind.
  function levelOfFile(f) {
    return 'group:' + f.group;
  }

  // ---------- Skeleton ----------

  root.textContent = '';
  var bar = html('div', 'demo-bar');
  var appName = html('div', 'demo-app');
  appName.appendChild(appTileEl('logo:claudecode', 15));
  appName.appendChild(html('strong', null, 'Claude Code'));
  var totals = html('span', 'demo-muted');
  appName.appendChild(totals);
  bar.appendChild(appName);

  var tabs = html('div', 'demo-tabs');
  tabs.setAttribute('role', 'tablist');
  var tabMap = html('button', null, 'Map');
  var tabInsights = html('button', null, 'Insights');
  var tabQuarantine = html('button');
  [tabMap, tabInsights, tabQuarantine].forEach(function (b) { b.type = 'button'; b.setAttribute('role', 'tab'); tabs.appendChild(b); });
  tabMap.id = 'demo-tab-map';
  tabInsights.id = 'demo-tab-insights';
  tabQuarantine.id = 'demo-tab-quarantine';
  bar.appendChild(tabs);
  bar.appendChild(html('span', 'demo-badge', 'Sample data'));
  var replay = html('button', 'demo-replay', 'Replay');
  replay.type = 'button';
  replay.id = 'demo-replay';
  bar.appendChild(replay);
  root.appendChild(bar);

  // The walkthrough is a real sequence, so its steps are numbered.
  var STEPS = ['Drop an app', 'Scan', 'See the totals', 'Open a prompt', 'See what it cost', 'Quarantine its leftovers', 'Restore'];
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
  var crumbBar = html('div', 'demo-crumbbar');
  scroller.appendChild(svg);
  stage.appendChild(crumbBar);
  stage.appendChild(scroller);
  var list = html('div', 'demo-list');
  stage.appendChild(list);
  var insightsBox = html('div', 'demo-insights');
  stage.appendChild(insightsBox);
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
  tile.appendChild(appTileEl('logo:claudecode', 24));
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
      [['folder', ''], ['logo:claudecode', ''], ['logo:cursor', ''], ['braces', ''], ['atlas', 'running']].forEach(function (d) {
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
  scanTitle.appendChild(appTileEl('logo:claudecode', 15));
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

  var CX = 440, CY = 268;
  var currentLevel = null;

  function shapeFor(n, x, y) {
    if (n.kind === 'app') return [el('circle', { cx: x, cy: y, r: 21 }), 22];
    if (n.kind === 'session' || n.kind === 'sessions') return [el('circle', { cx: x, cy: y, r: 15 }), 16];
    if (n.kind === 'file') return [el('circle', { cx: x, cy: y, r: 11.5 }), 13];
    return [el('rect', { x: x - 16, y: y - 16, width: 32, height: 32, rx: 8 }), 18];
  }

  function drawNode(n, x, y, index, isCenter) {
    var cls = n.kind === 'bucket' ? 'group' : n.kind === 'sessions' ? 'session' : n.kind;
    var g = el('g', { 'class': 'demo-node ' + cls + (n.risk ? ' ' + n.risk : '') + (n.kind === 'file' ? ' lit' : '') + (isCenter ? ' center' : '') });
    var built = shapeFor(n, x, y);
    var half = n.kind === 'app' ? 21 : n.kind === 'file' ? 11.5 : n.kind === 'session' || n.kind === 'sessions' ? 15 : 16;
    g.appendChild(el('circle', { cx: x, cy: y, r: half + 10, 'class': 'demo-hit' }));
    g.appendChild(built[0]);
    var glyph = el('g', {
      'class': 'demo-glyph' + (n.kind === 'app' ? ' logo' : ''),
      transform: 'translate(' + (x - built[1] / 2) + ' ' + (y - built[1] / 2) + ') scale(' + (built[1] / 24) + ')'
    });
    if (n.kind === 'app') glyph.appendChild(el('path', { d: APP_LOGO_PATH }));
    else Icons.paths[iconOf(n)].forEach(function (d) { glyph.appendChild(el('path', { d: d })); });
    g.appendChild(glyph);

    var labelY = y + half + 15;
    if (n.summary && n.summary.count > 0) {
      // Share of each risk level, as in the app
      var bar = el('g', { 'class': 'demo-riskbar' });
      var w = 46, bx = x - w / 2;
      ['safe', 'review', 'high', 'protected'].forEach(function (risk) {
        var share = (n.summary.risks[risk] || 0) / n.summary.count;
        if (share <= 0) return;
        bar.appendChild(el('rect', { x: bx, y: y + half + 5, width: Math.max(1, w * share - 1), height: 3, 'class': risk }));
        bx += w * share;
      });
      g.appendChild(bar);
      labelY += 8;
    }
    g.appendChild(el('text', { x: x, y: labelY, 'text-anchor': 'middle' }, n.label));
    if (n.summary) {
      g.appendChild(el('text', { x: x, y: labelY + 13, 'text-anchor': 'middle', 'class': 'meta' },
        n.summary.count + (n.summary.count === 1 ? ' file' : ' files') + ' \u00b7 ' + formatBytes(n.summary.bytes)));
    }
    g.style.setProperty('--d', (isCenter ? 0 : 0.08 + index * 0.05) + 's');

    var activate = null;
    if (n.kind === 'file') activate = function () { select(n.id); };
    else if (!isCenter && n.drill) activate = function () { go(n.drill); };
    if (activate) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', n.label + (n.risk ? ', ' + RISK[n.risk] : n.summary ? ', ' + n.summary.count + ' files, open' : ''));
      g.addEventListener('click', activate);
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(); }
      });
    } else {
      g.classList.add('static');
    }
    nodeLayer.appendChild(g);
    return g;
  }

  // On a narrow screen the map is wider than the window: keep its centre in view
  function centerScroller() {
    var spare = scroller.scrollWidth - scroller.clientWidth;
    if (spare > 0) scroller.scrollLeft = spare / 2;
  }

  function drawLevel(animate) {
    var level = buildLevel(state.level);
    state.level = level.id;
    currentLevel = level;
    edgeLayer.textContent = '';
    nodeLayer.textContent = '';
    nodeEls = {};
    var count = level.children.length;
    level.children.forEach(function (n, i) {
      var angle = (i / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
      var x = CX + Math.cos(angle) * 300;
      var y = CY + Math.sin(angle) * 176;
      var line = el('line', { x1: CX, y1: CY, x2: x, y2: y, 'class': 'demo-edge ' + (n.kind === 'file' ? n.strength : 'recorded') });
      line.style.setProperty('--d', (0.08 + i * 0.05) + 's');
      edgeLayer.appendChild(line);
      nodeEls[n.id] = drawNode(n, x, y, i, false);
    });
    drawNode(level.center, CX, CY, 0, true);
    if (animate && !reducedMotion) {
      svg.classList.remove('reveal');
      void svg.getBoundingClientRect();
      svg.classList.add('reveal');
    }
    renderCrumbs(level);
    centerScroller();
  }

  function renderCrumbs(level) {
    crumbBar.textContent = '';
    if (level.parent) {
      var up = html('button', 'demo-crumb-up', '\u2190');
      up.type = 'button';
      up.title = 'Up one level';
      up.setAttribute('aria-label', 'Up one level');
      up.addEventListener('click', function () { go(level.parent); });
      crumbBar.appendChild(up);
    }
    var crumbs = html('div', 'demo-crumbs');
    level.crumbs.forEach(function (c, i) {
      if (i) crumbs.appendChild(html('span', 'demo-crumb-sep', '/'));
      if (i === level.crumbs.length - 1) {
        crumbs.appendChild(html('span', 'demo-crumb current', c.title));
      } else {
        var b = html('button', 'demo-crumb', c.title);
        b.type = 'button';
        b.addEventListener('click', function () { go(c.id); });
        crumbs.appendChild(b);
      }
    });
    crumbBar.appendChild(crumbs);
    crumbBar.appendChild(html('span', 'demo-crumb-note', level.parent ? 'Click a file to trace it.' : 'Click a mark to open it.'));

    var label = html('label', 'demo-groupby');
    label.appendChild(html('span', null, 'Group by'));
    var selectEl = document.createElement('select');
    selectEl.id = 'demo-group-by';
    [['kind', 'Kind'], ['risk', 'Cleanup risk'], ['origin', 'Origin']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      if (level.grouping === o[0]) opt.selected = true;
      selectEl.appendChild(opt);
    });
    selectEl.addEventListener('change', function () { go(selectEl.value === 'kind' ? 'root' : 'root:' + selectEl.value); });
    label.appendChild(selectEl);
    crumbBar.appendChild(label);
  }

  var nodeEls = {};

  // Opens a level of the map.
  function go(levelId) {
    state.level = levelId;
    state.selected = null;
    state.armed = null;
    state.view = 'map';
    drawLevel(true);
    render();
  }

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

  // What a session cost beyond its output, and its leftovers: files that belong to it
  // alone and are not its output, its record or protected.
  function sessionFiles(sid) {
    return files.filter(function (f) {
      return !isQuarantined(f.id) && f.sessions.some(function (x) { return x[0] === sid; });
    });
  }
  function leftoversOf(sid) {
    return sessionFiles(sid).filter(function (f) {
      return f.sessions.length === 1 && f.part === 'kept' && f.risk !== 'protected';
    });
  }

  function renderSessionPanel(sn) {
    var kind = html('div', 'demo-kind');
    kind.appendChild(iconEl('session', 14));
    kind.appendChild(document.createTextNode('Session'));
    panel.appendChild(kind);
    panel.appendChild(html('h3', 'demo-title', sn.label));

    var mine = sessionFiles(sn.id);
    var parts = { output: [], kept: [], record: [] };
    mine.forEach(function (f) { parts[f.part].push(f); });
    var cost = parts.kept.concat(parts.record);
    var costBytes = cost.reduce(function (sum, f) { return sum + f.size; }, 0);

    panel.appendChild(html('h4', 'demo-sub', 'What this prompt cost'));
    var head = html('div', 'demo-total');
    head.appendChild(html('strong', null, formatBytes(costBytes)));
    head.appendChild(html('span', 'demo-muted', 'at least ' + cost.length + (cost.length === 1 ? ' file' : ' files') + ' beyond its output'));
    panel.appendChild(head);
    panel.appendChild(statRow(html('span'), 'Its output', countAndSize(parts.output)));
    panel.appendChild(statRow(html('span'), 'Kept by the app for it', countAndSize(parts.kept)));
    panel.appendChild(statRow(html('span'), 'Its own record', countAndSize(parts.record)));

    var left = leftoversOf(sn.id);
    var button = html('button', 'demo-btn', left.length
      ? 'Move what it left behind to Quarantine (' + left.length + ')'
      : 'Nothing left behind to move');
    button.type = 'button';
    button.id = 'demo-leftovers-button';
    button.disabled = !left.length;
    button.addEventListener('click', function () { quarantineMany(left.map(function (f) { return f.id; })); });
    panel.appendChild(button);
    panel.appendChild(html('p', 'demo-note', 'Never its output, its record, or files shared with another session.'));

    panel.appendChild(html('h4', 'demo-sub', 'Starting prompt'));
    panel.appendChild(html('p', 'demo-prompt', sn.prompt));
  }

  function renderPanel() {
    panel.textContent = '';
    var sel = byId[state.selected];
    var openSession = /^session:/.test(state.level) ? byId[state.level.slice(8)] : null;
    if (!sel && openSession) {
      renderSessionPanel(openSession);
      return;
    }
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
    drawLevel(false);
    render();
    if (!tour.running) tabQuarantine.focus();
  }

  function quarantineMany(ids) {
    ids.forEach(function (id) { if (!isQuarantined(id)) state.quarantined.push(id); });
    state.selected = null;
    state.armed = null;
    state.view = 'quarantine';
    drawLevel(false);
    render();
    if (!tour.running) tabQuarantine.focus();
  }

  function restore(id) {
    state.quarantined = state.quarantined.filter(function (q) { return q !== id; });
    state.level = levelOfFile(byId[id]);
    state.view = 'map';
    drawLevel(true);
    state.selected = id;
    render();
  }

  // ---------- Quarantine list ----------

  function renderList() {
    list.textContent = '';
    if (!state.quarantined.length) {
      list.appendChild(html('p', 'demo-empty', 'Quarantine is empty. Select a file on the map and move it here. It can be put back.'));
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

  // ---------- Insights (from the sample files only) ----------

  function insightCard(title) {
    var card = html('section', 'demo-icard');
    card.appendChild(html('h4', null, title));
    insightsBox.appendChild(card);
    return card;
  }

  function renderInsights() {
    insightsBox.textContent = '';
    var growth = insightCard('Since the last scan');
    growth.appendChild(html('p', 'demo-muted', 'This is the first scan of this app. The next one will show what changed.'));

    var builds = files.filter(function (f) { return f.group === 'gBuild' && !isQuarantined(f.id); });
    if (builds.length) {
      var b = insightCard('Build outputs');
      var bytes = builds.reduce(function (s, f) { return s + f.size; }, 0);
      b.appendChild(html('div', 'demo-ifigure', formatBytes(bytes)));
      b.appendChild(html('p', 'demo-muted', builds.length + (builds.length === 1 ? ' file' : ' files') + ' a build can make again. Selected files are reviewed before they move.'));
    }

    var copies = insightCard('Identical files');
    copies.appendChild(html('p', 'demo-muted', 'Compared only when you ask, by reading the files. In this sample, no two files have the same content.'));

    var q = insightCard('Quarantine');
    var held = state.quarantined.reduce(function (s, id) { return s + byId[id].size; }, 0);
    q.appendChild(html('div', 'demo-ifigure', formatBytes(held)));
    q.appendChild(html('p', 'demo-muted', 'Held, and can be put back. Unused leftovers are deleted after 7 days unless their app makes them again; anything else can be emptied after 30 days.'));
  }

  // ---------- Render ----------

  function render() {
    var live = files.filter(function (f) { return !isQuarantined(f.id); });
    var bytes = live.reduce(function (sum, f) { return sum + f.size; }, 0);
    totals.textContent = live.length + ' files · ' + formatBytes(bytes);
    tabQuarantine.textContent = 'Quarantine ' + state.quarantined.length;
    tabMap.setAttribute('aria-selected', String(state.view === 'map'));
    tabInsights.setAttribute('aria-selected', String(state.view === 'insights'));
    tabQuarantine.setAttribute('aria-selected', String(state.view === 'quarantine'));
    scroller.hidden = state.view !== 'map';
    if (!scroller.hidden) centerScroller();
    list.hidden = state.view !== 'quarantine';
    insightsBox.hidden = state.view !== 'insights';

    crumbBar.hidden = state.view !== 'map';
    for (var nodeId in nodeEls) {
      nodeEls[nodeId].classList.toggle('selected', state.selected === nodeId);
      nodeEls[nodeId].classList.toggle('dim', !!state.selected && state.selected !== nodeId && !!byId[nodeId]);
    }

    renderPanel();
    renderAction();
    renderList();
    renderInsights();

  }

  tabMap.addEventListener('click', function () { state.view = 'map'; render(); });
  tabQuarantine.addEventListener('click', function () { state.view = 'quarantine'; state.armed = null; render(); });
  tabInsights.addEventListener('click', function () { state.view = 'insights'; state.armed = null; render(); });
  svg.addEventListener('click', function (ev) {
    if (ev.target === svg) select(null);
  });
  // Escape goes up a level while the pointer or the keyboard focus is in the preview
  var pointerInside = false;
  root.addEventListener('pointerenter', function () { pointerInside = true; });
  root.addEventListener('pointerleave', function () { pointerInside = false; });
  document.addEventListener('keydown', function (ev) {
    var here = pointerInside || root.contains(document.activeElement);
    if (ev.key === 'Escape' && here && state.view === 'map' && currentLevel && currentLevel.parent) go(currentLevel.parent);
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
    state.level = 'root';
    drawLevel(false);
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

    // 3. Results: the top level draws itself beside the scan totals.
    later(6000, function () {
      setStep(2);
      showIntro(null);
      go('root');
    });
    // 4. The sessions, each named by the prompt that started it.
    later(8600, function () {
      setStep(3);
      go('sessions');
    });
    // 5. One session is opened: what it delivered, and what it cost beyond that.
    later(10800, function () {
      setStep(4);
      go('session:sA');
    });
    // 6 and 7. Its leftovers go to quarantine, and one comes back.
    later(14200, function () {
      setStep(5);
      quarantineMany(leftoversOf('sA').map(function (f) { return f.id; }));
    });
    later(17000, function () {
      setStep(6);
      restore('f1');
    });
    later(19600, stopTour);

  }

  // Any interaction hands control to the visitor.
  ['pointerdown', 'keydown', 'wheel'].forEach(function (type) {
    root.addEventListener(type, function (ev) {
      if (tour.running && !replay.contains(ev.target)) stopTour();
    }, { capture: true, passive: true });
  });
  replay.addEventListener('click', playTour);

  root.classList.add('ready');
  drawLevel(false);
  render();

  if (reducedMotion) {
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
