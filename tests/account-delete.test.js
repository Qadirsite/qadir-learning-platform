'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const adminData = require('../admin-db');
const { server } = require('../server');

const csrfSecret = Buffer.from('qadir-delete-test-secret-32-byte!');
const token = 'a'.repeat(43);
const password = 'correct horse battery';
const salt = crypto.randomBytes(16);
let passwordHash;
let currentUser;
let deletedIds = [];
const originals = {};

const student = { id: 7, username: 'student_one', role: 'student', role_label: 'طالب', role_priority: 0, permissions: [] };
function scrypt(value, saltBytes) {
  return new Promise((resolve, reject) => crypto.scrypt(value, saltBytes, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }
async function getCsrf(cookie = `qadir_session=${token}`) {
  const response = await fetch(`${baseUrl()}/api/auth/session`, { headers: cookie ? { cookie } : {} });
  return (await response.json()).csrfToken;
}
function remove(csrf, body, { cookie = `qadir_session=${token}` } = {}) {
  return fetch(`${baseUrl()}/api/auth/account/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
}

test.before(async () => {
  passwordHash = await scrypt(password, salt);
  for (const [owner, name] of [[db, 'getCsrfSecret'], [db, 'getSessionUser'], [db, 'getUserForLogin'], [db, 'deleteAccount'], [adminData, 'getSettings']]) originals[name] = owner[name];
  db.getCsrfSecret = async () => csrfSecret;
  db.getSessionUser = async () => currentUser;
  db.getUserForLogin = async username => ({ id: currentUser.id, username, password_salt: salt, password_hash: passwordHash, is_active: 1 });
  db.deleteAccount = async id => { deletedIds.push(id); return { deleted: true }; };
  adminData.getSettings = async () => ({});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
});
test.beforeEach(() => { currentUser = { ...student }; deletedIds = []; });
test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  db.getCsrfSecret = originals.getCsrfSecret; db.getSessionUser = originals.getSessionUser;
  db.getUserForLogin = originals.getUserForLogin; db.deleteAccount = originals.deleteAccount; adminData.getSettings = originals.getSettings;
});

test('account deletion requires CSRF, a session and an explicit confirmation', async () => {
  const csrf = await getCsrf();
  const anonymousCsrf = await getCsrf('');
  assert.equal((await remove('', { password, confirm: true })).status, 403);
  assert.equal((await remove(anonymousCsrf, { password, confirm: true }, { cookie: '' })).status, 401);
  assert.equal((await remove(anonymousCsrf, { password })).status, 403, 'a token issued without a session is rejected on a session');
  assert.equal((await remove(csrf, { password })).status, 400);
  assert.deepEqual(deletedIds, []);
});

test('a wrong password never deletes the account and does not look like an expired session', async () => {
  const csrf = await getCsrf();
  const response = await remove(csrf, { password: 'not-the-password', confirm: true });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /كلمة المرور/);
  assert.deepEqual(deletedIds, []);
});

test('the system owner account cannot be deleted', async () => {
  currentUser = { ...student, id: 1, username: 'ak9', role: 'admin' };
  const response = await remove(await getCsrf(), { password, confirm: true });
  assert.equal(response.status, 403);
  assert.deepEqual(deletedIds, []);
});

test('correct password deletes the account and clears the session cookie', async () => {
  const response = await remove(await getCsrf(), { password, confirm: true });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.deleted, true);
  assert.equal(data.user, null);
  assert.deepEqual(deletedIds, [7]);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /qadir_session=;/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=None/);
});

test('repeated wrong-password deletion attempts are rate limited', async () => {
  currentUser = { ...student, id: 8, username: 'student_two' };
  const csrf = await getCsrf();
  const statuses = [];
  for (let i = 0; i < 11; i += 1) statuses.push((await remove(csrf, { password: 'wrong-password', confirm: true })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(403));
  assert.equal(statuses[10], 429);
  assert.deepEqual(deletedIds, []);
});

test('the account menu wires a confirmed, password-protected delete flow', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'site', 'auth-client.js'), 'utf8');
  assert.match(client, /\/api\/auth\/account\/delete/);
  assert.match(client, /data-action="delete-start"/);
  assert.match(client, /id="qa-delete-form"/);
  assert.match(client, /type="password"[^>]*autocomplete="current-password"/);
  assert.match(client, /confirm:true/);
});
