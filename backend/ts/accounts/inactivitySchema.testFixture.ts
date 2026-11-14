import assert from 'node:assert/strict';

// Fixed SQL for isolated fixtures. The equality checks below ensure the tests
// exercise the exact reviewed drafts rather than silently drifting from them.
export const ACTIVITY_DRAFT_SQL = `-- Draft only: this is not part of the migration manifest or an authorized production operation.
CREATE TABLE parent_managed_child_activity (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    retention_activity_at DATETIME(6) NOT NULL COMMENT 'UTC',
    PRIMARY KEY (child_uuid),
    CONSTRAINT fk_child_activity_consent FOREIGN KEY (child_uuid)
        REFERENCES parent_child_consents (child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

export const WARNING_DRAFT_SQL = `-- Draft only. Not part of the migration manifest or approved for a live target.
-- The parent relationship and activity row must be rechecked under lock.
CREATE TABLE parent_child_inactivity_warnings (
    child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    warning_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    activity_at DATETIME(6) NOT NULL COMMENT 'UTC exact activity observed when prepared',
    channel ENUM('in-app', 'email') NOT NULL,
    target_digest BINARY(32) NOT NULL,
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
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

export function assertActivityDraft(source: string): void {
    assert.equal(source.replace(/\r\n/gu, '\n'), `${ACTIVITY_DRAFT_SQL}\n`, 'activity draft differs from fixed test SQL');
}

export function assertWarningDraft(source: string): void {
    assert.equal(source.replace(/\r\n/gu, '\n'), `${WARNING_DRAFT_SQL}\n`, 'warning draft differs from fixed test SQL');
}

export const CONTINUITY_DRAFT_SQL = `-- Reviewed separately before application; not part of the general migration manifest.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

export function assertContinuityDraft(source: string): void {
    assert.equal(source.replace(/\r\n/gu, '\n'), `${CONTINUITY_DRAFT_SQL}\n`, 'continuity draft differs from fixed test SQL');
}

export const WARNING_HISTORY_DRAFT_SQL = `-- Separate opt-in warning schema; applied through the guarded inactivity operation.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

export function assertWarningHistoryDraft(source: string): void {
    assert.equal(source.replace(/\r\n/gu, '\n'), `${WARNING_HISTORY_DRAFT_SQL}\n`, 'warning history draft differs from fixed test SQL');
}
