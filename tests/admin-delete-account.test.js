'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const adminData = require('../admin-db');
const { server } = require('../server');

const csrfSecret = Buffer.from('qadir-admin-delete-test-secret-32b');
const tokens = { owner: 'O'.repeat(43), admin: 'A'.repeat(43), student: 'S'.repeat(43) };
const accounts = new Map([
  ['ak9', { id: 9, username: 'ak9', role: 'admin' }],
  ['admin_one', { id: 1, username: 'admin_one', role: 'admin' }],
  ['admin_two', { id: 4, username: 'admin_two', role: 'admin' }],
  ['student_one', { id: 2, username: 'student_one', role: 'student' }]
]);
const deleted = [];
let originals = {};
function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }
async function csrfFor(token) {
  const response = await fetch(`${baseUrl()}/api/auth/session`, { headers: { cookie: `qadir_session=${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()).csrfToken;
}
async function requestDelete(token, csrfToken, username, includeCsrf = true) {
  const headers = { 'content-type': 'application/json', cookie: `qadir_session=${token}` };
  if (includeCsrf) headers['x-csrf-token'] = csrfToken;
  return fetch(`${baseUrl()}/api/admin/users/delete`, {
    method: 'POST', headers, body: JSON.stringify({ username, confirm: true })
  });
}

test.before(async () => {
  for (const name of ['getCsrfSecret', 'getSessionUser', 'hasPermission']) originals[name] = db[name];
  originals.deleteUser = adminData.deleteUser;
  db.getCsrfSecret = async () => csrfSecret;
  db.getSessionUser = async tokenHash => {
    const token = Object.values(tokens).find(value => digest(value).equals(tokenHash));
    if (!token) return null;
    const username = token === tokens.owner ? 'ak9' : token === tokens.admin ? 'admin_one' : 'student_one';
    const account = accounts.get(username);
    return account ? { ...account } : null;
  };
  db.hasPermission = async (userId, permission) => permission === 'users.manage' && [1, 9].includes(Number(userId));
  adminData.deleteUser = async (actor, username) => {
    const target = accounts.get(username);
    if (!target) return { error: 'not_found' };
    if (username === 'ak9' || username === actor.username) return { error: 'protected' };
    if (actor.username !== 'ak9' && target.role === 'admin') return { error: 'hierarchy' };
    accounts.delete(username);
    deleted.push({ actor: actor.username, username });
    return { deleted: true, username };
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  for (const [name, method] of Object.entries(originals)) {
    if (name === 'deleteUser') adminData[name] = method;
    else db[name] = method;
  }
});

test('administrator account deletion enforces CSRF, permission and hierarchy', async () => {
  const ownerCsrf = await csrfFor(tokens.owner);
  const adminCsrf = await csrfFor(tokens.admin);
  const studentCsrf = await csrfFor(tokens.student);

  const missingCsrf = await requestDelete(tokens.admin, '', 'student_one', false);
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(deleted, []);

  const student = await requestDelete(tokens.student, studentCsrf, 'student_one');
  assert.equal(student.status, 403);
  assert.deepEqual(deleted, []);

  const protectedOwner = await requestDelete(tokens.admin, adminCsrf, 'ak9');
  assert.equal(protectedOwner.status, 409);
  assert.deepEqual(deleted, []);

  const equalRank = await requestDelete(tokens.admin, adminCsrf, 'admin_two');
  assert.equal(equalRank.status, 403);
  assert.deepEqual(deleted, []);

  const removed = await requestDelete(tokens.admin, adminCsrf, 'student_one');
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: true, username: 'student_one' });
  assert.deepEqual(deleted, [{ actor: 'admin_one', username: 'student_one' }]);

  const ownerDelete = await requestDelete(tokens.owner, ownerCsrf, 'admin_one');
  assert.equal(ownerDelete.status, 200);
  assert.deepEqual(await ownerDelete.json(), { deleted: true, username: 'admin_one' });
});
