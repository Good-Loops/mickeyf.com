CREATE TABLE parent_registration_attempts (
    state_hash BINARY(32) NOT NULL,
    binding_hash BINARY(32) NOT NULL,
    parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_user_id INT NOT NULL,
    client_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    nonce CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_digest BINARY(32) NOT NULL,
    purpose ENUM('create-child', 'withdraw-child') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    phase ENUM('pending', 'verifying', 'approved', 'cancelled', 'used') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    grant_hash BINARY(32) NULL,
    provider ENUM('google', 'apple') CHARACTER SET ascii COLLATE ascii_bin NULL,
    subject VARBINARY(255) NULL,
    consent_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    policy_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (state_hash),
    UNIQUE KEY uq_parent_grant (grant_hash),
    KEY idx_parent_attempt_expiry (expires_at),
    KEY idx_parent_attempt_account (parent_uuid),
    CONSTRAINT fk_parent_attempt_account FOREIGN KEY (parent_uuid) REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_parent_attempt_purpose CHECK (
        (purpose = 'create-child' AND country_code IS NOT NULL AND child_uuid IS NULL)
        OR (purpose = 'withdraw-child' AND country_code IS NULL AND child_uuid IS NOT NULL)
    )
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
