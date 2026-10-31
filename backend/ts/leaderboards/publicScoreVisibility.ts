/** No authorization or profile field is selected into a public leaderboard DTO. */
export const PUBLIC_SCORE_JOIN = `LEFT JOIN account_score_permissions AS participation
    ON participation.account_uuid = users.account_uuid`;
export const PUBLIC_SCORE_FILTER = `((participation.account_uuid IS NULL
    AND (registration.account_uuid IS NULL OR registration.score_visibility = 'public'))
    OR (participation.visibility = 'public' AND participation.policy_digest = ?
    AND participation.registration_policy_version = registration.policy_version
    AND participation.country_code = registration.country_code AND participation.age_band = registration.age_band
    AND ((participation.authorizer_uuid = users.account_uuid AND NOT EXISTS
        (SELECT 1 FROM parent_child_consents ownership WHERE ownership.child_uuid = users.account_uuid))
        OR EXISTS (SELECT 1 FROM parent_child_consents ownership WHERE ownership.child_uuid = users.account_uuid
            AND ownership.parent_uuid = participation.authorizer_uuid))))`;
