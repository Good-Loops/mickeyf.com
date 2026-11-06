import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from './childDailyUsageNotice';

test('the consent version identifies the reviewed bilingual notice', () => {
    const notice = require('../../../shared/childDailyUsageNotice.json');
    assert.equal(CHILD_DAILY_USAGE_NOTICE_VERSION, 'child-daily-usage-consent-2026-11-06.2');
    assert.equal(createHash('sha256').update(JSON.stringify(notice)).digest('hex'),
        '74657c2261f6bfdd6af8058e96378a5bfba7dd828558da85499c982542dd10b2');
});
