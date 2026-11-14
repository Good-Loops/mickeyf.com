package com.mickeyf.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.agesignals.AgeSignalsAccessRequest;
import com.google.android.play.agesignals.AgeSignalsException;
import com.google.android.play.agesignals.AgeSignalsManager;
import com.google.android.play.agesignals.AgeSignalsManagerFactory;
import com.google.android.play.agesignals.AgeSignalsRequest;
import com.google.android.play.agesignals.model.AgeSignalsErrorCode;
import com.google.android.play.agesignals.model.AgeSignalsStatus;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import org.json.JSONObject;

@CapacitorPlugin(name = "LudolumeAge")
public final class LudolumeAgePlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private LudolumeAgeRequest pending;
    private Runnable timeout;

    @PluginMethod
    public void requestAgeRange(PluginCall call) {
        Activity activity = getActivity();
        if (call.getData().length() != 0 || activity == null) {
            resolve(call, LudolumeAgeRequest.Result.unavailable()); return;
        }
        activity.runOnUiThread(() -> {
            if (pending != null || activity.isFinishing() || activity.isDestroyed()) {
                resolve(call, LudolumeAgeRequest.Result.unavailable()); return;
            }
            try {
                AgeSignalsManager manager = AgeSignalsManagerFactory.create(activity.getApplicationContext());
                pending = new LudolumeAgeRequest(new PlayService(activity, manager), result -> {
                    if (timeout != null) main.removeCallbacks(timeout);
                    timeout = null; pending = null; resolve(call, result);
                });
                LudolumeAgeRequest current = pending;
                timeout = current::cancel;
                main.postDelayed(timeout, 120_000);
                current.start();
            } catch (RuntimeException error) { resolve(call, LudolumeAgeRequest.Result.unavailable()); }
        });
    }

    @Override protected void handleOnDestroy() {
        if (pending != null) pending.cancel();
        super.handleOnDestroy();
    }

    private static void resolve(PluginCall call, LudolumeAgeRequest.Result result) {
        JSObject response = new JSObject();
        response.put("status", result.status);
        response.put("minimumAge", result.minimumAge == null ? JSONObject.NULL : result.minimumAge);
        response.put("maximumAge", result.maximumAge == null ? JSONObject.NULL : result.maximumAge);
        call.resolve(response);
    }

    private static boolean unsupported(Exception error) {
        if (!(error instanceof AgeSignalsException)) return false;
        int code = ((AgeSignalsException) error).getErrorCode();
        return code == AgeSignalsErrorCode.API_NOT_AVAILABLE || code == AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND
            || code == AgeSignalsErrorCode.PLAY_SERVICES_NOT_FOUND || code == AgeSignalsErrorCode.APP_NOT_OWNED;
    }

    private static final class PlayService implements LudolumeAgeRequest.Service {
        private final Activity activity;
        private final AgeSignalsManager manager;

        PlayService(Activity activity, AgeSignalsManager manager) { this.activity = activity; this.manager = manager; }

        @Override public void requestAccess(Consumer<LudolumeAgeRequest.Access> success, Consumer<Boolean> failure) {
            // The current 0.0.4 access call owns Play's user/parent sharing prompt. Never bypass it.
            manager.requestAgeSignalsAccess(AgeSignalsAccessRequest.builder().setActivity(activity).build())
                .addOnSuccessListener(result -> {
                    Integer status = result == null ? null : result.ageSignalsStatus();
                    success.accept(status == null ? LudolumeAgeRequest.Access.UNKNOWN
                        : status == AgeSignalsStatus.SHARED ? LudolumeAgeRequest.Access.SHARED
                        : status == AgeSignalsStatus.NOT_SHARED ? LudolumeAgeRequest.Access.NOT_SHARED
                        : status == AgeSignalsStatus.VERIFICATION_REQUIRED ? LudolumeAgeRequest.Access.VERIFICATION_REQUIRED
                        : LudolumeAgeRequest.Access.UNKNOWN);
                }).addOnFailureListener(error -> failure.accept(unsupported(error)))
                .addOnCanceledListener(() -> failure.accept(false));
        }

        @Override public void checkRange(BiConsumer<Integer, Integer> success, Consumer<Boolean> failure) {
            manager.checkAgeSignals(AgeSignalsRequest.builder().build())
                .addOnSuccessListener(result -> {
                    if (result == null) failure.accept(false);
                    else success.accept(result.ageLower(), result.ageUpper());
                }).addOnFailureListener(error -> failure.accept(unsupported(error)))
                .addOnCanceledListener(() -> failure.accept(false));
        }
    }
}
