-- Draft only. Not part of the migration manifest or approved for a live target.
-- The parent relationship and activity row must be rechecked under lock.
CREATE TABLE parent_child_inactivity_warnings (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    warning_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    activity_at DATETIME(6) NOT NULL COMMENT 'UTC exact activity observed when prepared',
    contact_digest BINARY(32) NOT NULL,
    notice_digest BINARY(32) NOT NULL,
    prepared_at DATETIME(6) NOT NULL COMMENT 'UTC',
    delivered_at DATETIME(6) NULL COMMENT 'UTC independently confirmed delivery',
    receipt_digest BINARY(32) NULL,
    PRIMARY KEY (child_uuid),
    UNIQUE KEY idx_inactivity_warning_id (warning_uuid),
    CONSTRAINT fk_inactivity_warning_activity FOREIGN KEY (child_uuid)
        REFERENCES parent_managed_child_activity (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_inactivity_warning_receipt CHECK (
        (delivered_at IS NULL AND receipt_digest IS NULL) OR
        (delivered_at IS NOT NULL AND receipt_digest IS NOT NULL AND delivered_at >= prepared_at)
    )
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
