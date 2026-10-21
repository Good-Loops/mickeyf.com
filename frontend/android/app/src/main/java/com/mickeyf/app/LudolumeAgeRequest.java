package com.mickeyf.app;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/** Request-local state only. No provider identifiers or persistent age records are accepted. */
final class LudolumeAgeRequest {
    enum Access { SHARED, NOT_SHARED, VERIFICATION_REQUIRED, UNKNOWN }

    interface Service {
        void requestAccess(Consumer<Access> success, Consumer<Boolean> unsupportedFailure);
        void checkRange(BiConsumer<Integer, Integer> success, Consumer<Boolean> unsupportedFailure);
    }

    static final class Result {
        final String status;
        final Integer minimumAge;
        final Integer maximumAge;

        private Result(String status, Integer minimumAge, Integer maximumAge) {
            this.status = status; this.minimumAge = minimumAge; this.maximumAge = maximumAge;
        }

        static Result unavailable() { return empty("unavailable"); }
        static Result empty(String status) { return new Result(status, null, null); }

        static Result shared(Integer minimum, Integer maximum) {
            if (minimum == null && maximum == null) return empty("not-shared");
            // Play 0.0.4 documents inclusive bounds in 0..18 and an absent highest-band upper bound.
            if (minimum == null || minimum < 0 || minimum > 18
                || maximum != null && (maximum < minimum || maximum > 18)) return unavailable();
            return new Result("shared", minimum, maximum);
        }
    }

    private final Service service;
    private final Consumer<Result> completion;
    private final AtomicBoolean finished = new AtomicBoolean();
    private final AtomicBoolean rangeRequested = new AtomicBoolean();

    LudolumeAgeRequest(Service service, Consumer<Result> completion) {
        this.service = service; this.completion = completion;
    }

    void start() {
        try {
            service.requestAccess(access -> {
                if (finished.get()) return;
                if (access == Access.NOT_SHARED) finish(Result.empty("not-shared"));
                else if (access == Access.VERIFICATION_REQUIRED) finish(Result.empty("verification-required"));
                else if (access != Access.SHARED) finish(Result.unavailable());
                else if (rangeRequested.compareAndSet(false, true)) {
                    try { service.checkRange((minimum, maximum) -> finish(Result.shared(minimum, maximum)), this::failure); }
                    catch (RuntimeException error) { finish(Result.unavailable()); }
                }
            }, this::failure);
        } catch (RuntimeException error) { finish(Result.unavailable()); }
    }

    void cancel() { finish(Result.unavailable()); }

    private void failure(Boolean unsupported) {
        finish(Result.empty(Boolean.TRUE.equals(unsupported) ? "unsupported" : "unavailable"));
    }

    private void finish(Result result) {
        if (finished.compareAndSet(false, true)) completion.accept(result);
    }
}
