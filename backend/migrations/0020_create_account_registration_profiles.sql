CREATE TABLE account_registration_profiles (
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    age_band ENUM('minor', 'adult') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    score_visibility ENUM('private', 'public') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (account_uuid),
    CONSTRAINT fk_registration_profile_account FOREIGN KEY (account_uuid)
        REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_registration_minor_private CHECK (
        age_band = 'adult' OR score_visibility = 'private'
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
