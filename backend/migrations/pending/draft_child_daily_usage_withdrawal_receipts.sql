-- Draft only: apply with the daily usage schema, grants and scheduled retention.
-- A withdrawal receipt contains no daily limit, usage total or time zone.
CREATE TABLE child_daily_usage_withdrawal_receipts (
    receipt_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    notice_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    consented_at DATETIME(6) NOT NULL COMMENT 'UTC',
    withdrawn_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (receipt_uuid),
    KEY idx_child_daily_usage_receipt_child (child_uuid),
    KEY idx_child_daily_usage_withdrawn_at (withdrawn_at),
    CONSTRAINT fk_child_daily_usage_receipt_consent FOREIGN KEY (child_uuid)
        REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
