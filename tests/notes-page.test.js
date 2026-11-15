'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'site', 'notes.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'site', 'notes-page.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'site', 'manus-routes.json'), 'utf8');

test('notes are a standalone page with student send and reply flows', () => {
  assert.match(page, /href="\/notes\.html"/);
  assert.match(page, /id="notes-app"/);
  assert.match(client, /\/api\/auth\/session/);
  assert.match(client, /\/api\/contact\/threads/);
  assert.match(client, /\/api\/contact/);
  assert.match(client, /إرسال الملاحظة للإدارة/);
  assert.match(routes, /"path": "\/notes\.html"/);
});
test('public shell provides mobile navigation and learning shortcuts', () => {
  const nav = fs.readFileSync(path.join(root, 'site', 'public-nav.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'site', 'public-pages.css'), 'utf8');
  assert.match(nav, /mobile-menu-toggle/);
  assert.match(nav, /qadir-journey-bar/);
  assert.match(nav, /Escape/);
  assert.match(styles, /mobile-menu-drawer/);
  assert.match(styles, /qadir-journey-bar/);
});
