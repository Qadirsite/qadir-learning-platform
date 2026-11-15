SET @qadir_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='admin_messages' AND column_name='attachments'), 'SELECT 1', 'ALTER TABLE admin_messages ADD COLUMN attachments JSON NULL AFTER message');
PREPARE qadir_stmt FROM @qadir_ddl;
EXECUTE qadir_stmt;
DEALLOCATE PREPARE qadir_stmt;
