import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('iOS staging is debug-only, requires a separate bundle ID and does not fall back to production', async () => {
    const source = await readFile(new URL('../../ios/App/App/LudolumeApiPlugin.swift', import.meta.url), 'utf8');
    assert.match(source, /#if LUDOLUME_STAGING && !DEBUG\s+#error\(/);
    assert.match(source, /bundleIdentifier == "com\.mickeyf\.app\.staging"/);
    assert.match(source, /host != "mickeyf-org-j7yuum4tiq-uc\.a\.run\.app"/);
    assert.match(source, /else \{ return "" \}/);
    assert.match(source, /guard !host\.isEmpty, let address/);
    assert.match(source, /#else\s+static let host = "mickeyf-org-j7yuum4tiq-uc\.a\.run\.app"\s+#endif/);
});
