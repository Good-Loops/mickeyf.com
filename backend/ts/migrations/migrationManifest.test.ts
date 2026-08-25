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
        ['0001_create_game_runs', '0002_create_game_personal_bests']
    );
    for (const migration of migrations) {
        const rawSql = readFileSync(path.join(migrationDirectory, migration.fileName));
        assert.equal(rawSql.includes(0x0d), false);
        assert.deepEqual(
            migration.checksum,
            createHash('sha256').update(rawSql).digest()
        );
    }
});

test('migration manifest refuses unreviewed SQL files', () => {
    const directory = copyMigrationDirectory();
    try {
        writeFileSync(path.join(directory, '0003_unreviewed.sql'), 'SELECT 1;\n');
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
