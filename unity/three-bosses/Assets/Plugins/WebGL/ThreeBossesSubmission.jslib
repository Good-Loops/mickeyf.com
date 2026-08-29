mergeInto(LibraryManager.library, {
    MickeyfThreeBossesSignalReady: function () {
        var signalReady = globalThis.mickeyfThreeBossesSignalReady;
        if (typeof signalReady !== 'function') {
            throw new Error('The Three Bosses readiness bridge is unavailable.');
        }

        signalReady();
    },

    MickeyfThreeBossesSubmitRun: function (payloadPointer) {
        var submitRun = globalThis.mickeyfThreeBossesSubmitRun;
        if (typeof submitRun !== 'function') {
            throw new Error('The Three Bosses submission bridge is unavailable.');
        }

        submitRun(UTF8ToString(payloadPointer));
    },
});
