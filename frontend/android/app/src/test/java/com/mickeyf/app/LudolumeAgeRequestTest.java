package com.mickeyf.app;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import org.junit.Test;

public class LudolumeAgeRequestTest {
    private static final class Service implements LudolumeAgeRequest.Service {
        Consumer<LudolumeAgeRequest.Access> access;
        Consumer<Boolean> accessFailure;
        BiConsumer<Integer, Integer> range;
        Consumer<Boolean> rangeFailure;
        int checks;

        @Override public void requestAccess(Consumer<LudolumeAgeRequest.Access> success, Consumer<Boolean> failure) {
            access = success; accessFailure = failure;
        }
        @Override public void checkRange(BiConsumer<Integer, Integer> success, Consumer<Boolean> failure) {
            checks++; range = success; rangeFailure = failure;
        }
    }

    private static void empty(LudolumeAgeRequest.Result result, String status) {
        assertEquals(status, result.status); assertNull(result.minimumAge); assertNull(result.maximumAge);
    }

    @Test public void consentStatusStopsBeforeReadingAnyAgeRange() {
        for (LudolumeAgeRequest.Access access : new LudolumeAgeRequest.Access[] {
            LudolumeAgeRequest.Access.NOT_SHARED, LudolumeAgeRequest.Access.VERIFICATION_REQUIRED, LudolumeAgeRequest.Access.UNKNOWN, null }) {
            Service service = new Service(); List<LudolumeAgeRequest.Result> results = new ArrayList<>();
            new LudolumeAgeRequest(service, results::add).start();
            assertEquals(0, service.checks); assertTrue(results.isEmpty());
            service.access.accept(access);
            assertEquals(0, service.checks); assertEquals(1, results.size());
            empty(results.get(0), access == LudolumeAgeRequest.Access.NOT_SHARED ? "not-shared"
                : access == LudolumeAgeRequest.Access.VERIFICATION_REQUIRED ? "verification-required" : "unavailable");
        }
    }

    @Test public void playBoundsRemainInclusiveAndAdultHighestBandRemainsOpenEnded() {
        for (Integer[] bounds : new Integer[][] { { 0, 12 }, { 13, 15 }, { 16, 17 }, { 18, null }, { 13, 13 } }) {
            Service service = new Service(); List<LudolumeAgeRequest.Result> results = new ArrayList<>();
            new LudolumeAgeRequest(service, results::add).start();
            service.access.accept(LudolumeAgeRequest.Access.SHARED);
            assertEquals(1, service.checks); assertTrue(results.isEmpty());
            service.range.accept(bounds[0], bounds[1]);
            assertEquals("shared", results.get(0).status);
            assertEquals(bounds[0], results.get(0).minimumAge); assertEquals(bounds[1], results.get(0).maximumAge);
        }
    }

    @Test public void noBoundsNeverTurnsIntoAnAdultOrSharedSignal() {
        empty(LudolumeAgeRequest.Result.shared(null, null), "not-shared");
        for (Integer[] bounds : new Integer[][] { { null, 12 }, { -1, 12 }, { 13, 12 }, { 18, -1 }, { 19, null }, { 17, 19 } }) {
            empty(LudolumeAgeRequest.Result.shared(bounds[0], bounds[1]), "unavailable");
        }
    }

    @Test public void unsupportedAndTransientFailuresHaveNoAgeBounds() {
        for (boolean reading : new boolean[] { false, true }) for (boolean unsupported : new boolean[] { false, true }) {
            Service service = new Service(); List<LudolumeAgeRequest.Result> results = new ArrayList<>();
            new LudolumeAgeRequest(service, results::add).start();
            if (reading) { service.access.accept(LudolumeAgeRequest.Access.SHARED); service.rangeFailure.accept(unsupported); }
            else service.accessFailure.accept(unsupported);
            assertEquals(1, results.size()); empty(results.get(0), unsupported ? "unsupported" : "unavailable");
        }
    }

    @Test public void cancellationDiscardsLateSharingAndRangeCallbacks() {
        for (boolean reading : new boolean[] { false, true }) {
            Service service = new Service(); List<LudolumeAgeRequest.Result> results = new ArrayList<>();
            LudolumeAgeRequest request = new LudolumeAgeRequest(service, results::add); request.start();
            if (reading) service.access.accept(LudolumeAgeRequest.Access.SHARED);
            request.cancel();
            service.access.accept(LudolumeAgeRequest.Access.SHARED);
            if (reading) service.range.accept(18, null);
            assertEquals(reading ? 1 : 0, service.checks); assertEquals(1, results.size()); empty(results.get(0), "unavailable");
        }
    }

    @Test public void repeatedAccessCallbacksCannotStartAnotherReadOrCompleteTwice() {
        Service service = new Service(); List<LudolumeAgeRequest.Result> results = new ArrayList<>();
        new LudolumeAgeRequest(service, results::add).start();
        service.access.accept(LudolumeAgeRequest.Access.SHARED); service.access.accept(LudolumeAgeRequest.Access.SHARED);
        assertEquals(1, service.checks);
        service.range.accept(13, 15); service.range.accept(18, null); service.rangeFailure.accept(true);
        assertEquals(1, results.size()); assertEquals(Integer.valueOf(13), results.get(0).minimumAge);
    }

    @Test public void synchronousSdkFailuresAreProtectiveAndDoNotEscapeTheBridge() {
        for (boolean reading : new boolean[] { false, true }) {
            List<LudolumeAgeRequest.Result> results = new ArrayList<>();
            new LudolumeAgeRequest(new LudolumeAgeRequest.Service() {
                @Override public void requestAccess(Consumer<LudolumeAgeRequest.Access> success, Consumer<Boolean> failure) {
                    if (!reading) throw new IllegalStateException("not exposed");
                    success.accept(LudolumeAgeRequest.Access.SHARED);
                }
                @Override public void checkRange(BiConsumer<Integer, Integer> success, Consumer<Boolean> failure) {
                    throw new IllegalStateException("not exposed");
                }
            }, results::add).start();
            assertEquals(1, results.size()); empty(results.get(0), "unavailable");
        }
    }
}
