// "One prompt, and what it leaves behind": a conversation with a coding assistant on the left,
// the files it leaves on disk appearing on the right. An illustration with made-up numbers.
// Plays when it comes into view, loops, and shows its final state when motion is reduced.
(function () {
  var root = document.getElementById('story');
  if (!root) return;
  var chat = root.querySelector('.story-chat');
  var disk = root.querySelector('.story-disk-list');
  var total = root.querySelector('.story-total');
  var replay = root.querySelector('.story-replay');

  // Each step: a message in the conversation, and the files it leaves
  var STEPS = [
    { who: 'you', text: 'Add a checkout page with tests.' },
    { who: 'ai', text: 'I’ll create the page, install the payment library and add tests.' },
    { who: 'tool', text: 'Write src/checkout/page.tsx', files: [['project', 'src/checkout/page.tsx', 1, 6200]] },
    { who: 'tool', text: 'Run npm install', files: [['project', 'node_modules/', 1204, 38900000]] },
    { who: 'tool', text: 'Write tests/checkout.test.ts', files: [['project', 'tests/checkout.test.ts', 1, 3100]] },
    { who: 'tool', text: 'Run npm test', files: [['outside', '~/.cache/jest/', 312, 4400000], ['outside', '/tmp/checkout-preview.png', 1, 812000]] },
    { who: 'ai', text: 'Done. The page and its tests pass.', files: [['kept', '~/.claude/projects/shop/session.jsonl', 1, 2300000], ['kept', '~/.claude/todos/', 3, 9000], ['kept', '~/.claude/shell-snapshots/', 6, 48000]] }
  ];
  var GROUPS = { project: 'In your project', outside: 'Outside your projects', kept: 'Kept by the app for this session' };

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];
  var files = 0;
  var bytes = 0;
  var codeFiles = 0;
  var codeBytes = 0;
  var beyond = root.querySelector('.story-beyond');

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
  function groupBox(key) {
    var box = disk.querySelector('[data-group="' + key + '"]');
    if (!box) {
      box = el('div', 'story-group');
      box.setAttribute('data-group', key);
      box.appendChild(el('div', 'story-group-title', GROUPS[key]));
      disk.appendChild(box);
    }
    return box;
  }
  function addFile(f, animate) {
    var row = el('div', 'story-file' + (animate ? ' enter' : ''));
    row.appendChild(el('span', 'story-path', f[1]));
    row.appendChild(el('span', 'story-size', (f[2] > 1 ? f[2].toLocaleString('en-US') + ' files · ' : '') + fmt(f[3])));
    groupBox(f[0]).appendChild(row);
    files += f[2];
    bytes += f[3];
    total.textContent = '1 prompt · ' + files.toLocaleString('en-US') + (files === 1 ? ' file · ' : ' files · ') + fmt(bytes);
    // The code it was asked for: files it wrote in the project
    if (f[0] === 'project' && f[2] === 1) {
      codeFiles += 1;
      codeBytes += f[3];
    }
  }
  function addMessage(step, animate) {
    var bubble = el('div', 'story-msg ' + step.who + (animate ? ' enter' : ''));
    if (step.who === 'tool') bubble.appendChild(el('span', 'story-tool-dot'));
    bubble.appendChild(document.createTextNode(step.text));
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
  }
  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    chat.textContent = '';
    disk.textContent = '';
    files = 0;
    bytes = 0;
    codeFiles = 0;
    codeBytes = 0;
    total.textContent = '1 prompt';
    beyond.textContent = '';
    root.classList.remove('done');
  }
  function finish() {
    beyond.textContent = 'The code it wrote: ' + codeFiles + ' files, ' + fmt(codeBytes) + '. Everything else came with it.';
    root.classList.add('done');
  }
  function play() {
    reset();
    if (reduce) {
      STEPS.forEach(function (s) {
        addMessage(s, false);
        (s.files || []).forEach(function (f) { addFile(f, false); });
      });
      finish();
      return;
    }
    var t = 300;
    STEPS.forEach(function (s) {
      timers.push(setTimeout(function () { addMessage(s, true); }, t));
      (s.files || []).forEach(function (f, i) {
        timers.push(setTimeout(function () { addFile(f, true); }, t + 650 + i * 380));
      });
      t += s.who === 'you' ? 1300 : 1500 + (s.files ? s.files.length * 380 : 0);
    });
    timers.push(setTimeout(finish, t));
    // Loop while it stays on screen
    timers.push(setTimeout(function () { if (visible) play(); }, t + 6000));
  }

  var visible = false;
  var started = false;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible && !started) {
        started = true;
        play();
      }
    }, { threshold: 0.35 }).observe(root);
  } else {
    play();
  }
  replay.addEventListener('click', play);
})();
