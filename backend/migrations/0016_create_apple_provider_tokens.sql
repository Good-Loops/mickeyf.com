CREATE TABLE apple_provider_tokens (
    token_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encrypted_token VARBINARY(8192) NOT NULL,
    created_at DATETIME(6) NOT NULL COMMENT 'UTC',
    revocation_requested_at DATETIME(6) NULL COMMENT 'UTC',
    next_attempt_at DATETIME(6) NULL COMMENT 'UTC',
    retention_deadline DATETIME(6) NULL COMMENT 'UTC',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (token_id),
    KEY idx_apple_tokens_account (account_uuid),
    KEY idx_apple_tokens_retry (next_attempt_at, token_id),
    KEY idx_apple_tokens_retention (retention_deadline)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
