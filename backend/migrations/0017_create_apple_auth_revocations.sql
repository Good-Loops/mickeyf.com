CREATE TABLE apple_auth_revocations (
    subject_hash BINARY(32) NOT NULL,
    revoked_at BIGINT UNSIGNED NOT NULL,
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (subject_hash),
    KEY idx_apple_revocations_expiry (expires_at, subject_hash)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
