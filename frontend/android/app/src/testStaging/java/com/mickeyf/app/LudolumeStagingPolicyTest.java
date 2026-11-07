package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;

public class LudolumeStagingPolicyTest {
    @Test public void stagingAcceptsOnlyItsConfiguredOrigin() {
        assertTrue(BuildConfig.DEBUG);
        assertTrue(BuildConfig.LUDOLUME_STAGING);
        if (BuildConfig.LUDOLUME_STAGING_HOST.isEmpty()) {
            assertNull(LudolumeApiPolicy.request("https://ludolume-device-test.a.run.app/auth/registration/config", "GET", null));
            return;
        }
        assertEquals(BuildConfig.LUDOLUME_STAGING_HOST, LudolumeApiPolicy.HOST);
        assertNotNull(LudolumeApiPolicy.request(LudolumeApiPolicy.ORIGIN + "/auth/registration/config", "GET", null));
        assertNull(LudolumeApiPolicy.request("https://mickeyf-org-j7yuum4tiq-uc.a.run.app/auth/registration/config", "GET", null));
        assertNull(LudolumeApiPolicy.request("https://other.a.run.app/auth/registration/config", "GET", null));
    }
}
