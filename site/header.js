// Once the page is scrolled, the top bar becomes a small floating bar: the emblem and the
// links, without the name. It eases back at the top of the page.
(function () {
  var bar = document.querySelector('.topbar');
  if (!bar) return;
  var pending = false;
  function update() {
    pending = false;
    bar.classList.toggle('is-compact', window.scrollY > 24);
  }
  window.addEventListener('scroll', function () {
    if (!pending) {
      pending = true;
      window.requestAnimationFrame(update);
    }
  }, { passive: true });
  update();
})();
