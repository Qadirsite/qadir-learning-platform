'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const pathModule = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const { URL } = require('node:url');
const data = require('./admin-db');
const db = require('./db');
const chatAI = require('./llm');
const { createAdminAgent } = require('./admin-agent');

const CONTENT_KINDS = new Set(['lesson','resource','question','announcement','faq']);
const CONTENT_STATUSES = new Set(['draft','published','archived']);
const DEFAULT_FILE_TYPE = 'application/octet-stream';
const TEACHING_FILE_TYPES = new Set(['application/pdf','text/plain','text/csv','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg','image/webp','image/gif']);
function isTeachingFileType(type) { return TEACHING_FILE_TYPES.has(type) || type.startsWith('image/'); }
const settingsKeys = new Set(['site_name','logo_url','contact_email','social_links','seo_description','maintenance_mode','maintenance_message','notification_templates']);
const publicPages = new Set(['/','/chat.html','/library.html','/contact.html']);
function isFullAdmin(user) { return user?.username === 'ak9' || user?.role === 'admin'; }
const visitBuckets = new Map();
const contactBuckets = new Map();
const contactAttachmentBuckets = new Map();

function cleanText(value, max, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : '';
  const result = value.trim();
  if ((required && !result) || Array.from(result).length > max) return null;
  return result;
}
function normalizeYoutubeUrl(value) {
  const raw = cleanText(value, 512);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['https:','http:'].includes(parsed.protocol)) return null;
    if (!['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch { return null; }
}
function safeId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
function validEmail(value) { return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function safeUploadName(value) { return value.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g,'_').slice(-100) || 'attachment'; }
function requestHash(req, secret) {
  const address = String(req.socket.remoteAddress || 'unknown');
  return crypto.createHmac('sha256', secret).update(address).digest();
}
function limited(bucket, key, max, duration) {
  const now = Date.now();
  let state = bucket.get(key);
  if (!state || now >= state.until) state = { count: 0, until: now + duration };
  if (state.count >= max) { bucket.set(key,state); return false; }
  state.count += 1; bucket.set(key,state);
  if (bucket.size > 5000) bucket.delete(bucket.keys().next().value);
  return true;
}
async function auth(req, res, ctx, permission) {
  const user = await ctx.sessionUser(req);
  if (!user) { ctx.fail(res,401,'يلزم تسجيل الدخول.'); return null; }
  if (permission && !await db.hasPermission(user.id, permission)) { ctx.fail(res,403,'لا تملك صلاحية هذا القسم.'); return null; }
  return user;
}
async function bodyAndCsrf(req,res,ctx,maxBytes) {
  let body;
  try { body = await ctx.readJson(req,maxBytes); }
  catch(error) { ctx.fail(res,error.status || 400,'البيانات المرسلة غير صالحة.'); return null; }
  let secret;
  try { secret = await db.getCsrfSecret(); }
  catch { ctx.fail(res,503,'تعذر التحقق من الطلب.'); return null; }
  if (!await ctx.requireCsrf(req,res,secret)) return null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) { ctx.fail(res,400,'صيغة البيانات غير صالحة.'); return null; }
  return body;
}
function normalizedContent(body) {
  const kind = body.kind;
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const titleAr = cleanText(body.title_ar,200,{required:true});
  const bodyAr = cleanText(body.body_ar,30000,{required:true});
  const titleEn = cleanText(body.title_en,200);
  const bodyEn = cleanText(body.body_en,30000);
  const category = cleanText(body.category,80) ?? null;
  const status = body.status;
  const tags = Array.isArray(body.tags) && body.tags.length <= 20 && body.tags.every(tag => typeof tag === 'string' && tag.trim().length <= 40) ? [...new Set(body.tags.map(tag=>tag.trim()).filter(Boolean))] : null;
  const cover = cleanText(body.cover_url,512);
  const seoTitleAr = cleanText(body.seo_title_ar,200);
  const seoTitleEn = cleanText(body.seo_title_en,200);
  const seoDescriptionAr = cleanText(body.seo_description_ar,320);
  const seoDescriptionEn = cleanText(body.seo_description_en,320);
  let publishAt = null;
  if (body.publish_at) {
    const parsed = new Date(body.publish_at);
    if (Number.isNaN(parsed.getTime())) return null;
    publishAt = parsed.toISOString().slice(0,19).replace('T',' ');
  }
  if (!CONTENT_KINDS.has(kind) || !/^[a-z0-9]+(?:-[a-z0-9]+){0,15}$/.test(slug) || !titleAr || !bodyAr || titleEn === null || bodyEn === null || category === null || !tags || cover === null || !CONTENT_STATUSES.has(status) || seoTitleAr === null || seoTitleEn === null || seoDescriptionAr === null || seoDescriptionEn === null) return null;
  if (cover && !/^\/manus-storage\/[A-Za-z0-9._/-]{1,480}$/.test(cover)) return null;
  return { kind, slug, title_ar:titleAr, title_en:titleEn || null, body_ar:bodyAr, body_en:bodyEn || null,
    category, tags, cover_url:cover || null, status, seo_title_ar:seoTitleAr || null, seo_title_en:seoTitleEn || null,
    seo_description_ar:seoDescriptionAr || null, seo_description_en:seoDescriptionEn || null, publish_at:publishAt };
}
const CONTENT_CSV_COLUMNS=['kind','slug','title_ar','title_en','body_ar','body_en','category','tags','status','cover_url','publish_at','seo_title_ar','seo_title_en','seo_description_ar','seo_description_en'];
function parseCsv(text) {
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>1024*1024) return null;
  const rows=[];let row=[],field='',quoted=false,closedQuote=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"'){quoted=false;closedQuote=true;}else field+=ch;continue;}
    if(closedQuote&&ch!==','&&ch!=='\n'&&ch!=='\r')return null;
    if(ch==='"'){if(field||closedQuote)return null;quoted=true;continue;}
    if(ch===','){row.push(field);field='';closedQuote=false;continue;}
    if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';closedQuote=false;if(row.some(value=>value.trim()))rows.push(row);row=[];if(rows.length>101)return null;continue;}
    field+=ch;
  }
  if(quoted)return null;row.push(field);if(row.some(value=>value.trim()))rows.push(row);
  if(rows.length<2||rows.length>101)return null;
  const header=rows.shift().map(value=>value.trim().replace(/^\uFEFF/,''));
  if(CONTENT_CSV_COLUMNS.some(column=>!header.includes(column))||new Set(header).size!==header.length||header.length!==CONTENT_CSV_COLUMNS.length)return null;
  const records=[];const slugs=new Set();
  for(let index=0;index<rows.length;index++){
    if(rows[index].length!==header.length)return null;
    const raw=Object.fromEntries(header.map((key,position)=>[key,rows[index][position]]));
    const item=normalizedContent({...raw,tags:raw.tags?raw.tags.split('|').map(tag=>tag.trim()).filter(Boolean):[]});
    if(!item)return null;
    if(slugs.has(item.slug))return null;slugs.add(item.slug);
    records.push(item);
  }
  return records;
}
function pageParams(url) {
  const limit = Math.max(1,Math.min(100,Number.parseInt(url.searchParams.get('limit') || '25',10) || 25));
  const offset = Math.max(0,Math.min(1000000,Number.parseInt(url.searchParams.get('offset') || '0',10) || 0));
  const search = (url.searchParams.get('search') || '').trim().slice(0,100);
  return { limit, offset, search };
}
async function presignUpload(pathKey) {
  const base = process.env.MANUS_API_URL || process.env.BUILT_IN_FORGE_API_URL;
  const token = process.env.MANUS_API_KEY || process.env.BUILT_IN_FORGE_API_KEY;
  if (!base || !token) throw new Error('التخزين غير مهيأ في بيئة المشروع.');
  const endpoint = new URL('/v1/storage/presign/put',base);
  endpoint.searchParams.set('path',pathKey);
  const response = await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
  let result={}; try { result=await response.json(); } catch {}
  if (!response.ok || typeof result.url !== 'string') throw new Error('تعذر تجهيز رفع الملف إلى التخزين.');
  return result.url;
}
async function presignDownload(pathKey) {
  const base = process.env.MANUS_API_URL || process.env.BUILT_IN_FORGE_API_URL;
  const token = process.env.MANUS_API_KEY || process.env.BUILT_IN_FORGE_API_KEY;
  if (!base || !token) throw new Error('التخزين غير مهيأ في بيئة المشروع.');
  const endpoint = new URL('/v1/storage/presign/get',base);
  endpoint.searchParams.set('path',pathKey);
  const response = await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
  let result={}; try { result=await response.json(); } catch {}
  if (!response.ok || typeof result.url !== 'string') throw new Error('تعذر تجهيز تنزيل المرفق.');
  return result.url;
}
function normalizedFileType(value) {
  if (typeof value !== 'string' || value.length > 120) return null;
  return value.trim() || DEFAULT_FILE_TYPE;
}
function validFileSize(value) { return Number.isSafeInteger(value) && value >= 0; }
function verifyFileBytes(bytes, type, expectedSize) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== expectedSize || expectedSize < 0) return false;
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff;
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP';
  if (type === 'image/gif') return bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
  if (type === 'application/pdf') return bytes.length >= 5 && bytes.toString('ascii',0,5)==='%PDF-';
  if (type === 'text/plain') { if (bytes.includes(0)) return false; try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); return true; } catch { return false; } }
  return false;
}
async function verifyStoredFile(key, expectedSize) {
  const base=process.env.MANUS_API_URL||process.env.BUILT_IN_FORGE_API_URL;
  const token=process.env.MANUS_API_KEY||process.env.BUILT_IN_FORGE_API_KEY;
  if(!base||!token) throw new Error('التخزين غير مهيأ في بيئة المشروع.');
  const endpoint=new URL('/v1/storage/presign/get',base);endpoint.searchParams.set('path',key);
  const grant=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
  let info={};try{info=await grant.json();}catch{}
  if(!grant.ok||typeof info.url!=='string') return false;
  const head=await fetch(info.url,{method:'HEAD',signal:AbortSignal.timeout(12000)}).catch(()=>null);
  if(head?.ok && head.headers.get('content-length') !== null) return Number(head.headers.get('content-length'))===expectedSize;
  const response=await fetch(info.url,{headers:{Range:'bytes=0-0'},signal:AbortSignal.timeout(12000)});
  if(expectedSize===0) return false;
  if(!response.ok) return false;
  const contentRange=response.headers.get('content-range');
  const contentLength=Number(response.headers.get('content-length'));
  if(contentRange) return Number(contentRange.split('/').at(-1))===expectedSize;
  return response.status===200 && contentLength===expectedSize;
}
async function normalizeMessageAttachments(rawAttachments, prefix) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 3) return null;
  let total = 0; const items = [];
  const keyPattern = new RegExp(`^${prefix.replace('/','\\/')}\\/[A-Za-z0-9._/-]+$`);
  for (const item of rawAttachments) {
    const name=cleanText(item?.name,255,{required:true}); const key=cleanText(item?.key,512,{required:true}); const type=item?.type; const size=Number(item?.size);
    const normalizedType=normalizedFileType(type);
    if(!name||!key||!keyPattern.test(key)||!normalizedType||!validFileSize(size)) return null;
    if(!await verifyStoredFile(key,size)) return null;
    items.push({name,type:normalizedType,size,path:`/manus-storage/${key}`});
  }
  return items;
}


async function extractPdfSourceText(fileKey) {
  const temp=await fs.mkdtemp(pathModule.join(os.tmpdir(),'qadir-text-'));
  try {
    const signed=await presignDownload(fileKey); const response=await fetch(signed,{signal:AbortSignal.timeout(120000)}); if(!response.ok) return '';
    const pdfPath=pathModule.join(temp,'source.pdf'); await fs.writeFile(pdfPath,Buffer.from(await response.arrayBuffer()));
    let text=''; try { const result=await execFileAsync('pdftotext',['-layout','-enc','UTF-8',pdfPath,'-'],{timeout:120000,maxBuffer:20*1024*1024}); text=String(result.stdout||'').trim(); } catch {}
    if(text.length>15000) return text.slice(0,100000);
    try {
      const info=await execFileAsync('pdfinfo',[pdfPath],{timeout:30000}); const pages=Number(String(info.stdout).match(/Pages:\s+(\d+)/)?.[1]||0); if(!pages) return text;
      const prefix=pathModule.join(temp,'page'); await execFileAsync('pdftoppm',['-f','1','-l',String(Math.min(pages,40)),'-jpeg','-r','110',pdfPath,prefix],{timeout:180000});
      const files=(await fs.readdir(temp)).filter(name=>/^page-\d+\.jpg$/.test(name)).sort(); let ocr='';
      for(const file of files){ try { const result=await execFileAsync('tesseract',[pathModule.join(temp,file),'stdout','-l','ara+eng'],{timeout:60000,maxBuffer:4*1024*1024}); ocr+=`\n[صفحة ${file.match(/(\d+)/)?.[1]||''}]\n${result.stdout||''}`; } catch {} }
      return (ocr||text).trim().slice(0,120000);
    } catch { return text.slice(0,120000); }
  } finally { await fs.rm(temp,{recursive:true,force:true}).catch(()=>{}); }
}

async function buildFigureCovers(fileKey, questions) {
  const targets = (questions || []).map((item, index) => ({ item, index })).filter(({item}) => Number.isInteger(Number(item.page)) && Number(item.page) > 0 && Array.isArray(item.figure_bbox) && item.figure_bbox.length === 4);
  if (!targets.length) return new Map();
  const temp = await fs.mkdtemp(pathModule.join(os.tmpdir(), 'qadir-figures-'));
  const covers = new Map();
  try {
    const signed = await presignDownload(fileKey); const response = await fetch(signed, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('تعذر تنزيل ملف PDF لقص الأشكال.');
    const pdfPath = pathModule.join(temp, 'source.pdf'); await fs.writeFile(pdfPath, Buffer.from(await response.arrayBuffer()));
    const rendered = new Map();
    const cropScript = `from PIL import Image\nimport sys\nimg=Image.open(sys.argv[1])\nx,y,w,h=[float(v) for v in sys.argv[3:7]]\nleft=max(0,int((x-0.02)*img.width)); top=max(0,int((y-0.02)*img.height))\nright=min(img.width,int((x+w+0.02)*img.width)); bottom=min(img.height,int((y+h+0.02)*img.height))\nimg.crop((left,top,max(left+1,right),max(top+1,bottom))).save(sys.argv[2], 'PNG', optimize=True)`;
    for (const {item, index} of targets) {
      const page = Number(item.page); const bbox = item.figure_bbox.map(Number); if (bbox.some(value => !Number.isFinite(value) || value < 0 || value > 1) || bbox[2] <= 0 || bbox[3] <= 0) continue;
      try { let pagePath = rendered.get(page);
      if (!pagePath) { pagePath = pathModule.join(temp, `page-${page}`); await execFileAsync('pdftoppm', ['-f', String(page), '-l', String(page), '-png', '-r', '150', '-singlefile', pdfPath, pagePath], { timeout: 120000 }); pagePath += '.png'; rendered.set(page, pagePath); }
      const cropPath = pathModule.join(temp, `crop-${index}.png`); await execFileAsync('python3', ['-c', cropScript, pagePath, cropPath, ...bbox.map(String)], { timeout: 30000 });
        const key = `qadir/site-lessons/figures/${crypto.randomUUID()}.png`; const uploadUrl = await presignUpload(key); const upload = await fetch(uploadUrl, { method: 'PUT', headers: {'Content-Type':'image/png'}, body: await fs.readFile(cropPath), signal: AbortSignal.timeout(120000) });
        if (upload.ok) covers.set(index, `/manus-storage/${key}`); } catch {}
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
  return covers;
}

function questionBody(item) {
  const question=String(item.question||item.title_ar||'').trim();
  const options=Array.isArray(item.options)?item.options.map(value=>String(value||'').trim()).filter(Boolean).slice(0,8):[];
  const answer=String(item.answer||'').trim() || (Number.isInteger(Number(item.correct_option)) && options[Number(item.correct_option)] ? options[Number(item.correct_option)] : '');
  const explanation=String(item.explanation||'').trim();
  return `السؤال:\n${question}\n\n${options.length?`الخيارات:\n${options.map((value,index)=>`${index+1}) ${value}`).join('\n')}\n\n`:''}الإجابة:\n${answer}\n\nالشرح:\n${explanation}`.slice(0,30000);
}
const adminAgent = createAdminAgent({ data, chatAI, presignDownload, verifyStoredFile, extractPdfSourceText });

async function handle(req,res,url,ctx) {
  const {method}=req;
  const path=url.pathname;
  try {
    if (path === '/api/site/settings' && method === 'GET') return ctx.json(res,200,await data.publicSettings());
    if (path === '/api/navigation' && method === 'GET') return ctx.json(res,200,{items:(await data.getNavigation()).filter(item=>item.is_active)});
    if (path === '/api/student-lessons' && method === 'GET') return ctx.json(res,200,{items:await data.listStudentLessons()});
    if (path === '/api/metrics/visit' && method === 'POST') {
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const page=typeof body.path==='string'?body.path:'';
      if(!publicPages.has(page)&&!/^\/content\/[a-z0-9]+(?:-[a-z0-9]+){0,15}$/.test(page)) return ctx.fail(res,400,'مسار الزيارة غير صالح.');
      if(typeof body.clientId!=='string'||!/^[a-f0-9-]{32,36}$/i.test(body.clientId)) return ctx.fail(res,400,'معرّف الزيارة غير صالح.');
      if(!limited(visitBuckets,`${body.clientId}:${page}`,1,30*60*1000)) return ctx.json(res,200,{recorded:false});
      await data.recordVisit(page); return ctx.json(res,202,{recorded:true});
    }
    if (path === '/api/content' && method === 'GET') {
      const kind=url.searchParams.get('kind')||'';
      if(kind && !CONTENT_KINDS.has(kind)) return ctx.fail(res,400,'نوع المحتوى غير صالح.');
      return ctx.json(res,200,{items:await data.listPublicContent({kind,limit:url.searchParams.get('limit')})});
    }
    const publicContent=path.match(/^\/api\/content\/([a-z0-9]+(?:-[a-z0-9]+){0,15})$/);
    if(publicContent && method==='GET') {
      const item=await data.getContentBySlug(publicContent[1]);
      if(!item) return ctx.fail(res,404,'المحتوى غير موجود.');
      return ctx.json(res,200,{item});
    }
    if(path==='/api/contact/attachments/presign' && method==='POST') {
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const address=String(req.socket.remoteAddress||'unknown');
      if(!limited(contactAttachmentBuckets,address,12,60*60*1000)) return ctx.fail(res,429,'تجاوزت الحد المؤقت لرفع المرفقات. حاول لاحقًا.');
      const name=cleanText(body.name,255,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!type||!validFileSize(size)) return ctx.fail(res,400,'بيانات المرفق غير صالحة.');
      const key=`qadir/contact/${crypto.randomUUID()}-${safeUploadName(name)}`;
      const uploadUrl=await presignUpload(key);
      return ctx.json(res,200,{uploadUrl,key,path:`/manus-storage/${key}`});
    }
    if(path==='/api/contact' && method==='POST') {
      const body=await bodyAndCsrf(req,res,ctx,15*1024*1024); if(!body) return true;
      const name=cleanText(body.name,100,{required:true});
      const email=cleanText(body.email,254);
      const subject=cleanText(body.subject,180,{required:true});
      const message=cleanText(body.message,6000,{required:true});
      const rawAttachments=body.attachments === undefined ? [] : body.attachments;
      if(!Array.isArray(rawAttachments)||rawAttachments.length>3) return ctx.fail(res,400,'يمكن إرفاق 3 ملفات كحد أقصى.');
      let attachmentBytes=0; const attachments=[];
      for(const item of rawAttachments) {
        const itemName=cleanText(item?.name,255,{required:true}); const itemKey=cleanText(item?.key,512,{required:true}); const itemType=normalizedFileType(item?.type); const itemSize=Number(item?.size);
        if(!itemName||!itemKey||!/^qadir\/contact\/[A-Za-z0-9._/-]+$/.test(itemKey)||!itemType||!validFileSize(itemSize)) return ctx.fail(res,400,'بيانات المرفق غير صالحة.');
        if(!await verifyStoredFile(itemKey,itemSize)) return ctx.fail(res,400,'تعذر التحقق من وجود المرفق وحجمه.');
        attachments.push({name:itemName,type:itemType,size:itemSize,path:`/manus-storage/${itemKey}`});
      }
      if(!name||email===null||!validEmail(email)||!subject||(!message&&!attachments.length)) return ctx.fail(res,400,'تحقق من الاسم والبريد والموضوع واكتب رسالة أو أرفق ملفًا.');
      const address=String(req.socket.remoteAddress||'unknown');
      if(!limited(contactBuckets,address,5,60*60*1000)) return ctx.fail(res,429,'وصلت إلى الحد المؤقت لإرسال الرسائل. حاول لاحقًا.');
      const user=await ctx.sessionUser(req).catch(()=>null);
      const secret=await db.getCsrfSecret();
      const ipHash=requestHash(req,secret);
      const id=await data.addMessage({userId:user?.id||null,name,email:email||null,subject,message:message||'أرسل المرفقات دون نص.',attachments,ipHash});
      return ctx.json(res,201,{id,message:'وصلت رسالتك إلى فريق قادر.'});
    }
    if(path==='/api/contact/threads' && method==='GET') {
      const user=await ctx.sessionUser(req); if(!user) return ctx.fail(res,401,'يلزم تسجيل الدخول.');
      return ctx.json(res,200,{items:await data.listUserReplies(user.id)});
    }

    if(path==='/api/admin/summary' && method==='GET') {
      const user=await auth(req,res,ctx,'dashboard.view'); if(!user) return true;
      return ctx.json(res,200,await data.dashboardSummary());
    }
    if(path==='/api/admin/ai/files/presign'&&method==='POST') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      if(!isFullAdmin(user)) return ctx.fail(res,403,'رفع ملفات مساعد الإدارة متاح للمديرين الإداريين فقط.');
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const name=cleanText(body.name,255,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!type||!validFileSize(size)||size>30*1024*1024) return ctx.fail(res,400,'الملف غير صالح أو يتجاوز 30 ميغابايت.');
      const key=`qadir/admin-ai/${crypto.randomUUID()}-${safeUploadName(name)}`;
      return ctx.json(res,200,{uploadUrl:await presignUpload(key),key,path:`/manus-storage/${key}`});
    }
    if(path==='/api/admin/ai/command'&&method==='POST') {
      const user=await auth(req,res,ctx,'content.view'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx,160*1024); if(!body) return true;
      try { return ctx.json(res,200,await adminAgent.run(user,body)); }
      catch(error) { console.error('[admin-ai] command failed:',error?.message||error); return ctx.fail(res,502,error?.message||'تعذر تنفيذ أمر المساعد الإداري.'); }
    }
    if(path==='/api/admin/student-lessons' && method==='GET') {
      const user=await auth(req,res,ctx,'content.view'); if(!user) return true;
      return ctx.json(res,200,{items:await data.listStudentLessons()});
    }
    const studentLessonRoute=path.match(/^\/api\/admin\/student-lessons\/([klt]\d+)$/);
    if(studentLessonRoute && method==='PUT') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const lessonKey=studentLessonRoute[1]; const current=await data.getStudentLesson(lessonKey);
      if(!current) return ctx.fail(res,404,'الدرس غير موجود.');
      let title=cleanText(body.title_ar,200); const description=cleanText(body.description_ar,500); const youtube=normalizeYoutubeUrl(body.youtube_url);
      if(title===null || description===null || youtube===null) return ctx.fail(res,400,'تحقق من العنوان والوصف ورابط يوتيوب.');
      if(!title) {
        try {
          title=await chatAI.completeChat([
            {role:'system',content:'أنت محرر عناوين عربي لمنصة تعليمية. أعد عنوان درس واحدًا فقط، واضحًا وقصيرًا، بلا علامات اقتباس أو شرح.'},
            {role:'user',content:`اكتب عنوانًا مناسبًا لدرس ${current.section}. العنوان الأصلي: ${current.original_title_ar}. الوصف الحالي: ${description || current.description_ar || 'لا يوجد وصف'}`}
          ],globalThis.fetch,{model:'gpt-5-mini',maxCompletionTokens:80,maxOutputLength:200});
          title=title.replace(/["“”«»]/g,'').trim().slice(0,200);
        } catch { title=current.original_title_ar; }
      }
      await data.updateStudentLesson(user,lessonKey,{title_ar:title,description_ar:description,youtube_url:youtube});
      return ctx.json(res,200,{updated:true,item:await data.getStudentLesson(lessonKey),titleGenerated:title===current.original_title_ar && !body.title_ar});
    }
    if(path==='/api/admin/site-lessons/presign'&&method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const name=cleanText(body.name,255,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!isTeachingFileType(type)||!validFileSize(size)) return ctx.fail(res,400,'نوع الملف غير مدعوم للتحليل. ارفع PDF أو Word أو PowerPoint أو Excel أو صورة.');
      const key=`qadir/site-lessons/${crypto.randomUUID()}-${safeUploadName(name)}`; await presignUpload(key); return ctx.json(res,200,{key,path:`/manus-storage/${key}`});
    }
    if(path==='/api/admin/site-lessons/extract'&&method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx,70*1024); if(!body) return true;
      const key=cleanText(body.key,512,{required:true}); const type=normalizedFileType(body.type); const name=cleanText(body.name,255,{required:true}); const mode=body.mode==='questions'?'questions':'lesson'; const size=Number(body.size);
      if(!key||!/^qadir\/site-lessons\/[A-Za-z0-9._/-]+$/.test(key)||!name||!isTeachingFileType(type)||!validFileSize(size)) return ctx.fail(res,400,'بيانات ملف دروس الموقع غير صالحة.');
      if(!await verifyStoredFile(key,size)) return ctx.fail(res,400,'تعذر التحقق من وصول الملف المرفوع.');
      try {
        const extracted=await chatAI.extractTeachingContent(await presignDownload(key),type,mode,globalThis.fetch,{sourceText:type==='application/pdf'?await extractPdfSourceText(key):''}); const slugBase=`site-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const covers=type==='application/pdf'&&mode==='questions'?await buildFigureCovers(key,extracted.questions):new Map();
        const common={title_en:'',body_en:'',category:mode==='questions'?'بنك أسئلة':'درس مستخرج من ملف',tags:['دروس الموقع',mode==='questions'?'أسئلة':'درس'],cover_url:'',status:'draft',seo_title_ar:'',seo_title_en:'',seo_description_ar:'',seo_description_en:'',publish_at:null};
        let items=[];
        if(mode==='questions'&&extracted.questions.length) items=extracted.questions.map((item,index)=>{const options=Array.isArray(item.options)?item.options.map(value=>String(value||'').trim()).filter(Boolean).slice(0,8):[]; return {kind:'question',slug:`${slugBase}-${index+1}`,title_ar:String(item.question||`سؤال ${index+1}`).slice(0,200),question:String(item.question||'').trim(),options,correct_option:Number.isInteger(Number(item.correct_option))?Number(item.correct_option):null,body_ar:`السؤال:\n${String(item.question||'').trim()}\n\n${options.length?`الخيارات:\n${options.map((value,optionIndex)=>`${optionIndex+1}) ${value}`).join('\n')}\n\n`:''}الإجابة:\n${String(item.answer||'').trim()}\n\nالشرح:\n${String(item.explanation||'').trim()}`.slice(0,30000),...common,cover_url:covers.get(index)||''};});
        else items=[{kind:'lesson',slug:slugBase,title_ar:extracted.title_ar||name.replace(/\.[^.]+$/,''),body_ar:(extracted.body_ar||'').slice(0,30000),...common}];
        items=items.filter(item=>item.title_ar&&item.body_ar); if(!items.length) return ctx.fail(res,422,'لم يجد الذكاء الاصطناعي محتوى صالحًا داخل الملف.');
        return ctx.json(res,200,{preview:true,mode,items,source:{name,key,type,size},message:`تم استخراج ${items.length} عنصرًا. راجع المعاينة قبل الحفظ.`});
      } catch(error) { console.error('[site-lessons] extract failed:', error?.message || error); return ctx.fail(res,502,'تعذر تحليل الملف الآن. تأكد أن الملف صالح ويمكن قراءته ثم حاول مرة أخرى.'); }
    }
    if(path==='/api/admin/site-lessons/commit'&&method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx,20*1024*1024); if(!body) return true;
      const source=body.source||{}; const key=cleanText(source.key,512,{required:true}); const name=cleanText(source.name,255,{required:true}); const type=normalizedFileType(source.type); const size=Number(source.size);
      if(!key||!/^qadir\/site-lessons\/[A-Za-z0-9._/-]+$/.test(key)||!name||!isTeachingFileType(type)||!validFileSize(size)||!Array.isArray(body.items)||body.items.length<1||body.items.length>500) return ctx.fail(res,400,'بيانات المعاينة غير صالحة.');
      if(!await verifyStoredFile(key,size)) return ctx.fail(res,400,'انتهت صلاحية الملف أو لم يعد موجودًا.');
      const status='published'; const items=body.items.map(item=>normalizedContent({...item,status,body_ar:item.kind==='question'?questionBody(item):item.body_ar}));
      if(items.some(item=>!item)) return ctx.fail(res,400,'تعذر التحقق من أحد عناصر المعاينة.');
      try { const result=await data.importContent(user,items); await data.addMedia(user,{name,key,type,size}); return ctx.json(res,201,{imported:result.imported,ids:result.ids,message:status==='published'?'تم حفظ المعاينة ونشر المحتوى.':'تم حفظ المعاينة كمسودة.'}); }
      catch(error) { if(error.code==='ER_DUP_ENTRY') return ctx.fail(res,409,'يوجد رابط مكرر في المعاينة. أعد التحليل للحصول على روابط جديدة.'); throw error; }
    }
    if(path==='/api/admin/content' && method==='GET') {
      const user=await auth(req,res,ctx,'content.view'); if(!user) return true;
      const params=pageParams(url);
      const kind=url.searchParams.get('kind')||'';
      const status=url.searchParams.get('status')||'';
      if(kind&&!CONTENT_KINDS.has(kind)||status&&!CONTENT_STATUSES.has(status)) return ctx.fail(res,400,'خيارات التصفية غير صالحة.');
      return ctx.json(res,200,await data.listContent({...params,kind,status,trash:url.searchParams.get('trash')==='true'}));
    }
    if(path==='/api/admin/content/import'&&method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx,1400*1024); if(!body) return true;
      const items=parseCsv(body.csv); if(!items) return ctx.fail(res,400,'ملف CSV غير صالح؛ استخدم القالب الذي تصدّره قادر وتحقق من الحقول والحد البالغ 100 عنصر.');
      try { return ctx.json(res,201,await data.importContent(user,items)); }
      catch(error) { if(error.code==='ER_DUP_ENTRY') return ctx.fail(res,409,'تعذر الاستيراد لأن رابطًا مكررًا موجود. لم يُحفظ أي صف.'); throw error; }
    }
    if(path==='/api/admin/content' && method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const item=normalizedContent(body); if(!item) return ctx.fail(res,400,'تحقق من الحقول المطلوبة ونوع المحتوى وحالة النشر والرابط.');
      const result=await data.createContent(user,item);
      return ctx.json(res,201,{id:result.id});
    }
    if(path==='/api/admin/content/bulk' && method==='POST') {
      const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      if(!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>50||body.ids.some(id=>!safeId(id))) return ctx.fail(res,400,'حدد من 1 إلى 50 عنصرًا صالحًا.');
      if(!['publish','archive','trash'].includes(body.action)) return ctx.fail(res,400,'الإجراء الجماعي غير صالح.');
      return ctx.json(res,200,{updated:await data.bulkContent(user,[...new Set(body.ids.map(Number))],body.action)});
    }
    const contentRoute=path.match(/^\/api\/admin\/content\/(\d+)(?:\/(versions|restore|restore-version|permanent))?$/);
    if(contentRoute) {
      const id=safeId(contentRoute[1]); if(!id) return ctx.fail(res,400,'معرّف المحتوى غير صالح.');
      const sub=contentRoute[2]||'';
      if(method==='GET'&&sub==='versions') {
        const user=await auth(req,res,ctx,'content.view'); if(!user) return true;
        return ctx.json(res,200,{versions:await data.listVersions(id)});
      }
      if(method==='DELETE'&&sub==='permanent') {
        const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{deleted:await data.permanentlyDeleteContent(user,id)});
      }
      if(method==='POST'&&sub==='restore') {
        const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{restored:await data.setContentTrash(user,id,false)});
      }
      if(method==='POST'&&sub==='restore-version') {
        const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        const snapshot=await data.getVersion(id,safeId(body.versionId));
        if(!snapshot) return ctx.fail(res,404,'الإصدار غير موجود.');
        const item=normalizedContent(snapshot); if(!item) return ctx.fail(res,409,'لا يمكن استعادة هذا الإصدار.');
        return ctx.json(res,200,{restored:await data.updateContent(user,id,item)});
      }
      if(method==='PUT'&&!sub) {
        const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        const item=normalizedContent(body); if(!item) return ctx.fail(res,400,'تحقق من الحقول المطلوبة ونوع المحتوى وحالة النشر والرابط.');
        return ctx.json(res,200,{updated:await data.updateContent(user,id,item)});
      }
      if(method==='DELETE'&&!sub) {
        const user=await auth(req,res,ctx,'content.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{trashed:await data.setContentTrash(user,id,true)});
      }
    }
    if(path==='/api/admin/messages'&&method==='GET') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      const params=pageParams(url); const status=url.searchParams.get('status')||''; const type=url.searchParams.get('type')||''; const read=url.searchParams.get('read')||'';
      if(status&&!['new','open','replied','closed'].includes(status)) return ctx.fail(res,400,'حالة الرسالة غير صالحة.');
      if(type&&!['student','admin'].includes(type)) return ctx.fail(res,400,'نوع الرسالة غير صالح.');
      if(read&&!['read','unread'].includes(read)) return ctx.fail(res,400,'حالة القراءة غير صالحة.');
      return ctx.json(res,200,await data.listMessages({...params,status,type,read,trash:url.searchParams.get('trash')==='true'}));
    }
    if(path==='/api/admin/attachments'&&method==='GET') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      const params=pageParams(url); const type=url.searchParams.get('type')||'';
      if(type&&!['image','pdf','other'].includes(type)) return ctx.fail(res,400,'نوع المرفق غير صالح.');
      return ctx.json(res,200,await data.listMessageAttachments({...params,type}));
    }
    const attachmentRoute=path.match(/^\/api\/admin\/attachments\/(\d+)\/download$/);
    if(attachmentRoute&&method==='GET') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      const attachment=await data.getMessageAttachment(safeId(attachmentRoute[1]));
      if(!attachment) return ctx.fail(res,404,'المرفق غير موجود.');
      const location=await presignDownload(attachment.object_key);
      await data.logActivity(user,'attachment.download','message_attachment',attachment.id,{name:attachment.original_name,message_id:attachment.message_id});
      res.writeHead(302,{Location:location,'Cache-Control':'private, no-store'}); res.end(); return true;
    }
    if(path==='/api/admin/messages/recipients'&&method==='GET') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      return ctx.json(res,200,{items:await data.listAdminRecipients()});
    }
    if(path==='/api/admin/messages/attachments/presign'&&method==='POST') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const name=cleanText(body.name,255,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!type||!validFileSize(size)) return ctx.fail(res,400,'بيانات المرفق غير صالحة.');
      const key=`qadir/messages/${crypto.randomUUID()}-${safeUploadName(name)}`;
      const uploadUrl=await presignUpload(key);
      return ctx.json(res,200,{uploadUrl,key,path:`/manus-storage/${key}`});
    }
    if(path==='/api/admin/messages/admin'&&method==='POST') {
      const user=await auth(req,res,ctx,'messages.view'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const recipientUsername=typeof body.recipientUsername==='string'?body.recipientUsername.trim().toLowerCase():'';
      const subject=cleanText(body.subject,180,{required:true});
      const message=cleanText(body.message,6000,{required:true});
      const attachments=await normalizeMessageAttachments(body.attachments||[],'qadir/messages');
      if((recipientUsername!=='__all__'&&!/^[a-z0-9_]{3,24}$/.test(recipientUsername))||!subject||(!message&&!attachments?.length)||attachments===null) return ctx.fail(res,400,'تحقق من الإداري والموضوع واكتب رسالة أو أرفق ملفًا صالحًا.');
      const result=await data.addAdminMessage(user,{recipientUsername,subject,message:message||'أرسل المرفقات دون نص.',attachments});
      if(result.error==='recipient_not_found') return ctx.fail(res,404,'الإداري المستلم غير موجود.');
      return ctx.json(res,201,result);
    }
    const messageRoute=path.match(/^\/api\/admin\/messages\/(\d+)(?:\/(restore|permanent))?$/);
    if(messageRoute) {
      const id=safeId(messageRoute[1]);
      if(method==='DELETE'&&messageRoute[2]==='permanent') {
        const user=await auth(req,res,ctx,'messages.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{deleted:await data.permanentlyDeleteMessage(user,id)});
      }
      if(method==='POST'&&messageRoute[2]==='restore') {
        const user=await auth(req,res,ctx,'messages.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{restored:await data.updateMessage(user,id,{trash:false})});
      }
      if(method==='PUT'&&!messageRoute[2]) {
        const user=await auth(req,res,ctx,'messages.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        const reply=cleanText(body.reply,6000);
        const status=body.status||'replied';
        if(reply===null||!['open','replied','closed'].includes(status)) return ctx.fail(res,400,'نص الرد أو حالة الرسالة غير صالحة.');
        return ctx.json(res,200,{updated:await data.updateMessage(user,id,{reply,status})});
      }
      if(method==='DELETE'&&!messageRoute[2]) {
        const user=await auth(req,res,ctx,'messages.manage'); if(!user) return true;
        const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
        return ctx.json(res,200,{trashed:await data.updateMessage(user,id,{trash:true})});
      }
    }
    if(path==='/api/admin/users/status'&&method==='POST') {
      const user=await auth(req,res,ctx,'users.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
      if(!/^[a-z0-9_]{3,24}$/.test(username)||typeof body.active!=='boolean') return ctx.fail(res,400,'بيانات حالة الحساب غير صالحة.');
      const result=await data.setUserActive(user,username,body.active);
      if(result.error==='forbidden') return ctx.fail(res,403,'لا تملك صلاحية إدارة هذا الحساب.');
      if(result.error==='protected') return ctx.fail(res,409,'لا يمكن تعطيل حسابك أو حساب مالك النظام.');
      if(result.error==='hierarchy') return ctx.fail(res,403,'لا يمكنك إدارة حساب مساوٍ أو أعلى من رتبتك.');
      if(result.error==='not_found') return ctx.fail(res,404,'الحساب غير موجود.');
      return ctx.json(res,200,result);
    }
    if(path==='/api/admin/users/delete'&&method==='POST') {
      const user=await auth(req,res,ctx,'users.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';
      if(!/^[a-z0-9_]{3,24}$/.test(username)||body.confirm!==true) return ctx.fail(res,400,'أكّد حذف الحساب وأرسل اسم مستخدم صالحًا.');
      const result=await data.deleteUser(user,username);
      if(result.error==='forbidden') return ctx.fail(res,403,'لا تملك صلاحية حذف الحسابات.');
      if(result.error==='protected') return ctx.fail(res,409,'لا يمكن حذف حسابك أو حساب مالك النظام.');
      if(result.error==='hierarchy') return ctx.fail(res,403,'لا يمكنك حذف حساب مساوٍ أو أعلى من رتبتك.');
      if(result.error==='not_found') return ctx.fail(res,404,'الحساب غير موجود.');
      return ctx.json(res,200,result);
    }
    if(path==='/api/admin/settings'&&method==='GET') {
      const user=await auth(req,res,ctx,'settings.view'); if(!user) return true;
      return ctx.json(res,200,{settings:await data.getSettings()});
    }
    if(path==='/api/admin/settings'&&method==='PUT') {
      const user=await auth(req,res,ctx,'settings.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const entries=Object.entries(body.settings||{});
      if(!entries.length||entries.some(([key])=>!settingsKeys.has(key))) return ctx.fail(res,400,'مفاتيح الإعدادات غير صالحة.');
      for(const [key,value] of entries) {
        if(key==='site_name'&&(!cleanText(value,80,{required:true}))) return ctx.fail(res,400,'اسم الموقع مطلوب وبحد أقصى 80 حرفًا.');
        if(key==='logo_url'&&value&&!(typeof value==='string'&&/^\/manus-storage\/[A-Za-z0-9._/-]{1,480}$/.test(value))) return ctx.fail(res,400,'الشعار يجب أن يكون رابط تخزين قادر ثابتًا.');
        if(key==='contact_email'&&(cleanText(value,254)===null||!validEmail(value))) return ctx.fail(res,400,'البريد الإلكتروني غير صالح.');
        if(key==='seo_description'&&cleanText(value,320)===null) return ctx.fail(res,400,'وصف SEO يتجاوز الحد المسموح.');
        if(key==='maintenance_mode'&&typeof value!=='boolean') return ctx.fail(res,400,'قيمة وضع الصيانة غير صالحة.');
        if(key==='maintenance_message'&&cleanText(value,300,{required:true})===null) return ctx.fail(res,400,'رسالة الصيانة مطلوبة وبحد أقصى 300 حرف.');
        if(key==='social_links'&&(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(url=>typeof url!=='string'||url.length>300||!/^https:\/\//.test(url)))) return ctx.fail(res,400,'روابط التواصل يجب أن تكون روابط HTTPS.');
        if(key==='notification_templates'&&(!value||typeof value!=='object'||Array.isArray(value))) return ctx.fail(res,400,'قوالب الإشعارات غير صالحة.');
        await data.setSetting(user,key,value);
      }
      return ctx.json(res,200,{saved:true});
    }
    if(path==='/api/navigation'&&method==='GET') return ctx.json(res,200,{items:(await data.getNavigation()).filter(item=>item.is_active)});
    if(path==='/api/admin/navigation'&&method==='GET') {
      const user=await auth(req,res,ctx,'settings.view'); if(!user) return true;
      return ctx.json(res,200,{items:await data.getNavigation({includeTrash:url.searchParams.get('trash')==='true'})});
    }
    if(path==='/api/admin/navigation'&&method==='POST') {
      const user=await auth(req,res,ctx,'navigation.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const item={id:safeId(body.id)||null,label_ar:cleanText(body.label_ar,100,{required:true}),label_en:cleanText(body.label_en,100),href:cleanText(body.href,512,{required:true}),position:Math.max(0,Math.min(10000,Number(body.position)||0)),is_active:body.is_active!==false};
      if(!item.label_ar||item.label_en===null||!item.href||!(/^(\/|https:\/\/)/.test(item.href))||item.href.startsWith('//')) return ctx.fail(res,400,'تحقق من اسم الرابط وعنوانه.');
      return ctx.json(res,200,{id:await data.saveNavigation(user,item)});
    }
    const navRoute=path.match(/^\/api\/admin\/navigation\/(\d+)(?:\/(restore|permanent))?$/);
    if(navRoute&&method==='DELETE'&&navRoute[2]==='permanent') {
      const user=await auth(req,res,ctx,'navigation.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{deleted:await data.permanentlyDeleteNavigation(user,safeId(navRoute[1]))});
    }
    if(navRoute&&method==='DELETE') {
      const user=await auth(req,res,ctx,'navigation.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{trashed:await data.trashNavigation(user,safeId(navRoute[1]),false)});
    }
    if(navRoute&&method==='POST'&&navRoute[2]==='restore') {
      const user=await auth(req,res,ctx,'navigation.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{restored:await data.trashNavigation(user,safeId(navRoute[1]),true)});
    }
    if(path==='/api/admin/files'&&method==='GET') {
      const user=await auth(req,res,ctx,'media.view'); if(!user) return true;
      return ctx.json(res,200,await data.listMedia({...pageParams(url),trash:url.searchParams.get('trash')==='true'}));
    }
    if(path==='/api/admin/files/presign'&&method==='POST') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const name=cleanText(body.name,255,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!type||!validFileSize(size)) return ctx.fail(res,400,'بيانات الملف غير صالحة.');
      const safeName=name.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g,'_').slice(-100)||'upload';
      const key=`qadir/admin/${crypto.randomUUID()}-${safeName}`;
      const uploadUrl=await presignUpload(key);
      return ctx.json(res,200,{uploadUrl,key,path:`/manus-storage/${key}`});
    }
    if(path==='/api/admin/files'&&method==='POST') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      const name=cleanText(body.name,255,{required:true}); const key=cleanText(body.key,512,{required:true}); const type=normalizedFileType(body.type); const size=Number(body.size);
      if(!name||!key||!/^qadir\/admin\/[A-Za-z0-9._/-]+$/.test(key)||!type||!validFileSize(size)) return ctx.fail(res,400,'بيانات الملف غير صالحة.');
      if(!await verifyStoredFile(key,size)) return ctx.fail(res,400,'تعذر التحقق من وجود الملف وحجمه.');
      return ctx.json(res,201,{id:await data.addMedia(user,{name,key,type,size})});
    }
    const mediaRoute=path.match(/^\/api\/admin\/files\/(\d+)(?:\/(restore|permanent))?$/);
    if(mediaRoute&&method==='DELETE'&&mediaRoute[2]==='permanent') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{deleted:await data.permanentlyDeleteMedia(user,safeId(mediaRoute[1]))});
    }
    if(mediaRoute&&method==='DELETE') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{trashed:await data.trashMedia(user,safeId(mediaRoute[1]),false),note:'أُخفي الملف من فهرس الموقع؛ التخزين runtime لا يوفّر حذفًا ماديًا.'});
    }
    if(mediaRoute&&method==='POST'&&mediaRoute[2]==='restore') {
      const user=await auth(req,res,ctx,'media.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{restored:await data.trashMedia(user,safeId(mediaRoute[1]),true)});
    }
    if(path==='/api/admin/activity'&&method==='GET') {
      const user=await auth(req,res,ctx,'audit.view'); if(!user) return true;
      return ctx.json(res,200,{items:await data.listActivity(pageParams(url))});
    }
    if(path==='/api/admin/backup'&&method==='GET') {
      const user=await auth(req,res,ctx,'backups.manage'); if(!user) return true;
      const backup=await data.backup();
      const payload=Buffer.from(JSON.stringify(backup,null,2));
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="qadir-backup-${new Date().toISOString().slice(0,10)}.json"`,'Content-Length':payload.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(payload); return true;
    }
    if(path==='/api/admin/security/sessions'&&method==='GET') {
      const user=await auth(req,res,ctx,'security.manage'); if(!user) return true;
      return ctx.json(res,200,{items:await data.listSessions(user.id)});
    }
    const sessionRoute=path.match(/^\/api\/admin\/security\/sessions\/(\d+)$/);
    if(sessionRoute&&method==='DELETE') {
      const user=await auth(req,res,ctx,'security.manage'); if(!user) return true;
      const body=await bodyAndCsrf(req,res,ctx); if(!body) return true;
      return ctx.json(res,200,{revoked:await data.revokeSession(user.id,safeId(sessionRoute[1]))});
    }
  } catch(error) {
    if(error?.code==='ER_DUP_ENTRY') return ctx.fail(res,409,'هذا المعرف مستخدم بالفعل.');
    return ctx.fail(res,503,'تعذر إتمام طلب الإدارة الآن.');
  }
  return false;
}

module.exports={handle,verifyFileBytes,parseCsv,presignUpload};
