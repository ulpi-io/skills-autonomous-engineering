/* Autonomous Engineering Skills — progressive site behavior */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  var reduceMotion = Boolean(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  /* Theme: auto -> light -> dark. The saved choice is intentionally tiny and
     failure-tolerant so blocked storage never blocks the rest of the site. */
  var themeOrder = ['auto', 'light', 'dark'];
  var themeStorageKey = 'ae-theme';
  var themeButtons = Array.prototype.slice.call(document.querySelectorAll(
    '#theme, .themebtn, .theme-toggle, [data-theme-toggle]'
  ));

  function readStoredTheme() {
    try {
      var stored = window.localStorage.getItem(themeStorageKey);
      return themeOrder.indexOf(stored) !== -1 ? stored : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredTheme(theme) {
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch (_) {
      /* Theme still works for this page when storage is unavailable. */
    }
  }

  function updateThemeButtons(theme) {
    themeButtons.forEach(function (button) {
      var label = button.querySelector('[data-theme-label]');
      var text = '\u25d0 ' + theme;
      if (label) {
        label.textContent = theme;
      } else {
        button.textContent = text;
      }
      button.setAttribute('aria-label', 'Color theme: ' + theme + '. Activate for next theme.');
      button.setAttribute('title', 'Color theme: ' + theme);
      button.setAttribute('data-theme-state', theme);
    });
  }

  function setTheme(theme, persist) {
    var safeTheme = themeOrder.indexOf(theme) === -1 ? 'auto' : theme;
    root.setAttribute('data-theme', safeTheme);
    updateThemeButtons(safeTheme);
    if (persist) writeStoredTheme(safeTheme);
  }

  setTheme(readStoredTheme() || root.getAttribute('data-theme') || 'auto', false);

  themeButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var current = root.getAttribute('data-theme') || 'auto';
      var next = themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length];
      setTheme(next, true);
    });
  });

  /* Mobile navigation. The nav stays visible without JS; only the enhanced
     version becomes a dismissible drawer. */
  var navToggles = Array.prototype.slice.call(document.querySelectorAll(
    '.nav-toggle, [data-nav-toggle]'
  ));

  function navFor(toggle) {
    var id = toggle.getAttribute('aria-controls');
    return (id && document.getElementById(id)) || document.querySelector('.site-nav, .bar nav');
  }

  function setNav(toggle, open, restoreFocus) {
    var nav = navFor(toggle);
    if (!nav) return;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    nav.setAttribute('data-open', open ? 'true' : 'false');
    nav.classList.toggle('is-open', open);
    if (!open && restoreFocus) toggle.focus();
  }

  navToggles.forEach(function (toggle) {
    setNav(toggle, false, false);
    toggle.addEventListener('click', function () {
      setNav(toggle, toggle.getAttribute('aria-expanded') !== 'true', false);
    });

    var nav = navFor(toggle);
    if (nav) {
      nav.addEventListener('click', function (event) {
        if (event.target.closest('a')) setNav(toggle, false, false);
      });
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    navToggles.forEach(function (toggle) {
      if (toggle.getAttribute('aria-expanded') === 'true') setNav(toggle, false, true);
    });
  });

  document.addEventListener('click', function (event) {
    navToggles.forEach(function (toggle) {
      if (toggle.getAttribute('aria-expanded') !== 'true') return;
      var nav = navFor(toggle);
      if (nav && !nav.contains(event.target) && !toggle.contains(event.target)) {
        setNav(toggle, false, false);
      }
    });
  });

  if (window.matchMedia) {
    var desktop = window.matchMedia('(min-width: 761px)');
    var resetNav = function (event) {
      if (event.matches) navToggles.forEach(function (toggle) { setNav(toggle, false, false); });
    };
    if (desktop.addEventListener) desktop.addEventListener('change', resetNav);
    else if (desktop.addListener) desktop.addListener(resetNav);
  }

  /* Mark the current static route when a template did not do it already. */
  function normalizedPath(value) {
    try {
      var url = new URL(value, window.location.href);
      if (url.origin !== window.location.origin) return null;
      var path = url.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '/');
      return path || '/';
    } catch (_) {
      return null;
    }
  }

  var here = normalizedPath(window.location.href);
  document.querySelectorAll('.site-nav a[href], .bar nav a[href]').forEach(function (link) {
    if (link.hasAttribute('aria-current')) return;
    var there = normalizedPath(link.href);
    if (there && there === here) link.setAttribute('aria-current', 'page');
  });

  /* Copy buttons use event delegation so every generated page gets the same
     behavior. There is a selection fallback for non-secure/local previews. */
  function sourceForCopy(button) {
    var id = button.getAttribute('data-copy-target') || button.getAttribute('data-c');
    if (!id) {
      var raw = button.getAttribute('data-copy');
      if (raw && raw.charAt(0) === '#') id = raw.slice(1);
    }
    if (id) return document.getElementById(id);
    return button.closest('.cmdrow, .command-row, .copy-row, .code-block')?.querySelector('code, pre');
  }

  function fallbackCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.pointerEvents = 'none';
      document.body.appendChild(area);
      area.select();
      try {
        var copied = document.execCommand('copy');
        area.remove();
        copied ? resolve() : reject(new Error('copy command was rejected'));
      } catch (error) {
        area.remove();
        reject(error);
      }
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  function announceCopy(button, state) {
    if (!button.dataset.copyLabel) button.dataset.copyLabel = button.textContent.trim() || 'copy';
    window.clearTimeout(Number(button.dataset.copyTimer || 0));
    button.dataset.copied = state === 'copied' ? 'true' : 'false';
    button.textContent = state;
    button.setAttribute('aria-label', state === 'copied' ? 'Copied to clipboard' : 'Copy failed');
    button.dataset.copyTimer = String(window.setTimeout(function () {
      button.textContent = button.dataset.copyLabel;
      button.dataset.copied = 'false';
      button.setAttribute('aria-label', 'Copy command');
    }, 1500));
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('.cp, .copy-button, .command-row .copy, .copy-row [data-copy], [data-copy-target]');
    if (!button) return;
    var source = sourceForCopy(button);
    if (!source) return;
    copyText(source.textContent.trim()).then(
      function () { announceCopy(button, 'copied'); },
      function () { announceCopy(button, 'failed'); }
    );
  });

  /* Content is visible in raw HTML. We hide only after JS is known-good and
     always remove the hidden state through a short hard fail-safe. */
  var automaticRevealSelectors = [
    '#main > section:not(.hero):not(.page-hero) .section-head',
    '#main > section:not(.hero):not(.page-hero) .shead',
    '#main > section:not(.hero):not(.page-hero) .fails',
    '#main > section:not(.hero):not(.page-hero) .matrix',
    '#main > section:not(.hero):not(.page-hero) .comparison-table',
    '#main > section:not(.hero):not(.page-hero) .contract',
    '#main > section:not(.hero):not(.page-hero) .cmdrow',
    '#main > section:not(.hero):not(.page-hero) .install-callout'
  ].join(',');

  document.querySelectorAll(automaticRevealSelectors).forEach(function (element) {
    element.classList.add('reveal');
  });

  var revealElements = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  function revealAll() {
    revealElements.forEach(function (element) { element.classList.remove('pre'); });
  }

  if (!reduceMotion && 'IntersectionObserver' in window) {
    revealElements.forEach(function (element) { element.classList.add('pre'); });
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove('pre');
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -4% 0px' });
    revealElements.forEach(function (element) { revealObserver.observe(element); });
    window.setTimeout(revealAll, 1800);
  } else {
    revealAll();
  }

  /* Optional terminal transcript. This is the site's only sequential motion. */
  document.querySelectorAll('.term.type, .terminal.type').forEach(function (terminal) {
    var lines = Array.prototype.slice.call(terminal.querySelectorAll('.ln'));
    if (!lines.length || reduceMotion || !('IntersectionObserver' in window)) {
      terminal.classList.remove('type');
      lines.forEach(function (line) { line.style.opacity = '1'; });
      return;
    }

    var started = false;
    var terminalObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || started) return;
        started = true;
        terminal.classList.add('run');
        terminalObserver.disconnect();
        var index = 0;
        var step = function () {
          if (index >= lines.length) return;
          lines[index].style.opacity = '1';
          var pause = lines[index].classList.contains('bad') ? 500 : 140;
          index += 1;
          window.setTimeout(step, pause);
        };
        window.setTimeout(step, 220);
      });
    }, { threshold: 0.22 });

    terminalObserver.observe(terminal);
    window.setTimeout(function () {
      if (started) return;
      terminal.classList.add('run');
      lines.forEach(function (line) { line.style.opacity = '1'; });
    }, 2200);
  });

  /* Shared analytics. The script tag owns the property ID so this file stays
     reusable at every directory depth and still reports the full Pages path. */
  var script = document.currentScript || document.querySelector('script[data-ga-id]');
  var gaId = script && script.getAttribute('data-ga-id');
  if (gaId) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', gaId, {
      page_location: window.location.href,
      page_path: window.location.pathname + window.location.search
    });
  }

  /* Clarity is deliberately opt-in. Pages may add data-clarity-id to this
     script once the repository has a real project ID; an absent/empty or
     malformed value never causes a network request. */
  var clarityId = script && (script.getAttribute('data-clarity-id') || '').trim();
  if (clarityId && /^[a-z0-9]+$/i.test(clarityId)) {
    window.clarity = window.clarity || function () {
      (window.clarity.q = window.clarity.q || []).push(arguments);
    };
    var clarityScript = document.createElement('script');
    clarityScript.async = true;
    clarityScript.src = 'https://www.clarity.ms/tag/' + encodeURIComponent(clarityId);
    var firstScript = document.getElementsByTagName('script')[0];
    if (firstScript && firstScript.parentNode) {
      firstScript.parentNode.insertBefore(clarityScript, firstScript);
    } else {
      document.head.appendChild(clarityScript);
    }
  }
})();
