/**
 * Project audio capture + lightweight analysis for driving visuals.
 *
 * This module orchestrates a Web Audio graph around an `HTMLAudioElement`, extracts a small set of
 * features (pitch/clarity, peak-derived volume in dB, and a simple beat heuristic), and exposes a
 * single mutable `state` object for consumers.
 *
 * Dependencies: Web Audio APIs (`AudioContext`, `AnalyserNode`) and `pitchy` for pitch detection.
 *
 * Lifecycle (typical): `processAudio()`/`play()` → per-frame analysis loop (RAF) → `pause()`/`stop()`
 * → `dispose()`.
 *
 * Non-goals: this is not a DAW and not precision DSP. It is tuned for responsiveness and stability
 * in interactive visuals.
 */
import { PitchDetector } from "pitchy";

/**
 * Beat detection output for the current analysis frame.
 *
 * @category Audio — Support
 */
export type BeatState = {
	/** Whether the current frame crosses the beat threshold. */
    isBeat: boolean;
	/** Normalized beat strength in the range $[0, 1]$ (heuristic). */
    strength: number;
};

/**
 * Snapshot of audio analysis state exposed to the rest of the app.
 *
 * Consumers typically treat these values as “latest known” readings that are refreshed while
 * playback is running.
 *
 * @category Audio — Support
 */
export type AudioState = {
	/** Whether an audio source has been loaded (file selected and graph initialized). */
    hasAudio: boolean;
	/** Detected fundamental frequency in **Hz**. `0` when unknown/unavailable. */
    pitchHz: number;
	/** Pitch confidence in $[0, 1]$ as returned by `pitchy`. */
    clarity: number;
	/** Peak-derived volume estimate in **dB**. `-Infinity` represents silence/no signal. */
    volumeDb: number;  
	/** Track duration in **seconds** (from the underlying `HTMLAudioElement`). */
    durationSec: number;
	/** Whether playback is currently active. */
    playing: boolean;
	/** Simple beat detection output for the current frame. */
    beat: BeatState;
};

const DEFAULT_STATE: AudioState = {
    hasAudio: false,
    pitchHz: 0,
    clarity: 0,
    volumeDb: -Infinity,
    durationSec: 0,
    playing: false,
    beat: { isBeat: false, strength: 0 },
};


/**
 * Audio processing/analysis engine.
 *
 * Ownership:
 * - Owns the `AudioContext` and nodes it creates.
 * - Owns the per-frame analysis loop (driven by `requestAnimationFrame`).
 *
 * Thread model: this code runs on the main JS thread; Web Audio processing occurs on the browser's
 * internal audio thread and is sampled into JS on each analysis tick.
 *
 * @category Audio — Core
 */
export class AudioEngine {
    state: AudioState = { ...DEFAULT_STATE, beat: { ...DEFAULT_STATE.beat } };
    
    private audioElement: HTMLAudioElement | null = null;
    private audioContext: AudioContext | null = null;
    private sourceNode: MediaElementAudioSourceNode | null = null;
    private analyserNode: AnalyserNode | null = null;
    private volumeHistory: number[] = [];
    private readonly VOLUME_HISTORY_SIZE = 10;

    private rafId: number | null = null;
    private objectUrl: string | null = null;
    private endedListener: (() => void) | null = null;

    // Invalidates pending uploads and analysis loops when a track is replaced or disposed.
    private sessionId: number = 0;
    // Null means playback is no longer wanted, without cancelling the loaded track.
    private playbackRequest: symbol | null = null;
    private listeners = new Set<(state: AudioState) => void>();
    
    /**
     * Subscribes to state updates.
     *
     * The listener is invoked immediately with the current state, then again on each subsequent
     * state patch.
     *
     * @returns Unsubscribe function.
     */
    subscribe(listener: (state: AudioState) => void): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }

    /**
     * Loads an audio file, constructs the Web Audio graph, and begins playback/analysis.
     *
     * If an existing track is loaded, it is torn down first.
        * Analyzer configuration: uses an `AnalyserNode` with `fftSize = 2048`.
     *
     * @param file - Audio file selected by the user.
     */
    async processAudio(file: File): Promise<void> {
        const currentSessionId = ++this.sessionId;
        const request = this.playbackRequest = Symbol("upload playback");

        // Tear down any previous track so analysis sessions don't overlap.
        await this.teardownTrack();
        if (currentSessionId !== this.sessionId) return;
        this.patchState({ hasAudio: false, playing: false });

        try {
            const url = URL.createObjectURL(file);
            this.objectUrl = url;

            const audio = new Audio(url);
            this.audioElement = audio;

            this.endedListener = () => {
                this.playbackRequest = null;
                // Treat natural end like "paused at end": stop analysis, mark not playing, reset time
                this.patchState({ playing: false });
                this.stopAnalysisLoop();

                try {
                    audio.currentTime = 0;
                } catch {}
            };

            audio.addEventListener("ended", this.endedListener);

            const audioContext = new window.AudioContext();
            // Disposal must own these resources even while the browser is resuming audio.
            this.audioContext = audioContext;
            await audioContext.resume();
            if (currentSessionId !== this.sessionId) return;

            // Analyzer provides the time-domain buffer used for pitch/volume extraction.
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 2048;
            this.analyserNode = analyser;

            const source = audioContext.createMediaElementSource(audio);
            this.sourceNode = source;
            source.connect(analyser);
            analyser.connect(audioContext.destination);

            this.patchState({ hasAudio: true });

            audio.load();
            try {
                await this.resumePlayback(audio, request);
            } catch {
            }
        } catch (error) {
            if (currentSessionId !== this.sessionId) return;
            this.playbackRequest = null;
            await this.teardownTrack();
            if (currentSessionId !== this.sessionId) return;
            this.volumeHistory = [];
            this.patchState({ ...DEFAULT_STATE, beat: { ...DEFAULT_STATE.beat } });
            throw error;
        }
    }

    /**
        * Starts/resumes playback for the currently loaded track.
        *
        * If playback had previously reached the end, this restarts from the beginning.
     */
    async play() {
        const audio = this.audioElement;
        if (!audio || !this.state.hasAudio) return;
        const request = this.playbackRequest = Symbol("explicit playback");

        // If we reached the end previously, restart from the beginning
        if (audio.ended || audio.currentTime >= audio.duration) {
            audio.currentTime = 0;
        }

        try {
            await this.resumePlayback(audio, request);
        } catch (err) {
            if (!this.isCurrentPlayback(audio, request)) return;
            this.pause();
            console.error("AudioHandler.play() error:", err);
        }
    }

    /**
     * Pauses playback while keeping the current playback position.
     */
    pause() {
        this.playbackRequest = null;
        if (!this.audioElement) return;

        this.patchState({ playing: false });
        this.audioElement.pause();
        this.stopAnalysisLoop();
    }

    /**
        * Stops playback and resets the playback position to the beginning.
        *
        * This clears transient analysis state but keeps the `AudioContext` alive so that subsequent
        * `play()` calls can resume without rebuilding the entire graph.
     */
    stop() {
        this.playbackRequest = null;
        const audio = this.audioElement;
        if (!audio) return;

        this.stopAnalysisLoop();

        try {
            audio.pause();
            audio.currentTime = 0;
        } catch {}

        this.volumeHistory = [];
        this.patchState({ 
            playing: false,
            volumeDb: -Infinity,
            beat: { isBeat: false, strength: 0 },
        });
    }

    /**
     * Fully tears down the current track and releases owned Web Audio resources.
     *
     * After disposal, state resets to its defaults.
     */
    async dispose() {
        const currentSessionId = ++this.sessionId;
        this.playbackRequest = null;
        await this.teardownTrack();
        if (currentSessionId !== this.sessionId) return;
        this.volumeHistory = [];
        this.patchState({ ...DEFAULT_STATE, beat: { ...DEFAULT_STATE.beat } });
    }

    /**
     * Maps a volume reading in dB to a UI-friendly percentage.
     *
     * The mapping assumes a typical display range of `[-40, 20]` dB.
     *
     * @param volume - Volume in **dB**.
     * @returns Percentage in `[0, 100]`.
     */
    getVolumePercentage(volume: number): number {
        const normalized = (volume + 40) / 60;
        return Math.max(0, Math.min(1, normalized)) * 100;
    }

    /**
     * Patches the current audio state with the provided partial state.
     * 
     * @param patch - A partial AudioState object containing the properties to be updated.
     */
    private patchState(patch: Partial<AudioState>) {
        this.state = {
            ...this.state,
            ...patch,
            beat: patch.beat ? { ...this.state.beat, ...patch.beat } : this.state.beat,
        };

        this.notifyState();
    }

    /**
        * Notifies all subscribed listeners of the current state.
     */
    private notifyState() {
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (err) {
                // Don't let one bad listener break audio
                console.error("AudioHandler state listener error:", err);
            }
        }
    }

    /**
        * Starts the per-frame analysis loop.
        *
        * This samples the analyzer time-domain buffer, runs pitch detection, derives a peak-based
        * volume estimate in dB, and updates beat state.
     */
    private startAnalysis(): void {
        const analyser = this.analyserNode;
        const music = this.audioElement;
        const audioCtx = this.audioContext;
        if (!analyser || !music || !audioCtx) return;

        this.stopAnalysisLoop();

        const currentSessionId = this.sessionId;

        // Uses the analyzer buffer size and the context sample rate to run pitch detection.
        const detector = PitchDetector.forFloat32Array(analyser.fftSize);
        const input = new Float32Array(
            new ArrayBuffer(detector.inputLength * Float32Array.BYTES_PER_ELEMENT)
        );

        const loop = () => {
            if (currentSessionId !== this.sessionId || music.ended) {
                this.stopAnalysisLoop();
                return;
            }

            if (!this.state.playing) {
                if (!music.paused) music.pause();
            } else {
                const request = this.playbackRequest;
                if (music.paused && request) {
                    void this.resumePlayback(music, request).catch(() => {});
                }
            }

            analyser.getFloatTimeDomainData(input);
            const [pitch, clarity] = detector.findPitch(input, audioCtx.sampleRate);

            let maxAbs = 0;
            for (let i = 0; i < input.length; i++) {
                const v = Math.abs(input[i]);
                if (v > maxAbs) maxAbs = v;
            }
            const volumeDb =
                maxAbs <= 0 ? -Infinity : Math.round(20 * Math.log10(maxAbs));

            const beat = this.detectBeat(volumeDb);

            this.patchState({
                pitchHz: Math.round(pitch * 10) * 0.1,
                clarity,
                volumeDb,
                durationSec: music.duration,
                beat,
            });

            if (this.state.playing) {
                this.rafId = requestAnimationFrame(loop);
            } else {
                this.stopAnalysisLoop();
            }
        };

        loop();
    }

    /**
     * Detects beats based on volume changes.
        *
        * Heuristic: compares current dB value to the recent rolling average. Thresholds are expressed
        * in **dB** (`> 3 dB` over average counts as a beat).
        *
        * `strength` is a normalized `volumeDiff / 10` clamped to $[0, 1]$.
     */
    private detectBeat(volumeDb: number): BeatState {
        if (Number.isFinite(volumeDb)) {
            this.volumeHistory.push(volumeDb);
        }
        if (this.volumeHistory.length > this.VOLUME_HISTORY_SIZE) {
            this.volumeHistory.shift();
        }

        const validHistory = this.volumeHistory.filter(Number.isFinite);
        if (validHistory.length < 3 || !Number.isFinite(volumeDb)) {
            return { isBeat: false, strength: 0 };
        }

        const avgVolume = validHistory.reduce((a, b) => a + b, 0) / validHistory.length;
        const volumeDiff = volumeDb - avgVolume;

        const beatThresholdDb = 3;
        const strength = Math.max(0, Math.min(1, volumeDiff / 10));

        return {
            isBeat: volumeDiff > beatThresholdDb,
            strength,
        };
    }

    private isCurrentPlayback(audio: HTMLAudioElement, request: symbol): boolean {
        return this.playbackRequest === request && this.audioElement === audio;
    }

    // All playback paths respect the latest transport command across browser waits.
    private async resumePlayback(audio: HTMLAudioElement, request: symbol): Promise<void> {
        const context = this.audioContext;
        if (!context || !this.isCurrentPlayback(audio, request)) return;
        if (context.state === "suspended") await context.resume();
        if (!this.isCurrentPlayback(audio, request)) return;

        await audio.play();
        if (!this.isCurrentPlayback(audio, request)) {
            // A newer Play may own this same element; do not silence that request.
            if (this.playbackRequest === null || this.audioElement !== audio) audio.pause();
            return;
        }
        this.patchState({ playing: true });
        if (this.rafId === null && this.analyserNode) this.startAnalysis();
    }

    private stopAnalysisLoop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    private async teardownTrack() {
        this.stopAnalysisLoop();

        const audio = this.audioElement;
        const audioContext = this.audioContext;
        const source = this.sourceNode;
        const objectUrl = this.objectUrl;
        const endedListener = this.endedListener;

        // A new upload may start while close() waits; only release this captured track.
        this.audioElement = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.analyserNode = null;
        this.objectUrl = null;
        this.endedListener = null;

        if (audio && endedListener) audio.removeEventListener("ended", endedListener);

        try {
            audio?.pause();
        } catch {}

        try {
            source?.disconnect();
        } catch {}

        if (audioContext) {
            try { await audioContext.close(); } catch {}
        }

        // Revoke object URL to avoid memory leaks.
        if (objectUrl) {
            try {
                URL.revokeObjectURL(objectUrl);
            } catch {}
        }
    }
}

/**
 * Shared singleton instance.
 *
 * Consumers typically read `audioEngine.state` each render frame (pull model) and/or subscribe to
 * state changes for UI updates (push model).
 */
const audioEngine = new AudioEngine();
export { audioEngine };
