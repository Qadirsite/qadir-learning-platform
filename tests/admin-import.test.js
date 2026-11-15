'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../admin-api');

const columns = ['kind','slug','title_ar','title_en','body_ar','body_en','category','tags','status','cover_url','publish_at','seo_title_ar','seo_title_en','seo_description_ar','seo_description_en'];
function csvRow(values) {
  return values.map(value => `"${String(value ?? '').replace(/"/g,'""')}"`).join(',');
}
function record(overrides = {}) {
  return {kind:'lesson',slug:'percent-basics',title_ar:'أساسيات النسبة',title_en:'Percent basics',body_ar:'شرح "مبسط"\nللدرس',body_en:'Simple lesson',category:'رياضيات',tags:'نسبة|تدريب',status:'draft',cover_url:'',publish_at:'',seo_title_ar:'',seo_title_en:'',seo_description_ar:'',seo_description_en:'',...overrides};
}
function makeCsv(rows) {
  return '\ufeff' + [columns.join(','), ...rows.map(item => csvRow(columns.map(column => item[column])))].join('\r\n');
}

test('CSV import accepts the exported schema, UTF-8 BOM, quoted commas and embedded newlines', () => {
  const [item] = parseCsv(makeCsv([record({title_ar:'نسبة، وتناسب', body_ar:'السطر الأول\nالسطر الثاني "المهم"'})]));
  assert.equal(item.title_ar,'نسبة، وتناسب');
  assert.equal(item.body_ar,'السطر الأول\nالسطر الثاني "المهم"');
  assert.deepEqual(item.tags,['نسبة','تدريب']);
  assert.equal(item.status,'draft');
});

test('CSV import rejects missing/extra fields, malformed quoting, duplicate slugs and invalid content', () => {
  assert.equal(parseCsv('slug,title_ar\na,b'),null);
  assert.equal(parseCsv(makeCsv([record(), record()])),null);
  assert.equal(parseCsv(makeCsv([record({kind:'script'})])),null);
  assert.equal(parseCsv(makeCsv([record({slug:'../unsafe'})])),null);
  assert.equal(parseCsv(columns.join(',')+'\n"broken'),null);
  assert.equal(parseCsv(makeCsv([record()]).replace('title_ar','unexpected')),null);
});

test('CSV import caps rows and payload size', () => {
  assert.equal(parseCsv(makeCsv(Array.from({length:101},(_,index)=>record({slug:`lesson-${index}`})))),null);
  assert.equal(parseCsv('x'.repeat(1024*1024+1)),null);
  assert.equal(parseCsv(columns.join(',')+'\n'+csvRow(columns.map(column => column==='slug'?'empty':column==='title_ar'?'':'')).replace(/"empty"/,'""')),null);
});
