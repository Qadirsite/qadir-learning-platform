ALTER TABLE users MODIFY COLUMN role VARCHAR(32) NOT NULL DEFAULT 'student';

CREATE TABLE IF NOT EXISTS role_definitions (
  role_key VARCHAR(32) NOT NULL PRIMARY KEY,
  label VARCHAR(64) NOT NULL,
  category ENUM('student','admin') NOT NULL DEFAULT 'admin',
  priority SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  permissions JSON NOT NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_definitions_label (label),
  KEY idx_role_definitions_category_priority (category, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO role_definitions (role_key, label, category, priority, permissions, is_system) VALUES
  ('student', 'طالب', 'student', 0, JSON_ARRAY(), 1),
  ('admin', 'مدير', 'admin', 80, JSON_ARRAY('users.view', 'users.search', 'leaderboard.view', 'users.manage_roles'), 1),
  ('moderator', 'مشرف', 'admin', 50, JSON_ARRAY('users.view', 'users.search', 'leaderboard.view'), 1);
