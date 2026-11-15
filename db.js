'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

let pool;
const DUMMY_SALT = Buffer.alloc(16, 0x5a);
const DUMMY_HASH = Buffer.alloc(64, 0xa5);
const EDITABLE_ROLE_PERMISSIONS = Object.freeze([
  'users.view', 'users.search', 'leaderboard.view', 'users.manage_roles', 'users.manage',
  'dashboard.view', 'content.view', 'content.manage', 'messages.view', 'messages.manage',
  'media.view', 'media.manage', 'settings.view', 'settings.manage', 'navigation.manage',
  'audit.view', 'backups.manage', 'security.manage', 'integrations.manage'
]);
const SYSTEM_OWNER_PERMISSIONS = Object.freeze([...EDITABLE_ROLE_PERMISSIONS, 'roles.manage']);

function parsePermissions(value) {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = []; } }
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}
function userRoleInfo(row) {
  const owner = row.username === 'ak9';
  return {
    role_label: owner ? 'مالك النظام' : (row.role_label || (row.role === 'student' ? 'طالب' : 'مدير')),
    role_priority: owner ? 100 : (Number(row.role_priority) || 0),
    permissions: owner ? [...SYSTEM_OWNER_PERMISSIONS] : parsePermissions(row.permissions)
  };
}
function normalizedRole(row) {
  return row ? { ...row, ...userRoleInfo(row) } : null;
}
function validateRolePermissions(value) {
  if (!Array.isArray(value) || value.some(item => !EDITABLE_ROLE_PERMISSIONS.includes(item))) return null;
  const permissions = [...new Set(value)];
  const dependencies = [
    ['users.search', 'users.view'], ['users.manage_roles', 'users.view'], ['users.manage', 'users.view'],
    ['content.manage', 'content.view'], ['messages.manage', 'messages.view'],
    ['media.manage', 'media.view'], ['settings.manage', 'settings.view']
  ];
  if (dependencies.some(([permission, required]) => permissions.includes(permission) && !permissions.includes(required))) return null;
  return permissions;
}
function normalizedRoleDefinition(row) {
  return {
    role_key: row.role_key,
    label: row.label,
    category: row.category,
    priority: Number(row.priority) || 0,
    permissions: parsePermissions(row.permissions),
    is_system: Boolean(row.is_system),
    users_count: Number(row.users_count) || 0
  };
}

function poolConfigFromUrl(value) {
  if (!value) throw new Error('DATABASE_URL is required');
  const parsed = new URL(value);
  if (!['mysql:', 'mysqls:'].includes(parsed.protocol)) throw new Error('Unsupported database URL scheme');
  const params = parsed.searchParams;
  const sslMode = (params.get('ssl-mode') || params.get('sslMode') || '').toUpperCase();
  const rawSsl = params.get('ssl');
  const sslFlag = (rawSsl || '').toLowerCase();
  const tlsRequired = parsed.protocol === 'mysqls:' || ['REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'].includes(sslMode) || ['true', '1', 'required'].includes(sslFlag);
  let sslConfig = null;
  if (rawSsl && !['true', '1', 'required', 'false', '0', 'disabled'].includes(sslFlag)) {
    try {
      const parsedSsl = JSON.parse(rawSsl);
      if (!parsedSsl || typeof parsedSsl !== 'object' || Array.isArray(parsedSsl)) throw new Error('invalid TLS settings');
      sslConfig = parsedSsl;
    } catch { throw new Error('Invalid TLS settings in database URL'); }
  }
  const config = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 50,
    charset: 'utf8mb4',
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
  };
  if (sslConfig) config.ssl = sslConfig;
  else if (tlsRequired) config.ssl = { rejectUnauthorized: true };
  return config;
}
function getPool() {
  if (!pool) pool = mysql.createPool(poolConfigFromUrl(process.env.DATABASE_URL));
  return pool;
}

async function initialize() {
  const connection = await getPool().getConnection();
  const lockName = 'qadir_schema_migrations_v1';
  let lockAcquired = false;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Database migration lock unavailable');
    lockAcquired = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const migrationDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationDir).filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
    if (!files.length) throw new Error('No application migrations found');
    for (const file of files) {
      const version = file.slice(0, -4);
      const [applied] = await connection.execute('SELECT version FROM schema_migrations WHERE version = ? LIMIT 1', [version]);
      if (applied.length) continue;
      const source = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      const statements = source.split(';').map(statement => statement.trim()).filter(Boolean);
      for (const statement of statements) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
    }
    const [legacyMessages] = await connection.query('SELECT id,attachments FROM admin_messages WHERE attachments IS NOT NULL');
    for (const row of legacyMessages) {
      let attachments = row.attachments;
      if (Buffer.isBuffer(attachments)) attachments = attachments.toString('utf8');
      try { attachments = typeof attachments === 'string' ? JSON.parse(attachments) : attachments; } catch { attachments = []; }
      if (!Array.isArray(attachments)) continue;
      for (const file of attachments) {
        if (!file || typeof file !== 'object' || typeof file.key !== 'string' || typeof file.name !== 'string' || typeof file.type !== 'string') continue;
        const [existing] = await connection.execute('SELECT id FROM admin_message_attachments WHERE message_id=? AND object_key=? LIMIT 1', [row.id, file.key]);
        if (!existing.length) await connection.execute('INSERT INTO admin_message_attachments (message_id,original_name,object_key,content_type,size_bytes) VALUES (?,?,?,?,?)', [row.id, file.name.slice(0,255), file.key.slice(0,512), file.type.slice(0,120), Math.max(0, Number(file.size)||0)]);
      }
    }
  } finally {
    if (lockAcquired) { try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch {} }
    connection.release();
  }
}
async function seedInitialAdmin() {
  const connection = getPool();
  const [rows] = await connection.execute('SELECT id FROM users WHERE username = ? LIMIT 1', ['ak9']);
  if (rows.length) return;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Initial admin password is missing or invalid');
  }
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, derived) => err ? reject(err) : resolve(derived)));
  try {
    await connection.execute('INSERT INTO users (username, role, password_hash, password_salt) VALUES (?, ?, ?, ?)', ['ak9', 'admin', hash, salt]);
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    // Another process may have seeded concurrently. Never modify its row.
  }
}

async function healthCheck() {
  const [rows] = await getPool().query('SELECT 1 AS ready');
  if (!rows || rows[0].ready !== 1) throw new Error('Database check failed');
}

async function getCsrfSecret() {
  const connection = getPool();
  let [rows] = await connection.execute('SELECT metadata_value FROM app_metadata WHERE metadata_key = ? LIMIT 1', ['csrf_hmac_secret']);
  if (rows.length) return Buffer.from(rows[0].metadata_value);
  const candidate = crypto.randomBytes(32);
  await connection.execute('INSERT IGNORE INTO app_metadata (metadata_key, metadata_value) VALUES (?, ?)', ['csrf_hmac_secret', candidate]);
  [rows] = await connection.execute('SELECT metadata_value FROM app_metadata WHERE metadata_key = ? LIMIT 1', ['csrf_hmac_secret']);
  if (!rows.length) throw new Error('CSRF key unavailable');
  return Buffer.from(rows[0].metadata_value);
}

async function createStudent(username, hash, salt) {
  const [result] = await getPool().execute('INSERT INTO users (username, role, password_hash, password_salt) VALUES (?, ?, ?, ?)', [username, 'student', hash, salt]);
  return { id: result.insertId, username, role: 'student', role_label: 'طالب', role_priority: 0, permissions: [] };
}
async function getUserForLogin(username) {
  const [rows] = await getPool().execute(`SELECT u.id, u.username, u.role, r.label AS role_label, r.priority AS role_priority, r.permissions, u.password_hash, u.password_salt, u.is_active
    FROM users u LEFT JOIN role_definitions r ON r.role_key = u.role WHERE u.username = ? LIMIT 1`, [username]);
  return normalizedRole(rows[0] || null);
}
async function createSession(tokenHash, userId, days, client = {}) {
  const userAgent = typeof client.userAgent === 'string' ? client.userAgent.slice(0, 255) : null;
  const ipHash = Buffer.isBuffer(client.ipHash) && client.ipHash.length === 32 ? client.ipHash : null;
  await getPool().execute(`INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, user_agent, ip_hash)
    VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), UTC_TIMESTAMP(), ?, ?)`, [tokenHash, userId, days, userAgent, ipHash]);
}
async function getSessionUser(tokenHash) {
  const [rows] = await getPool().execute(`SELECT u.id, u.username, u.role, r.label AS role_label, r.priority AS role_priority, r.permissions
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN role_definitions r ON r.role_key = u.role
    WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.is_active = 1
      AND COALESCE(s.last_seen_at, s.created_at) > UTC_TIMESTAMP() - INTERVAL 45 MINUTE LIMIT 1`, [tokenHash]);
  if (!rows.length) return null;
  await getPool().execute(`UPDATE sessions SET last_seen_at = UTC_TIMESTAMP()
    WHERE token_hash = ? AND COALESCE(last_seen_at, created_at) < UTC_TIMESTAMP() - INTERVAL 1 MINUTE`, [tokenHash]);
  return normalizedRole(rows[0]);
}
async function deleteSession(tokenHash) {
  await getPool().execute('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}
async function changePassword(userId, hash, salt, keepTokenHash) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, userId]);
    await connection.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, keepTokenHash]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
async function recordHeartbeat(tokenHash, userId) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT id,
      CASE WHEN last_heartbeat_at IS NULL THEN 0
           WHEN TIMESTAMPDIFF(SECOND, last_heartbeat_at, UTC_TIMESTAMP()) > 45 THEN 0
           ELSE LEAST(45, GREATEST(0, TIMESTAMPDIFF(SECOND, last_heartbeat_at, UTC_TIMESTAMP()))) END AS delta_seconds
      FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE`, [tokenHash, userId]);
      if (!rows.length) {
        await connection.rollback();
        return false;
    }
    const delta = Number(rows[0].delta_seconds) || 0;
    await connection.execute('UPDATE sessions SET last_heartbeat_at = UTC_TIMESTAMP() WHERE id = ?', [rows[0].id]);
    await connection.execute(`UPDATE users SET total_active_seconds = total_active_seconds + ?, last_active_at = UTC_TIMESTAMP() WHERE id = ?`, [delta, userId]);
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
async function pauseHeartbeat(tokenHash, userId) {
  await getPool().execute('UPDATE sessions SET last_heartbeat_at = NULL WHERE token_hash = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()', [tokenHash, userId]);
}
async function getLeaderboard() {
  const [rows] = await getPool().execute(`SELECT u.username, u.total_active_seconds AS active_seconds
    FROM users u JOIN role_definitions r ON r.role_key = u.role
    WHERE r.category = 'student' ORDER BY u.total_active_seconds DESC, u.username ASC LIMIT 20`);
  return rows.map(row => ({ username: row.username, active_seconds: Number(row.active_seconds) }));
}
async function hasPermission(userId, permission) {
  const [rows] = await getPool().execute(`SELECT u.username, r.permissions
    FROM users u LEFT JOIN role_definitions r ON r.role_key = u.role WHERE u.id = ? LIMIT 1`, [userId]);
  if (!rows.length) return false;
  if (rows[0].username === 'ak9') return SYSTEM_OWNER_PERMISSIONS.includes(permission);
  return parsePermissions(rows[0].permissions).includes(permission);
}
async function isCurrentAdmin(userId) {
  return hasPermission(userId, 'users.view');
}
async function isSystemOwner(userId) {
  const [rows] = await getPool().execute('SELECT 1 AS is_owner FROM users WHERE id = ? AND username = ? LIMIT 1', [userId, 'ak9']);
  return rows.length > 0;
}
async function getRoleDefinitions() {
  const [rows] = await getPool().execute(`SELECT r.role_key, r.label, r.category, r.priority, r.permissions, r.is_system,
    (SELECT COUNT(*) FROM users u WHERE u.role = r.role_key) AS users_count
    FROM role_definitions r ORDER BY r.priority DESC, r.label ASC`);
  return rows.map(normalizedRoleDefinition);
}
async function getAssignableRoles(userId) {
  const [actors] = await getPool().execute(`SELECT u.username, u.role, r.priority, r.permissions
    FROM users u LEFT JOIN role_definitions r ON r.role_key = u.role WHERE u.id = ? LIMIT 1`, [userId]);
  if (!actors.length) return [];
  const actor = actors[0];
  const owner = actor.username === 'ak9';
  const permissions = owner ? SYSTEM_OWNER_PERMISSIONS : parsePermissions(actor.permissions);
  if (!permissions.includes('users.manage_roles')) return [];
  const actorPriority = owner ? 100 : Number(actor.priority) || 0;
  const [rows] = await getPool().execute(`SELECT role_key, label, category, priority, permissions, is_system
    FROM role_definitions WHERE priority < ? ORDER BY priority DESC, label ASC`, [actorPriority]);
  return rows.map(row => normalizedRoleDefinition(row));
}
async function getAdminUsers(limit, offset, search = '') {
  // mysql2 prepared placeholders are not accepted for LIMIT/OFFSET in all server modes;
  // the API has already clamped these values to bounded integers before calling this function.
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 50)));
  const safeOffset = Math.max(0, Math.min(1000000, Math.trunc(Number(offset) || 0)));
  const term = typeof search === 'string' ? search.trim().toLowerCase() : '';
  const where = term ? 'WHERE LOCATE(?, username) > 0' : '';
  const [rows] = await getPool().execute(`SELECT u.username, u.role, r.label AS role_label, r.priority AS role_priority, u.is_active, u.created_at, u.last_active_at, u.total_active_seconds AS active_seconds
    FROM users u LEFT JOIN role_definitions r ON r.role_key = u.role ${where.replace(/username/g, 'u.username')}
    ORDER BY u.created_at DESC, u.username ASC LIMIT ${safeLimit} OFFSET ${safeOffset}`, term ? [term] : []);
  return rows.map(row => ({
    username: row.username, role: row.role, role_label: row.username === 'ak9' ? 'مالك النظام' : (row.role_label || row.role), role_priority: Number(row.role_priority) || 0,
    is_active: Number(row.is_active) === 1,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    active_seconds: Number(row.active_seconds)
  }));
}
async function countAdminUsers(search = '') {
  const term = typeof search === 'string' ? search.trim().toLowerCase() : '';
  const [rows] = await getPool().execute(
    term ? 'SELECT COUNT(*) AS total FROM users WHERE LOCATE(?, username) > 0' : 'SELECT COUNT(*) AS total FROM users',
    term ? [term] : []
  );
  return Number(rows[0]?.total) || 0;
}
async function createRoleDefinition(actorId, label, priority, permissions) {
  const safePermissions = validateRolePermissions(permissions);
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safePriority = Number(priority);
  if (!safePermissions || safeLabel.length < 2 || safeLabel.length > 40 || !Number.isInteger(safePriority) || safePriority < 1 || safePriority > 99) return { error: 'invalid' };
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [owners] = await connection.execute('SELECT username FROM users WHERE id = ? FOR UPDATE', [actorId]);
    if (!owners.length || owners[0].username !== 'ak9') { await connection.rollback(); return { error: 'forbidden' }; }
    const roleKey = `custom_${crypto.randomBytes(6).toString('hex')}`;
    await connection.execute('INSERT INTO role_definitions (role_key, label, category, priority, permissions, is_system) VALUES (?, ?, ?, ?, ?, 0)', [roleKey, safeLabel, 'admin', safePriority, JSON.stringify(safePermissions)]);
    await connection.commit();
    return { role: { role_key: roleKey, label: safeLabel, category: 'admin', priority: safePriority, permissions: safePermissions, is_system: false, users_count: 0 } };
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return { error: 'invalid' };
    throw error;
  } finally { connection.release(); }
}
async function updateRoleDefinition(actorId, roleKey, label, priority, permissions) {
  const safePermissions = validateRolePermissions(permissions);
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safePriority = Number(priority);
  if (!/^[a-z0-9_]{3,32}$/.test(roleKey) || !safePermissions || safeLabel.length < 2 || safeLabel.length > 40 || !Number.isInteger(safePriority) || safePriority < 1 || safePriority > 99 || roleKey === 'student') return { error: 'invalid' };
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [owners] = await connection.execute('SELECT username FROM users WHERE id = ? FOR UPDATE', [actorId]);
    if (!owners.length || owners[0].username !== 'ak9') { await connection.rollback(); return { error: 'forbidden' }; }
    const [roles] = await connection.execute('SELECT role_key, category, is_system FROM role_definitions WHERE role_key = ? FOR UPDATE', [roleKey]);
    if (!roles.length) { await connection.rollback(); return { error: 'not_found' }; }
    if (roles[0].category !== 'admin' || roleKey === 'owner') { await connection.rollback(); return { error: 'protected' }; }
    await connection.execute('UPDATE role_definitions SET label = ?, priority = ?, permissions = ? WHERE role_key = ?', [safeLabel, safePriority, JSON.stringify(safePermissions), roleKey]);
    await connection.commit();
    return { role: { role_key: roleKey, label: safeLabel, category: 'admin', priority: safePriority, permissions: safePermissions, is_system: Boolean(roles[0].is_system) } };
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return { error: 'invalid' };
    throw error;
  } finally { connection.release(); }
}
async function deleteRoleDefinition(actorId, roleKey) {
  if (!/^[a-z0-9_]{3,32}$/.test(roleKey)) return { error: 'invalid' };
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [owners] = await connection.execute('SELECT username FROM users WHERE id = ? FOR UPDATE', [actorId]);
    if (!owners.length || owners[0].username !== 'ak9') { await connection.rollback(); return { error: 'forbidden' }; }
    const [roles] = await connection.execute('SELECT role_key, is_system FROM role_definitions WHERE role_key = ? FOR UPDATE', [roleKey]);
    if (!roles.length) { await connection.rollback(); return { error: 'not_found' }; }
    if (roles[0].is_system) { await connection.rollback(); return { error: 'protected' }; }
    const [used] = await connection.execute('SELECT COUNT(*) AS total FROM users WHERE role = ?', [roleKey]);
    if (Number(used[0]?.total) > 0) { await connection.rollback(); return { error: 'in_use' }; }
    await connection.execute('DELETE FROM role_definitions WHERE role_key = ?', [roleKey]);
    await connection.commit();
    return { deleted: roleKey };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
async function deleteAccount(userId) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT id, username FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!rows.length) { await connection.rollback(); return { deleted: false }; }
    if (rows[0].username === 'ak9') { await connection.rollback(); return { error: 'protected' }; }
    // Contact messages sent by this account are personal data; sessions also cascade, deleted explicitly for clarity.
    await connection.execute('DELETE FROM admin_messages WHERE user_id = ?', [userId]);
    await connection.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    const [result] = await connection.execute('DELETE FROM users WHERE id = ?', [userId]);
    await connection.commit();
    return { deleted: result.affectedRows === 1 };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function changeUserRole(actorId, username, role) {
  if (typeof role !== 'string' || !/^[a-z0-9_]{3,32}$/.test(role)) return { error: 'invalid_role' };
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`SELECT u.id, u.username, u.role, r.label AS role_label, r.category, r.priority, r.permissions
      FROM users u LEFT JOIN role_definitions r ON r.role_key = u.role
      WHERE u.id = ? OR u.username = ? ORDER BY u.id FOR UPDATE`, [actorId, username]);
    const actor = rows.find(row => String(row.id) === String(actorId));
    const target = rows.find(row => row.username === username);
    const actorPermissions = actor?.username === 'ak9' ? SYSTEM_OWNER_PERMISSIONS : parsePermissions(actor?.permissions);
    if (!actor || !actorPermissions.includes('users.manage_roles')) {
      await connection.rollback();
      return { error: 'forbidden' };
    }
    if (actor.username === username) {
      await connection.rollback();
      return { error: 'self' };
    }
    if (!target) {
      await connection.rollback();
      return { error: 'not_found' };
    }
    if (target.username === 'ak9') {
      await connection.rollback();
      return { error: 'protected' };
    }
    const [roleRows] = await connection.execute('SELECT role_key, label, category, priority FROM role_definitions WHERE role_key = ? FOR UPDATE', [role]);
    if (!roleRows.length || !['admin', 'student'].includes(roleRows[0].category)) { await connection.rollback(); return { error: 'invalid_role' }; }
    const actorPriority = actor.username === 'ak9' ? 100 : Number(actor.priority) || 0;
    const targetPriority = Number(target.priority) || 0;
    if (actor.username !== 'ak9' && (targetPriority >= actorPriority || Number(roleRows[0].priority) >= actorPriority)) {
      await connection.rollback();
      return { error: 'hierarchy' };
    }
    if (target.role !== role) await connection.execute('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
    await connection.commit();
    return { user: { username: target.username, role, role_label: roleRows[0].label } };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
async function close() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

module.exports = {
  DUMMY_SALT, DUMMY_HASH, initialize, seedInitialAdmin, healthCheck, getCsrfSecret,
  createStudent, getUserForLogin, changePassword, createSession, getSessionUser, deleteSession,
  recordHeartbeat, pauseHeartbeat, getLeaderboard, hasPermission, isCurrentAdmin, isSystemOwner,
  getRoleDefinitions, getAssignableRoles, getAdminUsers, countAdminUsers, createRoleDefinition,
  updateRoleDefinition, deleteRoleDefinition, changeUserRole, deleteAccount,
  EDITABLE_ROLE_PERMISSIONS, SYSTEM_OWNER_PERMISSIONS, getPool, close
};
