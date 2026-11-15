'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const authClient = fs.readFileSync(path.join(root, 'site', 'auth-client.js'), 'utf8');
const adminConsole = fs.readFileSync(path.join(root, 'site', 'admin-console.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'site', 'admin.html'), 'utf8');
const adminApi = fs.readFileSync(path.join(root, 'admin-api.js'), 'utf8');
const adminDb = fs.readFileSync(path.join(root, 'admin-db.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '004_message_channels.sql'), 'utf8');
const attachmentMigration = fs.readFileSync(path.join(root, 'migrations', '005_message_attachments.sql'), 'utf8');
const contactPage = fs.readFileSync(path.join(root, 'site', 'contact.html'), 'utf8');
const contactClient = fs.readFileSync(path.join(root, 'site', 'contact-page.js'), 'utf8');
const attachmentLibraryMigration = fs.readFileSync(path.join(root, 'migrations', '006_message_attachment_library.sql'), 'utf8');
const attachmentCss = fs.readFileSync(path.join(root, 'site', 'admin-attachments.css'), 'utf8');

test('users have an inbox for administration replies', () => {
  assert.match(authClient, /data-tab=\"threads\"/);
  assert.match(authClient, /\/api\/contact\/threads/);
  assert.match(authClient, /ملاحظاتي وردود الإدارة/);
  assert.match(adminDb, /message_type = 'student'/);
});

test('administration messages have student and admin channels', () => {
  assert.match(migration, /message_type ENUM/);
  assert.match(adminApi, /\['student','admin'\]/);
  assert.match(adminApi, /\/api\/admin\/messages\/admin/);
  assert.match(adminApi, /\/api\/admin\/messages\/recipients/);
  assert.match(adminDb, /addAdminMessage/);
  assert.match(adminDb, /message_type/);
  assert.match(adminConsole, /messages-type/);
  assert.match(adminConsole, /تواصل إداري/);
});

test('admin console exposes a dedicated internal messaging section with recipient names', () => {
  assert.match(adminHtml, /data-section="internal-messages"/);
  assert.match(adminHtml, /id="internal-recipient-list"/);
  assert.match(adminHtml, /id="internal-message-recipient"/);
  assert.match(adminHtml, /id="internal-admin-names"/);
  assert.doesNotMatch(adminHtml, /id="admin-message-form"/);
  assert.match(adminConsole, /loadInternalMessages/);
  assert.match(adminConsole, /recipient-card/);
  assert.match(adminApi, /messages\.view/);
});

test('internal admin messages render as a chat inbox', () => {
  assert.match(adminHtml, /id="internal-messages-list"/);
  assert.match(adminHtml, /المحادثات الإدارية/);
  assert.match(adminConsole, /loadInternalMessageInbox/);
  assert.match(adminConsole, /chat-bubble/);
  assert.match(adminConsole, /recipient_username/);
  assert.match(adminDb, /AS recipient_username/);
});

test('internal messaging can broadcast to all active administrators', () => {
  assert.match(adminConsole, /__all__/);
  assert.match(adminConsole, /كل الإداريين/);
  assert.match(adminApi, /recipientUsername!=='__all__'/);
  assert.match(adminDb, /message\.admin\.broadcast/);
  assert.match(adminDb, /sent_count/);
  assert.match(adminDb, /is_active/);
  assert.match(adminConsole, /غير النشطين/);
});

test('contact and internal messages support arbitrary attachment formats', () => {
  assert.match(attachmentMigration, /admin_messages.*attachments|attachments.*admin_messages/s);
  assert.match(adminApi, /DEFAULT_FILE_TYPE/);
  assert.match(adminApi, /normalizedFileType/);
  assert.doesNotMatch(adminApi, /CONTACT_FILE_TYPES/);
  assert.match(adminApi, /\/api\/contact\/attachments\/presign/);
  assert.match(adminApi, /\/api\/admin\/messages\/attachments\/presign/);
  assert.match(adminApi, /verifyStoredFile/);
  assert.match(adminDb, /JSON\.stringify\(message\.attachments/);
  assert.match(adminDb, /m\.attachments/);
  assert.match(contactPage, /id="contact-files"/);
  assert.match(contactClient, /defaultType/);
  assert.match(contactClient, /attachments\/presign/);
  assert.match(contactClient, /fetch\('\/api\/storage\/upload'/);
  assert.match(adminConsole, /xhr\.open\('PUT','\/api\/storage\/upload'\)/);
  assert.match(adminConsole, /X-Upload-Key/);
  assert.doesNotMatch(adminConsole, /state\.csrfToken/);
  assert.match(adminHtml, /id="internal-message-files"/);
  assert.match(adminConsole, /uploadInternalFile/);
  assert.match(adminConsole, /appendAttachments/);
});

test('attachment library supports protected downloads, previews, filters and upload progress', () => {
  assert.match(attachmentLibraryMigration, /admin_message_attachments/);
  assert.match(attachmentLibraryMigration, /CREATE TABLE IF NOT EXISTS/);
  assert.match(adminApi, /\/api\/admin\/attachments/);
  assert.match(adminApi, /presignDownload/);
  assert.match(adminApi, /attachment\.download/);
  assert.match(adminDb, /listMessageAttachments/);
  assert.match(adminDb, /getMessageAttachment/);
  assert.match(adminHtml, /data-section="attachments"/);
  assert.match(adminHtml, /id="attachments-search"/);
  assert.match(adminHtml, /id="attachments-type"/);
  assert.match(adminHtml, /id="internal-message-dropzone"/);
  assert.match(adminConsole, /previewAttachment/);
  assert.match(adminConsole, /XMLHttpRequest/);
  assert.match(adminConsole, /dragover/);
  assert.match(adminConsole, /إعادة المحاولة/);
  assert.match(adminConsole, /previewMedia/);
  assert.match(adminConsole, /downloadMedia/);
  assert.match(adminConsole, /btn\('معاينة'/);
  assert.match(adminConsole, /btn\('تنزيل'/);
  assert.match(adminConsole, /حذف نهائي/);
  assert.match(adminConsole, /سيُحذف هذا العنصر نهائيًا/);
  assert.match(adminApi, /permanentlyDeleteMedia/);
  assert.match(attachmentCss, /attachment-library/);
});
