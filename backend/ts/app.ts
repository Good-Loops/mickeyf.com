require('dotenv').config({
    path: require('path').resolve(__dirname, '../..', '.env'),
});

/**
 * Express application bootstrap and composition.
 *
 * Responsibility:
 * - Constructs the Express app and composes global middleware.
 * - Mounts routers and establishes cross-cutting guarantees (parsing, cookies, security headers, CORS).
 * - Starts the HTTP server when this module is used as the runtime entrypoint.
 *
 * Non-responsibilities:
 * - Endpoint business logic (owned by controllers/services).
 * - Route surface definition (owned by routers).
 *
 * Side effects:
 * - Registers middleware and route handlers.
 * - Starts listening on a port and emits startup logs.
 *
 * Invariants:
 * - Middleware order is part of the runtime contract for all requests.
 */

/** Environment/config loading: populates `process.env` used by the bootstrap below. */
// (kept above ESM imports intentionally; do not reorder)

import express from 'express'; // Import the Express module
import cookieParser from 'cookie-parser'; // Import the cookie-parser module
import helmet from 'helmet'; // Import the Helmet module
import cors from 'cors';  // Import the CORS module
 
// Import routers
import { createMainRouter } from './routers/mainRouter'; // Import the main router factory
import { createAuthRouter } from './routers/authRouter'; // Import the auth router factory

/** Environment selector used to choose between the dev/prod API base URL env vars. */
const environment: string = process.env.NODE_ENV as string; // Determine environment

/**
 * API base URL used for security policy and CORS allow-listing.
 *
 * Environment contract:
 * - Reads `DEV_API_URL` in development and `PROD_API_URL` otherwise.
 * - Required at runtime for this module (non-null asserted).
 */
const apiUrl: string = environment === 'development' ? process.env.DEV_API_URL! : process.env.PROD_API_URL!; // Detertmine API URL

/**
 * Process-wide Express application instance.
 *
 * Ownership:
 * - Module-owned app composed once for this service process.
 */
const app = express(); // Create an Express application

/** Signed cookie parsing: ensures signed cookies are verified for downstream handlers. */
app.use(cookieParser(process.env.SESSION_SECRET)); // Use cookie parser

/** Global security headers: establishes a CSP allow-list for resource loading. */
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: [
                "'self'",
                "data:",
                "https://mickeyf.com",
                "http://localhost:5173",
                `${apiUrl!}/api/users`,
                `${apiUrl}/auth/verify-token`
            ],
            imgSrc: [
                "'self'",
                "data:",
                "https://mickeyf.com",
                "http://localhost:5173"
            ],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://mickeyf.com",
                "http://localhost:5173"
            ],
            workerSrc: [
                "'self'",
                "blob:",
                "https://mickeyf.com",
                "http://localhost:5173"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://mickeyf.com",
                "http://localhost:5173"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://mickeyf.com",
                "http://localhost:5173"
            ],
        }
    })
);

/** Global request parsing: ensures `req.body` is populated for JSON payloads. */
app.use(express.json()); // Parse JSON bodies

/** Global CORS policy: governs cross-origin access and credentialed requests. */
app.use(cors({
    origin: [ // Allowed origins
        "https://mickeyf.com",
        "https://www.mickeyf.com",
        "http://localhost:5173", 
        `${apiUrl!}/api/users`, // Allow the /api/users route to be accessed from the frontend
        `${apiUrl!}/auth/verify-token` // Allow the /auth/verify-token route to be accessed from the frontend
    ],
    credentials: true, // Allow credentials 
    methods: '*', // Allowed HTTP methods
    allowedHeaders: ['Content-Type', 'Authorization'] // Allowed headers
}));


/** Route mounting: binds core API routes under the `/api` base path. */
app.use('/api', createMainRouter()); // Main router for database-operations related routes
/** Route mounting: binds authentication routes under the `/auth` base path. */
app.use('/auth', createAuthRouter()); // Auth router for authentication related routes

/** Proxy trust policy: enables correct scheme/IP handling behind a reverse proxy. */
app.set('trust proxy', true); // Trust the first proxy

/**
 * Listener port for this service.
 *
 * Environment contract:
 * - Reads `BACKEND_PORT` (string) and coerces to number.
 * - Defaults to `8080` when unset.
 */
const port = Number(process.env.BACKEND_PORT ?? 8080);

/** Server start: starts the HTTP listener for this process using `BACKEND_PORT`/default port. */
app.listen(port, () => console.log(`Listening on ${port}`));

export { app }; // Export the Express application