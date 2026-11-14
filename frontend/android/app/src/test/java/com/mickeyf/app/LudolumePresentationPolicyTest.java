package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class LudolumePresentationPolicyTest {
    private static final String SESSION = "a".repeat(32);

    @Test public void startsInPortraitAndRequiresAcknowledgedBaseline() {
        LudolumePresentationPolicy policy = new LudolumePresentationPolicy();
        assertFalse(policy.fullscreen());
        assertFalse(policy.apply(true, SESSION, 1));
        assertTrue(policy.apply(false, SESSION, 1));
        assertTrue(policy.apply(true, SESSION, 2));
        assertTrue(policy.fullscreen());
    }

    @Test public void newestExitBeatsReorderedAndRepeatedUnlocks() {
        LudolumePresentationPolicy policy = new LudolumePresentationPolicy();
        assertTrue(policy.apply(false, SESSION, 1));
        assertTrue(policy.apply(false, SESSION, 3));
        assertFalse(policy.apply(true, SESSION, 2));
        assertFalse(policy.apply(true, SESSION, 3));
        assertFalse(policy.fullscreen());
        assertTrue(policy.apply(true, SESSION, 4));
        assertTrue(policy.apply(false, SESSION, 5));
        assertFalse(policy.fullscreen());
    }

    @Test public void newDocumentMustResetAndOldDocumentCannotUnlockIt() {
        LudolumePresentationPolicy policy = new LudolumePresentationPolicy();
        assertTrue(policy.apply(false, SESSION, 1));
        assertTrue(policy.apply(true, SESSION, 2));
        String next = "b".repeat(32);
        assertTrue(policy.apply(false, next, 1));
        assertFalse(policy.apply(false, SESSION, 3));
        assertFalse(policy.apply(true, SESSION, 4));
        assertFalse(policy.fullscreen());
        assertTrue(policy.apply(true, next, 2));
        assertTrue(policy.fullscreen());
    }

    @Test public void sessionMemoryIsBoundedAndExhaustionCannotReopenRotation() {
        LudolumePresentationPolicy policy = new LudolumePresentationPolicy();
        for (int i = 0; i <= 128; i++) assertTrue(policy.apply(false, String.format("%032x", i), 1));
        String last = String.format("%032x", 128);
        assertTrue(policy.apply(true, last, 2));
        assertFalse(policy.apply(false, String.format("%032x", 129), 1));
        assertFalse(policy.fullscreen());
        assertFalse(policy.apply(true, last, 3));
        assertFalse(policy.apply(false, String.format("%032x", 130), 1));
        assertFalse(policy.fullscreen());
    }

    @Test public void tabletsAndMultiWindowRemainUnrestricted() {
        assertTrue(LudolumePresentationPolicy.locksPhone(393, false));
        assertTrue(LudolumePresentationPolicy.locksPhone(599, false));
        assertFalse(LudolumePresentationPolicy.locksPhone(600, false));
        assertFalse(LudolumePresentationPolicy.locksPhone(840, false));
        assertFalse(LudolumePresentationPolicy.locksPhone(393, true));
        assertFalse(LudolumePresentationPolicy.locksPhone(0, false));
    }

    @Test public void malformedCommandsCannotUnlockRotation() {
        LudolumePresentationPolicy policy = new LudolumePresentationPolicy();
        for (String value : new String[] { null, "", "a".repeat(31), "A".repeat(32), SESSION + "\n" }) {
            assertFalse(policy.apply(false, value, 1));
        }
        assertFalse(policy.apply(false, SESSION, 0));
        assertFalse(policy.apply(false, SESSION, -1));
        assertFalse(policy.fullscreen());
    }
}
