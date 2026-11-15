'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeChat } = require('../llm');

const saved = { url: process.env.MANUS_API_URL, key: process.env.MANUS_API_KEY };
test.before(() => { process.env.MANUS_API_URL = 'https://manus-api.example'; process.env.MANUS_API_KEY = 'test-key'; });
test.after(() => {
  if (saved.url === undefined) delete process.env.MANUS_API_URL; else process.env.MANUS_API_URL = saved.url;
  if (saved.key === undefined) delete process.env.MANUS_API_KEY; else process.env.MANUS_API_KEY = saved.key;
});

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const good = reply(200, { choices: [{ message: { content: 'جاهز.' } }] });
const options = { sleep: async () => {} };

test('retries once after a transient 503 and returns the recovered answer', async () => {
  let calls = 0;
  const text = await completeChat([], async () => (++calls === 1 ? reply(503, { error: 'busy' }) : good), options);
  assert.equal(text, 'جاهز.');
  assert.equal(calls, 2);
});

test('retries once after a network failure', async () => {
  let calls = 0;
  const text = await completeChat([], async () => { if (++calls === 1) throw new Error('socket hang up'); return good; }, options);
  assert.equal(text, 'جاهز.');
  assert.equal(calls, 2);
});

test('gives up after the second transient failure without leaking details', async () => {
  let calls = 0;
  await assert.rejects(() => completeChat([], async () => { calls += 1; return reply(429, { error: 'private detail' }); }, options), /AI service request failed/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(() => completeChat([], async () => { calls += 1; throw new Error('private network detail'); }, options), /^Error: AI service request failed$/);
  assert.equal(calls, 2);
});

test('does not retry client errors', async () => {
  let calls = 0;
  await assert.rejects(() => completeChat([], async () => { calls += 1; return reply(400, { error: 'bad request' }); }, options), /AI service request failed/);
  assert.equal(calls, 1);
});
