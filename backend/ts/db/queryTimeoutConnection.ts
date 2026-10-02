import type { PoolConnection } from 'mysql2/promise';

const COMMANDS = new Set<PropertyKey>(['query', 'execute', 'beginTransaction', 'commit', 'rollback']);

/** Guard a borrowed session before helpers sanitize driver errors.
 * mysql2's query timeout rejects the promise but leaves the protocol command active;
 * discarding immediately prevents cleanup from queuing behind that stalled command.
 */
export function guardConnectionQueries(connection: PoolConnection): PoolConnection {
    let state: 'available' | 'discarded' | 'released' = 'available';
    const discard = () => {
        if (state !== 'available') return;
        state = 'discarded';
        try { connection.destroy(); }
        finally {
            // mysql2 destroy() ends the stream gracefully; a silent peer must not
            // keep the socket alive. Match the existing maintenance watchdogs.
            (connection as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
        }
    };
    return new Proxy(connection, {
        get(target, property) {
            if (property === 'destroy') return discard;
            if (property === 'release') return () => {
                if (state !== 'available') return;
                state = 'released';
                target.release();
            };
            const value = Reflect.get(target, property);
            if (COMMANDS.has(property)) return async (...args: unknown[]) => {
                if (state !== 'available') throw new Error('Database connection is no longer available.');
                try { return await Reflect.apply(value, target, args); }
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
}
