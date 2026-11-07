ALTER TABLE parent_signed_forms
    MODIFY COLUMN user_name VARCHAR(64) NULL,
    DROP CHECK chk_signed_form_status,
    ADD CONSTRAINT chk_signed_form_status CHECK (
        country_code IN ('US','BR') AND public_approved IN (0,1) AND public_withdrawn IN (0,1)
        AND (public_approved = 0 OR public_policy_digest IS NOT NULL)
        AND ((status = 'pending' AND reviewed_at IS NULL AND reviewer IS NULL AND form_sha256 IS NULL AND child_uuid IS NULL AND public_approved = 0)
          OR (status IN ('approved','rejected') AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NULL)
          OR (status = 'used' AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL AND form_sha256 IS NOT NULL AND child_uuid IS NOT NULL))
    );
