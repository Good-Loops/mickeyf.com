-- Draft only: do not apply until grants, deletion/recovery and rollout are qualified.
-- One current-day aggregate per managed child; no individual activity log.
CREATE TABLE parent_child_daily_usage (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    time_zone VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    daily_limit_ms INT UNSIGNED NOT NULL,
    usage_day CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    used_ms INT UNSIGNED NOT NULL,
    accounted_at_ms BIGINT UNSIGNED NOT NULL,
    active_until_ms BIGINT UNSIGNED NULL,
    PRIMARY KEY (child_uuid),
    KEY idx_child_daily_usage_accounted_at (accounted_at_ms),
    CONSTRAINT fk_child_daily_usage_consent FOREIGN KEY (child_uuid)
        REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_child_daily_usage_bounds CHECK (
        daily_limit_ms BETWEEN 60000 AND 86400000 AND used_ms <= 86400000
        AND (active_until_ms IS NULL OR (active_until_ms >= accounted_at_ms
            AND active_until_ms <= accounted_at_ms + 30000))
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
