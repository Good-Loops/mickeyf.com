-- Disabled draft. Apply only through a separately reviewed schema operation.
CREATE TABLE parent_form_apple_relay_state (
    reference CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    last_event_at BIGINT UNSIGNED NOT NULL,
    forwarding_disabled TINYINT UNSIGNED NOT NULL,
    PRIMARY KEY (reference),
    CONSTRAINT fk_parent_form_relay_reference FOREIGN KEY (reference)
        REFERENCES parent_signed_forms(reference) ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT chk_parent_form_relay_disabled CHECK (forwarding_disabled IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
