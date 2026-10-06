ALTER TABLE parent_registration_attempts
    DROP CHECK chk_parent_attempt_purpose,
    MODIFY purpose ENUM('create-child', 'withdraw-child', 'delete-family', 'publish-scores') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ADD COLUMN family_digest BINARY(32) NULL,
    ADD COLUMN profile_digest BINARY(32) NULL,
    ADD CONSTRAINT chk_parent_attempt_purpose CHECK (
        (purpose = 'create-child' AND country_code IS NOT NULL AND child_uuid IS NULL AND family_digest IS NULL AND profile_digest IS NULL)
        OR (purpose = 'withdraw-child' AND country_code IS NULL AND child_uuid IS NOT NULL AND family_digest IS NULL AND profile_digest IS NULL)
        OR (purpose = 'publish-scores' AND country_code IS NULL AND child_uuid IS NOT NULL AND family_digest IS NULL AND profile_digest IS NOT NULL)
        OR (purpose = 'delete-family' AND country_code IS NULL AND child_uuid IS NULL AND family_digest IS NOT NULL AND profile_digest IS NULL)
    );
