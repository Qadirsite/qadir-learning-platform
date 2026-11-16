CREATE TABLE IF NOT EXISTS student_lessons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lesson_key VARCHAR(16) NOT NULL,
  section VARCHAR(40) NOT NULL,
  original_title_ar VARCHAR(200) NOT NULL,
  title_ar VARCHAR(200) NOT NULL,
  description_ar VARCHAR(500) NOT NULL DEFAULT '',
  youtube_url VARCHAR(512) NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_lessons_key (lesson_key),
  KEY idx_student_lessons_section (section),
  CONSTRAINT fk_student_lessons_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
