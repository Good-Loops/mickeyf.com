import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'mysql2/promise';
import {
    createThreeBossesPayloadFingerprint,
    readThreeBossesLeaderboard,
} from './threeBossesRunRepository';

test('builds the reviewed canonical payload fingerprint byte-for-byte', () => {
    assert.equal(
        createThreeBossesPayloadFingerprint(
            42,
            '123e4567-e89b-42d3-a456-426614174000',
            50_000
        ).toString('hex'),
        'e5ae8fca38b1ba6ef814b2fd210d64decd682a5642717ff5d551141fe664a369'
    );
});

test('reads only current Three Bosses rows in deterministic ascending order', async () => {
    let queryOptions: { sql?: string; timeout?: number } | undefined;
    let queryValues: unknown[] | undefined;
    const database = {
        async query(options: { sql?: string; timeout?: number }, values?: unknown[]) {
            queryOptions = options;
            queryValues = values;
            return [[
                {
                    userName: 'fast-player',
                    score: 2_000,
                    completionTimeMs: 50_000,
                    internalUserId: 42,
                },
            ], []];
        },
    } as unknown as Pick<Pool, 'query'>;

    assert.deepEqual(await readThreeBossesLeaderboard(database), [{
        userName: 'fast-player',
        score: 2_000,
        completionTimeMs: 50_000,
    }]);
    assert.deepEqual(queryValues, ['three-bosses', 1]);
    assert.equal(queryOptions?.timeout, 10_000);
    assert.equal(
        queryOptions?.sql?.replace(/\s+/g, ' ').trim(),
        'SELECT users.user_name AS userName, game_personal_bests.score AS score, game_personal_bests.completion_time_ms AS completionTimeMs FROM game_personal_bests INNER JOIN users ON users.user_id = game_personal_bests.user_id WHERE game_personal_bests.game_id = ? AND game_personal_bests.rules_version = ? AND game_personal_bests.completion_time_ms IS NOT NULL ORDER BY game_personal_bests.completion_time_ms ASC, game_personal_bests.recorded_at ASC, game_personal_bests.user_id ASC LIMIT 10'
    );
});
