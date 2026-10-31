-- Draft only: this is not part of the migration manifest or an authorized production operation.
CREATE TABLE parent_managed_child_activity (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    retention_activity_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (child_uuid),
    CONSTRAINT fk_child_activity_consent FOREIGN KEY (child_uuid)
        REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
