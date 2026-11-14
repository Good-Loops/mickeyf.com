package com.mickeyf.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LudolumePresentation")
public final class LudolumePresentationPlugin extends Plugin {
    @PluginMethod
    public void setFullscreen(PluginCall call) {
        Boolean active = call.getBoolean("active");
        String sessionId = call.getString("sessionId");
        Integer revision = call.getInt("revision");
        if (call.getData().length() != 3 || active == null || sessionId == null || revision == null) {
            call.reject("Invalid presentation request.", "INVALID_REQUEST");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (!(getActivity() instanceof MainActivity)
                || !((MainActivity) getActivity()).setPresentationFullscreen(active, sessionId, revision)) {
                call.reject("The presentation request is stale.", "STALE_REQUEST");
                return;
            }
            call.resolve();
        });
    }
}
