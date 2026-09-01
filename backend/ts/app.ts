require('dotenv').config({
    path: require('path').resolve(__dirname, '../..', '.env'),
});

// Environment loading intentionally precedes imports whose modules construct
// configuration-dependent resources such as the database pool.
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { loadRuntimeConfig } from './config/runtimeConfig';
import { closeDatabasePool, pool, verifyDatabaseConnection } from './db/dbConfig';
import { preventSensitiveResponseCaching } from './middleware/apiResponseSecurity';
import { notFoundHandler, requestErrorHandler } from './middleware/errorHandling';
import { createAuthRouter } from './routers/authRouter';
import { createLeaderboardRouter } from './routers/leaderboardRouter';
import { createMainRouter } from './routers/mainRouter';
import { createGeneralApiRateLimiter } from './security/requestRateLimits';

const runtimeConfig = loadRuntimeConfig();
const app = express();

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
    sessionSecret: runtimeConfig.sessionSecret,
    allowedMutationOrigins: runtimeConfig.corsOrigins,
    threeBossesRunSubmissionsEnabled:
        runtimeConfig.threeBossesRunSubmissionsEnabled,
}));
// Keep this parser after the leaderboard router. That router owns its POST
// parser so a disabled Three Bosses endpoint rejects before reading a body.
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api', createMainRouter({
    sessionSecret: runtimeConfig.sessionSecret,
    isProduction: runtimeConfig.isProduction,
    p4VegaScoreSubmissionsEnabled: runtimeConfig.p4VegaScoreSubmissionsEnabled,
}));
app.use('/auth', createAuthRouter(runtimeConfig.sessionSecret, runtimeConfig.isProduction));

app.use(notFoundHandler);
app.use(requestErrorHandler);

async function startServer(): Promise<void> {
    try {
        await verifyDatabaseConnection();
        app.listen(runtimeConfig.port, () => {
            console.log('Backend listening', {
                port: runtimeConfig.port,
                p4VegaScoreSubmissions: runtimeConfig.p4VegaScoreSubmissionsEnabled
                    ? 'enabled'
                    : 'frozen',
                threeBossesRunSubmissions:
                    runtimeConfig.threeBossesRunSubmissionsEnabled
                        ? 'enabled'
                        : 'disabled',
            });
        });
    } catch (error: unknown) {
        console.error('Backend startup failed', {
            name: error instanceof Error ? error.name : 'UnknownError',
        });
        process.exitCode = 1;
        try {
            await closeDatabasePool();
        } catch {
            // Preserve the original startup failure and avoid exposing details.
        }
    }
}

void startServer();

export { app, startServer };
