ALTER TABLE users
    ADD COLUMN account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT NULL,
    ADD UNIQUE KEY uq_users_account_uuid (account_uuid);
