'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeChat, SYSTEM_PROMPT } = require('../llm');

const originalUrl = process.env.MANUS_API_URL;
const originalKey = process.env.MANUS_API_KEY;

test.before(() => {
  process.env.MANUS_API_URL = 'https://manus-api.example';
  process.env.MANUS_API_KEY = 'test-server-only-key';
});
test.after(() => {
  if (originalUrl === undefined) delete process.env.MANUS_API_URL; else process.env.MANUS_API_URL = originalUrl;
  if (originalKey === undefined) delete process.env.MANUS_API_KEY; else process.env.MANUS_API_KEY = originalKey;
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('uses the Manus platform-default model and extracts a plain-text completion', async () => {
  let request;
  const text = await completeChat([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'ما قيمة 2 + 2؟' }], async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return response(200, { choices: [{ message: { content: 'الناتج 4.' } }] });
  });
  assert.equal(request.url, 'https://manus-api.example/v1/chat/completions');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-server-only-key');
  assert.equal('model' in request.body, false);
  assert.equal(text, 'الناتج 4.');
  assert.match(SYSTEM_PROMPT, /محصورة في اختبار القدرات/);
  assert.match(SYSTEM_PROMPT, /بلا Markdown أو LaTeX/);
});

test('supports text parts and caps unusually long provider responses', async () => {
  const text = await completeChat([{ role: 'user', content: 'سؤال قصير' }], async () => response(200, {
    choices: [{ message: { content: [{ type: 'text', text: 'أول جزء.' }, { type: 'text', text: 'ثانٍ.' + 'س'.repeat(5000) }] } }]
  }));
  assert.equal(text.length, 4000);
});

test('rejects provider errors and empty content without exposing upstream details', async () => {
  await assert.rejects(() => completeChat([], async () => response(200, { error: { message: 'private upstream key detail' } })), /AI service request failed/);
  await assert.rejects(() => completeChat([], async () => response(200, { choices: [{ message: { content: '' } }] })), /no answer/);
  await assert.rejects(() => completeChat([], async () => response(503, { error: 'private upstream detail' })), /AI service request failed/);
});

test('teaching extraction requests strict JSON schema output from the explicit extraction model', async () => {
  const { extractTeachingContent } = require('../llm');
  let body;
  const result = await extractTeachingContent('https://storage.example/file.pdf', 'application/pdf', 'questions', async (url, options) => {
    body = JSON.parse(options.body);
    return response(200, { choices: [{ message: { content: JSON.stringify({ title_ar: 'اختبار', body_ar: '', questions: [{ question: 'ما الناتج؟', answer: '4', explanation: '', options: ['4'], correct_option: 0, page: 1, figure_bbox: [0, 0, 0, 0] }] }) } }] });
  });
  assert.equal(body.model, 'gpt-5-mini');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.messages[1].content[1].type, 'file_url');
  assert.equal(result.questions.length, 1);

  let textBody;
  await extractTeachingContent('https://storage.example/scanned.pdf', 'application/pdf', 'questions', async (url, options) => {
    textBody = JSON.parse(options.body);
    return response(200, { choices: [{ message: { content: JSON.stringify({ title_ar: 'OCR', body_ar: '', questions: [] }) } }] });
  }, { sourceText: 'سؤال مستخرج من OCR' });
  assert.equal(textBody.messages[1].content[1].type, 'text');
});
