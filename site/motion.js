// Scroll motion for the rest of the page, in the style of the conversation above: items of a
// section come in one after another as it scrolls into view, and leave again when it scrolls
// back below the window, so scrolling up rewinds. Survey grids fill dot by dot while their
// numbers count up. Nothing moves when the visitor asks for reduced motion.
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('motion');

  // Items that come in one after another, numbered within their group
  var GROUPS = ['.rows', '.principles', '.app-tiers', '.stats', '.steps', '.spec-body > .callout'];
  GROUPS.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (group) {
      Array.prototype.forEach.call(group.children, function (child, i) {
        child.classList.add('reveal');
        child.style.setProperty('--i', String(Math.min(i, 8)));
      });
    });
  });
  document.querySelectorAll('.spec > h2, .spec-body > p:first-child, .figure-note, .spec-body > .note').forEach(function (el) {
    el.classList.add('reveal');
  });
  // Permission pages: each heading with what follows it, and the cards of the index
  document.querySelectorAll('body.doc main h2, body.doc main h2 ~ p, body.doc main h2 ~ ul, body.doc main h2 ~ ol, body.doc main .warn').forEach(function (el) {
    el.classList.add('reveal');
  });
  var cards = document.querySelectorAll('body.doc a.card');
  Array.prototype.forEach.call(cards, function (card, i) {
    card.classList.add('reveal');
    card.style.setProperty('--i', String(Math.min(i, 8)));
  });


  // Numbers count up to their published value, written the way the source wrote it
  function countUp(dt) {
    var text = dt.getAttribute('data-final') || dt.textContent;
    dt.setAttribute('data-final', text);
    var m = /^([\d.]+)(%|M)?$/.exec(text.trim());
    if (!m) return;
    var target = parseFloat(m[1]);
    var decimals = (m[1].split('.')[1] || '').length;
    // The grid next to a percentage lights one dot for each point the number passes
    var dots = m[2] === '%' ? dt.parentNode.querySelectorAll('.waffle circle.on') : [];
    var start = null;
    function frame(t) {
      if (start === null) start = t;
      var k = Math.min(1, (t - start) / 1300);
      var eased = 1 - Math.pow(1 - k, 3);
      var value = target * eased;
      dt.textContent = value.toFixed(decimals) + (m[2] || '');
      for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('lit', i < Math.round(value));
      if (k < 1 && dt.isConnected) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (entry.isIntersecting) {
        if (!el.classList.contains('in')) {
          el.classList.add('in');
          var dt = el.querySelector && el.querySelector(':scope > dt');
          if (dt && el.classList.contains('stat')) countUp(dt);
        }
      } else if (entry.boundingClientRect.top > 0) {
        // Scrolled back up past it: it leaves, and comes in again next time
        el.classList.remove('in');
        el.querySelectorAll && el.querySelectorAll('.waffle circle.lit').forEach(function (d) { d.classList.remove('lit'); });
      }
    });
  }, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { observer.observe(el); });
})();
