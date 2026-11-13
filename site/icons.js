// Artifact Atlas icon set.
// Original line glyphs on a 24x24 grid, drawn with a round 1.7 stroke. They describe what a
// thing is (a cache, a log, a session) and are not any product's logo. The desktop app shows
// an application's own icon, read from its bundle, wherever one is available; these glyphs
// are the fallback and are used for everything that is not an application.
//
// This file is shared verbatim with the project site (site/icons.js). A test keeps the two
// copies identical.
(function (global) {
  'use strict';

  var PATHS = {
    // Artifact types
    cache: ['M20 11a8 8 0 0 0-14.3-4.9L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.9L20 16', 'M20 20v-4h-4'],
    temp: ['M12 21a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z', 'M12 10v3.5l2.3 1.8', 'M9.5 3h5'],
    log: ['M6 3h9l4 4v14H6z', 'M14.5 3v4.5H19', 'M9 11.5h7', 'M9 14.5h7', 'M9 17.5h4'],
    build: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
    derived: ['M12 4l8 4-8 4-8-4z', 'M4 12l8 4 8-4', 'M4 16l8 4 8-4'],
    session: [
      'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
      'M8 9.5h8',
      'M8 12.5h5'
    ],
    source: ['M8.5 7.5L4 12l4.5 4.5', 'M15.5 7.5L20 12l-4.5 4.5', 'M13.5 5l-3 14'],
    model: [
      'M7 7h10v10H7z',
      'M10 10h4v4h-4z',
      'M9.5 4v3', 'M14.5 4v3', 'M9.5 17v3', 'M14.5 17v3',
      'M4 9.5h3', 'M4 14.5h3', 'M17 9.5h3', 'M17 14.5h3'
    ],
    checkpoint: ['M6 21V4', 'M6 4.5h11l-2.5 4 2.5 4H6'],
    unknown: ['M8.8 9a3.2 3.2 0 1 1 4.9 2.7c-1.1.7-1.7 1.4-1.7 2.8', 'M12 18.3v.2'],

    // Map structure
    folder: ['M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z'],
    tool: ['M13 3L5 13.5h6L10 21l8.5-11h-6z'],
    file: ['M6 3h9l4 4v14H6z', 'M14.5 3v4.5H19'],
    vault: ['M12 3l7.5 3v5.5c0 4.5-3 8-7.5 9.5-4.5-1.5-7.5-5-7.5-9.5V6z', 'M9 12l2.2 2.2L15 10.4'],

    // Application fallbacks
    terminal: [
      'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
      'M7 10l3 2.5L7 15',
      'M12.5 15h4'
    ],
    pointer: ['M6 3.5v15l4.2-3.6 2.6 5.6 2.4-1.1-2.6-5.5H18z'],
    braces: [
      'M9 4C7 4 6 5 6 7v2.5C6 11 5.2 12 4 12c1.2 0 2 1 2 2.5V17c0 2 1 3 3 3',
      'M15 4c2 0 3 1 3 3v2.5c0 1.5.8 2.5 2 2.5-1.2 0-2 1-2 2.5V17c0 2-1 3-3 3'
    ],
    app: [
      'M5 4h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 4z',
      'M3.5 8.5h17',
      'M6.6 6.3h.1',
      'M9.2 6.3h.1'
    ],
    atlas: ['M7 16.5L12 6', 'M7 16.5l10.5-2', 'M7 19.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']
  };

  var ARTIFACT_TYPE_ICON = {
    REGENERABLE_CACHE: 'cache',
    TEMP_FILE: 'temp',
    LOG: 'log',
    BUILD_OUTPUT: 'build',
    DERIVED_DATA: 'derived',
    SESSION_HISTORY: 'session',
    USER_CONTENT: 'source',
    MODEL_DATA: 'model',
    CHECKPOINT: 'checkpoint',
    UNKNOWN: 'unknown'
  };

  var NODE_TYPE_ICON = {
    WORKSPACE: 'folder',
    FOLDER: 'folder',
    SESSION: 'session',
    OPERATION: 'tool',
    UNKNOWN_ORIGIN: 'unknown'
  };

  function forArtifactType(type) {
    return ARTIFACT_TYPE_ICON[type] || 'unknown';
  }

  // Known applications that have a logo file in logos/. Used when the application's own
  // icon cannot be read from its bundle, and for the built-in sample apps.
  // The first match wins. A null entry means: no logo, the neutral glyph is shown.
  var APP_LOGOS = [
    [/claude[ -]?code/, 'claudecode'],
    [/claude/, 'claude'],
    [/cursor/, 'cursor'],
    // Windsurf is now Devin Desktop, which has no mark in the logo set
    [/devin/, null],
    [/windsurf|codeium/, 'windsurf'],
    [/ollama/, 'ollama'],
    [/lm ?studio/, 'lmstudio'],
    [/\bzed\b/, 'zedindustries'],
    [/gemini/, 'googlegemini'],
    [/copilot/, 'githubcopilot'],
    [/perplexity/, 'perplexity'],
    [/\btrae\b/, 'trae']
  ];

  // The name and bundle identifier decide; the adapter only when they match nothing, so
  // the Claude app (read with the Claude Code adapter) keeps its own mark.
  function logoForApp(app) {
    var own = [app && app.name, app && app.bundleId].join(' ').toLowerCase();
    var adapter = String((app && app.adapterId) || '').toLowerCase();
    for (var pass = 0; pass < 2; pass++) {
      var text = pass === 0 ? own : adapter;
      for (var i = 0; i < APP_LOGOS.length; i++) {
        if (APP_LOGOS[i][0].test(text)) return APP_LOGOS[i][1];
      }
    }
    return null;
  }

  // Fallback glyph for an application, chosen from its adapter or name.
  function forApp(app) {
    var text = [app && app.adapterId, app && app.name, app && app.bundleId].join(' ').toLowerCase();
    if (/cursor/.test(text)) return 'pointer';
    // Codex, in the CLI or in the ChatGPT app that now hosts it
    if (/codex/.test(text)) return 'braces';
    if (/claude|terminal|iterm|warp|aider/.test(text)) return 'terminal';
    return 'app';
  }

  // Icon for a map node: { nodeType, artifactType, metadata }.
  function forNode(node) {
    if (!node) return 'unknown';
    if (node.nodeType === 'AI_APPLICATION') return forApp(node.metadata || { name: node.label });
    if (node.nodeType === 'ARTIFACT' || node.nodeType === 'ARTIFACT_GROUP') {
      return forArtifactType(node.artifactType || (node.metadata && node.metadata.artifactType));
    }
    return NODE_TYPE_ICON[node.nodeType] || 'unknown';
  }

  // Inline SVG markup. The stroke follows the surrounding text color.
  function svg(name, size, className) {
    var paths = PATHS[name] || PATHS.unknown;
    var px = size || 16;
    return (
      '<svg class="' + (className || 'icon') + '" width="' + px + '" height="' + px +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      paths.map(function (d) { return '<path d="' + d + '"/>'; }).join('') +
      '</svg>'
    );
  }

  var path2dCache = {};

  // Draws an icon centered on (cx, cy) in a 2D canvas context.
  function draw(ctx, name, cx, cy, size, color) {
    var paths = PATHS[name] || PATHS.unknown;
    var key = PATHS[name] ? name : 'unknown';
    if (!path2dCache[key]) {
      path2dCache[key] = paths.map(function (d) { return new Path2D(d); });
    }
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    path2dCache[key].forEach(function (p) { ctx.stroke(p); });
    ctx.restore();
  }

  global.AtlasIcons = {
    paths: PATHS,
    artifactTypeIcons: ARTIFACT_TYPE_ICON,
    forArtifactType: forArtifactType,
    forApp: forApp,
    logoForApp: logoForApp,
    forNode: forNode,
    svg: svg,
    draw: draw
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
