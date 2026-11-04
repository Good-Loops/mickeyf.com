-- Separate opt-in warning schema; applied through the guarded inactivity operation.
CREATE TABLE parent_child_warning_history (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state_json JSON NOT NULL,
    head_json JSON NOT NULL,
    ledger_json JSON NOT NULL,
    PRIMARY KEY (child_uuid),
    CONSTRAINT fk_warning_history_activity FOREIGN KEY (child_uuid)
        REFERENCES parent_managed_child_activity (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_warning_history_state CHECK (JSON_TYPE(state_json) = 'OBJECT'),
    CONSTRAINT chk_warning_history_head CHECK (JSON_TYPE(head_json) = 'OBJECT'),
    CONSTRAINT chk_warning_history_ledger CHECK (JSON_TYPE(ledger_json) = 'ARRAY' AND JSON_LENGTH(ledger_json) BETWEEN 1 AND 2048)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
