import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { guardConnectionQueries } from '../db/queryTimeoutConnection';
import { assertAccountId } from './deletionJournal';
import { createPasswordAccount } from './passwordAccountRepository';
import { RegistrationRequiredError } from './registrationAuthorization';

/** Account insertion and registration/privacy evidence must commit or roll back together. */
export async function createRegisteredPasswordAccount(
    database: Pick<Pool, 'getConnection'>,
    input: Readonly<{ userName: string; email: string; passwordHash: string }>,
    consumeRegistration: (connection: PoolConnection, accountId: string) => Promise<void>,
): Promise<'created' | 'duplicate'> {
    const connection = guardConnectionQueries(await database.getConnection());
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    let reusable = true;
    const command = (sql: string) => connection.query({ sql, timeout: 10_000 });
    try {
        await command('START TRANSACTION');
        phase = 'active';
        const result = await createPasswordAccount(connection, input);
        if (result === 'duplicate') {
            phase = 'commit';
            await command('ROLLBACK');
            return result;
        }
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: 'SELECT account_uuid AS accountId FROM users WHERE user_name = ? AND email = ? LIMIT 2', timeout: 10_000,
        }, [input.userName, input.email]);
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
        assertAccountId(rows[0].accountId);
        await consumeRegistration(connection, rows[0].accountId);
        phase = 'commit';
        await command('COMMIT');
        return result;
    } catch (error) {
        if (phase !== 'active') reusable = false;
        else {
            try { await command('ROLLBACK'); } catch { reusable = false; }
        }
        if (error instanceof RegistrationRequiredError && phase === 'active' && reusable) throw error;
        throw new Error('Password account creation could not be confirmed.');
    } finally {
        if (reusable) connection.release(); else connection.destroy();
    }
}
