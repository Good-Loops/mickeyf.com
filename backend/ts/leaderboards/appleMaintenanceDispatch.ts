import { APPLE_MAINTENANCE_AUDIENCE, APPLE_MAINTENANCE_URL } from '../config/appleMaintenanceConfig';

export const APPLE_MAINTENANCE_DISPATCH_DURATION_MS = 110_000;
const METADATA_DURATION_MS = 5_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity'
    + `?audience=${encodeURIComponent(APPLE_MAINTENANCE_AUDIENCE)}&format=full`;
type Environment = Readonly<Record<string, string | undefined>>;
type FailureReason = 'configuration' | 'metadata' | 'dispatch' | 'deadline';
export type AppleMaintenanceDispatchResult = Readonly<{
    status: 'disabled' | 'completed' | 'failed';
    reason?: FailureReason;
}>;
type Dependencies = Readonly<{
    fetch?: typeof fetch;
    writeEvent?: (event: Record<string, unknown>) => void;
    metadataDurationMs?: number;
    durationMs?: number;
}>;

class DispatchError extends Error {
    constructor(readonly reason: FailureReason) { super(reason); }
}

function boundedDuration(value: number | undefined, maximum: number): number {
    if (value === undefined) return maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new DispatchError('configuration');
    }
    return value;
}

function ensureActive(signal: AbortSignal): void {
    if (signal.aborted) throw new DispatchError('deadline');
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
    ensureActive(signal);
    if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        throw new Error('Invalid response size.');
    }
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            ensureActive(signal);
            const part = await reader.read();
            ensureActive(signal);
            if (part.done) return Buffer.concat(chunks).toString('utf8');
            size += part.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw new Error('Invalid response size.');
            chunks.push(part.value);
        }
    } finally {
        // Never wait for a remote body to acknowledge cancellation.
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}

async function withDeadline<T>(
    operation: () => Promise<T>, controller: AbortController, durationMs: number
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        ensureActive(controller.signal);
        return await Promise.race([
            operation(),
            new Promise<never>((_, reject) => {
                onAbort = () => reject(new DispatchError('deadline'));
                controller.signal.addEventListener('abort', onAbort, { once: true });
                timer = setTimeout(() => {
                    controller.abort();
                    reject(new DispatchError('deadline'));
                }, durationMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
}

/** Uses only the job's attached identity; never loads a key, ADC or an env URL. */
export async function dispatchAppleMaintenance(
    env: Environment = process.env, dependencies: Dependencies = {}
): Promise<AppleMaintenanceDispatchResult> {
    const writeEvent = dependencies.writeEvent ?? ((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
    });
    const finish = (result: AppleMaintenanceDispatchResult) => {
        writeEvent({ component: 'apple-maintenance-dispatch',
            severity: result.status === 'failed' ? 'ERROR' : 'INFO', ...result });
        return result;
    };
    if (env.APPLE_MAINTENANCE_DISPATCH_ENABLED !== 'true') return finish({ status: 'disabled' });
    let stage: FailureReason = 'configuration';
    const controller = new AbortController();
    try {
        if (env.NODE_ENV !== 'production' || env.CLOUD_RUN_JOB !== 'mickeyf-submission-receipt-cleanup'
            || (env.LUDOLUME_ISOLATED_RUNTIME !== undefined && env.LUDOLUME_ISOLATED_RUNTIME !== 'false')) {
            throw new DispatchError('configuration');
        }
        const durationMs = boundedDuration(dependencies.durationMs, APPLE_MAINTENANCE_DISPATCH_DURATION_MS);
        const metadataDurationMs = boundedDuration(dependencies.metadataDurationMs, METADATA_DURATION_MS);
        const request = dependencies.fetch ?? fetch;
        await withDeadline(async () => {
            stage = 'metadata';
            const token = await withDeadline(async () => {
                const response = await request(METADATA_IDENTITY_URL, {
                    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: controller.signal,
                });
                ensureActive(controller.signal);
                if (response.status !== 200 || response.headers.get('metadata-flavor') !== 'Google') {
                    throw new DispatchError('metadata');
                }
                const value = (await readBoundedText(response, controller.signal)).trim();
                if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
                    throw new DispatchError('metadata');
                }
                return value;
            }, controller, metadataDurationMs);
            ensureActive(controller.signal);
            stage = 'dispatch';
            const response = await request(APPLE_MAINTENANCE_URL, {
                method: 'POST', body: '', headers: { Authorization: `Bearer ${token}` },
                redirect: 'error', signal: controller.signal,
            });
            ensureActive(controller.signal);
            if (response.status !== 200
                || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
                throw new DispatchError('dispatch');
            }
            const result: unknown = JSON.parse(await readBoundedText(response, controller.signal));
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).length !== 1 || !('completed' in result) || result.completed !== true) {
                throw new DispatchError('dispatch');
            }
        }, controller, durationMs);
        return finish({ status: 'completed' });
    } catch (error) {
        return finish({ status: 'failed', reason: error instanceof DispatchError ? error.reason : stage });
    } finally {
        controller.abort();
    }
}
