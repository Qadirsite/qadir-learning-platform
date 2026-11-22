'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const index = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');

test('desktop navigation exposes the full menu without the removed floating AI panel', () => {
  assert.match(index, /id:"qadir-menu-button"/);
  assert.doesNotMatch(index, /id:"qadir-menu-button"[^}]{0,260}className:"md:hidden/);
  assert.match(index, /Gi\.map\(c=>a\("button"/);
  assert.doesNotMatch(index, /مساعد قادر العائم/);
  assert.doesNotMatch(index, /غيّر الإجابة/);
  assert.match(index, /الإعدادات.*محادثة جديدة.*سجل المحادثات/);
  assert.match(index, /window\.location\.href="\/chat\.html\?new=1"/);
  assert.match(index, /window\.location\.href="\/chat\.html#history"/);
});

test('lesson notes can be sent to the shared administrator inbox', () => {
  assert.match(index, /sendNote=async/);
  assert.match(index, /fetch\("\/api\/contact"/);
  assert.match(index, /إرسال الملاحظة للإدارة/);
  assert.match(index, /تظهر الآن لكل الإداريين/);
});

test('published question banks refresh without a page reload', () => {
  assert.match(index, /fetch\("\/api\/content\?kind=question&limit=30"/);
  assert.match(index, /setInterval\(refreshBanks,15000\)/);
  assert.match(index, /setBankItems\(live\)/);
  assert.match(index, /bankItems\.filter/);
});

test('self-test starts with a choice of aptitude, achievement or both', () => {
  assert.match(index, /\[quizMode,setQuizMode\]=M\.useState\(null\)/);
  assert.match(index, /startQuiz=\(mode\)=>/);
  assert.match(index, /\["قدرات","أسئلة الكمي واللفظي","qudurat"\]/);
  assert.match(index, /\["تحصيلي","أسئلة العلوم والمواد التحصيلية","tahsili"\]/);
  assert.match(index, /\["الإثنين","مجموعة شاملة من النوعين","both"\]/);
  assert.match(index, /type:index>=26\?"تحصيلي":"قدرات"/);
  assert.doesNotMatch(index, /افتح بنك الأسئلة الأصلي/);
});

test('hero CTA scrolls to the learning section and the quantitative index uses the full two-column menu', () => {
  assert.match(index, /id:"qadir-learning-section"/);
  assert.match(index, /getElementById\("qadir-learning-section"\)\?\.scrollIntoView\(\{behavior:"smooth",block:"start"\}\)/);
  assert.doesNotMatch(index, /فهرس الكمي 15 درس/);
  assert.match(index, /children:"تنقل سريع"/);
  assert.match(index, /className:"mt-4 grid grid-cols-2 gap-2"/);
  assert.match(index, /Gi\.map\(c=>a\("button"/);
});

test('home section keeps the hero above and replaces course cards with the full menu', () => {
  assert.match(index, /e==="الرئيسية"&&d\("div"/);
  assert.match(index, /className:"grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4/);
  assert.doesNotMatch(index, /title:"الكمي 15 درس"/);
  assert.doesNotMatch(index, /title:"اللفظي 10 دروس"/);
  assert.doesNotMatch(index, /title:"التحصيلي 12 درس"/);
});

test('question bank records student performance and exposes weaknesses', () => {
  assert.match(index, /qadir-quiz-stats-v1/);
  assert.match(index, /recordQuizAnswer=\(question,selected,index\)=>/);
  assert.match(index, /children:"إجاباتك"/);
  assert.match(index, /children:"نسبة النجاح"/);
  assert.match(index, /children:"نقطة الضعف"/);
  assert.match(index, /type=question/);
});

test('home page exposes focused SEO metadata within the required limits', () => {
  const title = index.match(/<title>([^<]*)<\/title>/)?.[1] || '';
  const description = index.match(/<meta name="description" content="([^"]*)">/)?.[1] || '';
  const keywords = index.match(/<meta name="keywords" content="([^"]*)"/)?.[1].split(',').map(value => value.trim()).filter(Boolean) || [];
  assert.ok(title.length >= 30 && title.length <= 60);
  assert.ok(description.length >= 50 && description.length <= 160);
  assert.ok(keywords.length >= 3 && keywords.length <= 8);
});

test('expanded question bank keeps original questions, source metadata and unit filters', () => {
  assert.match(index, /const newQuestionBank=\[/);
  assert.match(index, /const questionBank=ee\.concat\(newQuestionBank\)/);
  assert.match(index, /sourceUrl:"https:\/\/etec\.gov\.sa\/ar\/programs\/mustaqbalhum"/);
  assert.match(index, /sourceUrl:"https:\/\/www\.iau\.edu\.sa\/sites\/default\/files\/resources\/achievement_test_preparation_guide_first_edition_2022-2023\.pdf"/);
  assert.match(index, /questionBank\.filter\(\(question\)=>question\.type==="قدرات"&&question\.section==="كمي"/);
  assert.match(index, /أضفنا .* سؤالًا أصليًا مصنفًا حسب القسم والوحدة/);
});

test('the main app has a visible runtime fallback instead of an empty root', () => {
  assert.match(index, /class QadirErrorBoundary extends Wf\.default\.Component/);
  assert.match(index, /تعذر عرض هذا القسم/);
  assert.match(index, /window\.location\.reload\(\)/);
});
