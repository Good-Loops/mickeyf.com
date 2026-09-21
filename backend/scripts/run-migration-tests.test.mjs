import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLE_REVOCATION_INTEGRATION_TEST_COMMAND, selectMigrationTestCommands } from './run-migration-tests.mjs';

test('Apple revocation filter runs only its focused disposable SQL suite', () => {
  assert.deepEqual(selectMigrationTestCommands({ appleRevocationOnly: true }), [APPLE_REVOCATION_INTEGRATION_TEST_COMMAND]);
  assert.deepEqual(APPLE_REVOCATION_INTEGRATION_TEST_COMMAND.args, [
    '--test', '-r', 'ts-node/register', 'ts/auth/appleSessionRevocation.integration.test.ts',
  ]);
  assert.equal(selectMigrationTestCommands().at(-1), APPLE_REVOCATION_INTEGRATION_TEST_COMMAND);
});

test('existing focused selections remain separate from new Apple SQL checks', () => {
  for (const options of [{ providerIdentitiesOnly: true }, { runtimeGrantsOnly: true }]) {
    assert(!selectMigrationTestCommands(options).includes(APPLE_REVOCATION_INTEGRATION_TEST_COMMAND));
  }
});

test('conflicting focused selections are rejected before Docker work', () => {
  for (const options of [
    { providerIdentitiesOnly: true, runtimeGrantsOnly: true },
    { providerIdentitiesOnly: true, appleRevocationOnly: true },
    { runtimeGrantsOnly: true, appleRevocationOnly: true },
  ]) assert.throws(() => selectMigrationTestCommands(options), /Select only one/u);
});
