-- Existing sessions remain non-renewable; only a fresh remembered login receives the new lifetime policy.
ALTER TABLE account_sessions
    ADD COLUMN remembered TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN renewed_at DATETIME(6) NULL COMMENT 'UTC',
    ADD COLUMN previous_session_hash BINARY(32) NULL,
    ADD COLUMN previous_valid_until DATETIME(6) NULL COMMENT 'UTC',
    ADD UNIQUE KEY uq_account_sessions_previous_hash (previous_session_hash);
