'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');

test('favorites summary opens a dedicated saved-items view', () => {
  assert.match(index, /Gi=\["الرئيسية","الدروس","المفضلة"/);
  assert.match(index, /onClick:\(\)=>Lt\("المفضلة"\)/);
  assert.match(index, /favoriteItems=M\.useMemo\(\(\)=>zr\.filter\(\(c\)=>o\.has\(c\.id\)\)/);
  assert.match(index, /كل ما وضعته في المفضلة/);
  assert.match(index, /إزالة من المفضلة/);
  assert.match(index, /عرض في الدروس ←/);
  assert.match(index, /المفضلة فارغة حاليًا/);
});
