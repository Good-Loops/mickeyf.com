import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from './childDailyUsageNotice';

test('the consent version identifies the reviewed bilingual notice', () => {
    const notice = require('../../../shared/childDailyUsageNotice.json');
    assert.equal(CHILD_DAILY_USAGE_NOTICE_VERSION, 'child-daily-usage-consent-2026-11-06.1');
    assert.equal(createHash('sha256').update(JSON.stringify(notice)).digest('hex'),
        '14efa1c60f1f55224cced74d56010a7a2308f193a4d25976a49be90a09dd5a6f');
});
