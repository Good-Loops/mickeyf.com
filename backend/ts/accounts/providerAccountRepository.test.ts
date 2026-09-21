import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import type { SessionProof } from '../security/sessionPolicy';
import { createProviderAccount, findProviderAccount, linkProviderAccount, readProviderAccountMethods,
    persistProviderCredential, ProviderAccountUnavailableError, type ProviderAccount } from './providerAccountRepository';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const otherId = '123e4567-e89b-42d3-a456-426614174001';
const target = { userId: 7, accountId };
const sessionProof: SessionProof = { accountId, sessionId: Buffer.alloc(32, 7).toString('base64url') };
const password = 'existing-test-password';
const passwordHash = bcrypt.hashSync(password, 4);
// The verifier has separate signed-token tests. This fixture represents its trusted output.
const identity = { provider: 'google', subject: 'CaseSensitiveSubject' } as VerifiedProviderIdentity;

function fixture(options: {
    accountId?: string; absent?: boolean; duplicate?: { accountId: string; subject: Buffer }[];
    sessionMissing?: boolean; passwordHash?: string | null;
    returningAccount?: ProviderAccount | null; lock?: () => Promise<void>;
    fail?: 'begin' | 'session' | 'insert' | 'commit' | 'unlock'; rollbackFails?: boolean;
} = {}) {
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[]; timeout: number }> = [];
    const failure = new Error('sensitive database credentials/provider subject must not escape');
    function step(name: string) { events.push(name); if (options.fail === name) throw failure; }
    const connection = {
        async beginTransaction() { step('begin'); },
        async commit() { step('commit'); },
        async rollback() { step('rollback'); if (options.rollbackFails) throw failure; },
        release() { step('release'); }, destroy() { step('destroy'); },
        async query(query: { sql: string; timeout: number }, values: unknown[]) {
            const sql = query.sql.replace(/\s+/g, ' ').trim();
            queries.push({ ...query, sql, values });
            if (sql.includes('GET_LOCK')) { step('lock'); await options.lock?.(); return [[{ lockResult: 1 }]]; }
            if (sql.includes('RELEASE_LOCK')) { step('unlock'); return [[{ lockResult: 1 }]]; }
            if (sql.startsWith('SELECT user_password')) {
                step('password'); return [options.absent ? [] : [{ accountId: options.accountId ?? accountId,
                    passwordHash: options.passwordHash === undefined ? passwordHash : options.passwordHash }]];
            }
            if (sql.startsWith('SELECT account_uuid AS accountId FROM users')) {
                step('account'); return [options.absent ? [] : [{ accountId: options.accountId ?? accountId }]];
            }
            if (sql.includes('FROM account_provider_identities AS p')) {
                step('lookup'); return [options.returningAccount === null ? []
                    : [options.returningAccount ?? { ...target, userName: 'existing' }]];
            }
            if (sql.includes('FROM account_sessions AS s')) {
                step('session'); return [options.sessionMissing ? [] : [{ userName: 'existing' }]];
            }
            if (sql.startsWith('INSERT')) {
                step('insert'); if (options.duplicate) throw { errno: 1062, sqlMessage: 'sensitive owner details' };
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT account_uuid')) { step('existing'); return [options.duplicate]; }
            throw new Error('Unexpected query');
        },
    } as unknown as PoolConnection;
    return { events, queries, connection, database: { getConnection: async () => connection } as Pick<Pool, 'getConnection'> };
}

test('links only a password-proven matching incarnation with a live session under the existing user lock and transaction', async () => {
    const f = fixture();
    assert.equal(await linkProviderAccount(f.database, target, password, identity, sessionProof), 'linked');
    assert.deepEqual(f.events, ['lock', 'begin', 'password', 'session', 'insert', 'commit', 'unlock', 'release']);
    assert(f.queries.every(q => q.timeout === 10000 && !q.values?.includes(password)
        && !q.values?.includes(sessionProof.sessionId)));
    const session = f.queries.find(q => q.sql.includes('FROM account_sessions AS s'))!;
    const sessionHash = createHash('sha256').update(sessionProof.sessionId, 'ascii').digest();
    assert.deepEqual(session.values, [target.userId, accountId, sessionHash, sessionHash]);
    assert.match(session.sql, /s.expires_at > UTC_TIMESTAMP\(6\)/);
    const insert = f.queries.find(q => q.sql.startsWith('INSERT'))!;
    assert.deepEqual(insert.values, ['google', Buffer.from('CaseSensitiveSubject'), accountId]);
    assert(f.queries.every(q => !/email|game_personal_bests|^\s*(?:UPDATE|DELETE)\b|ON DUPLICATE/i.test(q.sql)));
});

test('wrong password, removed account and reused numeric ID never create links', async () => {
    for (const [options, suppliedPassword, expected] of [
        [{}, 'wrong-password', 'invalid-password'],
        [{ absent: true }, password, 'not-found'],
        [{ accountId: otherId }, password, 'not-found'],
    ] as const) {
        const f = fixture(options);
        assert.equal(await linkProviderAccount(f.database, target, suppliedPassword, identity, sessionProof), expected);
        assert(!f.events.includes('insert'));
    }
    for (const invalid of ['', 'x'.repeat(73), 'test\u0000password']) {
        const f = fixture();
        assert.equal(await linkProviderAccount(f.database, target, invalid, identity, sessionProof), 'invalid-password');
        assert.deepEqual(f.events, []);
    }
});

test('a missing live session cannot create or confirm an idempotent provider link', async () => {
    for (const duplicate of [undefined, [{ accountId, subject: Buffer.from(identity.subject) }]]) {
        const f = fixture({ sessionMissing: true, duplicate });
        assert.equal(await linkProviderAccount(f.database, target, password, identity, sessionProof), 'not-found');
        assert.deepEqual(f.events, ['lock', 'begin', 'password', 'session', 'commit', 'unlock', 'release']);
    }
});

test('passwordless accounts cannot prove a password for linking', async () => {
    const f = fixture({ passwordHash: null });
    assert.equal(await linkProviderAccount(f.database, target, password, identity, sessionProof), 'invalid-password');
    assert.deepEqual(f.events, ['lock', 'begin', 'password', 'commit', 'unlock', 'release']);
});

test('missing, malformed and mismatched session proofs fail before database use', async () => {
    for (const proof of [undefined, null, { accountId, sessionId: '' },
        { accountId: 'invalid', sessionId: sessionProof.sessionId }]) {
        const f = fixture();
        await assert.rejects(linkProviderAccount(f.database, target, password, identity, proof as SessionProof));
        assert.deepEqual(f.events, []);
    }
    const f = fixture();
    assert.equal(await linkProviderAccount(f.database, target, password, identity,
        { ...sessionProof, accountId: otherId }), 'not-found');
    assert.deepEqual(f.events, []);
});

test('identical retry is idempotent; competing account or another identity is never reassigned', async () => {
    for (const [owner, subject, expected] of [
        [accountId, identity.subject, 'already-linked'],
        [otherId, identity.subject, 'link-conflict'],
        [accountId, 'AnotherSubject', 'link-conflict'],
    ] as const) {
        const f = fixture({ duplicate: [{ accountId: owner, subject: Buffer.from(subject) }] });
        assert.equal(await linkProviderAccount(f.database, target, password, identity, sessionProof), expected);
        assert.deepEqual(f.events.slice(-4), ['existing', 'commit', 'unlock', 'release']);
        assert(f.queries.every(q => !q.sql.startsWith('UPDATE')));
    }
});

test('uncertain transaction or lock outcome is sanitized and never reported as a successful link', async () => {
    for (const fail of ['begin', 'session', 'insert', 'commit', 'unlock'] as const) {
        const f = fixture({ fail });
        await assert.rejects(linkProviderAccount(f.database, target, password, identity, sessionProof), error => {
            assert(error instanceof ProviderAccountUnavailableError);
            assert.doesNotMatch(String(error), /sensitive|credentials|CaseSensitiveSubject/);
            assert.equal('cause' in error, false);
            return true;
        });
        if (fail !== 'insert' && fail !== 'session') assert(f.events.includes('destroy'));
        if (fail === 'session') assert(!f.events.includes('insert'));
    }
    const rollback = fixture({ fail: 'insert', rollbackFails: true });
    await assert.rejects(linkProviderAccount(rollback.database, target, password, identity, sessionProof), ProviderAccountUnavailableError);
    assert(rollback.events.includes('destroy'));
});

test('lookup is UUID-bound and byte-exact, and returns only account identity or null', async () => {
    let seenSql = '';
    let seenValues: unknown[] = [];
    const database = { query: async (query: { sql: string }, values: unknown[]) => {
        seenSql = query.sql; seenValues = values;
        return [[{ userId: 7, userName: 'existing', accountId }]];
    } } as unknown as Pick<Pool, 'query'>;
    assert.deepEqual(await findProviderAccount(database, identity), { userId: 7, userName: 'existing', accountId });
    assert.match(seenSql, /u\.account_uuid = p\.account_uuid/);
    assert.doesNotMatch(seenSql, /email|user_password|INSERT|UPDATE/);
    assert.deepEqual(seenValues, ['google', Buffer.from(identity.subject)]);
    const absent = { query: async () => [[]] } as unknown as Pick<Pool, 'query'>;
    assert.equal(await findProviderAccount(absent, identity), null);
    const broken = { query: async () => { throw new Error('raw secret'); } } as unknown as Pick<Pool, 'query'>;
    await assert.rejects(findProviderAccount(broken, identity), ProviderAccountUnavailableError);
});

test('malformed identities and target UUIDs fail before database use', async () => {
    for (const malformed of [{ provider: 'other', subject: 'valid' }, { provider: 'google', subject: '' },
        { provider: 'apple', subject: 'Ünicode' }, { provider: 'google', subject: 'trailing ' }]) {
        const f = fixture();
        await assert.rejects(linkProviderAccount(f.database, target, password, malformed as VerifiedProviderIdentity, sessionProof));
        assert.deepEqual(f.events, []);
    }
    const f = fixture();
    await assert.rejects(linkProviderAccount(f.database, { userId: 7, accountId: 'invalid' }, password, identity, sessionProof));
    assert.deepEqual(f.events, []);
});

function signupFixture(options: {
    existing?: boolean; duplicate?: 'user' | 'identity'; fail?: string; rollbackFails?: boolean;
    commit?: () => Promise<void>;
} = {}) {
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const step = (name: string) => {
        events.push(name);
        if (options.fail === name) throw new Error('sensitive email, identity and connection details');
    };
    const account = { userId: 7, userName: 'new-player', accountId };
    const connection = {
        async beginTransaction() { step('begin'); },
        async commit() { step('commit'); await options.commit?.(); },
        async rollback() { step('rollback'); if (options.rollbackFails) throw new Error('sensitive rollback'); },
        release() { step('release'); }, destroy() { step('destroy'); },
        async query(query: { sql: string; timeout: number }, values: unknown[]) {
            const sql = query.sql.replace(/\s+/g, ' ').trim();
            assert.equal(query.timeout, 10_000);
            queries.push({ sql, values });
            if (sql.includes('INNER JOIN users')) { step('lookup'); return [options.existing ? [account] : []]; }
            if (sql.startsWith('INSERT INTO users')) {
                step('user');
                if (options.duplicate === 'user') throw { errno: 1062, sqlMessage: 'sensitive email' };
                return [{ affectedRows: 1, insertId: 7 }];
            }
            if (sql.includes('FROM users WHERE user_id')) { step('account'); return [[account]]; }
            if (sql.startsWith('INSERT INTO account_provider_identities')) {
                step('identity');
                if (options.duplicate === 'identity') throw { errno: 1062, sqlMessage: 'sensitive subject' };
                return [{ affectedRows: 1 }];
            }
            throw new Error('Unexpected signup query');
        },
    } as unknown as PoolConnection;
    const database = { async getConnection() { step('connect'); return connection; } } as Pick<Pool, 'getConnection'>;
    return { account, events, queries, connection, database };
}

const signupIdentity = { ...identity, email: '  Verified@Example.test  ' } as VerifiedProviderIdentity;

for (const provider of ['google', 'apple'] as const) {
test(`${provider} signup atomically inserts a NULL password and exact subject; only commit confirms creation`, async () => {
    const f = signupFixture();
    assert.deepEqual(await createProviderAccount(f.database, { ...signupIdentity, provider }, '  new-player  '),
        { created: true, account: f.account });
    assert.deepEqual(f.events, ['connect', 'begin', 'lookup', 'user', 'account', 'identity', 'commit', 'release']);
    assert.deepEqual(f.queries[1], {
        sql: 'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, NULL)',
        values: ['new-player', 'verified@example.test'],
    });
    assert.deepEqual(f.queries.at(-1)?.values, [provider, Buffer.from(identity.subject), accountId]);
    assert.ok(f.queries.every(query => !/UPDATE|ON DUPLICATE|WHERE.*email|account_sessions/i.test(query.sql)));
});
}

test('signup rejects invalid usernames, unverified/missing emails and unsupported identities before database use', async () => {
    const f = signupFixture();
    for (const name of ['', ' ', 'x'.repeat(65), 'bad\u0000name', null]) {
        assert.deepEqual(await createProviderAccount(f.database, signupIdentity, name as string),
            { created: false, reason: 'INVALID_USERNAME' });
    }
    for (const email of [undefined, null, '', 'not-an-email', 'x'.repeat(250) + '@example.test', 'bad\u0000@example.test']) {
        assert.deepEqual(await createProviderAccount(f.database, { ...identity, email } as VerifiedProviderIdentity, 'new-player'),
            { created: false, reason: 'INVALID_EMAIL' });
    }
    await assert.rejects(createProviderAccount(f.database,
        { ...signupIdentity, provider: 'other' } as unknown as VerifiedProviderIdentity, 'new-player'), TypeError);
    assert.deepEqual(f.events, []);
});

test('signup never reassigns an existing subject or leaves an inserted user on username/email/identity collision', async () => {
    for (const [options, reason] of [
        [{ existing: true }, 'ALREADY_LINKED'], [{ duplicate: 'user' }, 'DUPLICATE_USER'],
        [{ duplicate: 'identity' }, 'ALREADY_LINKED'],
    ] as const) {
        const f = signupFixture(options);
        assert.deepEqual(await createProviderAccount(f.database, signupIdentity, 'new-player'), { created: false, reason });
        assert.deepEqual(f.events.slice(-2), ['rollback', 'release']);
        assert.equal(f.events.includes('commit'), false);
        if ('existing' in options) assert.equal(f.events.includes('user'), false);
    }
});

test('signup uncertain begin/commit, write failures and rollback failure are sanitized, never success', async () => {
    for (const fail of ['connect', 'begin', 'lookup', 'user', 'account', 'identity', 'commit', 'release']) {
        const f = signupFixture({ fail });
        await assert.rejects(createProviderAccount(f.database, signupIdentity, 'new-player'), error => {
            assert.ok(error instanceof ProviderAccountUnavailableError);
            assert.equal('cause' in error, false);
            assert.doesNotMatch(String(error), /sensitive|email|subject|connection/);
            return true;
        });
        if (fail === 'begin' || fail === 'commit') assert.ok(f.events.includes('destroy'));
    }
    const rollback = signupFixture({ duplicate: 'identity', rollbackFails: true });
    await assert.rejects(createProviderAccount(rollback.database, signupIdentity, 'new-player'), ProviderAccountUnavailableError);
    assert.ok(rollback.events.includes('destroy'));
    assert.equal(rollback.events.includes('release'), false);
});

test('signup does not report creation until the database acknowledges commit', async () => {
    let acknowledge!: () => void;
    let started!: () => void;
    const commitStarted = new Promise<void>(resolve => { started = resolve; });
    const commitPending = new Promise<void>(resolve => { acknowledge = resolve; });
    const f = signupFixture({ commit: async () => { started(); await commitPending; } });
    let finished = false;
    const creation = createProviderAccount(f.database, signupIdentity, 'new-player').then(result => { finished = true; return result; });
    await commitStarted;
    assert.equal(finished, false);
    acknowledge();
    assert.equal((await creation).created, true);
});

test('signup writes credentials on the same connection after identity creation and rolls everything back if that write fails', async () => {
    for (const fail of [false, true]) {
        const f = signupFixture();
        const creation = createProviderAccount(f.database, { ...signupIdentity, provider: 'apple' }, 'new-player',
            async (connection, createdAccount) => {
                assert.equal(connection, f.connection);
                assert.deepEqual(createdAccount, f.account);
                assert.deepEqual(f.events, ['connect', 'begin', 'lookup', 'user', 'account', 'identity']);
                f.events.push('credential');
                if (fail) throw new Error('private refresh token and encryption details');
            });
        if (fail) {
            await assert.rejects(creation, ProviderAccountUnavailableError);
            assert.deepEqual(f.events.slice(-3), ['credential', 'rollback', 'release']);
            assert.equal(f.events.includes('commit'), false);
        } else {
            assert.deepEqual(await creation, { created: true, account: f.account });
            assert.deepEqual(f.events.slice(-3), ['credential', 'commit', 'release']);
        }
    }
    for (const options of [{ existing: true }, { duplicate: 'user' as const }, { duplicate: 'identity' as const }]) {
        const f = signupFixture(options);
        const result = await createProviderAccount(f.database, { ...signupIdentity, provider: 'apple' }, 'new-player',
            async () => { assert.fail('a failed account insert cannot save credentials'); });
        assert.equal(result.created, false);
        assert.equal(f.events.includes('commit'), false);
    }
});

test('linking saves credentials only after exact ownership and live-session proof, in the same rollback boundary', async () => {
    const appleIdentity = { ...identity, provider: 'apple' as const };
    for (const duplicate of [undefined, [{ accountId, subject: Buffer.from(identity.subject) }]]) {
        for (const fail of [false, true]) {
            const f = fixture({ duplicate });
            const linking = linkProviderAccount(f.database, target, password, appleIdentity, sessionProof,
                async (connection, linkedAccount) => {
                    assert.equal(connection, f.connection);
                    assert.deepEqual(linkedAccount, target);
                    assert.deepEqual(f.events, ['lock', 'begin', 'password', 'session', 'insert', ...(duplicate ? ['existing'] : [])]);
                    f.events.push('credential');
                    if (fail) throw new Error('private provider credential');
                });
            if (fail) {
                await assert.rejects(linking, ProviderAccountUnavailableError);
                assert.deepEqual(f.events.slice(-4), ['credential', 'rollback', 'unlock', 'release']);
                assert.equal(f.events.includes('commit'), false);
            } else {
                assert.equal(await linking, duplicate ? 'already-linked' : 'linked');
                assert.deepEqual(f.events.slice(-4), ['credential', 'commit', 'unlock', 'release']);
            }
        }
    }
    for (const options of [{ absent: true }, { sessionMissing: true }, { passwordHash: null },
        { duplicate: [{ accountId: otherId, subject: Buffer.from(identity.subject) }] }]) {
        const f = fixture(options);
        const result = await linkProviderAccount(f.database, target, password, appleIdentity, sessionProof,
            async () => { assert.fail('missing authentication or another owner cannot save credentials'); });
        assert.ok(['not-found', 'invalid-password', 'link-conflict'].includes(result));
    }
});

test('returning-login credentials are saved only under the deletion lock for the same incarnation and exact subject', async () => {
    const f = fixture();
    await persistProviderCredential(f.database, target, { ...identity, provider: 'apple' }, async (connection, matched) => {
        assert.equal(connection, f.connection);
        assert.deepEqual(matched, target);
        assert.deepEqual(f.events, ['lock', 'begin', 'account', 'lookup']);
        f.events.push('credential');
    });
    assert.deepEqual(f.events, ['lock', 'begin', 'account', 'lookup', 'credential', 'commit', 'unlock', 'release']);
    assert.match(f.queries.find(query => query.sql.includes('FROM users WHERE'))!.sql, /FOR UPDATE$/);
    const lookup = f.queries.find(query => query.sql.includes('INNER JOIN users'))!;
    assert.deepEqual(lookup.values, ['apple', Buffer.from(identity.subject)]);
    assert.match(lookup.sql, /u\.account_uuid = p\.account_uuid/);
    assert.ok(f.queries.every(query => !/email|INSERT INTO users/i.test(query.sql)));
    for (const options of [{ absent: true }, { accountId: otherId }, { returningAccount: null },
        { returningAccount: { userId: target.userId, accountId: otherId, userName: 'other' } },
        { returningAccount: { userId: target.userId + 1, accountId, userName: 'other' } }]) {
        const missing = fixture(options);
        await assert.rejects(persistProviderCredential(missing.database, target, identity,
            async () => { missing.events.push('unexpected-credential'); }), ProviderAccountUnavailableError);
        assert.equal(missing.events.includes('unexpected-credential'), false);
        assert.equal(missing.events.includes('commit'), false);
        assert.deepEqual(missing.events.slice(-3), ['rollback', 'unlock', 'release']);
    }
});

test('deletion while returning-login credential persistence waits for the user lock prevents any credential write', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const options = { absent: false, lock: () => pending };
    const f = fixture(options);
    const saving = persistProviderCredential(f.database, target, identity,
        async () => { f.events.push('unexpected-credential'); });
    const rejected = assert.rejects(saving, ProviderAccountUnavailableError);
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(f.events, ['lock']);
        options.absent = true;
        release();
        await rejected;
        assert.equal(f.events.includes('unexpected-credential'), false);
        assert.equal(f.events.includes('commit'), false);
    } finally { release(); }
});

test('returning-login persistence captures its account and verified identity before awaiting the shared lock', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ lock: () => pending });
    const mutableTarget = { ...target };
    const mutableIdentity = { ...identity };
    const saving = persistProviderCredential(f.database, mutableTarget, mutableIdentity, async (_connection, captured) => {
        assert.deepEqual(captured, target);
        f.events.push('credential');
    });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        mutableTarget.userId = 99;
        mutableTarget.accountId = otherId;
        mutableIdentity.subject = 'ReplacementSubject';
        mutableIdentity.provider = 'apple';
        release();
        await saving;
        assert.deepEqual(f.queries.find(query => query.sql.includes('FROM users WHERE'))!.values, [target.userId]);
        assert.deepEqual(f.queries.find(query => query.sql.includes('INNER JOIN users'))!.values,
            ['google', Buffer.from(identity.subject)]);
    } finally { release(); }
});

test('returning-login persistence never confirms an unacknowledged credential write or commit', async () => {
    for (const fail of ['credential', 'commit'] as const) {
        const f = fixture(fail === 'commit' ? { fail } : {});
        await assert.rejects(persistProviderCredential(f.database, target, identity, async () => {
            f.events.push('credential');
            if (fail === 'credential') throw new Error('private token write failure');
        }), error => {
            assert.ok(error instanceof ProviderAccountUnavailableError);
            assert.equal('cause' in error, false);
            assert.doesNotMatch(String(error), /private|token/);
            return true;
        });
        assert.ok(f.events.includes('rollback'));
        if (fail === 'credential') assert.equal(f.events.includes('commit'), false);
        else assert.ok(f.events.includes('destroy'));
    }
});

test('account methods are UUID-scoped booleans, without exposing hashes, email or provider subjects', async () => {
    for (const [hasPassword, googleLinked, appleLinked] of [[0, 1, 0], [1, 0, 0], [1, 1, 1], [0, 0, 1], [0, 0, 0]]) {
        const database = { async query(query: { sql: string; timeout: number }, values: unknown[]) {
            assert.equal(query.timeout, 10_000);
            assert.doesNotMatch(query.sql, /email|subject|passwordHash/);
            if (query.sql.includes('FROM users')) {
                assert.deepEqual(values, [accountId]);
                assert.match(query.sql, /WHERE u\.account_uuid = \? LIMIT 2/);
                assert.match(query.sql, /user_password IS NOT NULL/);
                return [[{ hasPassword }]];
            }
            assert.deepEqual(values, [accountId, accountId]);
            assert.match(query.sql, /FROM account_provider_identities\s+WHERE account_uuid = \?/);
            return [[{ googleLinked, appleLinked }]];
        } } as unknown as Pick<Pool, 'query'>;
        assert.deepEqual(await readProviderAccountMethods(database, accountId),
            { hasPassword: hasPassword === 1, googleLinked: googleLinked === 1, appleLinked: appleLinked === 1 });
    }
    for (const row of [{ hasPassword: null, googleLinked: 1, appleLinked: 0 },
        { hasPassword: 0, googleLinked: '1', appleLinked: 0 }, { hasPassword: 0, googleLinked: 0, appleLinked: '1' }]) {
        const database = { query: async () => [[row]] } as unknown as Pick<Pool, 'query'>;
        await assert.rejects(readProviderAccountMethods(database, accountId), ProviderAccountUnavailableError);
    }
    assert.equal(await readProviderAccountMethods({ query: async () => [[]] } as unknown as Pick<Pool, 'query'>, accountId), null);
});

test('legacy password metadata tolerates only the confirmed missing provider table when explicitly allowed', async () => {
    const missing = { errno: 1146, code: 'ER_NO_SUCH_TABLE', sqlMessage: 'private schema details' };
    function metadataDatabase(hasPassword: unknown, failure: unknown = missing, failUserRead = false) {
        return { async query(query: { sql: string }) {
            if (query.sql.includes('FROM users')) {
                if (failUserRead) throw failure;
                return [[{ hasPassword }]];
            }
            throw failure;
        } } as unknown as Pick<Pool, 'query'>;
    }
    assert.deepEqual(await readProviderAccountMethods(metadataDatabase(1), accountId, { allowMissingProviderTable: true }),
        { hasPassword: true, googleLinked: false, appleLinked: false });
    await assert.rejects(readProviderAccountMethods(metadataDatabase(1), accountId), ProviderAccountUnavailableError);
    for (const hasPassword of [0, null, '1']) {
        await assert.rejects(readProviderAccountMethods(metadataDatabase(hasPassword), accountId,
            { allowMissingProviderTable: true }), ProviderAccountUnavailableError);
    }
    for (const error of [{ errno: 1146 }, { code: 'ER_NO_SUCH_TABLE' }, { errno: 1142, code: 'ER_TABLEACCESS_DENIED_ERROR' },
        { errno: 1054, code: 'ER_BAD_FIELD_ERROR' }, new Error('network error'), null]) {
        await assert.rejects(readProviderAccountMethods(metadataDatabase(1, error), accountId,
            { allowMissingProviderTable: true }), ProviderAccountUnavailableError);
    }
    await assert.rejects(readProviderAccountMethods(metadataDatabase(1, missing, true), accountId,
        { allowMissingProviderTable: true }), ProviderAccountUnavailableError);
});
