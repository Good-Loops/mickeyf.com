-- Draft only: review and qualify the operator procedure before production use.
-- The lineage is initialized once and preserved through every supported restore.
CREATE TABLE account_recovery_checkpoint (
    singleton_id TINYINT UNSIGNED NOT NULL,
    lineage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    epoch BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (singleton_id),
    CONSTRAINT chk_account_recovery_checkpoint_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
