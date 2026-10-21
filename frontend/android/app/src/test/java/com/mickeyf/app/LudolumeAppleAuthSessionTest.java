package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class LudolumeAppleAuthSessionTest {
    private static final String STATE = "A".repeat(43);
    private static final String NONCE = "B".repeat(42) + "A";
    private static final String PROOF = "C".repeat(42) + "A";
    private static final String RETURN = "https://mickeyf.com/auth/native/apple-return#state=" + STATE + "&result=ready&proof=" + PROOF;

    @Test public void authorizationUsesExactServerPinsAndChallengeOnly() {
        String url = LudolumeAppleAuthSession.authorizationUrl("com.mickeyf.web", LudolumeAppleAuthSession.CALLBACK, STATE, NONCE);
        assertTrue(url.startsWith("https://appleid.apple.com/auth/authorize?client_id=com.mickeyf.web&redirect_uri=https%3A%2F%2Fmickeyf.com%2Fauth%2Fproviders%2Fapple-android%2Fcallback&"));
        assertTrue(url.endsWith("response_type=code%20id_token&response_mode=form_post&scope=email&state=" + STATE + "&nonce=" + NONCE));
        for (String value : new String[] { "", "wrong", STATE + "\n", "A".repeat(42) + "B", "A".repeat(44) }) {
            assertThrows(IllegalArgumentException.class, () -> LudolumeAppleAuthSession.authorizationUrl("com.mickeyf.web", LudolumeAppleAuthSession.CALLBACK, value, NONCE));
        }
        assertThrows(IllegalArgumentException.class, () -> LudolumeAppleAuthSession.authorizationUrl("com.foreign", LudolumeAppleAuthSession.CALLBACK, STATE, NONCE));
        assertThrows(IllegalArgumentException.class, () -> LudolumeAppleAuthSession.authorizationUrl("com.mickeyf.web", "https://attacker.test/return", STATE, NONCE));
    }

    @Test public void exactVerifiedReturnIsSingleUse() {
        LudolumeAppleAuthSession session = new LudolumeAppleAuthSession();
        LudolumeAppleAuthSession.Ticket ticket = session.begin(STATE);
        assertEquals(LudolumeAppleAuthSession.Result.READY, session.finish(ticket, true, false, RETURN));
        assertEquals(PROOF, LudolumeAppleAuthSession.readyProof(STATE, RETURN));
        assertEquals(LudolumeAppleAuthSession.Result.STALE, session.finish(ticket, true, false, RETURN));
    }

    @Test public void browserVerificationFailureNeverBecomesReady() {
        LudolumeAppleAuthSession session = new LudolumeAppleAuthSession();
        assertEquals(LudolumeAppleAuthSession.Result.INVALID, session.finish(session.begin(STATE), false, false, RETURN));
        assertEquals(LudolumeAppleAuthSession.Result.CANCELLED, session.finish(session.begin(STATE), false, true, null));
        assertEquals(LudolumeAppleAuthSession.Result.CANCELLED,
            session.finish(session.begin(STATE), true, false, RETURN.replace("result=ready&proof=" + PROOF, "result=cancelled")));
    }

    @Test public void forgedAndCredentialBearingReturnsAreRejectedExactly() {
        for (String forged : new String[] { null, RETURN + "&code=private", RETURN + "&id_token=private",
            RETURN.replace("mickeyf.com", "mickeyf.com.attacker.test"), RETURN.replace("https:", "http:"),
            RETURN.replace("mickeyf.com", "user@mickeyf.com"), RETURN.replace("mickeyf.com", "mickeyf.com:443"),
            RETURN.replace("#", "?"), RETURN.replace("#", "?extra=1#"), RETURN.replace("/apple-return", "/apple-return/"),
            RETURN.replace("state=" + STATE, "state=" + NONCE), RETURN.replace("result=ready", "result=%72eady"),
            RETURN.replace("#state", "#state=" + STATE + "&state"), RETURN + "\n",
            RETURN.replace("&proof=" + PROOF, ""), RETURN.replace(PROOF, "bad"), RETURN.replace(PROOF, "A".repeat(42) + "B"),
            RETURN + "&proof=" + PROOF, RETURN.replace("result=ready", "result=cancelled") }) {
            LudolumeAppleAuthSession session = new LudolumeAppleAuthSession();
            assertEquals(LudolumeAppleAuthSession.Result.INVALID, session.finish(session.begin(STATE), true, false, forged));
        }
    }

    @Test public void cancellationKeepsOneOperationUntilTerminalResultAndLateResultsCannotReachRetry() {
        LudolumeAppleAuthSession session = new LudolumeAppleAuthSession();
        LudolumeAppleAuthSession.Ticket old = session.begin(STATE);
        session.cancel(old);
        assertThrows(IllegalStateException.class, () -> session.begin(NONCE));
        assertEquals(LudolumeAppleAuthSession.Result.CANCELLED, session.finish(old, true, false, RETURN));
        LudolumeAppleAuthSession.Ticket next = session.begin(NONCE);
        session.cancel(old);
        assertEquals(LudolumeAppleAuthSession.Result.STALE, session.finish(old, false, true, null));
        assertEquals(LudolumeAppleAuthSession.Result.READY, session.finish(next, true, false, RETURN.replace(STATE, NONCE)));
    }

    @Test public void processDeathDiscardsUnmatchedResultAndPendingState() {
        LudolumeAppleAuthSession session = new LudolumeAppleAuthSession();
        LudolumeAppleAuthSession.Ticket old = session.begin(STATE);
        session.destroy();
        assertEquals(LudolumeAppleAuthSession.Result.STALE, session.finish(old, true, false, RETURN));
        LudolumeAppleAuthSession replacement = new LudolumeAppleAuthSession();
        assertEquals(LudolumeAppleAuthSession.Result.STALE, replacement.finish(old, true, false, RETURN));
        assertEquals(LudolumeAppleAuthSession.Result.READY, replacement.finish(replacement.begin(STATE), true, false, RETURN));
    }

    @Test public void restoredBrowserMarkerBlocksNewLaunchUntilOldTerminalResultIsDiscarded() {
        LudolumeAppleAuthSession.BrowserGate gate = new LudolumeAppleAuthSession.BrowserGate();
        assertTrue(gate.available()); gate.begin(); assertFalse(gate.available());
        assertThrows(IllegalStateException.class, gate::begin);
        LudolumeAppleAuthSession.BrowserGate restored = new LudolumeAppleAuthSession.BrowserGate();
        restored.restore(true); assertFalse(restored.available());
        assertThrows(IllegalStateException.class, restored::begin);
        restored.finish(); assertTrue(restored.available()); restored.begin(); assertFalse(restored.available());
    }
}
