import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const [platform, file] of [
    ['Android', '../../android/app/src/main/java/com/mickeyf/app/LudolumeApiPolicy.java'],
    ['iOS', '../../ios/App/App/LudolumeApiPlugin.swift'],
]) test(`${platform} bridge lists only the exact daily usage routes`, async () => {
    const native = await readFile(new URL(file, import.meta.url), 'utf8');
    const routes = [...native.matchAll(/"((?:GET|POST) \/auth\/child-daily-usage\/[^"\n]+)"/g)].map(match => match[1]);
    assert.deepEqual(routes.sort(), [
        'POST /auth/child-daily-usage/clear', 'POST /auth/child-daily-usage/get',
        'POST /auth/child-daily-usage/heartbeat', 'POST /auth/child-daily-usage/set',
    ]);
});
