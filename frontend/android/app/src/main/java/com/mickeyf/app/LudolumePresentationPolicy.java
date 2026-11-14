package com.mickeyf.app;

import java.util.HashSet;
import java.util.Set;

/** Only presentation state; no identity, cookie, or credential access. */
final class LudolumePresentationPolicy {
    private String sessionId;
    private final Set<String> retiredSessions = new HashSet<>();
    private boolean exhausted;
    private int revision;
    private boolean fullscreen;

    boolean apply(boolean active, String sessionId, int revision) {
        if (sessionId == null || !sessionId.matches("[a-f0-9]{32}") || revision <= 0) return false;
        if (exhausted) { fullscreen = false; return false; }
        if (!sessionId.equals(this.sessionId)) {
            if (active || retiredSessions.contains(sessionId)) return false;
            if (this.sessionId != null) {
                // Never evict an old document ID and allow its delayed unlock to reclaim the bridge.
                if (retiredSessions.size() >= 128) { exhausted = true; fullscreen = false; return false; }
                retiredSessions.add(this.sessionId);
            }
            this.sessionId = sessionId;
            this.revision = 0;
        }
        if (revision <= this.revision) return false;
        this.revision = revision;
        fullscreen = active;
        return true;
    }

    boolean fullscreen() { return fullscreen; }

    static boolean locksPhone(int smallestScreenWidthDp, boolean multiWindow) {
        return smallestScreenWidthDp > 0 && smallestScreenWidthDp < 600 && !multiWindow;
    }
}
