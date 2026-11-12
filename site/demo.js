// Interactive preview of the Artifact Atlas map for the project site.
// Everything here is built-in sample data. Nothing is read from the visitor's disk and
// nothing leaves the page.
(function () {
  'use strict';

  var root = document.getElementById('demo');
  if (!root || !document.createElementNS) return;

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
    { id: 'gLogs', kind: 'group', label: 'Diagnostic Logs', x: 708, y: 238 },
    { id: 'gCache', kind: 'group', label: 'Regenerable Caches', x: 372, y: 446 },
    { id: 'gTmp', kind: 'group', label: 'Temporary Files', x: 612, y: 404 },
    { id: 'gHist', kind: 'group', label: 'Session Histories', x: 232, y: 366 },
    { id: 'gBuild', kind: 'group', label: 'Build Outputs', x: 176, y: 250 },
    { id: 'gSrc', kind: 'group', label: 'Source & User Content', x: 690, y: 110 },

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
  root.appendChild(bar);

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
    if (n.kind === 'app') shape = el('circle', { cx: n.x, cy: n.y, r: 11 });
    else if (n.kind === 'session') shape = el('circle', { cx: n.x, cy: n.y, r: 7 });
    else if (n.kind === 'unknown') shape = el('circle', { cx: n.x, cy: n.y, r: 9 });
    else if (n.kind === 'file') shape = el('circle', { cx: n.x, cy: n.y, r: 6.5 });
    else shape = el('rect', { x: n.x - 8, y: n.y - 8, width: 16, height: 16, rx: n.kind === 'group' ? 4 : 2 });
    g.appendChild(el('circle', { cx: n.x, cy: n.y, r: 18, 'class': 'demo-hit' }));
    g.appendChild(shape);
    var anchor = n.x > 700 ? 'end' : n.x < 130 ? 'start' : 'middle';
    var tx = anchor === 'end' ? n.x + 10 : anchor === 'start' ? n.x - 10 : n.x;
    g.appendChild(el('text', { x: tx, y: n.y + (n.kind === 'app' ? 30 : 25), 'text-anchor': anchor }, n.label));
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

  function renderPanel() {
    panel.textContent = '';
    var sel = byId[state.selected];
    if (!sel) {
      panel.appendChild(html('p', 'demo-muted', 'Select a file on the map to see where it came from.'));
      return;
    }
    var kindLabel = { app: 'Application', workspace: 'Workspace', session: 'Session', group: 'Group', unknown: 'Origin', file: 'File' };
    panel.appendChild(html('div', 'demo-kind', kindLabel[sel.kind]));
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
    if (state.armed === sel.id) button.focus();
  }

  function quarantine(id) {
    state.quarantined.push(id);
    state.selected = null;
    state.armed = null;
    state.view = 'quarantine';
    render();
    tabQuarantine.focus();
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

  root.classList.add('ready');
  render();
})();
