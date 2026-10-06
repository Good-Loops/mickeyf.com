package com.mickeyf.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LudolumeApiPlugin.class);
        registerPlugin(LudolumeIdentityPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
