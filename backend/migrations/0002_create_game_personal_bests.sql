CREATE TABLE game_personal_bests (
    game_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    rules_version INT UNSIGNED NOT NULL,
    user_id INT NOT NULL,
    score INT NOT NULL,
    completion_time_ms INT UNSIGNED NULL,
    recorded_at DATETIME(6) NOT NULL COMMENT 'UTC',
    source_game_run_id BIGINT UNSIGNED NULL,
    CONSTRAINT pk_game_personal_bests
        PRIMARY KEY (game_id, rules_version, user_id),
    KEY idx_game_personal_bests_user (user_id),
    KEY idx_game_personal_bests_source_game_run (
        game_id,
        rules_version,
        user_id,
        source_game_run_id
    ),
    KEY idx_game_personal_bests_score_leaderboard (
        game_id,
        rules_version,
        score DESC,
        recorded_at ASC,
        user_id ASC
    ),
    KEY idx_game_personal_bests_completion_leaderboard (
        game_id,
        rules_version,
        completion_time_ms ASC,
        recorded_at ASC,
        user_id ASC,
        score
    ),
    CONSTRAINT fk_game_personal_bests_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT fk_game_personal_bests_source_game_run
        FOREIGN KEY (
            game_id,
            rules_version,
            user_id,
            source_game_run_id
        ) REFERENCES game_runs (
            game_id,
            rules_version,
            user_id,
            game_run_id
        )
        ON UPDATE RESTRICT
        ON DELETE RESTRICT,
    CONSTRAINT chk_game_personal_bests_rules_version
        CHECK (rules_version > 0),
    CONSTRAINT chk_game_personal_bests_completion_time_positive
        CHECK (completion_time_ms IS NULL OR completion_time_ms > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
