'use strict';
(() => {
  function visitorId() {
    try {
      let id = sessionStorage.getItem('qadir-visit-id-v1');
      if (!id) {
        id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('qadir-visit-id-v1', id);
      }
      return id;
    } catch {
      return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
    }
  }
  const path = location.pathname === '/index.html' ? '/' : location.pathname;
  fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(session => {
      if (!session?.csrfToken) return;
      return fetch('/api/metrics/visit', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ path, clientId: visitorId() })
      });
    })
    .catch(() => {});
})();
