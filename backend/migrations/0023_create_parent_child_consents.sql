CREATE TABLE parent_child_consents (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    policy_digest BINARY(32) NOT NULL,
    consent_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    consented_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (child_uuid),
    KEY idx_parent_children (parent_uuid),
    CONSTRAINT fk_child_consent_account FOREIGN KEY (child_uuid) REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_child_consent_parent FOREIGN KEY (parent_uuid) REFERENCES users (account_uuid) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT chk_distinct_parent_child CHECK (parent_uuid <> child_uuid)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
