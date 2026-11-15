'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeChatRate, clientIp, ipBucket, CHAT_LIMITS, resetChatRateLimits } = require('../server');

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
const publicIp = i => `203.0.${(i >> 8) & 255}.${i & 255}`;
const clientId = i => String(i).padStart(32, '0');
test.beforeEach(() => resetChatRateLimits());

test('default AI capacity is 500 messages per minute and 10000 per day for the whole platform', () => {
  assert.equal(CHAT_LIMITS.globalMinute, 500);
  assert.equal(CHAT_LIMITS.globalDay, 10000);
});

test('the platform accepts 500 messages in a minute and rejects the 501st', () => {
  const now = Date.now();
  let allowed = 0;
  for (let i = 0; i < 500; i += 1) if (consumeChatRate(req(publicIp(i)), clientId(i), now).allowed) allowed += 1;
  assert.equal(allowed, 500);
  const blocked = consumeChatRate(req(publicIp(900)), clientId(900), now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'global');
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
  assert.equal(consumeChatRate(req(publicIp(901)), clientId(901), now + 61_000).allowed, true);
});

test('the platform accepts 10000 messages in a day, then waits for the window to roll', () => {
  const base = Date.now();
  let allowed = 0;
  for (let i = 0; i < 10000; i += 1) if (consumeChatRate(req(publicIp(i)), clientId(i), base + i * 130).allowed) allowed += 1;
  assert.equal(allowed, 10000);
  const at = base + 10000 * 130;
  const blocked = consumeChatRate(req(publicIp(6000)), clientId(6000), at);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'global');
  assert.ok(blocked.retryAfter > 3600);
  assert.equal(consumeChatRate(req(publicIp(6001)), clientId(6001), base + 24 * 60 * 60 * 1000 + 1000).allowed, true);
});

test('a rejected request does not consume platform quota', () => {
  const now = Date.now();
  const same = req('198.51.100.20');
  let deviceAllowed = 0;
  for (let i = 0; i < 28; i += 1) if (consumeChatRate(same, clientId(1), now).allowed) deviceAllowed += 1;
  assert.equal(deviceAllowed, CHAT_LIMITS.deviceMinute);
  let others = 0;
  for (let i = 0; i < 600; i += 1) if (consumeChatRate(req(publicIp(i)), clientId(1000 + i), now).allowed) others += 1;
  assert.equal(others, CHAT_LIMITS.globalMinute - CHAT_LIMITS.deviceMinute);
});

test('users behind one reverse proxy are limited separately by their real address', () => {
  const now = Date.now();
  const behindProxy = realIp => req('10.1.2.3', { 'x-forwarded-for': realIp });
  for (let i = 0; i < CHAT_LIMITS.ipMinute; i += 1) assert.equal(consumeChatRate(behindProxy('203.0.113.7'), clientId(i), now).allowed, true);
  const blocked = consumeChatRate(behindProxy('203.0.113.7'), clientId(999), now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, 'ip');
  assert.equal(consumeChatRate(behindProxy('203.0.113.8'), clientId(1), now).allowed, true);
});

test('clientIp trusts forwarding headers only from internal proxies', () => {
  assert.equal(clientIp(req('198.51.100.9', { 'x-forwarded-for': '1.2.3.4' })), '198.51.100.9');
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })), '203.0.113.7');
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.7, 10.0.0.9' })), '203.0.113.7');
  assert.equal(clientIp(req('::ffff:10.0.0.5', { 'x-forwarded-for': '203.0.113.7:4711' })), '203.0.113.7');
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': 'not-an-ip' })), '10.0.0.5');
  assert.equal(clientIp(req('10.0.0.5')), '10.0.0.5');
});

test('TRUST_PROXY modes: false ignores headers, a number trusts that many hops', () => {
  assert.equal(clientIp(req('10.0.0.5', { 'x-forwarded-for': '203.0.113.7' }), 'false'), '10.0.0.5');
  assert.equal(clientIp(req('198.51.100.1', { 'x-forwarded-for': '203.0.113.7' }), '1'), '203.0.113.7');
  assert.equal(clientIp(req('198.51.100.1', { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), '1'), '203.0.113.7');
  assert.equal(clientIp(req('198.51.100.1', { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), '0'), '198.51.100.1');
});

test('IPv6 clients are limited per /64 so rotating addresses does not bypass limits', () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipBucket('2001:db8:1:2::1'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
});
