ALTER TABLE users
    ADD CONSTRAINT uq_users_user_name UNIQUE (user_name);
