import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMigrationManifest } from './migrationManifest';

const migrationDirectory = path.resolve(process.cwd(), 'migrations');

test('migration manifest preserves lexical order and hashes exact LF bytes', () => {
    const migrations = loadMigrationManifest(migrationDirectory);

    assert.deepEqual(
        migrations.map(({ version }) => version),
        [
            '0001_create_game_runs',
            '0002_create_game_personal_bests',
            '0003_drop_users_p4_score',
            '0004_detach_personal_best_sources',
            '0005_retain_submission_receipts',
            '0006_add_account_identity',
            '0007_backfill_account_identity',
            '0008_finalize_account_identity',
            '0009_create_account_provider_identities',
            '0010_create_provider_auth_attempts',
            '0011_create_account_sessions',
            '0012_add_session_renewal',
            '0013_add_unique_user_names',
            '0014_allow_passwordless_accounts',
            '0015_extend_provider_attempt_actions',
            '0016_create_apple_provider_tokens',
            '0017_create_apple_auth_revocations',
            '0018_add_apple_session_provenance',
        ]
    );
    assert.deepEqual(
        migrations.map(({ effect }) => effect),
        ['create-table', 'create-table', 'drop-column', 'detach-best-source', 'retain-receipts',
            'add-account-identity', 'add-account-identity', 'add-account-identity', 'add-provider-identities',
            'add-provider-attempts', 'add-account-sessions', 'add-session-renewal', 'add-unique-user-names',
            'allow-passwordless-accounts', 'extend-provider-attempt-actions', 'add-apple-tokens',
            'add-apple-revocations', 'add-apple-session-provenance']
    );
    assert.deepEqual(migrations.slice(0, 10).map(({ checksum }) => checksum.toString('hex')), [
        '9a797edd514dfc946783cf66cf80ee8dfa774210a0d100946c3a9a822596ca00',
        '01eade4cfc8e1131be79df43881a9bc7a538aaf0e1e1d3f470deb6c21eaaed3a',
        'bc4c89691d9d2f729977446e1bde8f168c5ee83c95349e80c3a6deec598a2951',
        '88cc121f6410f6c324cff0d6bb57691062a64a10722c0c35deb826ce4cc0f9a6',
        'f91a3f5aa52f14e43c652282ca9cc1a9e6dc5e9294c8c7c330c8142cbd33becc',
        'aecdd543c2b3b5f9779b1ff607f2dacefe547a3d578c91806f65d4c73652d6bb',
        '59b3b59b87ecf4b7f78b1f2632935546493f0ff826370fd43efef2b21b9cc55c',
        'f92d599dfd8586022bfcbd60e9de382643a0fb89ff644ad664cd61d817701883',
        'e340eef416c5b837a37b40b10b5c435b7519536596f6d477b69addbb3314a57f',
        '150391a30408a7df03953b006472f39316be99b20c01fe3e57f481b5487ca937',
    ], 'historical migration bytes must remain immutable');
    for (const migration of migrations) {
        const rawSql = readFileSync(path.join(migrationDirectory, migration.fileName));
        assert.equal(rawSql.includes(0x0d), false);
        assert.deepEqual(
            migration.checksum,
            createHash('sha256').update(rawSql).digest()
        );
    }
    assert.equal(
        migrations[2].sql,
        'ALTER TABLE users DROP COLUMN p4_score, ALGORITHM=INSTANT;\n'
    );
    assert.match(migrations[4].sql, /DROP CHECK chk_game_runs_personal_best_boolean/u);
    assert.match(migrations[4].sql,
        /ADD CONSTRAINT chk_game_submission_receipts_improved_best_boolean\s+CHECK \(improved_personal_best IN \(0, 1\)\)/u);
});

test('migration manifest refuses unreviewed SQL files', () => {
    const directory = copyMigrationDirectory();
    try {
        writeFileSync(path.join(directory, '0004_unreviewed.sql'), 'SELECT 1;\n');
        assert.throws(
            () => loadMigrationManifest(directory),
            /must contain exactly/
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('migration manifest refuses checksum-unstable CRLF and multiple statements', () => {
    const crlfDirectory = copyMigrationDirectory();
    try {
        const file = path.join(crlfDirectory, '0001_create_game_runs.sql');
        writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
        assert.throws(() => loadMigrationManifest(crlfDirectory), /LF line endings/);
    } finally {
        rmSync(crlfDirectory, { recursive: true, force: true });
    }

    const multiStatementDirectory = copyMigrationDirectory();
    try {
        const file = path.join(multiStatementDirectory, '0002_create_game_personal_bests.sql');
        writeFileSync(file, 'SELECT 1;\nSELECT 2;\n');
        assert.throws(
            () => loadMigrationManifest(multiStatementDirectory),
            /exactly one SQL statement/
        );
    } finally {
        rmSync(multiStatementDirectory, { recursive: true, force: true });
    }
});

function copyMigrationDirectory(): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'mickeyf-migrations-'));
    cpSync(migrationDirectory, directory, { recursive: true });
    return directory;
}
