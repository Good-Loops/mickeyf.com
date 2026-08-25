CREATE TABLE game_runs (
    game_run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    game_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rules_version INT UNSIGNED NOT NULL,
    user_id INT NOT NULL,
    run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    score INT NOT NULL,
    completion_time_ms INT UNSIGNED NULL,
    payload_fingerprint BINARY(32) NOT NULL,
    personal_best TINYINT UNSIGNED NOT NULL,
    submitted_at DATETIME(6) NOT NULL COMMENT 'UTC',
    CONSTRAINT pk_game_runs PRIMARY KEY (game_run_id),
    UNIQUE KEY uq_game_runs_idempotency (game_id, user_id, run_id),
    UNIQUE KEY uq_game_runs_source_identity (
        game_id,
        rules_version,
        user_id,
        game_run_id
    ),
    KEY idx_game_runs_user_submitted_at (user_id, submitted_at DESC),
    CONSTRAINT fk_game_runs_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT chk_game_runs_rules_version
        CHECK (rules_version > 0),
    CONSTRAINT chk_game_runs_completion_time_positive
        CHECK (completion_time_ms IS NULL OR completion_time_ms > 0),
    CONSTRAINT chk_game_runs_personal_best_boolean
        CHECK (personal_best IN (0, 1))
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
