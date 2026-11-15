'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname,'..','admin-db.js'),'utf8');
const start = source.indexOf('async function backup()');
const end = source.indexOf('\n}\n',start);
const backup = source.slice(start,end);

test('administrator backup covers records, content versions, audit and daily metrics', () => {
  for (const table of ['users','role_definitions','admin_content','admin_content_versions','admin_messages','admin_media','admin_settings','admin_navigation','admin_activity','admin_daily_visits']) {
    assert.match(backup,new RegExp(`FROM ${table}\\b`));
  }
  assert.match(backup,/contentVersions/);
  assert.match(backup,/activity:/);
  assert.match(backup,/dailyVisits/);
});

test('administrator backup never exports password hashes, salts or session tokens', () => {
  assert.doesNotMatch(backup,/password_hash|password_salt|token_hash|FROM sessions/);
});
