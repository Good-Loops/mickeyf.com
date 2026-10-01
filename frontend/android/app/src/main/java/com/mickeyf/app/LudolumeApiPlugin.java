package com.mickeyf.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Cookie;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONObject;

@CapacitorPlugin(name = "LudolumeApi")
public final class LudolumeApiPlugin extends Plugin {
    // Serial requests also prevent late verification/cookie responses undoing a logout.
    private static final ExecutorService requests = Executors.newSingleThreadExecutor();
    private static final OkHttpClient client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(30, TimeUnit.SECONDS).build();
    private static LudolumeSessionStore sessions;

    @PluginMethod
    public void nativeRequest(PluginCall call) {
        String body = call.getString("body");
        Request request = LudolumeApiPolicy.request(call.getString("url"), call.getString("method"), body);
        if (request == null || (call.getData().has("body") && body == null)) {
            call.reject("Unsupported native API request.", "INVALID_REQUEST");
            return;
        }
        requests.execute(() -> {
            try {
                if (sessions == null) sessions = new LudolumeSessionStore(getContext().getApplicationContext());
                Request.Builder authenticated = request.newBuilder();
                String cookie = sessions.header();
                if (cookie != null) authenticated.header("Cookie", cookie);
                try (Response response = client.newCall(authenticated.build()).execute()) {
                    if (response.code() >= 300 && response.code() < 400 || response.body() == null
                        || response.body().contentLength() > LudolumeApiPolicy.MAX_RESPONSE) throw new IOException();
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    try (InputStream input = response.body().byteStream()) {
                        byte[] chunk = new byte[8192];
                        for (int count; (count = input.read(chunk)) != -1;) {
                            if (count > LudolumeApiPolicy.MAX_RESPONSE - bytes.size()) throw new IOException();
                            bytes.write(chunk, 0, count);
                        }
                    }
                    String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
                    // Only a fully received response may change the private session.
                    for (Cookie updated : Cookie.parseAll(request.url(), response.headers())) sessions.update(updated);
                    if (confirmedSignOut(request.url().encodedPath(), response.code(), text)) {
                        sessions.clear();
                        LudolumeIdentityPlugin.clearCredentialState(getContext());
                    }
                    JSObject result = new JSObject();
                    result.put("status", response.code());
                    result.put("body", text);
                    call.resolve(result);
                }
            } catch (Exception ignored) {
                // No request, provider, cookie, key or transport diagnostics reach JavaScript/logs.
                call.reject("Unable to complete the native API request.", "UNAVAILABLE");
            }
        });
    }

    private static boolean confirmedSignOut(String path, int status, String text) {
        if (status != 200) return false;
        try {
            JSONObject result = new JSONObject(text);
            if (path.equals("/auth/providers/complete")) return result.length() == 2
                && Boolean.TRUE.equals(result.opt("success")) && Boolean.TRUE.equals(result.opt("deleted"));
            return result.length() == 1 && ((path.equals("/auth/logout") && Boolean.TRUE.equals(result.opt("loggedOut")))
                || (path.equals("/auth/delete-account") && Boolean.TRUE.equals(result.opt("deleted"))));
        } catch (Exception ignored) { return false; }
    }

}
