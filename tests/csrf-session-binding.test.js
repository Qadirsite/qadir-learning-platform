'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { csrfToken, validCsrf, csrfKeyFor, consumeLoginAttempt, resetLoginAttempts } = require('../server');

const secret = 'test-secret';
const keyA = csrfKeyFor('a'.repeat(43));
const keyB = csrfKeyFor('b'.repeat(43));

test('CSRF token is accepted only for the session it was issued to', () => {
  const token = csrfToken(secret, keyA);
  assert.equal(validCsrf(token, secret, keyA), true);
  assert.equal(validCsrf(token, secret, keyB), false);
  assert.equal(validCsrf(token, secret, ''), false);
  assert.equal(validCsrf(csrfToken(secret), secret, ''), true);
});

test('malformed session cookie maps to the anonymous key', () => {
  assert.equal(csrfKeyFor('short'), '');
  assert.equal(csrfKeyFor(undefined), '');
});

test('login lockout grows after repeated lockouts and clears per key', () => {
  resetLoginAttempts();
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  for (let i = 0; i < 10; i++) assert.equal(consumeLoginAttempt(req, 'student1'), true);
  assert.equal(consumeLoginAttempt(req, 'student1'), false);
  assert.equal(consumeLoginAttempt(req, 'student1'), false);
  assert.equal(consumeLoginAttempt(req, 'student2'), true);
  resetLoginAttempts();
});
