/** Presentation-only bridge. Native phones start in portrait before JavaScript loads. */
export type PresentationCommand = Readonly<{ active: boolean; sessionId: string; revision: number }>;
type PresentationBridge = { setFullscreen: (command: PresentationCommand) => Promise<void> };
type PresentationLoader = () => Promise<PresentationBridge | null>;

async function loadPresentation(): Promise<PresentationBridge | null> {
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform() || !['ios', 'android'].includes(Capacitor.getPlatform())) return null;
    const plugin = registerPlugin<PresentationBridge>('LudolumePresentation');
    // A Capacitor proxy has a synthetic `then` method; only resolve a plain facade.
    return Object.freeze({ setFullscreen: (command: PresentationCommand) => plugin.setFullscreen(command) });
}

function createSessionId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createNativePresentation(load: PresentationLoader = loadPresentation, sessionId = createSessionId) {
    const owners = new Map<symbol, boolean>();
    let ready: Promise<PresentationBridge | null> | undefined;
    let session = '', revision = 0, version = 0, desired = false;

    const command = (active: boolean): PresentationCommand => ({ active, sessionId: session, revision: ++revision });
    const initialize = (): Promise<PresentationBridge | null> => {
        ready ??= (async () => {
            try {
                const bridge = await load();
                if (!bridge) return null;
                session = sessionId();
                if (!/^[a-f0-9]{32}$/.test(session)) return null;
                // A fresh document cannot unlock rotation until its portrait baseline is acknowledged.
                await bridge.setFullscreen(command(false));
                return bridge;
            } catch { return null; }
        })();
        return ready;
    };

    const publish = (active: boolean): void => {
        desired = active;
        const current = ++version;
        void (async () => {
            const bridge = await initialize();
            if (!bridge || current !== version) return;
            try { await bridge.setFullscreen(command(active)); }
            catch {
                if (current !== version) return;
                // A rejected acknowledgement may follow an applied unlock. Confirm portrait once,
                // without queuing behind an older promise or retrying an ambiguous unlock.
                try { await bridge.setFullscreen(command(false)); } catch { /* Never retry an ambiguous unlock. */ }
            }
        })();
    };

    const update = (): void => {
        const active = [...owners.values()].some(Boolean);
        if (active !== desired) publish(active);
    };

    return {
        reset: () => { owners.clear(); publish(false); },
        acquire: () => {
            const owner = Symbol('fullscreen');
            owners.set(owner, false);
            void initialize();
            return {
                setFullscreen(active: boolean) {
                    if (!owners.has(owner)) return;
                    owners.set(owner, active);
                    update();
                },
                release() { owners.delete(owner); update(); },
            };
        },
    };
}

export const nativePresentation = createNativePresentation();
