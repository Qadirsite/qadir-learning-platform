'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const html = readFileSync(join(root,'site','admin.html'),'utf8');
const js = readFileSync(join(root,'site','admin-console.js'),'utf8');
const css = readFileSync(join(root,'site','admin-console.css'),'utf8');
const db = readFileSync(join(root,'admin-db.js'),'utf8');
const api = readFileSync(join(root,'admin-api.js'),'utf8');

test('content section has a stable ID and its permission-gated CSV/PDF controls are wired', () => {
  assert.match(html, /<section id="section-content" data-admin-section="content"/);
  for (const id of ['content-export-csv','content-import-label','content-import-file','content-print-pdf']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/function setupContent\(\)[\s\S]*?\$\('#section-content \.bulk-bar'\)\.hidden=!manage/);
  assert.match(js,/\$\('#content-export-csv'\)\.addEventListener\('click',exportContentCsv\)/);
  assert.match(js,/\$\('#content-import-file'\)\.addEventListener\('change',importContentCsv\)/);
  assert.match(js,/\$\('#content-print-pdf'\)\.addEventListener\('click',\(\)=>window\.print\(\)\)/);
  assert.match(css,/@media print\{/);
});

test('CSV export remains available as a template when the content table is empty', () => {
  assert.match(js,/\[columns,\.\.\.values\]/);
  assert.match(js,/qadir-content\.csv/);
  assert.match(js,/exportContentCsv\(\)[\s\S]*?can\('content\.view'\)/);
});

test('content creation only asks for the required publishing fields', () => {
  assert.match(html, /id="content-title-ar"/);
  assert.match(html, /العنوان/);
  assert.match(html, /id="content-kind-edit"/);
  assert.match(html, /id="content-state"/);
  assert.match(html, /id="content-body-ar"/);
  assert.match(html, /id="content-publish-at"/);
  assert.match(html, /صورة الغلاف \(اختياري\)/);
  assert.match(html, /id="content-slug" type="hidden"/);
  assert.match(js, /content-slug.*content/);
});

test('messages can be filtered by read state', () => {
  assert.match(html, /id="messages-read"/);
  assert.match(js, /read:\$\('#messages-read'\)\.value/);
  assert.match(js, /\$\('#messages-read'\)\.addEventListener\('change',loadMessages\)/);
  assert.match(api, /const read=url\.searchParams\.get\('read'\)/);
  assert.match(db, /read === 'unread'/);
  assert.match(db, /read === 'read'/);
});

test('site lessons workspace previews all extracted items before commit and shows cropped figures', () => {
  for (const id of ['site-lessons-file','site-lessons-mode','site-lessons-preview','site-lessons-preview-list','site-lessons-commit','site-lessons-cancel']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/site-lessons\/extract/);
  assert.match(js,/site-lessons\/commit/);
  assert.match(js,/siteLessonPreview\?\.items/);
  assert.match(js,/site-lesson-figure/);
  assert.match(api,/figure_bbox/);
  assert.match(api,/pdftoppm/);
});

test('site lesson preview can add options, select the correct answer and delete a question', () => {
  assert.match(js,/إضافة خيار/);
  assert.match(js,/حذف السؤال/);
  assert.match(js,/correct_option/);
  assert.match(api,/questionBody/);
});

test('site lessons accepts common documents and uses extracted PDF/OCR text for AI verification', () => {
  assert.match(html,/accept="\.pdf,\.doc,\.docx,\.ppt,\.pptx,\.xls,\.xlsx,\.txt,image\/\*"/);
  assert.match(api,/extractPdfSourceText/);
  assert.match(api,/tesseract/);
  assert.match(api,/isTeachingFileType/);
  assert.match(api,/تعذر تحليل الملف الآن/);
});

test('existing content can be opened and assigned a teaching subject', () => {
  assert.match(html,/id="content-category-select"/);
  for (const subject of ['رياضيات','فيزياء','كيمياء','أحياء','قدرات كمي','تحصيلي عام']) assert.match(html,new RegExp(subject));
  assert.match(js,/categorySelect/);
  assert.match(js,/تعديل محتوى/);
});

test('file analysis has an extended server/AI timeout for heavy PDFs', () => {
  const server = readFileSync(join(root,'server.js'),'utf8');
  const llm = readFileSync(join(root,'llm.js'),'utf8');
  assert.match(server,/server\.requestTimeout = 5 \* 60 \* 1000/);
  assert.match(llm,/const REQUEST_TIMEOUT_MS = 120000/);
  assert.match(api,/console\.error\('\[site-lessons\] extract failed:/);
});

test('site lesson approval publishes immediately and manages existing drafts', () => {
  assert.match(api,/const status='published'/);
  assert.match(html,/بعد اعتماد المعاينة يُنشر الناتج مباشرة/);
  assert.match(html,/site-lessons-publish-drafts/);
  assert.match(js,/publishSiteDrafts/);
  assert.match(js,/limit=100&offset=0/);
  assert.match(js,/item\.category\|\|'مادة غير محددة'/);
});
