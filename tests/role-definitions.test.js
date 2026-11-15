'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const { server } = require('../server');

const csrfSecret = Buffer.from('qadir-role-definitions-test-secret');
const tokens = { owner: 'O'.repeat(43), admin: 'A'.repeat(43), student: 'S'.repeat(43) };
const accounts = new Map([
  [9, { id: 9, username: 'ak9', role: 'owner', role_priority: 100 }],
  [1, { id: 1, username: 'admin_one', role: 'admin', role_priority: 80 }],
  [2, { id: 2, username: 'student_one', role: 'student', role_priority: 0 }]
]);
const roleDefinitions = new Map([
  ['student', { key: 'student', label: 'طالب', category: 'student', priority: 0, permissions: [], system: true, usersCount: 1 }],
  ['admin', { key: 'admin', label: 'مدير', category: 'admin', priority: 80, permissions: ['users.view', 'users.search', 'leaderboard.view', 'users.manage_roles'], system: true, usersCount: 1 }],
  ['tutor', { key: 'tutor', label: 'مساعد', category: 'admin', priority: 30, permissions: ['users.view'], system: false, usersCount: 0 }]
]);
const usedRoleKeys = new Set(['student', 'admin']);
usedRoleKeys.add('tutor');
const originalMethods = {};

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }
async function csrfFor(token) {
  const response = await fetch(`${baseUrl()}/api/auth/session`, { headers: { cookie: `qadir_session=${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()).csrfToken;
}
async function call(token, method, path, body = {}, includeCsrf = true) {
  const headers = { cookie: `qadir_session=${token}`, 'content-type': 'application/json' };
  if (includeCsrf) headers['x-csrf-token'] = await csrfFor(token);
  const options = { method, headers };
  if (method !== 'GET') options.body = JSON.stringify(body);
  return fetch(`${baseUrl()}${path}`, options);
}

 test.before(async () => {
  for (const name of ['getCsrfSecret', 'getSessionUser', 'isCurrentAdmin', 'isSystemOwner', 'getRoleDefinitions', 'getAssignableRoles', 'createRoleDefinition', 'updateRoleDefinition', 'deleteRoleDefinition']) originalMethods[name] = db[name];
  db.getCsrfSecret = async () => csrfSecret;
  db.getSessionUser = async tokenHash => {
    const token = Object.values(tokens).find(value => digest(value).equals(tokenHash));
    if (!token) return null;
    const username = token === tokens.owner ? 'ak9' : token === tokens.admin ? 'admin_one' : 'student_one';
    return [...accounts.values()].find(account => account.username === username);
  };
  db.isCurrentAdmin = async userId => String(userId) === '9' || String(userId) === '1';
  db.isSystemOwner = async userId => String(userId) === '9';
  db.getRoleDefinitions = async () => [...roleDefinitions.values()];
  db.getAssignableRoles = async userId => {
    const actor = accounts.get(Number(userId));
    if (!actor) return [];
    return [...roleDefinitions.values()].filter(role => role.priority < actor.role_priority);
  };
  db.createRoleDefinition = async (actorId, label, priority, permissions) => {
    if (String(actorId) !== '9') return { error: 'forbidden' };
    if (!Array.isArray(permissions) || (permissions.some(permission => ['users.search', 'users.manage_roles'].includes(permission)) && !permissions.includes('users.view'))) return { error: 'invalid' };
    if (typeof label !== 'string' || !label.trim() || [...roleDefinitions.values()].some(role => role.label === label.trim())) return { error: 'invalid' };
    const role = { key: `custom_${roleDefinitions.size}`, label: label.trim(), category: 'admin', priority: Number(priority), permissions, system: false, usersCount: 0 };
    roleDefinitions.set(role.key, role);
    return { role };
  };
  db.updateRoleDefinition = async (actorId, key, label, priority, permissions) => {
    if (String(actorId) !== '9') return { error: 'forbidden' };
    if (!Array.isArray(permissions) || (permissions.some(permission => ['users.search', 'users.manage_roles'].includes(permission)) && !permissions.includes('users.view'))) return { error: 'invalid' };
    const existing = roleDefinitions.get(key);
    if (!existing) return { error: 'not_found' };
    if (existing.category !== 'admin') return { error: 'protected' };
    if ([...roleDefinitions.values()].some(role => role.key !== key && role.label === String(label).trim())) return { error: 'invalid' };
    const role = { ...existing, label: String(label).trim(), priority: Number(priority), permissions };
    roleDefinitions.set(key, role);
    return { role };
  };
  db.deleteRoleDefinition = async (actorId, key) => {
    if (String(actorId) !== '9') return { error: 'forbidden' };
    const role = roleDefinitions.get(key);
    if (!role) return { error: 'not_found' };
    if (role.system) return { error: 'protected' };
    if (role.usersCount || usedRoleKeys.has(key)) return { error: 'in_use' };
    roleDefinitions.delete(key);
    return { deleted: key };
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

test('only ak9 can customize role definitions; role assignment remains separate', async t => {
  await t.test('lists roles to an authorized administrator but not to a student', async () => {
    const admin = await call(tokens.admin, 'GET', '/api/admin/roles');
    assert.equal(admin.status, 200);
    const data = await admin.json();
    assert.equal(data.canManageDefinitions, false);
    assert.ok(data.assignableRoles.every(role => role.priority < 80));
    const student = await call(tokens.student, 'GET', '/api/admin/roles');
    assert.equal(student.status, 403);
  });

  await t.test('requires CSRF and rejects definition changes from another administrator', async () => {
    const noCsrf = await call(tokens.owner, 'POST', '/api/admin/roles', { label: 'منسق', priority: 25, permissions: ['users.view'] }, false);
    assert.equal(noCsrf.status, 403);
    const adminCreate = await call(tokens.admin, 'POST', '/api/admin/roles', { label: 'مساعد', priority: 25, permissions: ['users.view'] });
    assert.equal(adminCreate.status, 403);
  });

  await t.test('allows ak9 to create and edit a custom role', async () => {
    const created = await call(tokens.owner, 'POST', '/api/admin/roles', { label: 'مراقب', priority: 35, permissions: ['users.view', 'leaderboard.view'] });
    assert.equal(created.status, 201);
    const custom = (await created.json()).role;
    assert.equal(custom.label, 'مراقب');
    assert.equal(custom.priority, 35);
    const updated = await call(tokens.owner, 'PUT', `/api/admin/roles/${custom.key}`, { label: 'مراقب مساعد', priority: 40, permissions: ['users.view'] });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).role.label, 'مراقب مساعد');
    const deleted = await call(tokens.owner, 'DELETE', `/api/admin/roles/${custom.key}`, {});
    assert.equal(deleted.status, 200);
  });

  await t.test('rejects dependent permissions without account viewing access', async () => {
    for (const permission of ['users.search', 'users.manage_roles']) {
      const response = await call(tokens.owner, 'POST', '/api/admin/roles', { label: `بدون عرض ${permission}`, priority: 25, permissions: [permission] });
      assert.equal(response.status, 400);
    }
  });

  await t.test('allows ak9 to edit a built-in admin role but not remove it', async () => {
    const updated = await call(tokens.owner, 'PUT', '/api/admin/roles/admin', { label: 'مدير عام', priority: 85, permissions: ['users.view', 'users.manage_roles'] });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).role.label, 'مدير عام');
    const deleted = await call(tokens.owner, 'DELETE', '/api/admin/roles/admin', {});
    assert.equal(deleted.status, 409);
  });

  await t.test('protects system roles and refuses to delete a role that is in use', async () => {
    const protectedUpdate = await call(tokens.owner, 'PUT', '/api/admin/roles/student', { label: 'طالب معدل', priority: 0, permissions: [] });
    assert.equal(protectedUpdate.status, 409);
    const inUse = await call(tokens.owner, 'DELETE', '/api/admin/roles/tutor', {});
    assert.equal(inUse.status, 409);
    const unknown = await call(tokens.owner, 'DELETE', '/api/admin/roles/not_found', {});
    assert.equal(unknown.status, 404);
  });

  await t.test('does not claim success if the data layer independently denies an owner-only operation', async () => {
    db.isSystemOwner = async () => true;
    db.createRoleDefinition = async () => ({ error: 'forbidden' });
    const response = await call(tokens.owner, 'POST', '/api/admin/roles', { label: 'صلاحية مرفوضة', priority: 20, permissions: [] });
    assert.equal(response.status, 403);
  });
});
