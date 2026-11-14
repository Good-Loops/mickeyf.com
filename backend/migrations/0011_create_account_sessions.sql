CREATE TABLE account_sessions (
    session_hash BINARY(32) NOT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(6) NOT NULL COMMENT 'UTC',
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    CONSTRAINT pk_account_sessions PRIMARY KEY (session_hash),
    KEY idx_account_sessions_account_created (account_uuid, created_at),
    KEY idx_account_sessions_expiry (expires_at),
    CONSTRAINT fk_account_sessions_account FOREIGN KEY (account_uuid)
        REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
