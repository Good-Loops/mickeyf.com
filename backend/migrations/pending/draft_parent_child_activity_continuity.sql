-- Reviewed separately before application; not part of the general migration manifest.
-- No backfill: only newly initialized managed-child activity gets a witness.
CREATE TABLE parent_child_activity_continuity (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    head_json JSON NOT NULL,
    ledger_json JSON NOT NULL,
    PRIMARY KEY (child_uuid),
    CONSTRAINT fk_child_continuity_activity FOREIGN KEY (child_uuid)
        REFERENCES parent_managed_child_activity (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_child_continuity_head CHECK (JSON_TYPE(head_json) = 'OBJECT'),
    CONSTRAINT chk_child_continuity_ledger CHECK (JSON_TYPE(ledger_json) = 'ARRAY' AND JSON_LENGTH(ledger_json) BETWEEN 1 AND 2048)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
