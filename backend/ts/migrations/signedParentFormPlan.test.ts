import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMigrationManifest } from './migrationManifest';
import { assertSignedParentFormPlan, signedParentFormPlan } from './signedParentFormPlan';

const migrations = loadMigrationManifest();
const database = { databaseName: 'synthetic', currentUser: 'owner@localhost', serverUuid: 'synthetic-server',
    serverVersion: '8.0.31', versionComment: 'synthetic' };
const schema = { applied: migrations.slice(0, 25).map(item => item.version),
    pending: [migrations[25].version], recoverable: [] as string[] };

test('reviewed signed-form operation rejects a changed database, account, SQL or recovery state', () => {
    const plan = signedParentFormPlan(database, migrations, schema);
    const approval = { MIGRATION_CONFIRM_SERVER_UUID: database.serverUuid, MIGRATION_APPROVED_PLAN_SHA256: plan.sha256 };
    assert.doesNotThrow(() => assertSignedParentFormPlan(plan, approval));
    for (const next of [
        signedParentFormPlan({ ...database, serverUuid: 'another-server' }, migrations, schema),
        signedParentFormPlan({ ...database, currentUser: 'another-owner@localhost' }, migrations, schema),
        signedParentFormPlan({ ...database, databaseName: 'another-database' }, migrations, schema),
        signedParentFormPlan(database, migrations.map((item, index) => index === 25 ? { ...item, checksum: Buffer.alloc(32, 5) } : item), schema),
        signedParentFormPlan(database, migrations, { ...schema, recoverable: [...schema.pending] }),
    ]) assert.throws(() => assertSignedParentFormPlan(next, approval), /freshly approved/u);
    assert.throws(() => assertSignedParentFormPlan(plan, {}), /confirmed server/u);
});

test('signed-form operation refuses missing earlier history or additional pending operations', () => {
    assert.throws(() => signedParentFormPlan(database, migrations, { ...schema, applied: schema.applied.slice(1) }), /history/u);
    assert.throws(() => signedParentFormPlan(database, migrations, { ...schema, pending: [migrations[24].version, migrations[25].version] }), /history/u);
    assert.throws(() => signedParentFormPlan(database, migrations, { ...schema, recoverable: [migrations[24].version] }), /history/u);
    assert.throws(() => signedParentFormPlan(database, migrations.slice(0, 25), schema), /history/u);
});
