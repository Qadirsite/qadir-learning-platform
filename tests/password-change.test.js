'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const adminData = require('../admin-db');
const { server, resetLoginAttempts } = require('../server');

const csrfSecret = Buffer.from('qadir-password-test-secret-32byte');
const token = 'c'.repeat(43);
const cookie = `qadir_session=${token}`;
const oldPassword = 'correct horse battery';
const salt = crypto.randomBytes(16);
const student = { id: 9, username: 'student_pw', role: 'student', role_label: 'طالب', role_priority: 0, permissions: [] };
const originals = {};
let oldHash; let calls = [];

const scrypt = (value, s) => new Promise((resolve, reject) => crypto.scrypt(value, s, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));
const url = path => `http://127.0.0.1:${server.address().port}${path}`;
async function csrf(withCookie = true) {
  return (await (await fetch(url('/api/auth/session'), { headers: withCookie ? { cookie } : {} })).json()).csrfToken;
}
const change = (csrfToken, body, withCookie = true) => fetch(url('/api/auth/password'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...(withCookie ? { cookie } : {}) },
  body: JSON.stringify(body)
});

test.before(async () => {
  oldHash = await scrypt(oldPassword, salt);
  for (const name of ['getCsrfSecret', 'getSessionUser', 'getUserForLogin', 'changePassword']) originals[name] = db[name];
  originals.getSettings = adminData.getSettings;
  db.getCsrfSecret = async () => csrfSecret;
  db.getSessionUser = async () => student;
  db.getUserForLogin = async username => ({ id: student.id, username, password_salt: salt, password_hash: oldHash, is_active: 1 });
  db.changePassword = async (...args) => { calls.push(args); };
  adminData.getSettings = async () => ({});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
});
test.beforeEach(() => { calls = []; resetLoginAttempts(); });
test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  Object.assign(db, { getCsrfSecret: originals.getCsrfSecret, getSessionUser: originals.getSessionUser, getUserForLogin: originals.getUserForLogin, changePassword: originals.changePassword });
  adminData.getSettings = originals.getSettings;
});

test('password change needs a session-bound CSRF token and a signed-in user', async () => {
  const body = { current: oldPassword, next: 'a brand new passphrase' };
  assert.equal((await change('', body)).status, 403);
  assert.equal((await change(await csrf(false), body)).status, 403);
  assert.equal(calls.length, 0);
});

test('wrong current password or unchanged password is rejected without touching the database', async () => {
  const token1 = await csrf();
  assert.equal((await change(token1, { current: 'wrong password!!', next: 'a brand new passphrase' })).status, 403);
  assert.equal((await change(token1, { current: oldPassword, next: oldPassword })).status, 400);
  assert.equal((await change(token1, { current: oldPassword, next: 'short' })).status, 400);
  assert.equal(calls.length, 0);
});

test('correct current password stores a new hash and keeps only the current session', async () => {
  const response = await change(await csrf(), { current: oldPassword, next: 'a brand new passphrase' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.changed, true);
  assert.equal(calls.length, 1);
  const [userId, hash, newSalt, keep] = calls[0];
  assert.equal(userId, student.id);
  assert.deepEqual(await scrypt('a brand new passphrase', newSalt), hash);
  assert.deepEqual(keep, crypto.createHash('sha256').update(token).digest());
  assert.ok(!JSON.stringify(data).includes('passphrase'));
});
