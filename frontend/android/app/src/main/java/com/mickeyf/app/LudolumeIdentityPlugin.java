package com.mickeyf.app;

import android.content.MutableContextWrapper;
import android.net.Uri;
import android.os.CancellationSignal;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.core.content.ContextCompat;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

@CapacitorPlugin(name = "LudolumeIdentity")
public final class LudolumeIdentityPlugin extends Plugin {
    private Operation pending;
    private final LudolumeAppleAuthSession appleSession = new LudolumeAppleAuthSession();

    private boolean enabled() {
        String id = getContext().getString(R.string.google_server_client_id);
        return getContext().getResources().getBoolean(R.bool.ludolume_google_sign_in_enabled)
            && id.length() <= 255 && id.matches("[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com");
    }

    private String appleBrowser() {
        if (!getContext().getResources().getBoolean(R.bool.ludolume_apple_sign_in_enabled)
            || !LudolumeAppleAuthSession.CLIENT_ID.equals(getContext().getString(R.string.apple_android_services_id))
            || !LudolumeAppleAuthSession.CALLBACK.equals(getContext().getString(R.string.apple_android_redirect_uri))
            || !(getActivity() instanceof MainActivity) || !((MainActivity) getActivity()).appleBrowserAvailable()) return null;
        String browser = CustomTabsClient.getPackageName(getContext(), null);
        return browser != null && CustomTabsClient.isAuthTabSupported(getContext(), browser) ? browser : null;
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("google", enabled());
        result.put("apple", appleBrowser() != null);
        call.resolve(result);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean apple = "apple".equals(call.getString("provider"));
            String browser = apple ? appleBrowser() : null;
            if ((apple ? browser == null
                    || !LudolumeAppleAuthSession.CLIENT_ID.equals(call.getString("clientId"))
                    || !LudolumeAppleAuthSession.CALLBACK.equals(call.getString("redirectUri"))
                : !enabled() || !"google".equals(call.getString("provider"))
                    || !getContext().getString(R.string.google_server_client_id).equals(call.getString("clientId")))
                || !challengeValue(call.getString("nonce")) || !challengeValue(call.getString("state"))) {
                call.reject(apple ? "Apple sign-in requires configured HTTPS verification and an Auth Tab capable browser."
                    : "Native Google sign-in is unavailable.", "UNAVAILABLE");
                return;
            }
            if (pending != null) {
                call.reject("A native sign-in request is already active.", "BUSY");
                return;
            }
            if (getActivity().isFinishing() || getActivity().isDestroyed() || !getActivity().hasWindowFocus()) {
                call.reject("Native sign-in cannot be presented.", "UNAVAILABLE");
                return;
            }
            Operation operation = new Operation(call);
            pending = operation;
            if (apple) { startApple(operation, browser); return; }
            try {
                GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(call.getString("clientId"))
                    .setNonce(call.getString("nonce")).build();
                GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
                CredentialManager.create(getContext()).getCredentialAsync(new MutableContextWrapper(getActivity()),
                    request, operation.cancellation, ContextCompat.getMainExecutor(getContext()),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override public void onResult(GetCredentialResponse response) {
                            if (pending != operation) return;
                            if (operation.call == null) { finish(operation); return; }
                            try {
                                if (!(response.getCredential() instanceof CustomCredential)) throw new IllegalArgumentException();
                                CustomCredential credential = (CustomCredential) response.getCredential();
                                if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) throw new IllegalArgumentException();
                                String token = GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken();
                                if (token.length() > 16384 || !token.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")) throw new IllegalArgumentException();
                                JSObject result = new JSObject();
                                result.put("identityToken", token);
                                operation.call.resolve(result);
                            } catch (Exception ignored) {
                                operation.call.reject("Invalid native sign-in response.", "UNAVAILABLE");
                            } finally { finish(operation); }
                        }
                        @Override public void onError(GetCredentialException error) {
                            if (pending != operation) return;
                            if (operation.call != null) {
                                boolean cancelled = error instanceof GetCredentialCancellationException;
                                String message = cancelled ? "Native sign-in was cancelled."
                                    : error instanceof NoCredentialException ? "No Google sign-in account is available."
                                    : "Native sign-in failed.";
                                operation.call.reject(message, cancelled ? "CANCELLED" : "UNAVAILABLE");
                            }
                            finish(operation);
                        }
                    });
            } catch (Exception ignored) {
                call.reject("Native sign-in failed.", "UNAVAILABLE");
                finish(operation);
            }
        });
    }

    private void startApple(Operation operation, String browser) {
        try {
            String state = operation.call.getString("state");
            String authorization = LudolumeAppleAuthSession.authorizationUrl(operation.call.getString("clientId"),
                operation.call.getString("redirectUri"), state, operation.call.getString("nonce"));
            operation.appleTicket = appleSession.begin(state);
            ((MainActivity) getActivity()).launchApple(Uri.parse(authorization), browser, result -> {
                if (pending != operation) return;
                LudolumeAppleAuthSession.Result handoff = appleSession.finish(operation.appleTicket,
                    result.resultCode == AuthTabIntent.RESULT_OK, result.resultCode == AuthTabIntent.RESULT_CANCELED,
                    result.resultUri == null ? null : result.resultUri.toString());
                if (operation.call != null) {
                    if (handoff == LudolumeAppleAuthSession.Result.READY || handoff == LudolumeAppleAuthSession.Result.CANCELLED) {
                        JSObject response = new JSObject();
                        response.put("state", state);
                        response.put("result", handoff == LudolumeAppleAuthSession.Result.READY ? "ready" : "cancelled");
                        if (handoff == LudolumeAppleAuthSession.Result.READY) {
                            response.put("proof", LudolumeAppleAuthSession.readyProof(state, result.resultUri.toString()));
                        }
                        operation.call.resolve(response);
                    } else operation.call.reject("Invalid Apple browser return.", "UNAVAILABLE");
                }
                finish(operation);
            });
        } catch (Exception ignored) {
            appleSession.finish(operation.appleTicket, false, false, null);
            operation.call.reject("Apple browser sign-in could not be presented.", "UNAVAILABLE");
            finish(operation);
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Operation operation = pending;
            if (operation == null) { call.resolve(); return; }
            if (operation.call != null) operation.call.reject("Native sign-in was cancelled.", "CANCELLED");
            operation.call = null;
            if (operation.appleTicket != null) {
                appleSession.cancel(operation.appleTicket);
                // Auth Tab has no programmatic close. A retry waits for its terminal ActivityResult,
                // so an old browser cancellation cannot be delivered to a newer operation.
                if (operation.cancelCall != null) call.reject("Cancellation is already pending.", "BUSY");
                else operation.cancelCall = call;
                return;
            }
            operation.cancellation.cancel();
            // CancellationSignal targets this operation only; late callbacks cannot affect a retry.
            pending = null;
            call.resolve();
        });
    }

    private void finish(Operation operation) {
        operation.call = null;
        if (operation.cancelCall != null) { operation.cancelCall.resolve(); operation.cancelCall = null; }
        if (pending == operation) pending = null;
    }

    @Override protected void handleOnDestroy() {
        if (pending != null) {
            if (pending.call != null) pending.call.reject("Native sign-in was cancelled.", "CANCELLED");
            pending.call = null;
            pending.cancellation.cancel();
            if (pending.cancelCall != null) pending.cancelCall.resolve();
            pending = null;
        }
        appleSession.destroy();
        super.handleOnDestroy();
    }

    static boolean challengeValue(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]");
    }

    static void clearCredentialState(android.content.Context context) {
        CredentialManager.create(context).clearCredentialStateAsync(new ClearCredentialStateRequest(), null,
            ContextCompat.getMainExecutor(context), new CredentialManagerCallback<Void, ClearCredentialException>() {
                @Override public void onResult(Void result) { }
                // Server logout is already confirmed. A provider reset failure cannot restore a session.
                @Override public void onError(ClearCredentialException error) { }
            });
    }

    private static final class Operation {
        PluginCall call;
        PluginCall cancelCall;
        LudolumeAppleAuthSession.Ticket appleTicket;
        final CancellationSignal cancellation = new CancellationSignal();
        Operation(PluginCall call) { this.call = call; }
    }
}
