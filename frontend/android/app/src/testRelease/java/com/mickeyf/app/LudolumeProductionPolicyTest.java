package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class LudolumeProductionPolicyTest {
    @Test public void releaseRemainsPinnedToProduction() {
        assertFalse(BuildConfig.DEBUG);
        assertFalse(BuildConfig.LUDOLUME_STAGING);
        assertEquals("mickeyf-org-j7yuum4tiq-uc.a.run.app", LudolumeApiPolicy.HOST);
        assertNull(LudolumeApiPolicy.request("https://ludolume-device-test.a.run.app/auth/registration/config", "GET", null));
    }
}
