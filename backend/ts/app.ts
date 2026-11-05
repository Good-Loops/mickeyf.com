import './runtime/fetchRuntime';

// The isolated launcher supplies its complete environment; loading the root
// .env afterward could reintroduce provider or cloud settings it deliberately removed.
if (!(process.env.NODE_ENV === 'development' && process.env.LUDOLUME_ISOLATED_RUNTIME === 'true')) {
    require('dotenv').config({
        path: require('path').resolve(__dirname, '../..', '.env'),
    });
}

// Environment loading intentionally precedes imports whose modules construct
// configuration-dependent resources such as the database pool.
import express from 'express';
import { createServer } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { loadRuntimeConfig } from './config/runtimeConfig';
import { registrationPolicyForCreation } from './config/registrationPolicy';
import { closeDatabasePool, pool, verifyDatabaseConnection } from './db/dbConfig';
import { preventSensitiveResponseCaching } from './middleware/apiResponseSecurity';
import { notFoundHandler, requestErrorHandler, waitForPendingHandlers } from './middleware/errorHandling';
import { runHttpServer } from './serverLifecycle';
import { createAuthRouter } from './routers/authRouter';
import { createLeaderboardRouter } from './routers/leaderboardRouter';
import { createMainRouter } from './routers/mainRouter';
import { createGeneralApiRateLimiter } from './security/requestRateLimits';
import { createGcsDeletionJournal } from './accounts/gcsDeletionJournal';
import { verifyAccountDeletionReadiness, verifyAccountSessionReadiness,
    verifyProviderAuthReadiness } from './accounts/accountDeletionReadiness';
import { verifyPasswordlessAccountSchema } from './migrations/passwordlessAccountSchema';
import { verifyAppleTokenReadiness } from './migrations/appleTokenSchema';
import { verifyAppleRevocationReadiness } from './migrations/appleRevocationSchema';
import { verifyAppleAndroidHandoffReadiness } from './migrations/appleAndroidHandoffSchema';
import { APPLE_MAINTENANCE_PATH } from './config/appleMaintenanceConfig';
import { createAppleMaintenanceRouter } from './routers/appleMaintenanceRouter';
import { runAppleMaintenance } from './accounts/runAppleTokenRevocation';
import { loadAppleRuntimeLifecycle } from './config/appleRuntimeSecrets';
import { prepareRuntimeProviderAuth } from './config/providerAuthConfig';
import { verifyLocalProviderIdentity } from './db/localProviderIdentity';
import { createLocalProviderMaintenance } from './accounts/localProviderMaintenance';
import { cleanupExpiredAccountSessions } from './auth/accountSessionRepository';

import { createRegistrationAuthorization, cleanupRegistrationAuthorizations } from './accounts/registrationAuthorization';
import { verifyRegistrationReadiness } from './migrations/registrationSchema';
import { verifyScoreParticipationReadiness } from './migrations/scoreParticipationSchema';
import { verifyParentRegistrationReadiness } from './migrations/parentRegistrationSchema';
import { cleanupParentRegistrationAttempts } from './accounts/parentRegistrationRepository';
import { verifySignedParentFormReadiness } from './migrations/signedParentFormSchema';
import { cleanupSignedParentForms } from './accounts/signedParentFormReview';
import { verifyParentFormAppleRelayReadiness } from './accounts/parentFormAppleRelayReadiness';
import { cleanupParentFormAppleRelayState, recordParentFormAppleRelayEvent,
    verifyParentFormAppleRelayWriteAccess } from './accounts/parentFormAppleRelayState';
import { loadChildActivityContinuity } from './config/childActivityContinuity';
import { createDurableChildActivity } from './accounts/durableChildActivity';
import { createGcsChildContinuityTransport } from './accounts/gcsChildContinuityTransport';
import { verifyChildActivityContinuityReadiness } from './migrations/childActivityContinuityReadiness';
import { verifyParentManagedChildActivityReadiness } from './migrations/parentManagedChildActivityReadiness';
import { loadChildInactivityDeployment } from './config/childInactivityDeployment';
import { prepareChildInactivityDeployment } from './accounts/childInactivityDeployment';
import { CHILD_WARNING_WEBHOOK_PATH } from './routers/childWarningWebhookRouter';

const runtimeConfig = loadRuntimeConfig();
const childInactivityConfig = loadChildInactivityDeployment(process.env);
let childInactivityDeployment: Awaited<ReturnType<typeof prepareChildInactivityDeployment>> | undefined;
const childContinuityConfig = loadChildActivityContinuity(process.env, runtimeConfig.childOnlineActivityEnabled);
const childContinuityTransport = childContinuityConfig ? createGcsChildContinuityTransport({
    bucket: childContinuityConfig.bucket, expectedBucket: childContinuityConfig.bucket }) : undefined;
const childActivity = childContinuityConfig && childContinuityTransport
    ? createDurableChildActivity(childContinuityConfig, childContinuityTransport) : undefined;
const creationPolicy = registrationPolicyForCreation(runtimeConfig.registrationPolicy);
const registration = createRegistrationAuthorization(pool,
    runtimeConfig.registrationAudience === 'children-included' ? runtimeConfig.registrationPolicy : creationPolicy,
    runtimeConfig.registrationAudience, !!creationPolicy, runtimeConfig.adultOnlyRegistration);
const deletionJournal = runtimeConfig.accountDeletionEnabled
    ? createGcsDeletionJournal({ bucket: runtimeConfig.journalBucket }) : undefined;
const app = express();
let providerReadiness = { googleWebLogin: false, googleWebSignup: false, appleWebLogin: false, appleWebSignup: false };
const verifyLocalTarget = runtimeConfig.localProviderRuntime
    ? () => verifyLocalProviderIdentity(pool, runtimeConfig.localProviderRuntime!) : undefined;
const loadRuntimeAppleLifecycle = () => loadAppleRuntimeLifecycle(process.env, { verifyLocalTarget });

// Cloud Run supplies one trusted proxy hop. This must be configured before any
// IP-based security middleware evaluates req.ip.
app.set('trust proxy', 1);
app.set('json escape', true);
app.disable('x-powered-by');

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'none'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
        },
    },
    // HSTS is valuable only when the service is running behind production TLS.
    strictTransportSecurity: runtimeConfig.isProduction ? undefined : false,
}));

// This endpoint accepts only a pinned workload identity, never browser cookies.
// Mount before CORS/preflight and body parsers so they cannot bypass its checks.
async function runConfiguredMaintenance(): Promise<number> {
    // Independent cleanup must still run if Apple's provider request fails.
    const [apple, sessionCleanup, registrationCleanup, parentCleanup, formCleanup, relayCleanup, inactivity] = await Promise.allSettled([
        runAppleMaintenance({ database: pool, expectedServerUuid: runtimeConfig.appleMaintenance!.expectedServerUuid,
            loadLifecycle: loadRuntimeAppleLifecycle, appleAndroidEnabled: runtimeConfig.providerAuth.appleAndroidEnabled === true }),
        cleanupExpiredAccountSessions(pool),
        cleanupRegistrationAuthorizations(pool),
        cleanupParentRegistrationAttempts(pool),
        runtimeConfig.parentRegistrationPolicy?.signedFormsEnabled ? cleanupSignedParentForms(pool) : Promise.resolve({ backlog: false }),
        runtimeConfig.parentFormRelayEnabled ? cleanupParentFormAppleRelayState(pool) : Promise.resolve({ backlog: false }),
        childInactivityDeployment ? childInactivityDeployment.runMaintenance() : Promise.resolve(0),
    ]);
    return apple.status === 'fulfilled' && apple.value === 0
        && sessionCleanup.status === 'fulfilled' && !sessionCleanup.value.backlog
        && registrationCleanup.status === 'fulfilled' && !registrationCleanup.value.backlog
        && parentCleanup.status === 'fulfilled' && !parentCleanup.value.backlog
        && formCleanup.status === 'fulfilled' && !formCleanup.value.backlog
        && relayCleanup.status === 'fulfilled' && !relayCleanup.value.backlog
        && inactivity.status === 'fulfilled' && inactivity.value === 0 ? 0 : 1;
}
app.use(APPLE_MAINTENANCE_PATH, createAppleMaintenanceRouter(runtimeConfig.appleMaintenance, runConfiguredMaintenance));
// Authenticate provider callbacks before the general body parsers; no browser session is accepted.
app.use(CHILD_WARNING_WEBHOOK_PATH, (req, res, next) => childInactivityDeployment
    ? childInactivityDeployment.receiveBrevo(req, res, next) : res.status(404).end());
const localMaintenance = runtimeConfig.localProviderRuntime?.maintenanceEnabled
    ? createLocalProviderMaintenance(runConfiguredMaintenance) : undefined;

app.use(cors({
    origin: [...runtimeConfig.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
    maxAge: 600,
}));
app.use(['/api', '/auth'], preventSensitiveResponseCaching);
app.use(cookieParser(runtimeConfig.sessionSecret));

const generalApiRateLimiter = createGeneralApiRateLimiter();
app.use(['/api', '/auth'], generalApiRateLimiter);
app.use('/api/leaderboards', createLeaderboardRouter(pool, {
    childActivity,
    scorePublicationDigest: runtimeConfig.scoreParticipationPolicy?.digest, scoreParticipationReady: true,
    sessionSecret: runtimeConfig.sessionSecret,
    allowedMutationOrigins: runtimeConfig.corsOrigins,
    threeBossesRunSubmissionsEnabled:
        runtimeConfig.threeBossesRunSubmissionsEnabled,
}));
// Keep this parser after the leaderboard router. That router owns its POST
// parser so a disabled Three Bosses endpoint rejects before reading a body.
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api', createMainRouter({
    childActivity,
    database: pool,
    scorePublicationDigest: runtimeConfig.scoreParticipationPolicy?.digest, scoreParticipationReady: true,
    registration,
    sessionSecret: runtimeConfig.sessionSecret,
    isProduction: runtimeConfig.isProduction,
    p4VegaScoreSubmissionsEnabled: runtimeConfig.p4VegaScoreSubmissionsEnabled,
    allowedMutationOrigins: runtimeConfig.corsOrigins,
}));
async function startServer(): Promise<void> {
    await runHttpServer({
        server: createServer(app),
        port: runtimeConfig.port,
        ...(runtimeConfig.localProviderRuntime ? { host: '127.0.0.1' } : {}),
        closeDatabase: async () => { await localMaintenance?.stop(); await closeDatabasePool(); },
        waitForHandlers: waitForPendingHandlers,
        prepare: async () => {
            await verifyDatabaseConnection();
            await verifyLocalTarget?.();
            await verifyAccountSessionReadiness(pool);
            await verifyRegistrationReadiness(pool);
            await verifyParentRegistrationReadiness(pool);
            if (childActivity) {
                await verifyParentManagedChildActivityReadiness(pool);
                await verifyChildActivityContinuityReadiness(pool, childContinuityConfig!);
                await childContinuityTransport!.verifyConfiguration('1012884798546');
            }
            await verifyScoreParticipationReadiness(pool);
            if (runtimeConfig.parentRegistrationPolicy?.signedFormsEnabled) await verifySignedParentFormReadiness(pool,
                runtimeConfig.parentRegistrationPolicy.audience === 'children-included' && runtimeConfig.parentRegistrationPolicy.creationEnabled === true);
            const providerAuth = await prepareRuntimeProviderAuth(runtimeConfig.providerAuth, process.env,
                { loadLifecycle: loadRuntimeAppleLifecycle });
            if (providerAuth.appleTokenLifecycle) await verifyAppleTokenReadiness(pool);
            if (runtimeConfig.providerAuth.appleNotifications) await verifyAppleRevocationReadiness(pool);
            if (runtimeConfig.parentFormRelayEnabled) {
                await verifyParentFormAppleRelayReadiness(pool);
                await verifyParentFormAppleRelayWriteAccess(pool);
            }
            if (runtimeConfig.providerAuth.appleAndroidEnabled) await verifyAppleAndroidHandoffReadiness(pool);
            if (runtimeConfig.providerAuth.signupEnabled) {
                await verifyPasswordlessAccountSchema(pool);
            }
            if (runtimeConfig.providerAuth.enabled) {
                const requiresExtendedAttempts = providerAuth.signupEnabled
                    || (runtimeConfig.accountDeletionEnabled && (providerAuth.clients['google-web'] !== undefined
                        || providerAuth.clients['apple-ios']?.deletionEnabled === true));
                await verifyProviderAuthReadiness(pool, requiresExtendedAttempts);
            }
            if (runtimeConfig.accountDeletionEnabled) {
                await verifyAccountDeletionReadiness(pool, runtimeConfig.accountIdentityEpoch!);
            }
            if (childInactivityConfig) childInactivityDeployment = await prepareChildInactivityDeployment(pool, childInactivityConfig,
                { activityConfig: childContinuityConfig, activity: childActivity, transport: childContinuityTransport });
            // Explicit local maintenance performs real queue cleanup only after all startup schema/identity gates pass.
            await localMaintenance?.start();
            const googleWeb = providerAuth.publicClients.find(client => client.clientKey === 'google-web');
            const appleWeb = providerAuth.publicClients.find(client => client.clientKey === 'apple-web');
            const appleAvailable = !localMaintenance || localMaintenance.isHealthy();
            providerReadiness = { googleWebLogin: !!googleWeb, appleWebLogin: !!appleWeb && appleAvailable,
                googleWebSignup: googleWeb?.signup === true && registration.creationEnabled,
                appleWebSignup: appleWeb?.signup === true && registration.creationEnabled && appleAvailable };
            app.use('/auth', createAuthRouter(
                pool, runtimeConfig.sessionSecret, runtimeConfig.isProduction, runtimeConfig.corsOrigins,
                { accountDeletionEnabled: runtimeConfig.accountDeletionEnabled, deletionJournal,
                    providerAuth: runtimeConfig.parentFormRelayEnabled ? { ...providerAuth,
                        appleForwardingEvents: { record: notification => recordParentFormAppleRelayEvent(pool, notification) } } : providerAuth,
                    registration,
                    childActivity, childInactivity: childInactivityDeployment?.service,
                    reconcileChildKeep: childInactivityDeployment?.reconcileChildKeep,
                    parentRegistrationStorageReady: true, parentRegistrationPolicy: runtimeConfig.parentRegistrationPolicy,
                    scoreParticipationPolicy: runtimeConfig.scoreParticipationPolicy,
                    ...(localMaintenance ? { appleIssuanceAvailable: () => localMaintenance.isHealthy() } : {}) }
            ));
            app.use(notFoundHandler);
            app.use(requestErrorHandler);
        },
        onListening: () => {
            console.log('Backend listening', {
                port: runtimeConfig.port,
                p4VegaScoreSubmissions: runtimeConfig.p4VegaScoreSubmissionsEnabled
                    ? 'enabled'
                    : 'frozen',
                threeBossesRunSubmissions:
                    runtimeConfig.threeBossesRunSubmissionsEnabled
                        ? 'enabled'
                        : 'disabled',
                accountDeletion: runtimeConfig.accountDeletionEnabled ? 'enabled' : 'disabled',
                providerAuth: runtimeConfig.providerAuth.enabled ? 'enabled' : 'disabled',
                providers: providerReadiness,
                ...(localMaintenance ? { localProviderMaintenance: localMaintenance.isHealthy() ? 'ready' : 'unavailable' } : {}),
            });
        },
    });
}

void startServer();

export { app, startServer };
