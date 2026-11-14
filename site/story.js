// "One prompt, and what it leaves behind": a conversation with a coding assistant on the left,
// the files it leaves on disk on the right. Driven by scrolling: the stage stays in place
// while the page scrolls through it, each step appears in turn, and scrolling back rewinds.
// An illustration with example numbers. With reduced motion it shows its final state.
(function () {
  var root = document.getElementById('story');
  if (!root) return;
  var track = root.querySelector('.story-track');
  var chat = root.querySelector('.story-chat');
  var disk = root.querySelector('.story-disk-list');
  var total = root.querySelector('.story-total');
  var beyond = root.querySelector('.story-beyond');
  var bar = root.querySelector('.story-progress span');

  var STEPS = [
    { who: 'you', text: 'Add a checkout page with tests.' },
    { who: 'ai', text: 'I’ll create the page, install the payment library and add tests.' },
    { who: 'tool', text: 'Write src/checkout/page.tsx', files: [['project', 'src/checkout/page.tsx', 1, 6200, true]] },
    { who: 'tool', text: 'Run npm install', files: [['project', 'node_modules/', 1204, 38900000]] },
    { who: 'tool', text: 'Write tests/checkout.test.ts', files: [['project', 'tests/checkout.test.ts', 1, 3100, true]] },
    { who: 'tool', text: 'Run npm test', files: [['outside', '~/.cache/jest/', 312, 4400000], ['outside', '/tmp/checkout-preview.png', 1, 812000]] },
    { who: 'ai', text: 'Done. The page and its tests pass.', files: [['kept', '~/.claude/projects/shop/session.jsonl', 1, 2300000], ['kept', '~/.claude/todos/', 3, 9000], ['kept', '~/.claude/shell-snapshots/', 6, 48000]] }
  ];
  var GROUPS = [['project', 'In your project'], ['outside', 'Outside your projects'], ['kept', 'Kept by the app for this session']];

  function fmt(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return Math.round(b / 1e3) + ' KB';
    return b + ' B';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Everything is built once; scrolling only shows and hides it
  var groupEls = {};
  GROUPS.forEach(function (g) {
    var box = el('div', 'story-group');
    box.appendChild(el('div', 'story-group-title', g[1]));
    disk.appendChild(box);
    groupEls[g[0]] = box;
  });
  var beats = []; // one per thing that appears, in order
  STEPS.forEach(function (s) {
    var bubble = el('div', 'story-msg ' + s.who);
    if (s.who === 'tool') bubble.appendChild(el('span', 'story-tool-dot'));
    bubble.appendChild(document.createTextNode(s.text));
    chat.appendChild(bubble);
    beats.push({ node: bubble });
    (s.files || []).forEach(function (f) {
      var row = el('div', 'story-file');
      row.appendChild(el('span', 'story-path', f[1]));
      row.appendChild(el('span', 'story-size', (f[2] > 1 ? f[2].toLocaleString('en-US') + ' files · ' : '') + fmt(f[3])));
      groupEls[f[0]].appendChild(row);
      beats.push({ node: row, file: f, group: groupEls[f[0]] });
    });
  });

  var shown = -1;
  function render(count) {
    if (count === shown) return;
    shown = count;
    var files = 0;
    var bytes = 0;
    var code = 0;
    var codeBytes = 0;
    var groupsOn = {};
    beats.forEach(function (b, i) {
      var on = i < count;
      b.node.classList.toggle('on', on);
      if (on && b.file) {
        files += b.file[2];
        bytes += b.file[3];
        if (b.file[4]) {
          code += 1;
          codeBytes += b.file[3];
        }
        groupsOn[b.file[0]] = true;
      }
    });
    GROUPS.forEach(function (g) { groupEls[g[0]].classList.toggle('on', !!groupsOn[g[0]]); });
    total.textContent = '1 prompt' + (files ? ' · ' + files.toLocaleString('en-US') + (files === 1 ? ' file · ' : ' files · ') + fmt(bytes) : '');
    var done = count >= beats.length;
    root.classList.toggle('done', done);
    beyond.textContent = done ? 'The code it wrote: ' + code + ' files, ' + fmt(codeBytes) + '. Everything else came with it.' : '';
  }

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !track) {
    root.classList.add('static');
    render(beats.length);
    return;
  }

  var pending = false;
  function update() {
    pending = false;
    var rect = track.getBoundingClientRect();
    var span = rect.height - window.innerHeight;
    // 0 when the track's top reaches the top of the window, 1 when its end does
    var p = span > 0 ? Math.min(1, Math.max(0, -rect.top / span)) : 1;
    bar.style.transform = 'scaleX(' + p + ')';
    // The last stretch holds the finished picture
    render(Math.min(beats.length, Math.floor((p / 0.88) * beats.length + 0.0001)));
  }
  window.addEventListener('scroll', function () {
    if (!pending) {
      pending = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });
  window.addEventListener('resize', update);
  update();
})();
