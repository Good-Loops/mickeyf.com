mergeInto(LibraryManager.library, {
    MickeyfThreeBossesSubmitRun: function (payloadPointer) {
        var submitRun = globalThis.mickeyfThreeBossesSubmitRun;
        if (typeof submitRun !== 'function') {
            throw new Error('The Three Bosses submission bridge is unavailable.');
        }

        submitRun(UTF8ToString(payloadPointer));
    },
});
