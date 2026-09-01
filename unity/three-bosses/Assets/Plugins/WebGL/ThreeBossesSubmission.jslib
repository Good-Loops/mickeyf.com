mergeInto(LibraryManager.library, {
    MickeyfThreeBossesSignalReady: function () {
        var signalReady = globalThis.mickeyfThreeBossesSignalReady;
        if (typeof signalReady !== 'function') {
            // The browser removes this one-shot bridge after the first main
            // menu frame. Returning to the menu later is already ready and
            // must not halt Unity's WebGL main loop.
            return;
        }

        signalReady();
    },

    MickeyfThreeBossesBeginRun: function (runIdPointer) {
        try {
            var beginRun = globalThis.mickeyfThreeBossesBeginRun;
            if (typeof beginRun !== 'function') {
                return;
            }

            beginRun(UTF8ToString(runIdPointer));
        } catch (error) {
            console.warn('The Three Bosses run-start bridge failed.', error);
        }
    },

    MickeyfThreeBossesSubmitRun: function (payloadPointer) {
        var submitRun = globalThis.mickeyfThreeBossesSubmitRun;
        if (typeof submitRun !== 'function') {
            throw new Error('The Three Bosses submission bridge is unavailable.');
        }

        submitRun(UTF8ToString(payloadPointer));
    },
});
