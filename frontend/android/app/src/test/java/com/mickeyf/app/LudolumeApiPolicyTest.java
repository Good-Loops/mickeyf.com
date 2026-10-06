package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;
import okhttp3.Cookie;
import okhttp3.HttpUrl;
import okhttp3.Request;

public class LudolumeApiPolicyTest {
    @Test public void parentRegistrationAllowsOnlyItsSevenExactMethodPaths() {
        String base = LudolumeApiPolicy.ORIGIN + "/auth/parent-registration/";
        assertNotNull(LudolumeApiPolicy.request(base + "config", "GET", null));
        assertNull(LudolumeApiPolicy.request(base + "config", "GET", "{}"));
        assertNull(LudolumeApiPolicy.request(base + "config", "POST", "{}"));
        for (String route : new String[] { "begin", "complete", "cancel", "children", "withdraw", "children/list" }) {
            assertNotNull(route, LudolumeApiPolicy.request(base + route, "POST", "{}"));
            assertNull(route, LudolumeApiPolicy.request(base + route, "GET", null));
            assertNull(route, LudolumeApiPolicy.request(base + route + "?extra=1", "POST", "{}"));
            assertNull(route, LudolumeApiPolicy.request(base + route + "/", "POST", "{}"));
        }
        assertNull(LudolumeApiPolicy.request(base + "children/delete", "POST", "{}"));
        assertNull(LudolumeApiPolicy.request("https://attacker.test/auth/parent-registration/children", "POST", "{}"));
    }

    @Test public void registrationAllowsOnlyItsThreeExactMethodPaths() {
        String origin = LudolumeApiPolicy.ORIGIN;
        assertNotNull(LudolumeApiPolicy.request(origin + "/auth/registration/config", "GET", null));
        for (String route : new String[] { "begin", "cancel" }) {
            assertNotNull(LudolumeApiPolicy.request(origin + "/auth/registration/" + route, "POST", "{}"));
            assertNull(LudolumeApiPolicy.request(origin + "/auth/registration/" + route, "GET", null));
            assertNull(LudolumeApiPolicy.request(origin + "/auth/registration/" + route + "?extra=1", "POST", "{}"));
        }
        assertNull(LudolumeApiPolicy.request(origin + "/auth/registration/config", "POST", "{}"));
        assertNull(LudolumeApiPolicy.request(origin + "/auth/registration/approve", "POST", "{}"));
    }
    @Test public void permitsOnlyExactSessionApiRoutesAndNativeHeaders() {
        Request request = LudolumeApiPolicy.request(LudolumeApiPolicy.ORIGIN + "/auth/providers/begin", "POST", "{}");
        assertNotNull(request);
        assertEquals("capacitor://localhost", request.header("Origin"));
        assertNull(request.header("Cookie"));
        for (String address : new String[] {
            "http://" + LudolumeApiPolicy.HOST + "/auth/verify-token",
            LudolumeApiPolicy.ORIGIN + ":443/auth/verify-token",
            LudolumeApiPolicy.ORIGIN + "/auth/verify-token?redirect=1",
            LudolumeApiPolicy.ORIGIN + "/auth/verify-token#fragment",
            LudolumeApiPolicy.ORIGIN + "/api/../auth/verify-token",
            LudolumeApiPolicy.ORIGIN + "/auth/%76erify-token",
            "https://attacker.test/auth/verify-token", "https://user@" + LudolumeApiPolicy.HOST + "/auth/verify-token",
            LudolumeApiPolicy.ORIGIN + "/internal/maintenance/apple"
        }) assertNull(address, LudolumeApiPolicy.request(address, "GET", null));
        assertNull(LudolumeApiPolicy.request(LudolumeApiPolicy.ORIGIN + "/auth/verify-token", "POST", "{}"));
        assertNull(LudolumeApiPolicy.request(LudolumeApiPolicy.ORIGIN + "/auth/verify-token", "GET", "{}"));
    }

    @Test public void limitsRequestBytesRatherThanCharacters() {
        String url = LudolumeApiPolicy.ORIGIN + "/auth/providers/complete";
        assertNotNull(LudolumeApiPolicy.request(url, "POST", new String(new char[32768]).replace('\0', 'a')));
        assertNull(LudolumeApiPolicy.request(url, "POST", new String(new char[32769]).replace('\0', 'a')));
        assertNull(LudolumeApiPolicy.request(url, "POST", new String(new char[16385]).replace('\0', '\u00e9')));
    }

    @Test public void acceptsOnlyPrivateHostSessionCookiesIncludingServerExpiry() {
        HttpUrl url = HttpUrl.get(LudolumeApiPolicy.ORIGIN);
        assertTrue(LudolumeSessionStore.acceptable(Cookie.parse(url, "session=synthetic; Path=/; Secure; HttpOnly")));
        assertTrue(LudolumeSessionStore.acceptable(Cookie.parse(url, "session=; Path=/; Secure; HttpOnly; Max-Age=0")));
        for (String value : new String[] { "session=synthetic; Path=/; Secure", "session=synthetic; Path=/; HttpOnly",
            "session=synthetic; Path=/auth; Secure; HttpOnly", "__session=synthetic; Path=/; Secure; HttpOnly",
            "session=synthetic; Path=/; Secure; HttpOnly; Domain=" + LudolumeApiPolicy.HOST }) {
            assertFalse(value, LudolumeSessionStore.acceptable(Cookie.parse(url, value)));
        }
    }
}
