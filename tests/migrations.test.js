'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname,'..');
const database = readFileSync(join(root,'db.js'),'utf8');
const migration = readFileSync(join(root,'migrations','003_admin_console.sql'),'utf8');

test('migration startup serializes concurrent containers on one pinned MySQL connection', () => {
  assert.match(database,/await getPool\(\)\.getConnection\(\)/);
  assert.match(database,/SELECT GET_LOCK\(\?, 30\) AS acquired/);
  assert.match(database,/SELECT RELEASE_LOCK\(\?\)/);
  assert.match(database,/finally\s*\{[\s\S]*connection\.release\(\)/);
});

test('admin schema column additions safely skip columns created by a partial prior run', () => {
  const checks = [...migration.matchAll(/SET @qadir_ddl = IF\(EXISTS\(SELECT 1 FROM information_schema\.columns/g)];
  assert.equal(checks.length,4);
  assert.equal((migration.match(/PREPARE qadir_stmt FROM @qadir_ddl/g)||[]).length,4);
  assert.equal((migration.match(/DEALLOCATE PREPARE qadir_stmt/g)||[]).length,4);
  for (const column of ['users.*is_active','sessions.*last_seen_at','sessions.*user_agent','sessions.*ip_hash']) assert.match(migration,new RegExp(column));
  assert.match(migration,/CREATE TABLE IF NOT EXISTS admin_content/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS admin_activity/);
});

test('public page route manifest resolves to real HTML pages', () => {
  const manifest=JSON.parse(readFileSync(join(root,'site','manus-routes.json'),'utf8'));
  const pages=new Set(manifest.routes.map(route=>route.path));
  for (const [route,file] of [['/','index.html'],['/admin','admin.html'],['/admin.html','admin.html'],['/chat.html','chat.html'],['/content/:slug','library.html'],['/library.html','library.html'],['/contact.html','contact.html']]) {
    assert.ok(pages.has(route),`route manifest must include ${route}`);
    assert.ok(require('node:fs').existsSync(join(root,'site',file)),`${route} must resolve to ${file}`);
  }
  assert.ok(require('node:fs').existsSync(join(root,'site','project-logo.svg')));
});
