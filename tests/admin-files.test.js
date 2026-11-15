'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {verifyFileBytes}=require('../admin-api');

test('admin media verifier rejects MIME spoofing and validates allowed file signatures',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZcAAAAASUVORK5CYII=','base64');
  assert.equal(verifyFileBytes(png,'image/png',png.length),true);
  assert.equal(verifyFileBytes(png,'image/jpeg',png.length),false);
  assert.equal(verifyFileBytes(Buffer.from([0xff,0xd8,0xff,0xd9]),'image/jpeg',4),true);
  assert.equal(verifyFileBytes(Buffer.from('RIFF0000WEBP','ascii'),'image/webp',12),true);
  assert.equal(verifyFileBytes(Buffer.from('GIF89a','ascii'),'image/gif',6),true);
  assert.equal(verifyFileBytes(Buffer.from('%PDF-1.7','ascii'),'application/pdf',8),true);
  assert.equal(verifyFileBytes(Buffer.from('نص عربي','utf8'),'text/plain',Buffer.byteLength('نص عربي')),true);
  assert.equal(verifyFileBytes(Buffer.from('<svg/>','utf8'),'image/png',6),false);
  assert.equal(verifyFileBytes(Buffer.from('a\0b'),'text/plain',3),false);
  assert.equal(verifyFileBytes(Buffer.alloc(12),'image/webp',13),false);
});
