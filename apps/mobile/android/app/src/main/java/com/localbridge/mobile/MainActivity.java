package com.localbridge.mobile;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static volatile boolean foreground;

    public static boolean isForeground() {
        return foreground;
    }

    @Override
    public void onStart() {
        super.onStart();
        foreground = true;
    }

    @Override
    public void onStop() {
        foreground = false;
        super.onStop();
    }
}
