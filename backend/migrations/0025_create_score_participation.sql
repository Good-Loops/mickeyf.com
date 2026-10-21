CREATE TABLE account_score_permissions (
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    visibility ENUM('private', 'public') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_digest BINARY(32) NULL,
    registration_policy_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
    age_band ENUM('minor', 'adult') CHARACTER SET ascii COLLATE ascii_bin NULL,
    authorizer_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    confirmed_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (account_uuid),
    CONSTRAINT fk_score_permission_account FOREIGN KEY (account_uuid) REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_score_permission_choice CHECK (
        (visibility = 'private' AND policy_digest IS NULL AND registration_policy_version IS NULL AND country_code IS NULL AND age_band IS NULL AND authorizer_uuid IS NULL)
        OR (visibility = 'public' AND policy_digest IS NOT NULL AND registration_policy_version IS NOT NULL AND country_code IS NOT NULL AND age_band IS NOT NULL AND authorizer_uuid IS NOT NULL)
    )
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
