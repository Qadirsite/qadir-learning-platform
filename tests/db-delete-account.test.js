'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

function makeConnection(calls, { owner = false } = {}) {
  return {
    beginTransaction: async () => calls.push('begin'),
    execute: async (sql, params) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push(text);
      if (text.startsWith('SELECT')) return [[{ id: params[0], username: owner ? 'ak9' : 'student_one' }]];
      return [{ affectedRows: 1 }];
    },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release')
  };
}
const originalCreatePool = mysql.createPool;
test.afterEach(() => { mysql.createPool = originalCreatePool; });

// The pool is created lazily on first use, so the stub stays installed until the test ends.
function freshDb(connection) {
  mysql.createPool = () => ({ getConnection: async () => connection, execute: async () => [[]], end: async () => {} });
  process.env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:3306/qadir_test';
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('deleteAccount removes the user, sessions and contact messages in one transaction', async () => {
  const calls = [];
  const database = freshDb(makeConnection(calls));
  assert.deepEqual(await database.deleteAccount(7), { deleted: true });
  assert.deepEqual(calls.filter(call => !call.startsWith('SELECT')), [
    'begin',
    'DELETE FROM admin_messages WHERE user_id = ?',
    'DELETE FROM sessions WHERE user_id = ?',
    'DELETE FROM users WHERE id = ?',
    'commit',
    'release'
  ]);
});

test('deleteAccount refuses the system owner and rolls back', async () => {
  const calls = [];
  const database = freshDb(makeConnection(calls, { owner: true }));
  assert.deepEqual(await database.deleteAccount(1), { error: 'protected' });
  assert.ok(calls.includes('rollback'));
  assert.ok(!calls.some(call => call.startsWith('DELETE')));
  assert.ok(calls.includes('release'));
});
