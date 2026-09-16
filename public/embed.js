(function () {
  // Capture this synchronously: currentScript is null in DOMContentLoaded callbacks.
  var script = document.currentScript;
  var BASE = script && script.src
    ? new URL('.', script.src).href.replace(/\/$/, '')
    : 'https://yap.pr';

  function run() {
    var elements = document.querySelectorAll('[data-yappr-post]:not([data-yappr-loaded])');

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var postId = el.getAttribute('data-yappr-post');
      var ownerId = el.getAttribute('data-yappr-owner') || '';
      var theme = el.getAttribute('data-yappr-theme') || 'light';

      if (!postId) continue;

      var src = BASE + '/embed/?post=' + encodeURIComponent(postId);
      if (ownerId) src += '&owner=' + encodeURIComponent(ownerId);
      src += '&theme=' + encodeURIComponent(theme);

      var iframe = document.createElement('iframe');
      iframe.src = src;
      iframe.width = '100%';
      iframe.height = '600';
      iframe.style.border = 'none';
      iframe.style.maxWidth = '100%';
      iframe.title = 'Yappr embedded post';
      // allow-scripts + allow-same-origin: required for SDK (WASM, DAPI fetch, storage).
      // The escape-sandbox risk only applies when parent and iframe share the same origin;
      // embeds are loaded on third-party sites (different origin from yap.pr).
      // Let a user click "View on Yappr" to open the article in the host tab.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-top-navigation-by-user-activation');
      iframe.loading = 'lazy';

      el.appendChild(iframe);
      el.setAttribute('data-yappr-loaded', 'true');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
