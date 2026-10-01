package com.mickeyf.app;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.Request;
import okhttp3.RequestBody;

final class LudolumeApiPolicy {
    static final String HOST = "mickeyf-org-j7yuum4tiq-uc.a.run.app";
    static final String ORIGIN = "https://" + HOST;
    static final int MAX_REQUEST = 32 * 1024;
    static final int MAX_RESPONSE = 1024 * 1024;
    private static final Set<String> ROUTES = new HashSet<>(Arrays.asList(
        "POST /api/users", "GET /auth/verify-token", "POST /auth/logout", "POST /auth/renew",
        "POST /auth/delete-account", "GET /auth/providers/config", "GET /auth/providers/account",
        "GET /auth/providers/apple-credential", "POST /auth/providers/begin", "POST /auth/providers/complete",
        "GET /api/leaderboards", "GET /api/leaderboards/p4-vega", "GET /api/leaderboards/three-bosses",
        "POST /api/leaderboards/three-bosses/run-tickets", "POST /api/leaderboards/three-bosses/runs"));

    static Request request(String address, String method, String body) {
        if (address == null || address.length() > 512 || method == null) return null;
        HttpUrl url = HttpUrl.parse(address);
        if (url == null || !url.isHttps() || !HOST.equals(url.host()) || url.port() != 443
            || !url.username().isEmpty() || !url.password().isEmpty() || url.query() != null || url.fragment() != null
            || !address.equals(ORIGIN + url.encodedPath()) || !ROUTES.contains(method + " " + url.encodedPath())
            || ("GET".equals(method) && body != null)) return null;
        byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_REQUEST) return null;
        return new Request.Builder().url(url).header("Origin", "capacitor://localhost")
            .header("Accept", "application/json").header("Cache-Control", "no-store")
            .method(method, "POST".equals(method) ? RequestBody.create(bytes, MediaType.get("application/json")) : null).build();
    }

    private LudolumeApiPolicy() { }
}
