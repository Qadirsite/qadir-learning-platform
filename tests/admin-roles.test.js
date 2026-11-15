'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const { server } = require('../server');

const csrfSecret = Buffer.from('qadir-admin-role-test-secret-32b');
const tokens = {
  owner: 'O'.repeat(43),
  admin: 'A'.repeat(43),
  student: 'S'.repeat(43)
};
const accounts = new Map([
  ['ak9', { id: 9, username: 'ak9', role: 'admin', role_priority: 100 }],
  ['admin_one', { id: 1, username: 'admin_one', role: 'admin', role_priority: 80 }],
  ['moderator_one', { id: 3, username: 'moderator_one', role: 'moderator', role_priority: 50 }],
  ['student_one', { id: 2, username: 'student_one', role: 'student', role_priority: 0 }]
]);
let roleChangeCalls = 0;
const originalMethods = {};

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }

async function csrfFor(token) {
  const headers = token ? { cookie: `qadir_session=${token}` } : {};
  const response = await fetch(`${baseUrl()}/api/auth/session`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).csrfToken;
}

function baseUrl() {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function changeRole(token, csrfToken, username, role, includeCsrf = true) {
  const headers = { 'content-type': 'application/json', cookie: `qadir_session=${token}` };
  if (includeCsrf) headers['x-csrf-token'] = csrfToken;
  return fetch(`${baseUrl()}/api/admin/users/role`, {
    method: 'POST', headers, body: JSON.stringify({ username, role })
  });
}

test.before(async () => {
  for (const name of ['getCsrfSecret', 'getSessionUser', 'isCurrentAdmin', 'hasPermission', 'getAdminUsers', 'countAdminUsers', 'changeUserRole']) originalMethods[name] = db[name];
  db.getCsrfSecret = async () => csrfSecret;
  db.getSessionUser = async tokenHash => {
    const token = Object.values(tokens).find(value => digest(value).equals(tokenHash));
    if (!token) return null;
    const username = token === tokens.owner ? 'ak9' : token === tokens.admin ? 'admin_one' : 'student_one';
    const account = accounts.get(username);
    return { id: account.id, username: account.username, role: account.role };
  };
  const roleTable = new Map([
    ['student', { label: 'طالب', priority: 0, category: 'student' }],
    ['moderator', { label: 'مشرف', priority: 50, category: 'admin' }],
    ['admin', { label: 'مدير', priority: 80, category: 'admin' }]
  ]);
  db.hasPermission = async (userId, permission) => [...accounts.values()].some(account => String(account.id) === String(userId) && (account.username === 'ak9' ? ['users.view', 'users.search', 'leaderboard.view', 'users.manage_roles'].includes(permission) : account.role === 'admin' && ['users.view', 'users.search', 'leaderboard.view', 'users.manage_roles'].includes(permission)));
  db.isCurrentAdmin = async userId => db.hasPermission(userId, 'users.view');
  db.getAdminUsers = async (limit, offset, search = '') => [...accounts.values()]
    .filter(account => !search || account.username.includes(search))
    .slice(offset, offset + limit)
    .map(account => ({ ...account, role_label: account.username === 'ak9' ? 'مالك النظام' : roleTable.get(account.role)?.label, active_seconds: 12, created_at: null, last_active_at: null }));
  db.countAdminUsers = async (search = '') => [...accounts.values()].filter(account => !search || account.username.includes(search)).length;
  db.changeUserRole = async (actorId, username, role) => {
    roleChangeCalls += 1;
    const actor = [...accounts.values()].find(account => account.id === actorId);
    const owner = actor?.username === 'ak9';
    const actorPermissions = owner ? ['users.manage_roles'] : actor?.role === 'admin' ? ['users.manage_roles'] : [];
    if (!actor || !actorPermissions.includes('users.manage_roles')) return { error: 'forbidden' };
    if (actor.username === username) return { error: 'self' };
    if (username === 'ak9') return { error: 'protected' };
    const target = accounts.get(username);
    if (!target) return { error: 'not_found' };
    const newRole = roleTable.get(role);
    if (!newRole || !['admin', 'student'].includes(newRole.category)) return { error: 'invalid_role' };
    const actorPriority = owner ? 100 : Number(actor.role_priority) || 0;
    if (!owner && (Number(target.role_priority) >= actorPriority || newRole.priority >= actorPriority)) return { error: 'hierarchy' };
    target.role = role;
    target.role_priority = newRole.priority;
    return { user: { username: target.username, role: target.role } };
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  for (const [name, method] of Object.entries(originalMethods)) db[name] = method;
});

test('admin role API enforces CSRF, admin authorization and protected accounts', async t => {
  const ownerCsrf = await csrfFor(tokens.owner);
  const adminCsrf = await csrfFor(tokens.admin);
  const studentCsrf = await csrfFor(tokens.student);
  const guestToken = 'G'.repeat(43);
  const guestCsrf = await csrfFor(guestToken);
  const initialCalls = roleChangeCalls;

  await t.test('searches accounts by username and enforces admin-only access', async () => {
    const params = new URLSearchParams({ search: 'student', limit: '1', offset: '0' });
    const response = await fetch(`${baseUrl()}/api/admin/users?${params}`, { headers: { cookie: `qadir_session=${tokens.admin}` } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.total, 1);
    assert.equal(data.users[0].username, 'student_one');
    assert.equal(data.limit, 1);

    const studentResponse = await fetch(`${baseUrl()}/api/admin/users?search=student`, { headers: { cookie: `qadir_session=${tokens.student}` } });
    assert.equal(studentResponse.status, 403);
  });

  await t.test('rejects invalid usernames in search', async () => {
    const response = await fetch(`${baseUrl()}/api/admin/users?search=%25`, { headers: { cookie: `qadir_session=${tokens.admin}` } });
    assert.equal(response.status, 400);
  });

  await t.test('rejects a missing CSRF token', async () => {
    const response = await changeRole(tokens.admin, '', 'student_one', 'admin', false);
    assert.equal(response.status, 403);
    assert.equal(roleChangeCalls, initialCalls);
  });

  await t.test('rejects a non-admin account', async () => {
    const response = await changeRole(tokens.student, studentCsrf, 'student_one', 'admin');
    assert.equal(response.status, 403);
    assert.equal(roleChangeCalls, initialCalls + 1);
    assert.equal(accounts.get('student_one').role, 'student');
  });

  await t.test('rejects requests without an authenticated session', async () => {
    const response = await changeRole(guestToken, guestCsrf, 'student_one', 'admin');
    assert.equal(response.status, 401);
    assert.equal(roleChangeCalls, initialCalls + 1);
  });

  await t.test('prevents the active administrator from changing their own role', async () => {
    const response = await changeRole(tokens.admin, adminCsrf, 'admin_one', 'student');
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'لا يمكنك تغيير صلاحية حسابك.');
    assert.equal(accounts.get('admin_one').role, 'admin');
  });

  await t.test('protects ak9 from being demoted', async () => {
    const response = await changeRole(tokens.admin, adminCsrf, 'ak9', 'student');
    assert.equal(response.status, 409);
    assert.equal(accounts.get('ak9').role, 'admin');
  });

  await t.test('promotes and demotes another existing account', async () => {
    const promote = await changeRole(tokens.admin, adminCsrf, 'student_one', 'moderator');
    assert.equal(promote.status, 200);
    assert.deepEqual((await promote.json()).updatedUser, { username: 'student_one', role: 'moderator' });
    assert.equal(accounts.get('student_one').role, 'moderator');

    const demote = await changeRole(tokens.admin, adminCsrf, 'student_one', 'student');
    assert.equal(demote.status, 200);
    assert.deepEqual((await demote.json()).updatedUser, { username: 'student_one', role: 'student' });
    assert.equal(accounts.get('student_one').role, 'student');
  });

  await t.test('enforces role hierarchy and reserves top-tier assignment to ak9', async () => {
    const equalRank = await changeRole(tokens.admin, adminCsrf, 'student_one', 'admin');
    assert.equal(equalRank.status, 403);
    assert.equal((await equalRank.json()).error, 'لا يمكنك إسناد رتبة مساوية أو أعلى من رتبتك.');
    const highTarget = await changeRole(tokens.admin, adminCsrf, 'moderator_one', 'admin');
    assert.equal(highTarget.status, 403);
    const ownerPromote = await changeRole(tokens.owner, ownerCsrf, 'student_one', 'admin');
    assert.equal(ownerPromote.status, 200);
    assert.equal(accounts.get('student_one').role, 'admin');
    const ownerDemote = await changeRole(tokens.owner, ownerCsrf, 'student_one', 'student');
    assert.equal(ownerDemote.status, 200);
    assert.equal(accounts.get('student_one').role, 'student');
  });

  await t.test('rejects role names outside the supported roles', async () => {
    const response = await changeRole(tokens.admin, adminCsrf, 'student_one', 'owner');
    assert.equal(response.status, 400);
  });

  await t.test('rejects non-object JSON and unknown account names', async () => {
    const malformed = await fetch(`${baseUrl()}/api/admin/users/role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `qadir_session=${tokens.admin}`, 'x-csrf-token': adminCsrf },
      body: 'null'
    });
    assert.equal(malformed.status, 400);

    const missing = await changeRole(tokens.admin, adminCsrf, 'missing_user', 'admin');
    assert.equal(missing.status, 404);
  });
});
