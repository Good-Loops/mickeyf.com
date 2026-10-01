package com.mickeyf.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** A cookie response is usable only after its complete bounded UTF-8 body has arrived. */
final class LudolumeResponseBody {
    static String read(InputStream input, long declaredLength) throws IOException {
        if (declaredLength > LudolumeApiPolicy.MAX_RESPONSE) throw new IOException();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        for (int count; (count = input.read(chunk)) != -1;) {
            if (count > LudolumeApiPolicy.MAX_RESPONSE - bytes.size()) throw new IOException();
            bytes.write(chunk, 0, count);
        }
        if (declaredLength >= 0 && bytes.size() != declaredLength) throw new IOException();
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
    }
}
