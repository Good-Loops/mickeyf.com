import type { PoolConnection } from 'mysql2/promise';

const COMMANDS = new Set<PropertyKey>(['query', 'execute', 'beginTransaction', 'commit', 'rollback']);
const activeTransactions = new WeakSet<object>();

/** Only explicitly started transactions on this application's guarded sessions qualify. */
export function assertActiveGuardedTransaction(connection: object): void {
    if (!activeTransactions.has(connection)) throw new Error('An active guarded transaction is required.');
}

/** Guard a borrowed session before helpers sanitize driver errors.
 * mysql2's query timeout rejects the promise but leaves the protocol command active;
 * discarding immediately prevents cleanup from queuing behind that stalled command.
 */
export function guardConnectionQueries(connection: PoolConnection): PoolConnection {
    let state: 'available' | 'discarded' | 'released' = 'available';
    const discard = () => {
        if (state !== 'available') return;
        state = 'discarded';
        activeTransactions.delete(guarded);
        try { connection.destroy(); }
        finally {
            // mysql2 destroy() ends the stream gracefully; a silent peer must not
            // keep the socket alive. Match the existing maintenance watchdogs.
            (connection as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
        }
    };
    const guarded = new Proxy(connection, {
        get(target, property) {
            if (property === 'destroy') return discard;
            if (property === 'release') return () => {
                if (state !== 'available') return;
                state = 'released';
                activeTransactions.delete(guarded);
                target.release();
            };
            const value = Reflect.get(target, property);
            if (COMMANDS.has(property)) return async (...args: unknown[]) => {
                if (state !== 'available') throw new Error('Database connection is no longer available.');
                const input = args[0];
                const sql = typeof input === 'string' ? input : input && typeof input === 'object' && 'sql' in input ? input.sql : '';
                const command = typeof sql === 'string' ? sql.trim().replace(/;$/u, '').toUpperCase() : '';
                const starts = property === 'beginTransaction' || /^(?:START TRANSACTION|BEGIN)$/u.test(command);
                const ends = property === 'commit' || property === 'rollback' || /^(?:COMMIT|ROLLBACK)(?:\s|$)/u.test(command);
                // Runtime writers have no DDL grants. Still clear the marker for
                // potential implicit commits instead of claiming a transaction survived.
                if (ends || /^(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|LOCK|UNLOCK|USE|SET\s+(?:SESSION\s+)?AUTOCOMMIT)\b/u.test(command)) {
                    activeTransactions.delete(guarded);
                }
                if (starts && activeTransactions.has(guarded)) throw new Error('Nested guarded transactions are not supported.');
                try {
                    const result = await Reflect.apply(value, target, args);
                    if (starts && state === 'available') activeTransactions.add(guarded);
                    return result;
                }
                catch (error) {
                    if (error !== null && typeof error === 'object' && 'code' in error
                        && error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
                        // Teardown must not replace the original failure with driver details.
                        try { discard(); } catch { /* The connection remains unavailable. */ }
                    }
                    throw error;
                }
            };
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return guarded;
}
