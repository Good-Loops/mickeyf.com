CREATE TABLE parent_signed_forms (
    reference CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_name VARCHAR(64) NOT NULL,
    policy_digest BINARY(32) NOT NULL,
    consent_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider ENUM('google','apple') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARBINARY(255) NOT NULL,
    verified_contact VARCHAR(254) NOT NULL,
    status ENUM('pending','approved','rejected','used') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    submitted_at DATETIME(6) NOT NULL COMMENT 'UTC',
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    reviewed_at DATETIME(6) NULL COMMENT 'UTC',
    reviewer VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    form_sha256 BINARY(32) NULL,
    public_policy_digest BINARY(32) NULL,
    public_approved TINYINT UNSIGNED NOT NULL DEFAULT 0,
    public_withdrawn TINYINT UNSIGNED NOT NULL DEFAULT 0,
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (reference),
    UNIQUE KEY idx_signed_form_child (child_uuid),
    KEY idx_signed_form_parent (parent_uuid),
    KEY idx_signed_form_expiry (expires_at),
    CONSTRAINT fk_signed_form_parent FOREIGN KEY (parent_uuid) REFERENCES users(account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_signed_form_child FOREIGN KEY (child_uuid) REFERENCES users(account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_signed_form_status CHECK (
        country_code = 'US' AND public_approved IN (0,1) AND public_withdrawn IN (0,1)
        AND (public_approved = 0 OR public_policy_digest IS NOT NULL)
        AND ((status = 'pending' AND reviewed_at IS NULL AND reviewer IS NULL AND form_sha256 IS NULL AND child_uuid IS NULL AND public_approved = 0)
          OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NULL)
          OR (status = 'used' AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NOT NULL))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
