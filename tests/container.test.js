'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Docker image includes every local module imported by the server', () => {
  const requiredModules = [...server.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)]
    .map((match) => `${match[1].slice(2)}.js`);
  const copySources = dockerfile.split(/\r?\n/)
    .filter((line) => /^\s*COPY\s+/i.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));

  assert.ok(requiredModules.length > 0, 'server.js should declare local modules');
  for (const moduleFile of requiredModules) {
    assert.ok(
      copySources.includes(moduleFile),
      `Dockerfile must copy ${moduleFile}, imported by server.js`
    );
    assert.ok(fs.existsSync(path.join(root, moduleFile)), `${moduleFile} must exist in the project`);
  }
  assert.match(dockerfile, /\bCMD\s+\["node",\s*"server\.js"\]/);
});
