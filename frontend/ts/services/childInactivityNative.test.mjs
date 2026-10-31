import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const [platform, file] of [
    ['Android', '../../android/app/src/main/java/com/mickeyf/app/LudolumeApiPolicy.java'],
    ['iOS', '../../ios/App/App/LudolumeApiPlugin.swift'],
]) test(`${platform} bridge permits only the exact child warning routes`, async () => {
    const native = await readFile(new URL(file, import.meta.url), 'utf8');
    const routes = [...native.matchAll(/"((?:GET|POST) \/auth\/child-inactivity\/[^"\n]+)"/g)].map(match => match[1]);
    assert.deepEqual(routes.sort(), ['POST /auth/child-inactivity/acknowledge', 'POST /auth/child-inactivity/warning']);
});
