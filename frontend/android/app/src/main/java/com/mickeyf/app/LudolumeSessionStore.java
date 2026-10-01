package com.mickeyf.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.Cookie;
import okhttp3.HttpUrl;

/** A single private session cookie. No WebView/global cookie jar or bridge cookie API. */
final class LudolumeSessionStore {
    private static final String KEY_ALIAS = "ludolume.api.session.v1";
    private static final byte[] AAD = LudolumeApiPolicy.ORIGIN.getBytes(StandardCharsets.UTF_8);
    private final AtomicFile file;
    private final SecretKey key;
    private Cookie cookie;

    LudolumeSessionStore(Context context) throws Exception {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "api-session.v1"));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            // Never replace a missing key for an existing encrypted session silently.
            if (file.getBaseFile().exists()) throw new IOException("Session storage unavailable");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        key = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (file.getBaseFile().exists()) {
            if (file.getBaseFile().length() > 8192) throw new IOException("Invalid session storage");
            byte[] data = file.readFully();
            if (data.length < 28) throw new IOException("Invalid session storage");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12)));
            cipher.updateAAD(AAD);
            String value = new String(cipher.doFinal(data, 12, data.length - 12), StandardCharsets.UTF_8);
            if (!value.isEmpty()) {
                Cookie saved = Cookie.parse(HttpUrl.get(LudolumeApiPolicy.ORIGIN), value);
                if (saved == null || !acceptable(saved) || !saved.persistent()) throw new IOException("Invalid session storage");
                cookie = saved;
            }
        }
    }

    String header() {
        return cookie != null && cookie.expiresAt() > System.currentTimeMillis() ? cookie.name() + "=" + cookie.value() : null;
    }

    void update(Cookie next) throws Exception {
        if (!acceptable(next)) return;
        save(next.expiresAt() > System.currentTimeMillis() ? next : null);
    }

    void clear() throws Exception { save(null); }

    private void save(Cookie next) throws Exception {
        // Session cookies stay in memory; only server-issued persistent expiry enables disk storage.
        String value = next != null && next.persistent() ? next.toString() : "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] output = ByteBuffer.allocate(12 + encrypted.length).put(cipher.getIV()).put(encrypted).array();
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(output);
            file.finishWrite(stream);
        } catch (IOException error) {
            if (stream != null) file.failWrite(stream);
            throw error;
        }
        cookie = next;
    }

    static boolean acceptable(Cookie value) {
        return value.name().equals("session") && value.domain().equals(LudolumeApiPolicy.HOST)
            && value.hostOnly() && value.path().equals("/") && value.secure() && value.httpOnly()
            && value.value().length() <= 4096;
    }
}
