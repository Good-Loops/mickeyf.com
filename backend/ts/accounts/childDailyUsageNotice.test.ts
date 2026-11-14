import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from './childDailyUsageNotice';

test('the consent version identifies the reviewed bilingual notice', () => {
    const notice = require('../../../shared/childDailyUsageNotice.json');
    assert.equal(CHILD_DAILY_USAGE_NOTICE_VERSION, 'child-daily-usage-consent-2026-11-06.3');
    assert.equal(createHash('sha256').update(JSON.stringify(notice)).digest('hex'),
        '14eb9155cbc57df289f794cb9030609772f92248a26cca0539e966753b149e82');
});
