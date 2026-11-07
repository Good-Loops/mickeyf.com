package com.mickeyf.app;

/** In-memory browser operation only. No credentials or pending state survive process death. */
final class LudolumeAppleAuthSession {
    static final String CLIENT_ID = "com.mickeyf.web";
    static final String CALLBACK = "https://mickeyf.com/auth/providers/apple-android/callback";
    static final String RETURN_HOST = "mickeyf.com";
    static final String RETURN_PATH = "/auth/native/apple-return";
    private static final String RETURN_URL = "https://" + RETURN_HOST + RETURN_PATH;
    enum Result { READY, CANCELLED, INVALID, STALE }
    static final class Ticket {
        final String state;
        boolean cancelled;
        private Ticket(String state) { this.state = state; }
    }
    private Ticket pending;

    static final class BrowserGate {
        private boolean inFlight;
        boolean available() { return !inFlight; }
        void restore(boolean outstanding) { inFlight = outstanding; }
        void begin() {
            if (inFlight) throw new IllegalStateException("Browser operation already active.");
            inFlight = true;
        }
        void finish() { inFlight = false; }
    }

    static boolean challenge(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]");
    }

    static String readyProof(String state, String url) {
        String prefix = RETURN_URL + "#state=" + state + "&result=ready&proof=";
        if (!challenge(state) || url == null || !url.startsWith(prefix)) return null;
        String proof = url.substring(prefix.length());
        return challenge(proof) ? proof : null;
    }

    static String authorizationUrl(String clientId, String callback, String state, String nonce) {
        if (!CLIENT_ID.equals(clientId) || !CALLBACK.equals(callback) || !challenge(state) || !challenge(nonce)) {
            throw new IllegalArgumentException("Invalid Apple authorization configuration.");
        }
        return "https://appleid.apple.com/auth/authorize?client_id=" + CLIENT_ID
            + "&redirect_uri=https%3A%2F%2Fmickeyf.com%2Fauth%2Fproviders%2Fapple-android%2Fcallback"
            + "&response_type=code%20id_token&response_mode=form_post&scope=email&state=" + state + "&nonce=" + nonce;
    }

    Ticket begin(String state) {
        if (pending != null || !challenge(state)) throw new IllegalStateException("Apple browser operation unavailable.");
        pending = new Ticket(state);
        return pending;
    }

    void cancel(Ticket ticket) { if (ticket == pending) ticket.cancelled = true; }

    Result finish(Ticket ticket, boolean verifiedReturn, boolean browserCancelled, String url) {
        if (ticket == null || ticket != pending) return Result.STALE;
        pending = null;
        if (ticket.cancelled || browserCancelled) return Result.CANCELLED;
        if (!verifiedReturn) return Result.INVALID;
        // Exact wire representation rejects alternate hosts/paths, encodings, queries and credential-bearing additions.
        if (readyProof(ticket.state, url) != null) return Result.READY;
        if ((RETURN_URL + "#state=" + ticket.state + "&result=cancelled").equals(url)) return Result.CANCELLED;
        return Result.INVALID;
    }

    void destroy() { pending = null; }
}
