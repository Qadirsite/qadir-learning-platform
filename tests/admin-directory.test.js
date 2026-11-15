'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const html = readFileSync(join(root,'site','admin-admins.html'),'utf8');
const client = readFileSync(join(root,'site','admin-admins.js'),'utf8');
const admin = readFileSync(join(root,'site','admin-console.js'),'utf8');
const routes = readFileSync(join(root,'site','manus-routes.json'),'utf8');

test('admin directory lists assigned admins and returns the selected recipient', () => {
  assert.match(html, /دليل الإداريين/);
  assert.match(html, /admin-directory-list/);
  assert.match(html, /id="copy-admin-names"/);
  assert.match(client, /\/api\/admin\/messages\/recipients/);
  assert.match(client, /admin\.html\?section=internal-messages&recipient=/);
  assert.match(client, /navigator\.clipboard\.writeText/);
  assert.match(client, /تم نسخ الأسماء/);
  assert.match(admin, /requestedRecipient/);
  assert.match(routes, /admin-admins\.html/);
});
