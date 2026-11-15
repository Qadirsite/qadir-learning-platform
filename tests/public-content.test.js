'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adminData = require('../admin-db');
const { server } = require('../server');

let lookup = async () => null;
const originalGetSettings = adminData.getSettings;
const originalGetContentBySlug = adminData.getContentBySlug;
function baseUrl() { return `http://127.0.0.1:${server.address().port}`; }

test.before(async () => {
  adminData.getSettings = async () => ({});
  adminData.getContentBySlug = (...args) => lookup(...args);
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
});

test.after(async () => {
  if (server.listening) { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; }
  adminData.getSettings = originalGetSettings;
  adminData.getContentBySlug = originalGetContentBySlug;
});

test('published content is server-rendered with escaped metadata, canonical URL and body text', async () => {
  lookup = async slug => slug === 'safe-lesson' ? {
    slug, kind:'lesson', title_ar:'درس <script>alert(1)</script>', body_ar:'محتوى تعليمي\nوسطر ثانٍ </p><script>bad()</script>',
    seo_title_ar:'عنوان SEO', seo_description_ar:'شرح عربي للمادة.', cover_url:'/manus-storage/library/cover.webp'
  } : null;
  const response = await fetch(`${baseUrl()}/content/safe-lesson`);
  assert.equal(response.status,200);
  const html = await response.text();
  assert.match(html,/<title>عنوان SEO \| قادر<\/title>/);
  assert.match(html,/<link rel="canonical" href="https:\/\/qadirsite-alxodqyn\.manus\.space\/content\/safe-lesson">/);
  assert.match(html,/<meta property="og:type" content="article">/);
  assert.match(html,/وسطر ثانٍ &lt;\/p&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
  assert.match(html,/name="robots" content="index,follow"/);
});

test('unknown published content returns a noindex HTTP 404', async () => {
  lookup = async () => null;
  const response = await fetch(`${baseUrl()}/content/unknown-item`);
  assert.equal(response.status,404);
  assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
  const html = await response.text();
  assert.match(html,/المحتوى غير موجود/);
  assert.doesNotMatch(html,/rel="canonical"/);
});
