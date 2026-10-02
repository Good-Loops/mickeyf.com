UPDATE users SET account_uuid = UUID() WHERE account_uuid IS NULL;
