CREATE TABLE registration_authorizations (
    binding_hash BINARY(32) NOT NULL,
    policy_digest BINARY(32) NOT NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    age_band ENUM('minor', 'adult') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(6) NOT NULL COMMENT 'UTC',
    consumed_at DATETIME(6) NULL COMMENT 'UTC',
    PRIMARY KEY (binding_hash),
    INDEX idx_registration_expiry (expires_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
