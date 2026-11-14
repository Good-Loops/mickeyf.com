import type { Pool, RowDataPacket } from 'mysql2/promise';

type AccountDatabase = Pick<Pool, 'query'>;
type SignupIdentity = Readonly<{ userName: string; email: string }>;

export type PasswordLoginAccount = Readonly<{
    userId: number;
    accountId: string;
    userName: string;
    passwordHash: string | null;
}>;

type LoginRow = RowDataPacket & {
    user_id: number;
    account_uuid: string;
    user_name: string;
    user_password: string | null;
};

const DATABASE_QUERY_TIMEOUT_MS = 10_000;

/** Signup preflight avoids password hashing when an identifier is already taken. */
export async function isAccountIdentifierTaken(
    database: AccountDatabase, { userName, email }: SignupIdentity,
): Promise<boolean> {
    const [rows] = await database.query<RowDataPacket[]>({
        sql: 'SELECT 1 FROM users WHERE user_name = ? OR email = ? LIMIT 1',
        timeout: DATABASE_QUERY_TIMEOUT_MS,
    }, [userName, email]);
    return rows.length > 0;
}

/** Accepts an already-hashed password; unique keys protect concurrent signups. */
export async function createPasswordAccount(
    database: AccountDatabase,
    { userName, email, passwordHash }: SignupIdentity & { passwordHash: string },
): Promise<'created' | 'duplicate'> {
    try {
        await database.query({
            sql: 'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)',
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        }, [userName, email, passwordHash]);
        return 'created';
    } catch (error) {
        if (error && typeof error === 'object' && 'errno' in error && error.errno === 1062) {
            return 'duplicate';
        }
        throw error;
    }
}

/** A null password hash identifies an account without password sign-in. */
export async function findPasswordLoginAccount(
    database: AccountDatabase, userName: string,
): Promise<PasswordLoginAccount | undefined> {
    const [rows] = await database.query<LoginRow[]>({
        sql: `SELECT user_id, account_uuid, user_name, user_password
            FROM users
            WHERE user_name = ?
            LIMIT 1`,
        timeout: DATABASE_QUERY_TIMEOUT_MS,
    }, [userName]);
    const row = rows[0];
    return row && {
        userId: row.user_id,
        accountId: row.account_uuid,
        userName: row.user_name,
        passwordHash: row.user_password,
    };
}
