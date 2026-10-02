CREATE TABLE provider_auth_attempts (
    state_hash BINARY(32) NOT NULL,
    binding_hash BINARY(32) NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id INT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    CONSTRAINT pk_provider_auth_attempts PRIMARY KEY (state_hash),
    CONSTRAINT uq_provider_auth_attempt_binding UNIQUE (binding_hash),
    INDEX idx_provider_auth_attempt_account (account_uuid),
    INDEX idx_provider_auth_attempt_expiry (expires_at),
    CONSTRAINT fk_provider_auth_attempt_account FOREIGN KEY (account_uuid)
        REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_provider_auth_attempt_action CHECK (
        CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('link' AS BINARY))
    ),
    -- MySQL prohibits CHECK on a cascading foreign-key column. The repository
    -- validates the paired UUID shape when writing and consuming each attempt.
    CONSTRAINT chk_provider_auth_attempt_user CHECK (
        CASE WHEN CAST(action AS BINARY) = CAST('login' AS BINARY)
            THEN user_id IS NULL
            ELSE COALESCE(user_id > 0, 0)
        END = 1
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
