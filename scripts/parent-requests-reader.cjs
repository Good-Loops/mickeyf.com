const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const backend = path.resolve(__dirname, '../backend');
const backendRequire = createRequire(path.join(backend, 'package.json'));
const FAILURE = 'Não foi possível consultar a fila. Nenhuma ausência ou decisão foi confirmada.';

function validatePins(pins, after) {
  if (!pins || pins.host !== '127.0.0.1' || !Number.isInteger(pins.port) || pins.port < 1024 || pins.port > 65535
    || !/^[A-Za-z0-9_]{1,64}$/.test(pins.database) || !/^[a-f0-9-]{36}$/.test(pins.serverUuid)
    || typeof pins.currentUser !== 'string' || !pins.currentUser.includes('@')
    || (after !== null && !/^[a-f0-9-]{36}$/.test(after))) throw new Error(FAILURE);
}

async function readPendingRequests(connection, pins, after, dependencies) {
  validatePins(pins, after);
  try {
    const [identity] = await connection.query({ sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS user, @@server_uuid AS serverUuid', timeout: 10000 });
    if (identity.length !== 1 || identity[0].db !== pins.database || identity[0].user !== pins.currentUser
      || identity[0].serverUuid !== pins.serverUuid) throw new Error(FAILURE);
    await connection.query({ sql: 'SET TRANSACTION READ ONLY', timeout: 10000 });
    await connection.beginTransaction();
    await dependencies.verifySchema(connection);
    const page = await dependencies.pending(connection, after, false);
    await connection.commit();
    return { mode: 'live', readOnly: true, observedAt: new Date().toISOString(), ...page };
  } catch {
    try { await connection.rollback(); } catch { /* Closing the owned connection releases its read-only transaction. */ }
    throw new Error(FAILURE);
  }
}

async function main() {
  const [configPath] = process.argv.slice(2);
  if (!configPath || process.argv.length !== 3) throw new Error(FAILURE);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length; if (length > 8192) throw new Error(FAILURE); chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 512
    || Object.keys(input).sort().join(',') !== 'after,password') throw new Error(FAILURE);
  validatePins(config.database, input.after);
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.database.user)
    || !config.database.currentUser.startsWith(`${config.database.user}@`)) throw new Error(FAILURE);
  backendRequire('ts-node').register({ project: path.join(backend, 'tsconfig.json') });
  const mysql = backendRequire('mysql2/promise');
  const { verifySignedParentFormReadiness } = require(path.join(backend, 'ts/migrations/signedParentFormSchema.ts'));
  const { pendingParentFormOutreach } = require(path.join(backend, 'ts/accounts/signedParentFormOutreach.ts'));
  let connection;
  try {
    connection = await mysql.createConnection({ host: config.database.host, port: config.database.port,
      database: config.database.database, user: config.database.user, password: input.password,
      connectTimeout: 10000, multipleStatements: false, timezone: 'Z', dateStrings: true });
    input.password = '';
    const report = await readPendingRequests(connection, config.database, input.after,
      { verifySchema: verifySignedParentFormReadiness, pending: pendingParentFormOutreach });
    await connection.end(); connection = undefined;
    process.stdout.write(JSON.stringify(report));
  } finally { input.password = ''; if (connection) await connection.end(); }
}

module.exports = { readPendingRequests, FAILURE };
if (require.main === module) main().catch(() => { process.stderr.write(FAILURE); process.exitCode = 1; });
