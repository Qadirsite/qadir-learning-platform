'use strict';

const db = require('./db');
const pool = () => db.getPool();

function parseJson(value, fallback = null) {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return fallback; } }
  return value ?? fallback;
}
function parsePermissions(value) {
  const permissions=parseJson(value,[]);
  return Array.isArray(permissions)?permissions.filter(item=>typeof item==='string'):[];
}
function safeLimit(value, max = 100) { return Math.max(1, Math.min(max, Math.trunc(Number(value) || 25))); }
function safeOffset(value) { return Math.max(0, Math.min(1000000, Math.trunc(Number(value) || 0))); }
function contentFields(input) {
  return [input.kind, input.slug, input.title_ar, input.title_en || null, input.body_ar,
    input.body_en || null, input.category || '', JSON.stringify(input.tags || []), input.cover_url || null,
    input.status, input.seo_title_ar || null, input.seo_title_en || null,
    input.seo_description_ar || null, input.seo_description_en || null, input.publish_at || null];
}
const CONTENT_COLUMNS = 'kind, slug, title_ar, title_en, body_ar, body_en, category, tags, cover_url, status, seo_title_ar, seo_title_en, seo_description_ar, seo_description_en, publish_at';
function rowContent(row) {
  return { ...row, id: Number(row.id), tags: parseJson(row.tags, []), created_by: row.created_by == null ? null : Number(row.created_by), updated_by: row.updated_by == null ? null : Number(row.updated_by) };
}
async function logActivity(actor, action, targetType, targetId = null, details = {}) {
  await pool().execute(`INSERT INTO admin_activity (actor_user_id, actor_username, action, target_type, target_id, details)
    VALUES (?, ?, ?, ?, ?, ?)`, [actor.id, actor.username, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(details)]);
}

async function dashboardSummary() {
  const connection = pool();
  const [[counts]] = await connection.query(`SELECT
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COUNT(*) FROM users WHERE created_at >= UTC_DATE()) AS registrations_today,
    (SELECT COUNT(*) FROM users WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY) AS registrations_7d,
    (SELECT COUNT(*) FROM users WHERE last_active_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AS active_24h,
    (SELECT COALESCE(SUM(total_active_seconds),0) FROM users) AS active_seconds,
    (SELECT COUNT(*) FROM admin_content WHERE deleted_at IS NULL AND status = 'published' AND (publish_at IS NULL OR publish_at <= UTC_TIMESTAMP())) AS published_content,
    (SELECT COUNT(*) FROM admin_messages WHERE deleted_at IS NULL AND status = 'new') AS new_messages`);
  const [visits] = await connection.query(`SELECT DATE_FORMAT(visit_date, '%Y-%m-%d') AS day, SUM(views) AS views
    FROM admin_daily_visits WHERE visit_date >= UTC_DATE() - INTERVAL 13 DAY GROUP BY visit_date ORDER BY visit_date`);
  const [registrations] = await connection.query(`SELECT DATE_FORMAT(DATE(created_at), '%Y-%m-%d') AS day, COUNT(*) AS count
    FROM users WHERE created_at >= UTC_DATE() - INTERVAL 13 DAY GROUP BY DATE(created_at) ORDER BY DATE(created_at)`);
  return {
    totals: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value) || 0])),
    visits: visits.map(row => ({ day: row.day, count: Number(row.views) || 0 })),
    registrations: registrations.map(row => ({ day: row.day, count: Number(row.count) || 0 }))
  };
}
async function recordVisit(page) {
  await pool().execute(`INSERT INTO admin_daily_visits (visit_date, path, views) VALUES (UTC_DATE(), ?, 1)
    ON DUPLICATE KEY UPDATE views = views + 1`, [page]);
}
async function listContent({ search = '', kind = '', status = '', trash = false, limit = 25, offset = 0 }) {
  const where = [];
  const params = [];
  if (trash) where.push('deleted_at IS NOT NULL'); else where.push('deleted_at IS NULL');
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (status && !trash) { where.push('status = ?'); params.push(status); }
  if (search) { where.push('(LOCATE(?, title_ar) > 0 OR LOCATE(?, COALESCE(title_en, "")) > 0 OR LOCATE(?, slug) > 0)'); params.push(search, search, search); }
  const filter = `WHERE ${where.join(' AND ')}`;
  const [rows] = await pool().execute(`SELECT * FROM admin_content ${filter} ORDER BY updated_at DESC, id DESC LIMIT ${safeLimit(limit)} OFFSET ${safeOffset(offset)}`, params);
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total FROM admin_content ${filter}`, params);
  return { items: rows.map(rowContent), total: Number(count.total) || 0 };
}
async function getContentBySlug(slug) {
  const [rows] = await pool().execute(`SELECT id,kind,slug,title_ar,title_en,body_ar,body_en,summary_ar,summary_status,summary_generated_at,category,tags,cover_url,seo_title_ar,seo_title_en,seo_description_ar,seo_description_en,publish_at,created_at,updated_at
    FROM admin_content WHERE slug = ? AND deleted_at IS NULL AND status = 'published' AND (publish_at IS NULL OR publish_at <= UTC_TIMESTAMP()) LIMIT 1`, [slug]);
  return rows[0] ? rowContent(rows[0]) : null;
}
async function listPublicContent({ kind = '', limit = 30, offset = 0 }) {
  const params = [];
  const kindFilter = kind ? ' AND kind = ?' : '';
  if (kind) params.push(kind);
  const [rows] = await pool().execute(`SELECT id,kind,slug,title_ar,title_en,body_ar,body_en,summary_ar,summary_status,summary_generated_at,category,tags,cover_url,seo_title_ar,seo_title_en,seo_description_ar,seo_description_en,publish_at,created_at,updated_at
    FROM admin_content WHERE deleted_at IS NULL AND status = 'published' AND (publish_at IS NULL OR publish_at <= UTC_TIMESTAMP())${kindFilter}
    ORDER BY COALESCE(publish_at,updated_at) DESC,id DESC LIMIT ${safeLimit(limit, 100)} OFFSET ${safeOffset(offset)}`, params);
  return rows.map(rowContent);
}
async function createContent(actor, input) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(`INSERT INTO admin_content (${CONTENT_COLUMNS}, created_by, updated_by)
      VALUES (${new Array(15).fill('?').join(',')}, ?, ?)`, [...contentFields(input), actor.id, actor.id]);
    const id = Number(result.insertId);
    const snapshot = { ...input, id };
    await connection.execute('INSERT INTO admin_content_versions (content_id, version_no, snapshot, created_by) VALUES (?, 1, ?, ?)', [id, JSON.stringify(snapshot), actor.id]);
    await connection.execute(`INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)`, [actor.id, actor.username, 'content.create', 'content', String(id), JSON.stringify({ slug: input.slug, kind: input.kind })]);
    await connection.commit();
    return { id };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function importContent(actor, items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) throw new Error('invalid_import_count');
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const ids = [];
    for (const input of items) {
      const [result] = await connection.execute(`INSERT INTO admin_content (${CONTENT_COLUMNS}, created_by, updated_by)
        VALUES (${new Array(15).fill('?').join(',')}, ?, ?)`, [...contentFields(input), actor.id, actor.id]);
      const id = Number(result.insertId);
      await connection.execute('INSERT INTO admin_content_versions (content_id, version_no, snapshot, created_by) VALUES (?, 1, ?, ?)', [id, JSON.stringify({ ...input, id }), actor.id]);
      ids.push(id);
    }
    await connection.execute('INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)', [actor.id, actor.username, 'content.import', 'content', null, JSON.stringify({ count: ids.length })]);
    await connection.commit();
    return { imported: ids.length, ids };
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function updateContent(actor, id, input) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT * FROM admin_content WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!rows.length) { await connection.rollback(); return false; }
    const [[version]] = await connection.execute('SELECT COALESCE(MAX(version_no),0) + 1 AS next_version FROM admin_content_versions WHERE content_id = ?', [id]);
    await connection.execute('INSERT INTO admin_content_versions (content_id, version_no, snapshot, created_by) VALUES (?, ?, ?, ?)', [id, Number(version.next_version), JSON.stringify(rowContent(rows[0])), actor.id]);
    const setClause = CONTENT_COLUMNS.split(', ').map(column => `${column} = ?`).join(', ');
    await connection.execute(`UPDATE admin_content SET ${setClause}, updated_by = ? WHERE id = ?`, [...contentFields(input), actor.id, id]);
    await connection.execute('INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)', [actor.id, actor.username, 'content.update', 'content', String(id), JSON.stringify({ slug: input.slug, status: input.status })]);
    await connection.commit();
    return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function setContentTrash(actor, id, trash) {
  const [result] = await pool().execute(`UPDATE admin_content SET deleted_at = ${trash ? 'UTC_TIMESTAMP()' : 'NULL'}, updated_by = ? WHERE id = ? AND ${trash ? 'deleted_at IS NULL' : 'deleted_at IS NOT NULL'}`, [actor.id, id]);
  if (result.affectedRows) await logActivity(actor, trash ? 'content.trash' : 'content.restore', 'content', id);
  return result.affectedRows > 0;
}
async function permanentlyDeleteContent(actor, id) {
  const [result] = await pool().execute('DELETE FROM admin_content WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (result.affectedRows) await logActivity(actor, 'content.permanent_delete', 'content', id);
  return result.affectedRows > 0;
}
async function bulkContent(actor, ids, action) {
  const placeholders = ids.map(() => '?').join(',');
  let query;
  if (action === 'publish') query = `UPDATE admin_content SET status='published', publish_at=NULL, updated_by=? WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  else if (action === 'archive') query = `UPDATE admin_content SET status='archived', updated_by=? WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  else if (action === 'trash') query = `UPDATE admin_content SET deleted_at=UTC_TIMESTAMP(), updated_by=? WHERE id IN (${placeholders}) AND deleted_at IS NULL`;
  else return 0;
  const [result] = await pool().execute(query, [actor.id, ...ids]);
  if (result.affectedRows) await logActivity(actor, `content.bulk.${action}`, 'content', null, { count: result.affectedRows });
  return result.affectedRows;
}
async function markSummaryPending(ids) {
  const unique = [...new Set((ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!unique.length) return 0;
  const placeholders = unique.map(() => '?').join(',');
  const [result] = await pool().execute(`UPDATE admin_content SET summary_status='pending', summary_error=NULL, summary_generated_at=NULL
    WHERE id IN (${placeholders}) AND kind='lesson' AND deleted_at IS NULL`, unique);
  return result.affectedRows;
}
async function getLessonForSummary(id) {
  const [rows] = await pool().execute(`SELECT id,kind,title_ar,body_ar,summary_status,summary_source_hash
    FROM admin_content WHERE id=? AND kind='lesson' AND deleted_at IS NULL LIMIT 1`, [id]);
  return rows[0] ? { ...rows[0], id:Number(rows[0].id) } : null;
}
async function saveLessonSummary(id, sourceHash, summary) {
  const [result] = await pool().execute(`UPDATE admin_content SET summary_ar=?, summary_status='completed', summary_generated_at=UTC_TIMESTAMP(), summary_error=NULL, summary_source_hash=?
    WHERE id=? AND kind='lesson' AND deleted_at IS NULL AND SHA2(CONCAT(title_ar, '\n', body_ar), 256)=?`, [summary, sourceHash, id, sourceHash]);
  return result.affectedRows > 0;
}
async function saveLessonSummaryError(id, error) {
  const message = String(error?.message || 'تعذر إنشاء الملخص.').replace(/[\r\n]+/g, ' ').slice(0, 500);
  const [result] = await pool().execute(`UPDATE admin_content SET summary_status='failed', summary_error=?
    WHERE id=? AND kind='lesson' AND deleted_at IS NULL`, [message, id]);
  return result.affectedRows > 0;
}
async function getSummaryStatus(id) {
  const [rows] = await pool().execute(`SELECT id,title_ar,summary_ar,summary_status,summary_generated_at,summary_error
    FROM admin_content WHERE id=? AND kind='lesson' AND deleted_at IS NULL LIMIT 1`, [id]);
  return rows[0] ? { ...rows[0], id:Number(rows[0].id) } : null;
}
async function listVersions(id) {
  const [rows] = await pool().execute(`SELECT id,version_no,created_at,created_by FROM admin_content_versions WHERE content_id = ? ORDER BY version_no DESC LIMIT 50`, [id]);
  return rows.map(row => ({ ...row, id: Number(row.id), version_no: Number(row.version_no), created_by: row.created_by == null ? null : Number(row.created_by) }));
}
async function getVersion(id, versionId) {
  const [rows] = await pool().execute('SELECT snapshot FROM admin_content_versions WHERE content_id = ? AND id = ? LIMIT 1', [id, versionId]);
  return rows[0] ? parseJson(rows[0].snapshot, null) : null;
}
async function addAttachmentRows(connection, messageId, attachments = []) {
  for (const file of attachments) {
    await connection.execute('INSERT INTO admin_message_attachments (message_id,original_name,object_key,content_type,size_bytes) VALUES (?,?,?,?,?)', [messageId, file.name, file.key, file.type, file.size]);
  }
}
async function addMessage(message) {
  const [result] = await pool().execute(`INSERT INTO admin_messages (user_id,message_type,sender_name,sender_email,subject,message,attachments,ip_hash) VALUES (?, 'student', ?, ?, ?, ?, ?, ?)`,
    [message.userId, message.name, message.email || null, message.subject, message.message, JSON.stringify(message.attachments || []), message.ipHash || null]);
  await addAttachmentRows(pool(), result.insertId, message.attachments || []);
  return Number(result.insertId);
}
async function listAdminRecipients() {
  const [rows] = await pool().execute(`SELECT u.id,u.username,u.is_active,r.label
    FROM users u LEFT JOIN role_definitions r ON r.role_key=u.role
    WHERE u.role='admin' OR COALESCE(r.priority,0)>0
    ORDER BY u.username LIMIT 200`);
  return rows.map(row => ({ id:Number(row.id), username:row.username, label:row.label || 'مدير', is_active:Boolean(row.is_active) }));
}
async function addAdminMessage(actor, { recipientUsername, subject, message, attachments = [] }) {
  if (recipientUsername === '__all__') {
    const connection = await pool().getConnection();
    try {
      await connection.beginTransaction();
      const [recipients] = await connection.execute(`SELECT u.id,u.username
        FROM users u LEFT JOIN role_definitions r ON r.role_key=u.role
        WHERE u.id<>? AND (u.role='admin' OR COALESCE(r.priority,0)>0)
        ORDER BY u.username FOR UPDATE`, [actor.id]);
      if (!recipients.length) { await connection.rollback(); return { error:'recipient_not_found' }; }
      for (const recipient of recipients) {
        const [result] = await connection.execute(`INSERT INTO admin_messages (user_id,message_type,sender_name,subject,message,attachments)
          VALUES (?, 'admin', ?, ?, ?, ?)`, [recipient.id, actor.username, subject, message, JSON.stringify(attachments)]);
        await addAttachmentRows(connection, result.insertId, attachments);
      }
      await connection.commit();
      await logActivity(actor, 'message.admin.broadcast', 'message', null, { recipients:recipients.map(recipient=>recipient.username), subject });
      return { sent_count: recipients.length, broadcast:true };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  const connection = pool();
  const [[recipient]] = await connection.query(`SELECT u.id,u.username
    FROM users u LEFT JOIN role_definitions r ON r.role_key=u.role
    WHERE u.username=? AND (u.role='admin' OR COALESCE(r.priority,0)>0) LIMIT 1`, [recipientUsername]);
  if (!recipient) return { error:'recipient_not_found' };
  const [result] = await connection.execute(`INSERT INTO admin_messages (user_id,message_type,sender_name,subject,message,attachments)
    VALUES (?, 'admin', ?, ?, ?, ?)`, [recipient.id, actor.username, subject, message, JSON.stringify(attachments)]);
  await addAttachmentRows(connection, result.insertId, attachments);
  await logActivity(actor, 'message.admin.create', 'message', result.insertId, { recipient:recipient.username, subject });
  return { id:Number(result.insertId), recipient:recipient.username };
}
async function listMessageAttachments({ search = '', type = '', limit = 40, offset = 0 }) {
  const where = ['m.deleted_at IS NULL']; const params = [];
  if (search) { where.push('(LOCATE(?,a.original_name)>0 OR LOCATE(?,m.subject)>0 OR LOCATE(?,m.sender_name)>0)'); params.push(search, search, search); }
  if (type === 'image') where.push("a.content_type LIKE 'image/%'");
  if (type === 'pdf') where.push("a.content_type = 'application/pdf'");
  if (type === 'other') where.push("a.content_type NOT LIKE 'image/%' AND a.content_type <> 'application/pdf'");
  const filter = `WHERE ${where.join(' AND ')}`;
  const [rows] = await pool().execute(`SELECT a.id,a.message_id,a.original_name,a.object_key,a.content_type,a.size_bytes,a.created_at,m.subject,m.sender_name,m.message_type,u.username AS recipient_username FROM admin_message_attachments a JOIN admin_messages m ON m.id=a.message_id LEFT JOIN users u ON u.id=m.user_id ${filter} ORDER BY a.created_at DESC LIMIT ${safeLimit(limit,100)} OFFSET ${safeOffset(offset)}`, params);
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total,COALESCE(SUM(a.size_bytes),0) AS total_bytes FROM admin_message_attachments a JOIN admin_messages m ON m.id=a.message_id LEFT JOIN users u ON u.id=m.user_id ${filter}`, params);
  return { items: rows.map(row => ({...row,id:Number(row.id),message_id:Number(row.message_id),size_bytes:Number(row.size_bytes),download_path:`/api/admin/attachments/${Number(row.id)}/download`})), total:Number(count.total)||0, total_bytes:Number(count.total_bytes)||0 };
}
async function getMessageAttachment(id) {
  const [[row]] = await pool().execute('SELECT a.id,a.message_id,a.original_name,a.object_key,a.content_type,a.size_bytes,m.subject,m.sender_name FROM admin_message_attachments a JOIN admin_messages m ON m.id=a.message_id WHERE a.id=? AND m.deleted_at IS NULL LIMIT 1',[id]);
  return row ? {...row,id:Number(row.id),message_id:Number(row.message_id),size_bytes:Number(row.size_bytes)} : null;
}
async function listMessages({ search = '', status = '', type = '', read = '', trash = false, limit = 25, offset = 0 }) {
  const where = [trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params = [];
  if (status && !trash) { where.push('status = ?'); params.push(status); }
  if (read === 'unread' && !trash) where.push("status = 'new'");
  if (read === 'read' && !trash) where.push("status <> 'new'");
  if (type) { where.push('message_type = ?'); params.push(type); }
  if (search) { where.push('(LOCATE(?,sender_name)>0 OR LOCATE(?,COALESCE(sender_email,""))>0 OR LOCATE(?,subject)>0 OR LOCATE(?,message)>0)'); params.push(search, search, search, search); }
  const filter = `WHERE ${where.join(' AND ')}`;
  const aliasedFilter = filter.replaceAll('message','m.message').replaceAll('user_id','m.user_id').replaceAll('sender_name','m.sender_name').replaceAll('subject','m.subject').replaceAll('reply','m.reply').replaceAll('status','m.status').replaceAll('deleted_at','m.deleted_at').replaceAll('created_at','m.created_at');
  const [rows] = await pool().execute(`SELECT m.id,m.user_id,u.username AS recipient_username,m.message_type,m.sender_name,m.sender_email,m.subject,m.message,m.attachments,m.reply,m.status,m.created_at,m.updated_at,m.deleted_at FROM admin_messages m LEFT JOIN users u ON u.id=m.user_id ${aliasedFilter} ORDER BY m.created_at DESC LIMIT ${safeLimit(limit)} OFFSET ${safeOffset(offset)}`, params);
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total FROM admin_messages ${filter}`, params);
  return { items: rows.map(row => ({ ...row, id: Number(row.id), user_id: row.user_id == null ? null : Number(row.user_id), attachments: parseJson(row.attachments, []) })), total: Number(count.total) || 0 };
}
async function updateMessage(actor, id, { reply, status, trash }) {
  if (trash !== undefined) {
    const [result] = await pool().execute(`UPDATE admin_messages SET deleted_at = ${trash ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ? AND ${trash ? 'deleted_at IS NULL' : 'deleted_at IS NOT NULL'}`, [id]);
    if (result.affectedRows) await logActivity(actor, trash ? 'message.trash' : 'message.restore', 'message', id);
    return result.affectedRows > 0;
  }
  const [result] = await pool().execute(`UPDATE admin_messages SET reply = ?, status = ? WHERE id = ? AND deleted_at IS NULL`, [reply, status, id]);
  if (result.affectedRows) await logActivity(actor, 'message.reply', 'message', id, { status });
  return result.affectedRows > 0;
}
async function permanentlyDeleteMessage(actor, id) {
  const [result] = await pool().execute('DELETE FROM admin_messages WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (result.affectedRows) await logActivity(actor, 'message.permanent_delete', 'message', id);
  return result.affectedRows > 0;
}
async function listUserReplies(userId) {
  const [rows] = await pool().execute(`SELECT id,subject,message,attachments,reply,status,created_at,updated_at FROM admin_messages
    WHERE user_id = ? AND message_type = 'student' AND deleted_at IS NULL AND reply IS NOT NULL ORDER BY updated_at DESC LIMIT 100`, [userId]);
  return rows.map(row => ({ ...row, id: Number(row.id), attachments: parseJson(row.attachments, []) }));
}
async function getSettings() {
  const [rows] = await pool().query('SELECT setting_key,setting_value FROM admin_settings');
  return Object.fromEntries(rows.map(row => [row.setting_key, parseJson(row.setting_value, null)]));
}
async function setSetting(actor, key, value) {
  await pool().execute(`INSERT INTO admin_settings (setting_key,setting_value,updated_by) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`, [key, JSON.stringify(value), actor.id]);
  await logActivity(actor, 'settings.update', 'setting', key);
}
async function getNavigation({ includeTrash = false } = {}) {
  const [rows] = await pool().execute(`SELECT id,label_ar,label_en,href,position,is_active,deleted_at FROM admin_navigation WHERE ${includeTrash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'} ORDER BY position,id`);
  return rows.map(row => ({ ...row, id: Number(row.id), position: Number(row.position), is_active: Boolean(row.is_active) }));
}
async function saveNavigation(actor, item) {
  if (item.id) {
    const [result] = await pool().execute('UPDATE admin_navigation SET label_ar=?,label_en=?,href=?,position=?,is_active=?,updated_by=? WHERE id=? AND deleted_at IS NULL', [item.label_ar,item.label_en,item.href,item.position,item.is_active,actor.id,item.id]);
    if (result.affectedRows) await logActivity(actor,'navigation.update','navigation',item.id);
    return result.affectedRows ? Number(item.id) : null;
  }
  const [result] = await pool().execute('INSERT INTO admin_navigation (label_ar,label_en,href,position,is_active,updated_by) VALUES (?,?,?,?,?,?)', [item.label_ar,item.label_en,item.href,item.position,item.is_active,actor.id]);
  await logActivity(actor,'navigation.create','navigation',result.insertId);
  return Number(result.insertId);
}
async function trashNavigation(actor, id, restore = false) {
  const [result] = await pool().execute(`UPDATE admin_navigation SET deleted_at=${restore ? 'NULL' : 'UTC_TIMESTAMP()'},updated_by=? WHERE id=? AND ${restore ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'}`, [actor.id,id]);
  if (result.affectedRows) await logActivity(actor,restore?'navigation.restore':'navigation.trash','navigation',id);
  return result.affectedRows > 0;
}
async function permanentlyDeleteNavigation(actor, id) {
  const [result] = await pool().execute('DELETE FROM admin_navigation WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (result.affectedRows) await logActivity(actor, 'navigation.permanent_delete', 'navigation', id);
  return result.affectedRows > 0;
}
async function listMedia({ search = '', trash = false, limit = 40, offset = 0 }) {
  const where = [trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const params = [];
  if (search) { where.push('LOCATE(?,original_name)>0'); params.push(search); }
  const filter = `WHERE ${where.join(' AND ')}`;
  const [rows] = await pool().execute(`SELECT id,original_name,object_key,content_type,size_bytes,uploaded_by,created_at,deleted_at FROM admin_media ${filter} ORDER BY created_at DESC LIMIT ${safeLimit(limit,100)} OFFSET ${safeOffset(offset)}`, params);
  const [[count]] = await pool().execute(`SELECT COUNT(*) AS total FROM admin_media ${filter}`, params);
  return { items: rows.map(row => ({ ...row, id:Number(row.id), size_bytes:Number(row.size_bytes), uploaded_by:row.uploaded_by == null ? null : Number(row.uploaded_by), url:`/manus-storage/${row.object_key}` })), total:Number(count.total)||0 };
}
async function addMedia(actor, item) {
  const [result] = await pool().execute('INSERT INTO admin_media (original_name,object_key,content_type,size_bytes,uploaded_by) VALUES (?,?,?,?,?)', [item.name,item.key,item.type,item.size,actor.id]);
  await logActivity(actor,'media.upload','media',result.insertId,{name:item.name,type:item.type,size:item.size});
  return Number(result.insertId);
}
async function trashMedia(actor, id, restore = false) {
  const [result] = await pool().execute(`UPDATE admin_media SET deleted_at=${restore ? 'NULL' : 'UTC_TIMESTAMP()'} WHERE id=? AND ${restore ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'}`, [id]);
  if (result.affectedRows) await logActivity(actor,restore?'media.restore':'media.trash','media',id);
  return result.affectedRows > 0;
}
async function permanentlyDeleteMedia(actor, id) {
  const [result] = await pool().execute('DELETE FROM admin_media WHERE id = ? AND deleted_at IS NOT NULL', [id]);
  if (result.affectedRows) await logActivity(actor, 'media.permanent_delete', 'media', id);
  return result.affectedRows > 0;
}
async function listActivity({ search = '', limit = 50, offset = 0 }) {
  const params = [];
  const where = search ? 'WHERE LOCATE(?,actor_username)>0 OR LOCATE(?,action)>0 OR LOCATE(?,target_type)>0' : '';
  if (search) params.push(search,search,search);
  const [rows] = await pool().execute(`SELECT id,actor_username,action,target_type,target_id,details,created_at FROM admin_activity ${where} ORDER BY created_at DESC LIMIT ${safeLimit(limit,200)} OFFSET ${safeOffset(offset)}`, params);
  return rows.map(row => ({ ...row, id:Number(row.id), details:parseJson(row.details,{}) }));
}
async function setUserActive(actor, username, active) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`SELECT u.id,u.username,u.is_active,r.priority,r.permissions FROM users u LEFT JOIN role_definitions r ON r.role_key=u.role
      WHERE u.id=? OR u.username=? ORDER BY u.id FOR UPDATE`, [actor.id,username]);
    const acting = rows.find(row => String(row.id) === String(actor.id));
    const target = rows.find(row => row.username === username);
    const actorPermissions=acting?.username==='ak9'?db.SYSTEM_OWNER_PERMISSIONS:parsePermissions(acting?.permissions);
    if (!acting || !actorPermissions.includes('users.manage')) { await connection.rollback(); return { error:'forbidden' }; }
    if (!target) { await connection.rollback(); return { error:'not_found' }; }
    if (target.username === 'ak9' || target.username === acting.username) { await connection.rollback(); return { error:'protected' }; }
    if (acting.username !== 'ak9' && Number(target.priority || 0) >= Number(acting.priority || 0)) { await connection.rollback(); return { error:'hierarchy' }; }
    await connection.execute('UPDATE users SET is_active=? WHERE id=?', [active ? 1 : 0,target.id]);
    if (!active) await connection.execute('DELETE FROM sessions WHERE user_id=?', [target.id]);
    await connection.execute('INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)', [actor.id,actor.username,active?'user.activate':'user.deactivate','user',String(target.id),JSON.stringify({username})]);
    await connection.commit();
    return { username, is_active:Boolean(active) };
  } catch(error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function deleteUser(actor, username) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`SELECT u.id,u.username,r.priority,r.permissions
      FROM users u LEFT JOIN role_definitions r ON r.role_key=u.role
      WHERE u.id=? OR u.username=? ORDER BY u.id FOR UPDATE`, [actor.id,username]);
    const acting = rows.find(row => String(row.id) === String(actor.id));
    const target = rows.find(row => row.username === username);
    const actorPermissions=acting?.username==='ak9'?db.SYSTEM_OWNER_PERMISSIONS:parsePermissions(acting?.permissions);
    if (!acting || !actorPermissions.includes('users.manage')) { await connection.rollback(); return { error:'forbidden' }; }
    if (!target) { await connection.rollback(); return { error:'not_found' }; }
    if (target.username === 'ak9' || target.username === acting.username) { await connection.rollback(); return { error:'protected' }; }
    if (acting.username !== 'ak9' && Number(target.priority || 0) >= Number(acting.priority || 0)) { await connection.rollback(); return { error:'hierarchy' }; }
    await connection.execute('DELETE FROM admin_messages WHERE user_id=?', [target.id]);
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [target.id]);
    const [result] = await connection.execute('DELETE FROM users WHERE id=?', [target.id]);
    if (result.affectedRows !== 1) { await connection.rollback(); return { error:'not_found' }; }
    await connection.execute('INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)', [actor.id,actor.username,'user.delete','user',String(target.id),JSON.stringify({username})]);
    await connection.commit();
    return { deleted: true, username };
  } catch(error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function listSessions(userId) {
  const [rows] = await pool().execute(`SELECT id,user_agent,ip_hash,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=? AND expires_at>UTC_TIMESTAMP() ORDER BY last_seen_at DESC`, [userId]);
  return rows.map(row => ({ id:Number(row.id), user_agent:row.user_agent || 'غير معروف', ip_fingerprint:row.ip_hash ? Buffer.from(row.ip_hash).toString('hex').slice(0,12) : '', created_at:row.created_at,last_seen_at:row.last_seen_at,expires_at:row.expires_at }));
}
async function revokeSession(userId, sessionId) {
  const [result] = await pool().execute('DELETE FROM sessions WHERE id=? AND user_id=?', [sessionId,userId]);
  return result.affectedRows > 0;
}
async function publicSettings() {
  const values = await getSettings();
  return {
    site_name: typeof values.site_name === 'string' ? values.site_name : 'قادر',
    logo_url: typeof values.logo_url === 'string' ? values.logo_url : '',
    contact_email: typeof values.contact_email === 'string' ? values.contact_email : '',
    social_links: values.social_links && typeof values.social_links === 'object' ? values.social_links : {},
    seo_description: typeof values.seo_description === 'string' ? values.seo_description : 'منصة قادر التعليمية المجانية للقدرات والتحصيلي.'
  };
}
async function listStudentLessons() {
  const [rows] = await pool().execute(`SELECT id,lesson_key,section,original_title_ar,title_ar,description_ar,youtube_url,updated_at
    FROM student_lessons ORDER BY FIELD(section,'كمي','لفظي','تحصيلي'), lesson_key`);
  return rows.map(row => ({ ...row, id: Number(row.id), youtube_url: row.youtube_url || '' }));
}
async function getStudentLesson(lessonKey) {
  const [rows] = await pool().execute(`SELECT id,lesson_key,section,original_title_ar,title_ar,description_ar,youtube_url,updated_at
    FROM student_lessons WHERE lesson_key=? LIMIT 1`, [lessonKey]);
  return rows[0] ? { ...rows[0], id: Number(rows[0].id), youtube_url: rows[0].youtube_url || '' } : null;
}
async function updateStudentLesson(actor, lessonKey, input) {
  const connection = await pool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT id FROM student_lessons WHERE lesson_key=? FOR UPDATE', [lessonKey]);
    if (!rows.length) { await connection.rollback(); return false; }
    await connection.execute('UPDATE student_lessons SET title_ar=?,description_ar=?,youtube_url=?,updated_by=? WHERE lesson_key=?',
      [input.title_ar, input.description_ar, input.youtube_url || null, actor.id, lessonKey]);
    await connection.execute('INSERT INTO admin_activity (actor_user_id,actor_username,action,target_type,target_id,details) VALUES (?,?,?,?,?,?)',
      [actor.id, actor.username, 'student_lesson.update', 'student_lesson', lessonKey, JSON.stringify({ title_ar: input.title_ar, has_youtube: Boolean(input.youtube_url) })]);
    await connection.commit();
    return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function backup() {
  const connection = pool();
  const [users] = await connection.query('SELECT id,username,role,is_active,created_at,last_active_at,total_active_seconds FROM users ORDER BY id');
  const [roles] = await connection.query('SELECT role_key,label,category,priority,permissions,is_system FROM role_definitions ORDER BY priority DESC');
  const [content] = await connection.query('SELECT * FROM admin_content ORDER BY id');
  const [contentVersions] = await connection.query('SELECT id,content_id,version_no,snapshot,created_by,created_at FROM admin_content_versions ORDER BY content_id,version_no');
  const [messages] = await connection.query('SELECT id,user_id,message_type,sender_name,sender_email,subject,message,attachments,reply,status,created_at,updated_at,deleted_at FROM admin_messages ORDER BY id');
  const [media] = await connection.query('SELECT id,original_name,object_key,content_type,size_bytes,uploaded_by,created_at,deleted_at FROM admin_media ORDER BY id');
  const [settings] = await connection.query('SELECT setting_key,setting_value,updated_at FROM admin_settings');
  const [navigation] = await connection.query('SELECT id,label_ar,label_en,href,position,is_active,deleted_at,updated_at FROM admin_navigation ORDER BY id');
  const [activity] = await connection.query('SELECT id,actor_user_id,actor_username,action,target_type,target_id,details,created_at FROM admin_activity ORDER BY id');
  const [messageAttachments] = await connection.query('SELECT id,message_id,original_name,object_key,content_type,size_bytes,created_at FROM admin_message_attachments ORDER BY id');
  const [dailyVisits] = await connection.query('SELECT visit_date,path,views FROM admin_daily_visits ORDER BY visit_date,path');
  const [studentLessons] = await connection.query('SELECT id,lesson_key,section,original_title_ar,title_ar,description_ar,youtube_url,updated_by,created_at,updated_at FROM student_lessons ORDER BY id');
  return { format:'qadir-admin-backup', version:1, created_at:new Date().toISOString(), users, roles:roles.map(row=>({...row,permissions:parseJson(row.permissions,[])})), content:content.map(rowContent), contentVersions:contentVersions.map(row=>({...row,snapshot:parseJson(row.snapshot,{})})), messages, media, settings:settings.map(row=>({...row,setting_value:parseJson(row.setting_value,null)})), navigation, activity:activity.map(row=>({...row,details:parseJson(row.details,null)})), dailyVisits, studentLessons };
}

module.exports = {
  logActivity, dashboardSummary, recordVisit, listContent, getContentBySlug, listPublicContent,
  createContent, importContent, updateContent, bulkContent, markSummaryPending, getLessonForSummary, saveLessonSummary, saveLessonSummaryError, getSummaryStatus, updateContent, setContentTrash, permanentlyDeleteContent, listVersions, getVersion,
  addMessage, listAdminRecipients, addAdminMessage, listMessages, updateMessage, permanentlyDeleteMessage, listUserReplies, getSettings, setSetting,
  getNavigation, saveNavigation, trashNavigation, permanentlyDeleteNavigation, listMedia, addMedia, trashMedia, permanentlyDeleteMedia, listMessageAttachments, getMessageAttachment,
  listActivity, setUserActive, deleteUser, listSessions, revokeSession, publicSettings, listStudentLessons, getStudentLesson, updateStudentLesson, backup
};
