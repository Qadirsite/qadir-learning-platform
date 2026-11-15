'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');

test('YouTube study links search the current and next year', () => {
  assert.match(index, /currentYear=new Date\(\)\.getFullYear\(\),nextYear=currentYear\+1/);
  assert.match(index, /قدرات \$\{c\} \$\{currentYear\} \$\{nextYear\} أحدث نتائج شرح جديد/);
  assert.doesNotMatch(index, /search_query=قدرات\+\$\{encodeURIComponent\(c\)\}\+شرح\+كامل\+2024/);
  assert.doesNotMatch(index, /افتـح شرح يوتيوب كامل 2024/);
  assert.doesNotMatch(index, /year:"2024",title:"تجميع 1445/);
});
