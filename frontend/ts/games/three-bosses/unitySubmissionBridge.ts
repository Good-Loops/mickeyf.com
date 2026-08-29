import {
    isCanonicalThreeBossesRunId,
    isValidThreeBossesCompletionTimeMs,
    LEADERBOARD_CONTRACT_VERSION,
    LeaderboardRequestError,
    THREE_BOSSES_RULES_VERSION,
    type LeaderboardClientErrorCode,
    type ThreeBossesRunSubmissionRequest,
    type ThreeBossesRunSubmissionResponse,
} from '../../services/leaderboardApi.ts';
import { THREE_BOSSES_RUN_SESSION_OBJECT } from './unityVisibility.ts';

export const THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION =
    'mickeyfThreeBossesSubmitRun' as const;
export const THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT =
    THREE_BOSSES_RUN_SESSION_OBJECT;
export const THREE_BOSSES_SUBMISSION_RESULT_METHOD =
    'ReceiveRunSubmissionResult' as const;
export const THREE_BOSSES_SUBMISSION_CONFIGURE_METHOD =
    'ConfigureRunSubmission' as const;
export const THREE_BOSSES_SUBMISSION_TIMEOUT_MS = 30_000 as const;

type ThreeBossesSubmissionBridgeCallback =
    | Readonly<{
          success: true;
          runId: string;
          response: ThreeBossesRunSubmissionResponse;
      }>
    | Readonly<{
          success: false;
          runId: string | null;
          status: number;
          error: LeaderboardClientErrorCode;
      }>;

export type ThreeBossesRunSubmitter = (
    request: ThreeBossesRunSubmissionRequest,
    signal: AbortSignal
) => Promise<ThreeBossesRunSubmissionResponse>;

export type UnitySubmissionBridgeInstance = Readonly<{
    SendMessage?: (
        gameObjectName: string,
        methodName: string,
        parameter?: string
    ) => void;
}>;

type SubmissionBridgeWindow = {
    mickeyfThreeBossesSubmitRun?: (payloadJson: string) => void;
};

type UnityRunPayload = Readonly<{
    runId: string;
    completionTimeMs: number;
}>;

type ActiveSubmission = Readonly<{
    key: string;
    controller: AbortController;
    cancelTimeout: () => void;
}>;

export function configureThreeBossesSubmission(
    instance: UnitySubmissionBridgeInstance,
    enabled: boolean,
): void {
    if (typeof instance.SendMessage !== 'function') {
        throw new Error('The Unity WebGL player is missing the required submission API.');
    }

    instance.SendMessage(
        THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
        THREE_BOSSES_SUBMISSION_CONFIGURE_METHOD,
        enabled ? '1' : '0',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUnityRunPayload(payloadJson: unknown): UnityRunPayload | null {
    if (typeof payloadJson !== 'string') return null;

    let value: unknown;
    try {
        value = JSON.parse(payloadJson);
    } catch {
        return null;
    }

    if (!isRecord(value)) return null;
    const keys = Object.keys(value).sort();
    if (
        keys.length !== 2
        || keys[0] !== 'completionTimeMs'
        || keys[1] !== 'runId'
        || !isCanonicalThreeBossesRunId(value.runId)
        || !isValidThreeBossesCompletionTimeMs(value.completionTimeMs)
    ) {
        return null;
    }

    return {
        runId: value.runId,
        completionTimeMs: value.completionTimeMs,
    };
}

function submissionKey(payload: UnityRunPayload): string {
    return `${payload.runId}\n${payload.completionTimeMs}`;
}

function requestFor(payload: UnityRunPayload): ThreeBossesRunSubmissionRequest {
    return {
        contractVersion: LEADERBOARD_CONTRACT_VERSION,
        rulesVersion: THREE_BOSSES_RULES_VERSION,
        runId: payload.runId,
        completionTimeMs: payload.completionTimeMs,
    };
}

function normalizedSubmissionError(error: unknown): Readonly<{
    status: number;
    code: LeaderboardClientErrorCode;
}> {
    if (error instanceof LeaderboardRequestError) {
        return { status: error.status, code: error.code };
    }

    return { status: 0, code: 'NETWORK_ERROR' };
}

function isUncertainOutcome(code: LeaderboardClientErrorCode): boolean {
    return code === 'NETWORK_ERROR'
        || code === 'INVALID_RESPONSE'
        || code === 'SERVER_ERROR';
}

/**
 * Owns the single browser-global submission entry point for one Unity player.
 * Unity supplies only canonical run metrics; browser authentication remains in
 * fetch-managed cookies and never crosses the SendMessage boundary.
 */
export function bindThreeBossesSubmissionBridge(
    instance: UnitySubmissionBridgeInstance,
    submitRun: ThreeBossesRunSubmitter,
    bridgeWindow: SubmissionBridgeWindow = window as unknown as SubmissionBridgeWindow,
    submissionTimeoutMs: number = THREE_BOSSES_SUBMISSION_TIMEOUT_MS,
): () => void {
    const sendMessage = instance.SendMessage;
    if (typeof sendMessage !== 'function') {
        throw new Error('The Unity WebGL player is missing the required submission callback API.');
    }
    if (bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION] !== undefined) {
        throw new Error('A Three Bosses submission bridge is already active.');
    }

    let disposed = false;
    let activeSubmission: ActiveSubmission | null = null;
    let uncertainSubmissionKey: string | null = null;

    const deliver = (callback: ThreeBossesSubmissionBridgeCallback): void => {
        if (disposed) return;
        try {
            sendMessage.call(
                instance,
                THREE_BOSSES_SUBMISSION_RECEIVER_OBJECT,
                THREE_BOSSES_SUBMISSION_RESULT_METHOD,
                JSON.stringify(callback)
            );
        } catch {
            // The player may be tearing down between fetch completion and the
            // callback. Do not turn that lifecycle race into an unhandled task.
        }
    };

    const rejectLocally = (
        runId: string | null,
        status: number,
        error: LeaderboardClientErrorCode
    ): void => {
        deliver({ success: false, runId, status, error });
    };

    const submitFromUnity = (payloadJson: string): void => {
        if (disposed) return;

        const payload = parseUnityRunPayload(payloadJson);
        if (!payload) {
            rejectLocally(null, 400, 'INVALID_RUN');
            return;
        }

        const key = submissionKey(payload);
        if (activeSubmission) {
            if (activeSubmission.key !== key) {
                rejectLocally(payload.runId, 409, 'IDEMPOTENCY_CONFLICT');
            }
            return;
        }
        if (uncertainSubmissionKey && uncertainSubmissionKey !== key) {
            rejectLocally(payload.runId, 409, 'IDEMPOTENCY_CONFLICT');
            return;
        }

        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const cancelTimeout = () => {
            if (timeoutId === null) return;
            clearTimeout(timeoutId);
            timeoutId = null;
        };
        activeSubmission = { key, controller, cancelTimeout };
        const request = requestFor(payload);
        const clearActiveSubmission = () => {
            if (activeSubmission?.controller === controller) {
                activeSubmission.cancelTimeout();
                activeSubmission = null;
            }
        };
        timeoutId = setTimeout(() => {
            if (disposed || activeSubmission?.controller !== controller) return;

            uncertainSubmissionKey = key;
            clearActiveSubmission();
            controller.abort();
            rejectLocally(payload.runId, 0, 'NETWORK_ERROR');
        }, submissionTimeoutMs);
        let submissionPromise: Promise<ThreeBossesRunSubmissionResponse>;

        try {
            submissionPromise = submitRun(request, controller.signal);
        } catch (error) {
            submissionPromise = Promise.reject(error);
        }

        void submissionPromise
            .then((response) => {
                cancelTimeout();
                if (disposed || controller.signal.aborted) return;
                clearActiveSubmission();
                uncertainSubmissionKey = null;
                deliver({ success: true, runId: payload.runId, response });
            })
            .catch((error: unknown) => {
                cancelTimeout();
                if (disposed || controller.signal.aborted) return;

                const normalized = normalizedSubmissionError(error);
                clearActiveSubmission();
                uncertainSubmissionKey = isUncertainOutcome(normalized.code) ? key : null;
                rejectLocally(payload.runId, normalized.status, normalized.code);
            })
            .finally(() => {
                clearActiveSubmission();
            });
    };

    bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION] = submitFromUnity;

    return () => {
        if (disposed) return;
        disposed = true;
        activeSubmission?.cancelTimeout();
        activeSubmission?.controller.abort();
        activeSubmission = null;
        uncertainSubmissionKey = null;

        if (bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION] === submitFromUnity) {
            delete bridgeWindow[THREE_BOSSES_SUBMISSION_BRIDGE_FUNCTION];
        }
    };
}
