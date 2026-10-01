/**
 * Auth router: mounts authentication endpoints and composes middleware + controller handlers.
 *
 * Responsibility:
 * - Defines the auth route surface (paths + HTTP methods) and binds them to controller handlers.
 * - Establishes per-route middleware ordering guarantees where applicable.
 *
 * Non-responsibilities:
 * - Implementing auth business logic and request processing (owned by controllers/services).
 * - Application-wide middleware configuration (owned by app bootstrap).
 *
 * Invariants:
 * - Route path + method pairs form a stable external contract.
 */
import { Router } from 'express';
import { createAuthController } from '../controllers/authController';
import { createSessionRenewalController } from '../controllers/sessionRenewalController';
import { Pool } from 'mysql2/promise';
import { createAccountDeletionController } from '../controllers/accountDeletionController';
import type { AccountDeletionJournal } from '../accounts/deletionJournal';
import { asyncHandler } from '../middleware/errorHandling';
import { createAccountDeletionRateLimiters, createSessionRenewalRateLimiter } from '../security/requestRateLimits';

import { createLogoutHandler } from './authRouter.handlers';
import { createProviderAuthRouter } from './providerAuthRouter';
import type { ProviderAuthClient } from '../auth/providerAuthFlow';
import type { PublicProviderAuthClient } from '../config/providerAuthConfig';
import type { AppleTokenLifecycle } from '../config/appleTokenConfig';
import type { AppleNotificationVerifier } from '../auth/appleNotificationVerifier';
import { applyAppleNotification } from '../auth/appleSessionRevocation';
import { createAppleNotificationRouter } from './appleNotificationRouter';
import { createAppleTokenRevocationWorker } from '../accounts/appleTokenRevocation';
import { createRegistrationAuthorization, type RegistrationAuthorization } from '../accounts/registrationAuthorization';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createRegistrationRouter } from './registrationRouter';
import { createParentRegistrationFlow, type ParentRegistrationPolicy } from '../accounts/parentRegistrationFlow';
import { assertNoManagedChildren, createParentRegistrationRepository } from '../accounts/parentRegistrationRepository';
import { createParentRegistrationRouter } from './parentRegistrationRouter';

export { authRoutesContract } from './authRouter.contract';

export function createAuthRouter(
    database: Pick<Pool, 'query' | 'getConnection'>,
    sessionSecret: string,
    isProduction: boolean,
    allowedMutationOrigins: readonly string[],
    { accountDeletionEnabled = false, deletionJournal, providerAuth, registration = createRegistrationAuthorization(database),
        parentRegistrationStorageReady = false, parentRegistrationPolicy }: {
        parentRegistrationStorageReady?: boolean;
        parentRegistrationPolicy?: ParentRegistrationPolicy;
        registration?: RegistrationAuthorization;
        accountDeletionEnabled?: boolean;
        deletionJournal?: AccountDeletionJournal;
        providerAuth?: {
            enabled: boolean;
            signupEnabled?: boolean;
            clients: Readonly<Record<string, ProviderAuthClient>>;
            publicClients?: readonly PublicProviderAuthClient[];
            appleTokenLifecycle?: AppleTokenLifecycle;
            appleNotifications?: AppleNotificationVerifier;
        };
    } = {}
): Router {
    /**
     * Configured Express router for authentication routes.
     *
     * Ownership:
     * - Exports a fully-mounted router; mounting location (base path) is owned by the app bootstrap.
     *
     * Side effects:
     * - None beyond Express route registration.
     */
    const router: Router = Router();
    const beforeAccountDeletion = parentRegistrationStorageReady ? assertNoManagedChildren : undefined;
    if (parentRegistrationPolicy && (!parentRegistrationStorageReady || !deletionJournal || !providerAuth?.enabled)) {
        throw new Error('Parent registration dependencies are not ready.');
    }
    if (parentRegistrationStorageReady && deletionJournal) {
        router.use('/parent-registration', createParentRegistrationRouter(createParentRegistrationFlow({
            policy: parentRegistrationPolicy, clients: providerAuth?.clients ?? {},
            store: createParentRegistrationRepository(database, deletionJournal),
        }), createProviderAuthContextReader({ database, sessionSecret, allowedOrigins: allowedMutationOrigins })));
    } else router.get('/parent-registration/config', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store'); return res.json({ enabled: false });
    });
    router.use('/registration', createRegistrationRouter(registration,
        createProviderAuthContextReader({ database, sessionSecret, allowedOrigins: allowedMutationOrigins }), isProduction));
    const appleLifecycle = providerAuth?.appleTokenLifecycle;
    const appleAccountRevocation = appleLifecycle ? createAppleTokenRevocationWorker({
        database, clientId: appleLifecycle.clientId,
        vault: appleLifecycle.repository, appleTokens: appleLifecycle.client,
        additionalClients: appleLifecycle.web ? [{ clientId: appleLifecycle.web.clientId,
            vault: appleLifecycle.web.repository, appleTokens: appleLifecycle.web.client }] : [],
    }) : undefined;
    router.use('/providers/apple-notifications', createAppleNotificationRouter(providerAuth?.appleNotifications,
        notification => applyAppleNotification(database, notification)));

    // Only public identifiers are exposed, never verifier configuration or credentials.
    router.get('/providers/config', (_request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.json({ clients: providerAuth?.enabled ? (providerAuth.publicClients ?? []).map(({ signup, ...client }) => ({ ...client,
            ...(signup === true && registration.policy !== undefined ? { signup: true } : {}) })) : [] });
    });

    router.use('/providers', createProviderAuthRouter({
        database, sessionSecret, isProduction, allowedOrigins: allowedMutationOrigins,
        clients: providerAuth?.clients ?? {}, enabled: providerAuth?.enabled === true,
        signupEnabled: providerAuth?.signupEnabled, accountDeletionEnabled, deletionJournal,
        appleTokenRepository: providerAuth?.appleTokenLifecycle?.repository,
        appleTokenRepositories: appleLifecycle ? Object.freeze({ [appleLifecycle.clientId]: appleLifecycle.repository,
            ...(appleLifecycle.web ? { [appleLifecycle.web.clientId]: appleLifecycle.web.repository } : {}) }) : undefined,
        appleAccountRevocation, registration, beforeAccountDeletion,
    }));

    /** GET /verify-token — validates auth context for the current request. */
    router.get('/verify-token', asyncHandler(createAuthController(database, sessionSecret)));

    router.post('/renew', createSessionRenewalRateLimiter(), asyncHandler(createSessionRenewalController({
        database, sessionSecret, isProduction, allowedOrigins: allowedMutationOrigins,
    })));

    router.post('/delete-account', ...createAccountDeletionRateLimiters(sessionSecret),
        asyncHandler(createAccountDeletionController({
            database, sessionSecret, isProduction, allowedMutationOrigins,
            accountDeletionEnabled,
            deletionJournal,
            appleAccountRevocation,
            beforeAccountDeletion,
        })));

    /** POST /logout — revokes this device's session before clearing its cookies. */
    router.post('/logout', asyncHandler(createLogoutHandler(database, sessionSecret, isProduction, allowedMutationOrigins)));

    return router;
}
