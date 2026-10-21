CREATE TABLE apple_android_handoffs (
    state_hash BINARY(32) NOT NULL,
    binding_hash BINARY(32) NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    client_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    user_id INT NULL,
    phase ENUM('pending','ready') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    encrypted_credential VARBINARY(24576) NULL,
    created_at DATETIME(6) NOT NULL COMMENT 'UTC',
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (state_hash),
    UNIQUE KEY uq_apple_android_handoff_binding (binding_hash),
    KEY idx_apple_android_handoff_expiry (expires_at),
    CONSTRAINT fk_apple_android_handoff_attempt FOREIGN KEY (state_hash)
        REFERENCES provider_auth_attempts (state_hash) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_apple_android_handoff_client CHECK (BINARY client_key = BINARY 'apple-android'),
    CONSTRAINT chk_apple_android_handoff_target CHECK (
        (BINARY action IN (BINARY 'login', BINARY 'signup') AND account_uuid IS NULL AND user_id IS NULL)
        OR (BINARY action IN (BINARY 'link', BINARY 'delete') AND account_uuid IS NOT NULL AND user_id IS NOT NULL AND user_id > 0)
    ),
    CONSTRAINT chk_apple_android_handoff_phase CHECK (
        (phase = 'pending' AND encrypted_credential IS NULL)
        OR (phase = 'ready' AND encrypted_credential IS NOT NULL AND OCTET_LENGTH(encrypted_credential) > 31)
    ),
    CONSTRAINT chk_apple_android_handoff_lifetime CHECK (
        expires_at > created_at AND expires_at <= TIMESTAMPADD(SECOND, 300, created_at)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
