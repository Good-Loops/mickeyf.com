package com.mickeyf.app;

import android.app.Activity;
import android.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
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
    private static final AtomicLong sessionGeneration = new AtomicLong();
    private boolean recoveryDialogShowing;

    @PluginMethod
    public void nativeRequest(PluginCall call) {
        String body = call.getString("body");
        Request request = LudolumeApiPolicy.request(call.getString("url"), call.getString("method"), body);
        if (request == null || (call.getData().has("body") && body == null)) {
            call.reject("Unsupported native API request.", "INVALID_REQUEST");
            return;
        }
        long generation = sessionGeneration.get();
        requests.execute(() -> {
            if (generation != sessionGeneration.get()) {
                call.reject("Saved sign-in changed. Please try again.", "CANCELLED");
                return;
            }
            try {
                if (sessions == null) sessions = new LudolumeSessionStore(getContext().getApplicationContext());
                Request.Builder authenticated = request.newBuilder();
                String cookie = sessions.header();
                if (cookie != null) authenticated.header("Cookie", cookie);
                try (Response response = client.newCall(authenticated.build()).execute()) {
                    if (response.code() >= 300 && response.code() < 400 || response.body() == null
                        || response.body().contentLength() > LudolumeApiPolicy.MAX_RESPONSE) throw new IOException();
                    String text;
                    try (InputStream input = response.body().byteStream()) {
                        text = LudolumeResponseBody.read(input, response.body().contentLength());
                    }
                    // Only a fully received response may change the private session.
                    if (confirmedSignOut(request.url().encodedPath(), response.code(), text)) {
                        sessions.clear();
                        LudolumeIdentityPlugin.clearCredentialState(getContext());
                    } else sessions.updateFromResponse(Cookie.parseAll(request.url(), response.headers()));
                    JSObject result = new JSObject();
                    result.put("status", response.code());
                    result.put("body", text);
                    call.resolve(result);
                }
            } catch (LudolumeSessionStore.CorruptSessionException ignored) {
                sessions = null;
                call.reject("Saved sign-in needs local recovery.", "SESSION_RECOVERY_REQUIRED");
                offerLocalSessionRecovery();
            } catch (Exception ignored) {
                // No request, provider, cookie, key or transport diagnostics reach JavaScript/logs.
                call.reject("Unable to complete the native API request.", "UNAVAILABLE");
            }
        });
    }

    private void offerLocalSessionRecovery() {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (activity.isFinishing() || activity.isDestroyed() || recoveryDialogShowing) return;
            recoveryDialogShowing = true;
            new AlertDialog.Builder(activity).setTitle("Reset saved sign-in?")
                .setMessage("Saved sign-in on this device cannot be read. Reset it and sign in again. "
                    + "This does not confirm server logout. Unsaved form entries will be cleared.")
                .setNegativeButton("Cancel", (dialog, which) -> recoveryDialogShowing = false)
                .setOnCancelListener(dialog -> recoveryDialogShowing = false)
                .setPositiveButton("Reset saved sign-in", (dialog, which) -> requests.execute(() -> {
                    boolean recovered = false;
                    try {
                        sessions = LudolumeSessionStore.resetCorrupt(getContext().getApplicationContext());
                        sessionGeneration.incrementAndGet();
                        LudolumeIdentityPlugin.clearCredentialState(getContext());
                        recovered = true;
                    } catch (Exception ignored) { /* A transient failure never authorizes erasing saved data. */ }
                    final boolean success = recovered;
                    activity.runOnUiThread(() -> {
                        recoveryDialogShowing = false;
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        if (success) getBridge().getWebView().reload();
                        else new AlertDialog.Builder(activity).setTitle("Saved sign-in unavailable")
                            .setMessage("Recovery could not be confirmed. Please try again later.")
                            .setPositiveButton("OK", null).show();
                    });
                })).show();
        });
    }

    private static boolean confirmedSignOut(String path, int status, String text) {
        if (status != 200) return false;
        try {
            JSONObject result = new JSONObject(text);
            if (path.equals("/auth/providers/complete")) return result.length() == 2
                && Boolean.TRUE.equals(result.opt("success")) && Boolean.TRUE.equals(result.opt("deleted"));
            return result.length() == 1 && ((path.equals("/auth/logout") && Boolean.TRUE.equals(result.opt("loggedOut")))
                || ((path.equals("/auth/delete-account") || path.equals("/auth/parent-registration/family/delete")) && Boolean.TRUE.equals(result.opt("deleted"))));
        } catch (Exception ignored) { return false; }
    }

}
