'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const adminData = require('../admin-db');
const { server } = require('../server');

const originalGetSettings = adminData.getSettings;
test.before(async () => {
  adminData.getSettings = async () => ({});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
});
test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  adminData.getSettings = originalGetSettings;
});

test('pages are served with CSP, framing, referrer and sniffing protections', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/contact.html`);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", "connect-src 'self'"]) assert.ok(csp.includes(directive), directive);
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
});

test('the CSP still permits the Google Fonts stylesheet the home page imports', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
  assert.match(html, /@import url\('https:\/\/fonts\.googleapis\.com\//);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
});

test('static assets advertise cache validators and gzip when supported', async () => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/public-pages.css`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /max-age=3600/);
  assert.ok(response.headers.get('etag'));
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  const cached = await fetch(`http://127.0.0.1:${server.address().port}/public-pages.css`, { headers: { 'If-None-Match': response.headers.get('etag') } });
  assert.equal(cached.status, 304);
});
