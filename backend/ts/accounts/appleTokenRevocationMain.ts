import { runAppleTokenRevocation } from './runAppleTokenRevocation';

// Dedicated compiled job, never imported by the HTTP server. Hard exit after
// bounded shutdown prevents an uncertain driver socket from keeping it alive.
void runAppleTokenRevocation(process.argv.slice(2)).then(
    code => process.exit(code),
    () => process.exit(1),
);
