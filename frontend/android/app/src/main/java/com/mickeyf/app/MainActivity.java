package com.mickeyf.app;

import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import androidx.activity.result.ActivityResultLauncher;
import androidx.browser.auth.AuthTabIntent;
import java.util.function.Consumer;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final LudolumePresentationPolicy presentationPolicy = new LudolumePresentationPolicy();
    private static final String APPLE_BROWSER_IN_FLIGHT = "ludolume.apple.browser.inFlight";
    private final LudolumeAppleAuthSession.BrowserGate appleBrowserGate = new LudolumeAppleAuthSession.BrowserGate();
    private Consumer<AuthTabIntent.AuthResult> appleResult;
    private final ActivityResultLauncher<Intent> appleLauncher = AuthTabIntent.registerActivityResultLauncher(this, result -> {
        Consumer<AuthTabIntent.AuthResult> callback = appleResult;
        appleResult = null;
        appleBrowserGate.finish();
        // A restored ActivityResult has no matching in-memory attempt after process death.
        if (callback != null) callback.accept(result);
    });

    void launchApple(Uri authorization, String browser, Consumer<AuthTabIntent.AuthResult> callback) {
        appleBrowserGate.begin();
        appleResult = callback;
        try {
            AuthTabIntent tab = new AuthTabIntent.Builder().build();
            tab.intent.setPackage(browser);
            tab.launch(appleLauncher, authorization, LudolumeAppleAuthSession.RETURN_HOST, LudolumeAppleAuthSession.RETURN_PATH);
        } catch (RuntimeException error) { appleResult = null; appleBrowserGate.finish(); throw error; }
    }

    boolean appleBrowserAvailable() { return appleBrowserGate.available(); }

    boolean setPresentationFullscreen(boolean active, String sessionId, int revision) {
        boolean applied = presentationPolicy.apply(active, sessionId, revision);
        applyPresentationOrientation();
        return applied;
    }

    private void applyPresentationOrientation() {
        boolean phone = LudolumePresentationPolicy.locksPhone(getResources().getConfiguration().smallestScreenWidthDp, isInMultiWindowMode());
        int orientation = !phone ? ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            : presentationPolicy.fullscreen() ? ActivityInfo.SCREEN_ORIENTATION_FULL_USER : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        if (getRequestedOrientation() != orientation) setRequestedOrientation(orientation);
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        // Persist only a busy marker. An old browser result is discarded before a new operation may start.
        appleBrowserGate.restore(savedInstanceState != null && savedInstanceState.getBoolean(APPLE_BROWSER_IN_FLIGHT));
        registerPlugin(LudolumeApiPlugin.class);
        registerPlugin(LudolumeIdentityPlugin.class);
        registerPlugin(LudolumePresentationPlugin.class);
        applyPresentationOrientation();
        super.onCreate(savedInstanceState);
        addOnMultiWindowModeChangedListener(info -> applyPresentationOrientation());
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyPresentationOrientation();
    }

    @Override public void onSaveInstanceState(Bundle state) {
        state.putBoolean(APPLE_BROWSER_IN_FLIGHT, !appleBrowserGate.available());
        super.onSaveInstanceState(state);
    }
}
