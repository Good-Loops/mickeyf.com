package com.mickeyf.app;

import static org.junit.Assert.*;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import okhttp3.Cookie;
import okhttp3.HttpUrl;

public class LudolumeSessionStoreTest {
    private static final class Disk implements LudolumeSessionStore.Storage {
        byte[] value;
        boolean failRead, failWrite, dropWrite, failClear;
        int writes, clears;
        public byte[] read() throws IOException {
            if (failRead) throw new IOException("synthetic read failure");
            return value == null ? null : value.clone();
        }
        public void write(byte[] bytes) throws IOException {
            writes++;
            if (failWrite) throw new IOException("synthetic write failure");
            if (!dropWrite) value = bytes.clone();
        }
        public void clear() throws IOException {
            if (failClear) throw new IOException("synthetic reset failure");
            clears++; value = null;
        }
    }
    private static final class Keys implements LudolumeSessionStore.Keys {
        SecretKey key;
        boolean unavailable, invalidated;
        int resets;
        public SecretKey load(boolean stored) throws Exception {
            if (unavailable) throw new IOException("synthetic transient Keystore failure");
            if (invalidated) throw new LudolumeSessionStore.CorruptSessionException(true);
            if (key == null) {
                if (stored) throw new LudolumeSessionStore.CorruptSessionException(false);
                KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); key = generator.generateKey();
            }
            return key;
        }
        public void reset() { resets++; invalidated = false; key = null; }
    }
    private static Cookie cookie(String value, boolean persistent) {
        return Cookie.parse(HttpUrl.get(LudolumeApiPolicy.ORIGIN), "session=" + value + "; Path=/; Secure; HttpOnly"
            + (persistent ? "; Max-Age=3600" : ""));
    }

    @Test public void rememberedCookieIsEncryptedAndSurvivesStoreRestart() throws Exception {
        Disk disk = new Disk(); Keys keys = new Keys();
        LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
        store.update(cookie("synthetic-remembered", true));
        assertEquals("session=synthetic-remembered", store.header());
        assertFalse(new String(disk.value, StandardCharsets.ISO_8859_1).contains("synthetic-remembered"));
        assertEquals(store.header(), new LudolumeSessionStore(disk, keys).header());
    }

    @Test public void sessionOnlyCookieAndConfirmedClearNeverReappearAfterRestart() throws Exception {
        Disk disk = new Disk(); Keys keys = new Keys();
        LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
        store.update(cookie("remembered", true));
        store.update(cookie("memory-only", false));
        assertEquals("session=memory-only", store.header());
        assertNull(new LudolumeSessionStore(disk, keys).header());
        store.update(cookie("another", true));
        store.clear();
        assertNull(store.header());
        assertNull(new LudolumeSessionStore(disk, keys).header());
    }

    @Test public void malformedPersistenceRequiresExplicitResetAndDoesNotDeleteTheKey() throws Exception {
        for (int length : new int[] {0, 27, 8193}) {
            Disk disk = new Disk(); Keys keys = new Keys(); disk.value = new byte[length];
            assertThrows(LudolumeSessionStore.CorruptSessionException.class, () -> new LudolumeSessionStore(disk, keys));
            assertEquals(0, disk.clears);
            assertNotNull(disk.value);
            assertNull(LudolumeSessionStore.resetCorrupt(disk, keys).header());
            assertEquals(1, disk.clears);
            assertEquals(0, keys.resets);
        }
    }

    @Test public void authenticatedCiphertextTamperingAndTruncationCannotBecomeCookies() throws Exception {
        Disk disk = new Disk(); Keys keys = new Keys();
        LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
        store.update(cookie("synthetic", true));
        byte[] original = disk.value.clone();
        disk.value[15] ^= 1;
        assertThrows(LudolumeSessionStore.CorruptSessionException.class, () -> new LudolumeSessionStore(disk, keys));
        disk.value = Arrays.copyOf(original, original.length - 1);
        assertThrows(LudolumeSessionStore.CorruptSessionException.class, () -> new LudolumeSessionStore(disk, keys));
        assertEquals(0, disk.clears);
        assertNull(LudolumeSessionStore.resetCorrupt(disk, keys).header());
        assertEquals(0, keys.resets);
    }

    @Test public void missingOrPermanentlyInvalidatedKeyCanRecoverOnlyAfterExplicitReset() throws Exception {
        for (boolean invalidated : new boolean[] {false, true}) {
            Disk disk = new Disk(); Keys keys = new Keys();
            new LudolumeSessionStore(disk, keys).update(cookie("synthetic", true));
            if (invalidated) keys.invalidated = true; else keys.key = null;
            assertThrows(LudolumeSessionStore.CorruptSessionException.class, () -> new LudolumeSessionStore(disk, keys));
            assertEquals(0, disk.clears);
            LudolumeSessionStore recovered = LudolumeSessionStore.resetCorrupt(disk, keys);
            assertNull(recovered.header());
            recovered.update(cookie("fresh-login", true));
            assertEquals("session=fresh-login", new LudolumeSessionStore(disk, keys).header());
            assertEquals(invalidated ? 1 : 0, keys.resets);
        }
    }

    @Test public void transientReadOrKeyFailureNeverErasesStoredSession() throws Exception {
        for (boolean keyFailure : new boolean[] {false, true}) {
            Disk disk = new Disk(); Keys keys = new Keys();
            new LudolumeSessionStore(disk, keys).update(cookie("preserved", true));
            byte[] original = disk.value.clone();
            keys.unavailable = keyFailure; disk.failRead = !keyFailure;
            Exception failure = assertThrows(IOException.class, () -> LudolumeSessionStore.resetCorrupt(disk, keys));
            assertFalse(failure instanceof LudolumeSessionStore.CorruptSessionException);
            assertArrayEquals(original, disk.value);
            assertEquals(0, disk.clears); assertEquals(0, keys.resets);
            keys.unavailable = false; disk.failRead = false;
            assertEquals("session=preserved", new LudolumeSessionStore(disk, keys).header());
        }
    }

    @Test public void healthySessionIsNotResetAndFailedResetNeverClaimsRecovery() throws Exception {
        Disk disk = new Disk(); Keys keys = new Keys();
        new LudolumeSessionStore(disk, keys).update(cookie("healthy", true));
        assertEquals("session=healthy", LudolumeSessionStore.resetCorrupt(disk, keys).header());
        assertEquals(0, disk.clears);
        disk.value = new byte[2]; disk.failClear = true;
        assertThrows(IOException.class, () -> LudolumeSessionStore.resetCorrupt(disk, keys));
        assertNotNull(disk.value);
    }

    @Test public void failedOrUnconfirmedDiskWritesCannotAdvanceMemoryOrConfirmLogout() throws Exception {
        for (boolean dropped : new boolean[] {false, true}) {
            Disk disk = new Disk(); Keys keys = new Keys();
            LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
            store.update(cookie("old", true));
            disk.failWrite = !dropped; disk.dropWrite = dropped;
            assertThrows(IOException.class, () -> store.update(cookie("new", true)));
            assertEquals("session=old", store.header());
            assertThrows(IOException.class, store::clear);
            assertEquals("session=old", new LudolumeSessionStore(disk, keys).header());
        }
    }

    @Test public void responseCookiesCommitOnlyTheLastAcceptedValueAndExpiryClearsIt() throws Exception {
        Disk disk = new Disk(); Keys keys = new Keys();
        LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
        Cookie invalid = Cookie.parse(HttpUrl.get(LudolumeApiPolicy.ORIGIN), "session=ignored; Path=/; Secure");
        store.updateFromResponse(Arrays.asList(cookie("first", true), invalid, cookie("last", true)));
        assertEquals(1, disk.writes);
        assertEquals("session=last", new LudolumeSessionStore(disk, keys).header());
        store.update(Cookie.parse(HttpUrl.get(LudolumeApiPolicy.ORIGIN), "session=; Path=/; Secure; HttpOnly; Max-Age=0"));
        assertNull(store.header());
        assertNull(new LudolumeSessionStore(disk, keys).header());
    }

    @Test public void truncatedOversizeOrMalformedResponsesDoNotReachCookieCommit() throws Exception {
        for (byte[] body : new byte[][] {new byte[] {'{'}, new byte[] {(byte)0xc3, 0x28}, new byte[LudolumeApiPolicy.MAX_RESPONSE + 1]}) {
            Disk disk = new Disk(); Keys keys = new Keys();
            LudolumeSessionStore store = new LudolumeSessionStore(disk, keys);
            store.update(cookie("before-response", true));
            int writes = disk.writes;
            assertThrows(IOException.class, () -> {
                LudolumeResponseBody.read(new ByteArrayInputStream(body), body.length == 1 ? 2 : -1);
                store.update(cookie("unconfirmed", true));
            });
            assertEquals(writes, disk.writes);
            assertEquals("session=before-response", store.header());
        }
        assertEquals("{}", LudolumeResponseBody.read(new ByteArrayInputStream(new byte[] {'{', '}'}), -1));
    }
}
