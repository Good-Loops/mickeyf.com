package com.mickeyf.app;

import android.content.MutableContextWrapper;
import android.os.CancellationSignal;
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

    private boolean enabled() {
        String id = getContext().getString(R.string.google_server_client_id);
        return getContext().getResources().getBoolean(R.bool.ludolume_google_sign_in_enabled)
            && id.length() <= 255 && id.matches("[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com");
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("google", enabled());
        result.put("apple", false);
        call.resolve(result);
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!enabled() || !"google".equals(call.getString("provider"))
                || !getContext().getString(R.string.google_server_client_id).equals(call.getString("clientId"))
                || !challengeValue(call.getString("nonce")) || !challengeValue(call.getString("state"))) {
                call.reject("Native Google sign-in is unavailable.", "UNAVAILABLE");
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
                                operation.call.reject(cancelled ? "Native sign-in was cancelled." : "Native sign-in failed.",
                                    cancelled ? "CANCELLED" : "UNAVAILABLE");
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

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Operation operation = pending;
            if (operation == null) { call.resolve(); return; }
            if (operation.call != null) operation.call.reject("Native sign-in was cancelled.", "CANCELLED");
            operation.call = null;
            operation.cancellation.cancel();
            // CancellationSignal targets this operation only; late callbacks cannot affect a retry.
            pending = null;
            call.resolve();
        });
    }

    private void finish(Operation operation) {
        operation.call = null;
        if (pending == operation) pending = null;
    }

    @Override protected void handleOnDestroy() {
        if (pending != null) {
            if (pending.call != null) pending.call.reject("Native sign-in was cancelled.", "CANCELLED");
            pending.call = null;
            pending.cancellation.cancel();
            pending = null;
        }
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
        final CancellationSignal cancellation = new CancellationSignal();
        Operation(PluginCall call) { this.call = call; }
    }
}
