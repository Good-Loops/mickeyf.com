CREATE TABLE account_provider_identities (
    account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    provider VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    subject VARBINARY(255) NOT NULL,
    linked_at DATETIME(6) NOT NULL COMMENT 'UTC',
    CONSTRAINT pk_account_provider_identities PRIMARY KEY (provider, subject),
    CONSTRAINT uq_account_provider_identity UNIQUE (account_uuid, provider),
    CONSTRAINT fk_account_provider_identity_account FOREIGN KEY (account_uuid)
        REFERENCES users (account_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_account_provider_identity_provider CHECK (
        CAST(provider AS BINARY) IN (CAST('google' AS BINARY), CAST('apple' AS BINARY))
    ),
    CONSTRAINT chk_account_provider_identity_subject CHECK (OCTET_LENGTH(subject) BETWEEN 1 AND 255)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
