SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='is_active'), 'SELECT 1', 'ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;
SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sessions' AND column_name='last_seen_at'), 'SELECT 1', 'ALTER TABLE sessions ADD COLUMN last_seen_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;
SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sessions' AND column_name='user_agent'), 'SELECT 1', 'ALTER TABLE sessions ADD COLUMN user_agent VARCHAR(255) NULL');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;
SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sessions' AND column_name='ip_hash'), 'SELECT 1', 'ALTER TABLE sessions ADD COLUMN ip_hash BINARY(32) NULL');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;

UPDATE role_definitions
SET permissions = JSON_ARRAY(
  'users.view','users.search','leaderboard.view','users.manage_roles',
  'dashboard.view','content.view','content.manage','users.manage',
  'messages.view','messages.manage','media.view','media.manage',
  'settings.view','settings.manage','navigation.manage','audit.view',
  'backups.manage','security.manage','integrations.manage'
)
WHERE role_key = 'admin'
  AND JSON_LENGTH(permissions) = 4
  AND JSON_CONTAINS(permissions, JSON_ARRAY('users.view','users.search','leaderboard.view','users.manage_roles'));

INSERT IGNORE INTO role_definitions (role_key, label, category, priority, permissions, is_system) VALUES
('editor', 'محرر', 'admin', 60, JSON_ARRAY('dashboard.view','content.view','content.manage','media.view','media.manage'), 1),
('viewer', 'مشاهد', 'admin', 10, JSON_ARRAY('dashboard.view','content.view'), 1);

CREATE TABLE IF NOT EXISTS admin_content (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('lesson','resource','question','announcement','faq') NOT NULL DEFAULT 'resource',
  slug VARCHAR(140) NOT NULL,
  title_ar VARCHAR(200) NOT NULL,
  title_en VARCHAR(200) NULL,
  body_ar MEDIUMTEXT NOT NULL,
  body_en MEDIUMTEXT NULL,
  category VARCHAR(80) NOT NULL DEFAULT '',
  tags JSON NOT NULL,
  cover_url VARCHAR(512) NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  seo_title_ar VARCHAR(200) NULL,
  seo_title_en VARCHAR(200) NULL,
  seo_description_ar VARCHAR(320) NULL,
  seo_description_en VARCHAR(320) NULL,
  publish_at DATETIME NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_content_slug (slug),
  KEY idx_admin_content_public (status, publish_at, deleted_at, kind),
  KEY idx_admin_content_category (category, updated_at),
  CONSTRAINT fk_admin_content_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_admin_content_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_content_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  content_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  snapshot JSON NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_content_version (content_id, version_no),
  KEY idx_admin_content_version_created (content_id, created_at),
  CONSTRAINT fk_admin_content_version_content FOREIGN KEY (content_id) REFERENCES admin_content(id) ON DELETE CASCADE,
  CONSTRAINT fk_admin_content_version_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  sender_name VARCHAR(100) NOT NULL,
  sender_email VARCHAR(254) NULL,
  subject VARCHAR(180) NOT NULL,
  message MEDIUMTEXT NOT NULL,
  reply MEDIUMTEXT NULL,
  status ENUM('new','open','replied','closed') NOT NULL DEFAULT 'new',
  ip_hash BINARY(32) NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_admin_messages_inbox (status, deleted_at, created_at),
  KEY idx_admin_messages_user (user_id, created_at),
  CONSTRAINT fk_admin_message_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_media (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  original_name VARCHAR(255) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_by BIGINT UNSIGNED NULL,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_admin_media_object_key (object_key),
  KEY idx_admin_media_owner (uploaded_by, deleted_at, created_at),
  CONSTRAINT fk_admin_media_user FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_admin_setting_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_navigation (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label_ar VARCHAR(100) NOT NULL,
  label_en VARCHAR(100) NULL,
  href VARCHAR(512) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_admin_navigation_active (is_active, deleted_at, position),
  CONSTRAINT fk_admin_navigation_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_username VARCHAR(24) NOT NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(48) NOT NULL,
  target_id VARCHAR(64) NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_activity_time (created_at),
  KEY idx_admin_activity_actor (actor_user_id, created_at),
  CONSTRAINT fk_admin_activity_user FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_daily_visits (
  visit_date DATE NOT NULL,
  path VARCHAR(180) NOT NULL,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (visit_date, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
