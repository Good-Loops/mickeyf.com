import { Pool } from 'mysql2/promise';
import type { AuthenticatedIdentity } from './requestAuthentication';
import { readLiveSession } from '../auth/accountSessionRepository';

/** A signed token proves issuance, not that its account still exists. Never cache this lookup. */
export async function readActiveAccount(database: Pick<Pool, 'query'>, identity: AuthenticatedIdentity) {
    return readLiveSession(database, identity.userId, identity.accountId, identity.sessionId);
}
