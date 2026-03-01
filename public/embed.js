(function () {
  var BASE = 'https://yap.pr';

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
