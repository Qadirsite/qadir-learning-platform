'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const adminPage = readFileSync(join(__dirname, '..', 'site', 'admin-page.js'), 'utf8');

test('admin role selectors are restored after the account list finishes loading', () => {
  const start = adminPage.indexOf('async function loadUsers()');
  const end = adminPage.indexOf('function addPermissionInputs(', start);
  assert.ok(start >= 0 && end > start, 'account loader exists');

  const loader = adminPage.slice(start, end);
  assert.match(loader, /state\.busy = true;\s*setRoleControlsDisabled\(true\);/);
  assert.match(loader, /state\.busy = false;\s*setRoleControlsDisabled\(false\);/);
  assert.match(adminPage, /function setRoleControlsDisabled\(disabled\)\s*\{\s*list\.querySelectorAll\('\.user-role-select'\)\.forEach\(control => \{ control\.disabled = disabled; \}\);/);
});

test('admin account deletion is permission-gated and explicitly confirmed', () => {
  assert.match(adminPage, /function canDeleteUser\(user\)/);
  assert.match(adminPage, /window\.confirm\(`حذف حساب \$\{user\.username\} نهائيًا/);
  assert.match(adminPage, /\/api\/admin\/users\/delete/);
  assert.match(adminPage, /deleteButton\.textContent='حذف الحساب'/);
});
