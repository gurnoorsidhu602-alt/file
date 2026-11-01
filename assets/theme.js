// Theme preference (light by default) shared by all pages, plus small helpers.
// The inline snippet in each page's <head> applies the saved theme before
// first paint; this file wires up the toggle button.
(function () {
  const KEY = 'theme';
  const get = () => { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } };
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.setAttribute('aria-pressed', String(t === 'dark'));
      const l = b.querySelector('.label'); if (l) l.textContent = t === 'dark' ? 'Dark' : 'Light';
    });
  };
  window.setTheme = (t) => { try { localStorage.setItem(KEY, t); } catch {} apply(t); };
  document.addEventListener('DOMContentLoaded', () => {
    apply(get());
    document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => window.setTheme(get() === 'dark' ? 'light' : 'dark')));
  });
  // Keep other open tabs in sync.
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(get()); });
})();
