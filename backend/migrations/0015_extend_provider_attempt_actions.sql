ALTER TABLE provider_auth_attempts
    DROP CHECK chk_provider_auth_attempt_action,
    DROP CHECK chk_provider_auth_attempt_user,
    ADD CONSTRAINT chk_provider_auth_attempt_action CHECK (
        CAST(action AS BINARY) IN (
            CAST('login' AS BINARY), CAST('link' AS BINARY),
            CAST('signup' AS BINARY), CAST('delete' AS BINARY)
        )
    ),
    ADD CONSTRAINT chk_provider_auth_attempt_user CHECK (
        CASE WHEN CAST(action AS BINARY) IN (CAST('login' AS BINARY), CAST('signup' AS BINARY))
            THEN user_id IS NULL
            ELSE COALESCE(user_id > 0, 0)
        END = 1
    );
