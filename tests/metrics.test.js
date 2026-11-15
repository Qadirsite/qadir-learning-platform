'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const adminData = require('../admin-db');
const { server } = require('../server');

const secret = Buffer.from('qadir-metrics-test-secret-32-bytes');
const originalGetCsrfSecret = db.getCsrfSecret;
const originalGetSettings = adminData.getSettings;
const originalRecordVisit = adminData.recordVisit;
const visits = [];
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }
async function csrf() {
  const response = await fetch(`${baseUrl()}/api/auth/session`);
  return (await response.json()).csrfToken;
}
async function postVisit(token, body) {
  return fetch(`${baseUrl()}/api/metrics/visit`, { method:'POST', headers:{'content-type':'application/json','x-csrf-token':token}, body:JSON.stringify(body) });
}

test.before(async () => {
  db.getCsrfSecret = async () => secret;
  adminData.getSettings = async () => ({});
  adminData.recordVisit = async path => { visits.push(path); };
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
});
test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  db.getCsrfSecret = originalGetCsrfSecret;
  adminData.getSettings = originalGetSettings;
  adminData.recordVisit = originalRecordVisit;
});

test('visit metrics accept a bounded anonymous page ID and count a public content detail route once', async () => {
  const token = await csrf();
  const clientId = crypto.randomUUID();
  const payload = { path:'/content/example-lesson', clientId };
  const first = await postVisit(token,payload);
  assert.equal(first.status,202);
  assert.deepEqual(await first.json(),{recorded:true});
  const second = await postVisit(token,payload);
  assert.equal(second.status,200);
  assert.deepEqual(await second.json(),{recorded:false});
  assert.deepEqual(visits,['/content/example-lesson']);
});

test('visit metrics reject invalid paths and malformed client identifiers', async () => {
  const token = await csrf();
  assert.equal((await postVisit(token,{path:'/admin',clientId:crypto.randomUUID()})).status,400);
  assert.equal((await postVisit(token,{path:'/',clientId:'x'})).status,400);
});
