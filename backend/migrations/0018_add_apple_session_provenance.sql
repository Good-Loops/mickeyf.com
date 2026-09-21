ALTER TABLE account_sessions
    ADD COLUMN apple_subject_hash BINARY(32) NULL,
    ADD COLUMN apple_authenticated_at BIGINT UNSIGNED NULL,
    ADD CONSTRAINT chk_account_sessions_apple_provenance CHECK (
        (apple_subject_hash IS NULL AND apple_authenticated_at IS NULL)
        OR (apple_subject_hash IS NOT NULL AND apple_authenticated_at IS NOT NULL AND apple_authenticated_at > 0)
    );
