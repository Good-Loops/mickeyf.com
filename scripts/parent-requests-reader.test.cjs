const assert = require('node:assert/strict');
const test = require('node:test');
const { readPendingRequests, FAILURE } = require('./parent-requests-reader.cjs');
const pins = { host: '127.0.0.1', port: 13308, database: 'synthetic', currentUser: 'operator@%', serverUuid: '11111111-1111-4111-8111-111111111111' };
function fixture({ identity = true, fail = false } = {}) {
  const calls = [];
  const connection = { async query(query) { calls.push(query.sql); return [[{ db: pins.database, user: pins.currentUser, serverUuid: identity ? pins.serverUuid : 'wrong' }]]; },
    async beginTransaction() { calls.push('begin'); }, async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); } };
  const dependencies = { async verifySchema() { calls.push('schema'); }, async pending(_connection, after, relay) {
    calls.push('pending'); assert.equal(relay, false); if (fail) throw new Error('private credential must not appear');
    return { requests: [], nextAfter: after };
  } };
  return { connection, dependencies, calls };
}
test('a private queue read pins identity, uses a read-only transaction and preserves pagination', async () => {
  const f = fixture(); const result = await readPendingRequests(f.connection, pins, pins.serverUuid, f.dependencies);
  assert.equal(result.readOnly, true); assert.equal(result.nextAfter, pins.serverUuid);
  assert.deepEqual(f.calls.slice(1), ['SET TRANSACTION READ ONLY', 'begin', 'schema', 'pending', 'commit']);
});
test('wrong server, invalid cursor and failed lookup cannot become an empty successful queue or disclose driver details', async () => {
  for (const settings of [{ identity: false }, { fail: true }]) {
    const f = fixture(settings);
    await assert.rejects(readPendingRequests(f.connection, pins, null, f.dependencies), { message: FAILURE });
    assert.equal(f.calls.includes('commit'), false);
    if (settings.identity === false) assert.equal(f.calls.includes('pending'), false);
  }
  const f = fixture();
  await assert.rejects(readPendingRequests(f.connection, pins, 'invalid', f.dependencies), { message: FAILURE });
  assert.deepEqual(f.calls, []);
});
