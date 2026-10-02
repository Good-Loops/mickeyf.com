package com.mickeyf.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import okhttp3.Cookie;
import okhttp3.HttpUrl;

/** Single private cookie; the plugin's serial executor owns every read, write and reset. */
final class LudolumeSessionStore {
    private static final String KEY_ALIAS = "ludolume.api.session.v1";
    private static final byte[] AAD = LudolumeApiPolicy.ORIGIN.getBytes(StandardCharsets.UTF_8);
    private static final int MAX_STORED_BYTES = 8192;

    interface Storage {
        byte[] read() throws Exception;
        void write(byte[] value) throws Exception;
        void clear() throws Exception;
    }
    interface Keys {
        SecretKey load(boolean hasStoredValue) throws Exception;
        void reset() throws Exception;
    }
    static final class CorruptSessionException extends IOException {
        final boolean resetKey;
        CorruptSessionException(boolean resetKey) { super("Saved sign-in requires local reset"); this.resetKey = resetKey; }
    }

    private final Storage storage;
    private final SecretKey key;
    private Cookie cookie;

    LudolumeSessionStore(Context context) throws Exception { this(new DiskStorage(context), new AndroidKeys()); }

    LudolumeSessionStore(Storage storage, Keys keys) throws Exception {
        this.storage = storage;
        byte[] data = storage.read();
        if (data != null && (data.length < 28 || data.length > MAX_STORED_BYTES)) throw new CorruptSessionException(false);
        try {
            key = keys.load(data != null);
            if (data == null) return;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(data, 0, 12)));
            cipher.updateAAD(AAD);
            String value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(cipher.doFinal(data, 12, data.length - 12))).toString();
            if (!value.isEmpty()) {
                Cookie saved = Cookie.parse(HttpUrl.get(LudolumeApiPolicy.ORIGIN), value);
                if (saved == null || !acceptable(saved) || !saved.persistent()) throw new CorruptSessionException(false);
                cookie = saved;
            }
        } catch (KeyPermanentlyInvalidatedException error) {
            throw new CorruptSessionException(true);
        } catch (BadPaddingException | IllegalBlockSizeException | CharacterCodingException error) {
            throw new CorruptSessionException(false);
        }
    }

    String header() {
        return cookie != null && cookie.expiresAt() > System.currentTimeMillis() ? cookie.name() + "=" + cookie.value() : null;
    }

    void update(Cookie next) throws Exception {
        if (acceptable(next)) save(next.expiresAt() > System.currentTimeMillis() ? next : null);
    }

    void updateFromResponse(Iterable<Cookie> values) throws Exception {
        Cookie last = null;
        for (Cookie value : values) if (acceptable(value)) last = value;
        if (last != null) update(last);
    }

    void clear() throws Exception { save(null); }

    static LudolumeSessionStore resetCorrupt(Context context) throws Exception {
        return resetCorrupt(new DiskStorage(context), new AndroidKeys());
    }

    /** Only after explicit local-reset confirmation; transient failures must never erase data. */
    static LudolumeSessionStore resetCorrupt(Storage storage, Keys keys) throws Exception {
        try { return new LudolumeSessionStore(storage, keys); }
        catch (CorruptSessionException error) {
            if (error.resetKey) keys.reset();
            storage.clear();
            return new LudolumeSessionStore(storage, keys);
        }
    }

    private void save(Cookie next) throws Exception {
        String value = next != null && next.persistent() ? next.toString() : "";
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv.length != 12) throw new IOException("Session storage unavailable");
            byte[] output = ByteBuffer.allocate(12 + encrypted.length).put(iv).put(encrypted).array();
            storage.write(output);
            if (!Arrays.equals(output, storage.read())) throw new IOException("Session write not confirmed");
            cookie = next; // No in-memory login/logout until persistence is confirmed.
        } catch (KeyPermanentlyInvalidatedException error) { throw new CorruptSessionException(true); }
    }

    static boolean acceptable(Cookie value) {
        return value != null && value.name().equals("session") && value.domain().equals(LudolumeApiPolicy.HOST)
            && value.hostOnly() && value.path().equals("/") && value.secure() && value.httpOnly()
            && value.value().length() <= 4096;
    }

    private static final class AndroidKeys implements Keys {
        private KeyStore open() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); return store;
        }
        public SecretKey load(boolean hasStoredValue) throws Exception {
            KeyStore store = open();
            if (!store.containsAlias(KEY_ALIAS)) {
                if (hasStoredValue) throw new CorruptSessionException(false);
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
            }
            java.security.Key loaded = store.getKey(KEY_ALIAS, null);
            if (!(loaded instanceof SecretKey)) throw new IOException("Session key unavailable");
            return (SecretKey) loaded;
        }
        public void reset() throws Exception { open().deleteEntry(KEY_ALIAS); }
    }

    private static final class DiskStorage implements Storage {
        private final AtomicFile file;
        DiskStorage(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "api-session.v1")); }
        public byte[] read() throws Exception {
            try (FileInputStream input = file.openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (count > MAX_STORED_BYTES - output.size()) throw new CorruptSessionException(false);
                    output.write(buffer, 0, count);
                }
                return output.toByteArray();
            } catch (FileNotFoundException error) {
                if (file.getBaseFile().exists() || !file.getBaseFile().getParentFile().canRead()) throw error;
                return null;
            }
        }
        public void write(byte[] value) throws Exception {
            FileOutputStream stream = null;
            try {
                stream = file.startWrite(); stream.write(value); stream.getFD().sync();
                file.finishWrite(stream); stream = null;
            } catch (IOException error) {
                if (stream != null) file.failWrite(stream);
                throw error;
            }
        }
        public void clear() throws Exception {
            file.delete();
            if (read() != null) throw new IOException("Local session reset not confirmed");
        }
    }
}
