// The ONLY place the site name is written (besides the static <title> and the two
// pre-JS placeholders in index.html, which are overwritten at load).
// To rename the site, change the two strings below. Do NOT touch DB_NAME in
// storage.js: it is a storage key, not a label, and renaming it orphans saved photos.
(function () {
  var SITE = { name: 'Sinopia', slug: 'sinopia' };   // <- change here
  window.SITE = SITE;
  document.title = SITE.name;
  function fill() {
    var els = document.querySelectorAll('[data-site-name]');
    for (var i = 0; i < els.length; i++) els[i].textContent = SITE.name;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
