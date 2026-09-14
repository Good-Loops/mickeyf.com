import { Request, Response } from 'express';
import { Pool } from 'mysql2/promise';
import { AccountDeletionPendingError, deleteAccount } from '../accounts/accountDeletionRepository';
import type { AccountDeletionJournal } from '../accounts/deletionJournal';
import { hasAllowedMutationOrigin, isJsonMutationRequest } from '../security/mutationRequest';
import { authenticateRequest } from '../security/requestAuthentication';
import { clearAuthenticationCookies } from '../security/sessionCookie';
import { isRecord, validateLoginRequest } from '../security/userRequestValidation';

type AccountDeletionDependencies = {
    database: Pick<Pool, 'getConnection'>;
    sessionSecret: string;
    isProduction: boolean;
    allowedMutationOrigins: readonly string[];
    accountDeletionEnabled?: boolean;
    deletionJournal?: AccountDeletionJournal;
};

export function createAccountDeletionController({
    database, sessionSecret, isProduction, allowedMutationOrigins,
    accountDeletionEnabled = false,
    deletionJournal,
}: AccountDeletionDependencies) {
    return async function deleteCurrentAccount(req: Request, res: Response) {
        // Keep destructive account operations unavailable until recovery protection
        // and the separately approved production rollout are ready.
        if (!accountDeletionEnabled || !deletionJournal) {
            return res.status(503).json({ error: 'ACCOUNT_DELETION_UNAVAILABLE' });
        }
        const authentication = authenticateRequest(req, sessionSecret);
        if (!authentication.authenticated) {
            return res.status(401).json({ error: 'UNAUTHENTICATED' });
        }
        if (!hasAllowedMutationOrigin(req, allowedMutationOrigins)) {
            return res.status(403).json({ error: 'INVALID_REQUEST' });
        }
        const body: unknown = req.body;
        if (!isJsonMutationRequest(req) || !isRecord(body)
            || Object.keys(body).length !== 2 || body.confirmation !== 'DELETE') {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        // Use the login password rules, including support for existing short passwords.
        const validation = validateLoginRequest({
            user_name: authentication.identity.userName,
            user_password: body.password,
        });
        if (!validation.valid) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }

        try {
            // Ownership comes exclusively from the verified token, never the request body.
            const result = await deleteAccount(
                database, authentication.identity.userId, validation.input.password, deletionJournal, authentication.identity
            );
            if (result === 'invalid-password') {
                return res.status(403).json({ error: 'INVALID_PASSWORD' });
            }
            clearAuthenticationCookies(res, isProduction);
            if (result === 'not-found') {
                return res.status(401).json({ error: 'UNAUTHENTICATED' });
            }
            return res.json({ deleted: true });
        } catch (error) {
            if (error instanceof AccountDeletionPendingError) {
                console.error('Account deletion pending reconciliation');
                return res.status(503).json({ error: 'ACCOUNT_DELETION_PENDING' });
            }
            // A lost commit acknowledgement is uncertain, not proof of success or rollback.
            // Never log credentials or raw SQL errors.
            console.error('Account deletion unavailable');
            return res.status(503).json({ error: 'ACCOUNT_DELETION_UNAVAILABLE' });
        }
    };
}
