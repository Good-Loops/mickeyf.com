import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export type LeaderboardTableName = 'game_runs' | 'game_personal_bests';

export type MigrationEffectKind = 'create-table' | 'drop-column';

type MigrationMetadata = Readonly<{
    version: string;
    fileName: string;
    sql: string;
    checksum: Buffer;
}>;

export type MigrationDefinition = MigrationMetadata & Readonly<
    | {
        effect: 'create-table';
        tableName: LeaderboardTableName;
    }
    | {
        effect: 'drop-column';
        tableName: 'users';
        columnName: 'p4_score';
    }
>;

const MIGRATION_SPECS = Object.freeze([
    Object.freeze({
        fileName: '0001_create_game_runs.sql',
        effect: 'create-table' as const,
        tableName: 'game_runs' as const,
    }),
    Object.freeze({
        fileName: '0002_create_game_personal_bests.sql',
        effect: 'create-table' as const,
        tableName: 'game_personal_bests' as const,
    }),
    Object.freeze({
        fileName: '0003_drop_users_p4_score.sql',
        effect: 'drop-column' as const,
        tableName: 'users' as const,
        columnName: 'p4_score' as const,
    }),
]);

const MIGRATION_FILE_NAME = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

function defaultMigrationDirectory(): string {
    return path.resolve(process.cwd(), 'migrations');
}

function assertSingleStatement(sql: string, fileName: string): void {
    const withoutLineComments = sql.replace(/--[^\n]*(?:\n|$)/g, '\n').trim();
    if (!withoutLineComments.endsWith(';')) {
        throw new Error(`${fileName} must end with one SQL statement terminator`);
    }

    const statementBody = withoutLineComments.slice(0, -1);
    if (statementBody.includes(';')) {
        throw new Error(`${fileName} must contain exactly one SQL statement`);
    }
}

function readMigration(
    directory: string,
    spec: (typeof MIGRATION_SPECS)[number]
): MigrationDefinition {
    if (!MIGRATION_FILE_NAME.test(spec.fileName)) {
        throw new Error(`Invalid migration filename: ${spec.fileName}`);
    }

    const rawSql = readFileSync(path.join(directory, spec.fileName));
    if (rawSql.length === 0) {
        throw new Error(`${spec.fileName} must not be empty`);
    }
    if (rawSql[0] === 0xef && rawSql[1] === 0xbb && rawSql[2] === 0xbf) {
        throw new Error(`${spec.fileName} must be UTF-8 without a byte-order mark`);
    }
    if (rawSql.includes(0x0d)) {
        throw new Error(`${spec.fileName} must use LF line endings for stable checksums`);
    }

    const sql = rawSql.toString('utf8');
    assertSingleStatement(sql, spec.fileName);

    const migrationMetadata = {
        version: spec.fileName.slice(0, -'.sql'.length),
        fileName: spec.fileName,
        sql,
        checksum: createHash('sha256').update(rawSql).digest(),
    };
    if (spec.effect === 'drop-column') {
        return Object.freeze({
            ...migrationMetadata,
            effect: spec.effect,
            tableName: spec.tableName,
            columnName: spec.columnName,
        });
    }

    return Object.freeze({
        ...migrationMetadata,
        effect: spec.effect,
        tableName: spec.tableName,
    });
}

export function loadMigrationManifest(
    directory: string = defaultMigrationDirectory()
): readonly MigrationDefinition[] {
    const discoveredFiles = readdirSync(directory)
        .filter((fileName) => fileName.endsWith('.sql'))
        .sort();
    const expectedFiles = MIGRATION_SPECS.map(({ fileName }) => fileName);

    if (
        discoveredFiles.length !== expectedFiles.length
        || discoveredFiles.some((fileName, index) => fileName !== expectedFiles[index])
    ) {
        throw new Error(
            `Migration directory must contain exactly: ${expectedFiles.join(', ')}`
        );
    }

    const migrations = MIGRATION_SPECS.map((spec) => readMigration(directory, spec));
    const versions = new Set(migrations.map(({ version }) => version));
    if (versions.size !== migrations.length) {
        throw new Error('Migration versions must be unique');
    }

    return Object.freeze(migrations);
}
