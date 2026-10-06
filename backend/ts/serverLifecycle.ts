import { once } from 'node:events';
import type { Server } from 'node:http';

type StopSignal = 'SIGINT' | 'SIGTERM';
type ProcessControl = {
    on(signal: StopSignal, listener: () => void): unknown;
    off(signal: StopSignal, listener: () => void): unknown;
    exit(code: number): void;
};

type ServerLifecycleOptions = {
    server: Server;
    port: number;
    prepare(): Promise<void>;
    closeDatabase(): Promise<void>;
    waitForHandlers(): Promise<void>;
    onListening(): void;
    processControl?: ProcessControl;
    shutdownTimeoutMs?: number;
};

/** Owns the HTTP listener and ordered teardown, not routes or database policy. */
export async function runHttpServer({ server, port, prepare, closeDatabase,
    waitForHandlers, onListening, processControl = process,
    // Cloud Run allows ten seconds after SIGTERM; leave time for process exit.
    shutdownTimeoutMs = 9_000 }: ServerLifecycleOptions): Promise<void> {
    let stopping = false;
    let listening = false;
    let finished = false;
    let exitCode = 0;
    let shutdown: Promise<void> | undefined;

    const stopSignal = () => { void stop(); };
    const serverError = () => {
        // During bind, events.once forwards the error to startup's catch below.
        if (!listening) return;
        console.error('Backend listener failed');
        exitCode = 1;
        void stop();
    };
    server.on('error', serverError);
    processControl.on('SIGTERM', stopSignal);
    processControl.on('SIGINT', stopSignal);

    const startup = Promise.resolve().then(prepare).then(async () => {
        if (stopping) return;
        const ready = once(server, 'listening');
        server.listen(port);
        await ready;
        listening = true;
        if (!stopping) onListening();
    }).catch(() => {
        console.error('Backend startup failed');
        exitCode = 1;
    });

    function finish(code: number) {
        if (finished) return;
        finished = true;
        processControl.off('SIGTERM', stopSignal);
        processControl.off('SIGINT', stopSignal);
        server.off('error', serverError);
        processControl.exit(code);
    }

    function stop(): Promise<void> {
        stopping = true;
        if (shutdown) return shutdown;
        shutdown = Promise.resolve().then(async () => {
            const deadline = setTimeout(() => {
                console.error('Backend shutdown timed out');
                server.closeAllConnections();
                finish(1);
            }, shutdownTimeoutMs);
            try {
                // A stop during readiness must not close the pool underneath it.
                await startup;
                if (finished) return;
                if (server.listening) {
                    await new Promise<void>((resolve, reject) => {
                        server.close(error => error ? reject(error) : resolve());
                    });
                }
                // Disconnected sockets can still have asynchronous SQL/provider work.
                await waitForHandlers();
                if (finished) return;
                await closeDatabase();
            } catch {
                console.error('Backend shutdown failed');
                exitCode = 1;
            } finally {
                clearTimeout(deadline);
                finish(exitCode);
            }
        });
        return shutdown;
    }

    await startup;
    if (exitCode !== 0) await stop();
}
