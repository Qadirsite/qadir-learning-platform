SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='admin_messages' AND column_name='message_type'), 'SELECT 1', 'ALTER TABLE admin_messages ADD COLUMN message_type ENUM(''student'',''admin'') NOT NULL DEFAULT ''student'' AFTER user_id');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;

SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='admin_messages' AND index_name='idx_admin_messages_type'), 'SELECT 1', 'ALTER TABLE admin_messages ADD KEY idx_admin_messages_type (message_type, status, deleted_at, created_at)');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;
