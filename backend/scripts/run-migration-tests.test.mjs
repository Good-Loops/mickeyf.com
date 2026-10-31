import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLE_REVOCATION_INTEGRATION_TEST_COMMAND, REGISTRATION_INTEGRATION_TEST_COMMAND, PARENT_REGISTRATION_INTEGRATION_TEST_COMMAND, selectMigrationTestCommands } from './run-migration-tests.mjs';

test('Apple revocation filter runs only its focused disposable SQL suite', () => {
  assert.deepEqual(selectMigrationTestCommands({ appleRevocationOnly: true }), [APPLE_REVOCATION_INTEGRATION_TEST_COMMAND]);
  assert.deepEqual(APPLE_REVOCATION_INTEGRATION_TEST_COMMAND.args, [
    '--test', '-r', 'ts-node/register', 'ts/auth/appleSessionRevocation.integration.test.ts',
  ]);
  assert(selectMigrationTestCommands().includes(APPLE_REVOCATION_INTEGRATION_TEST_COMMAND));
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
      { registrationOnly: true, appleRevocationOnly: true },
      { registrationOnly: true, runtimeGrantsOnly: true },
      { registrationOnly: true, providerIdentitiesOnly: true },
  ]) assert.throws(() => selectMigrationTestCommands(options), /Select only one/u);
});

test('registration selection runs only its disposable SQL suite and remains in the full suite', () => {
  assert.deepEqual(selectMigrationTestCommands({ registrationOnly: true }), [REGISTRATION_INTEGRATION_TEST_COMMAND]);
  assert(selectMigrationTestCommands().includes(REGISTRATION_INTEGRATION_TEST_COMMAND));
});

test('parent selection includes only the persistent/browser fixture and rejects mixed selections', () => {
    assert.deepEqual(selectMigrationTestCommands({ parentRegistrationOnly: true }), [PARENT_REGISTRATION_INTEGRATION_TEST_COMMAND]);
    assert(selectMigrationTestCommands().includes(PARENT_REGISTRATION_INTEGRATION_TEST_COMMAND));
    for (const option of ['registrationOnly', 'appleRevocationOnly', 'runtimeGrantsOnly', 'providerIdentitiesOnly']) {
        assert.throws(() => selectMigrationTestCommands({ parentRegistrationOnly: true, [option]: true }), /Select only one/u);
    }
});
