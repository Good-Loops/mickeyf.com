import assert from 'node:assert/strict';
import test from 'node:test';
import { childDailyUsageEnabled, childDailyUsageReceiptRetentionEnabled } from './childDailyUsageConfig';

test('daily usage is off by default and requires each dependency when enabled', () => {
    const ready = { childAudience: true, signedForms: true, accountDeletion: true, maintenance: true, receiptRetention: true };
    assert.equal(childDailyUsageEnabled({}, ready), false);
    assert.equal(childDailyUsageEnabled({ CHILD_DAILY_USAGE_ENABLED: 'false' }, ready), false);
    assert.throws(() => childDailyUsageEnabled({ CHILD_DAILY_USAGE_ENABLED: 'true' }, ready), /parent notice and consent/);
    assert.throws(() => childDailyUsageEnabled({ CHILD_DAILY_USAGE_ENABLED: 'yes' }, ready));
    for (const key of Object.keys(ready) as Array<keyof typeof ready>) {
        assert.throws(() => childDailyUsageEnabled({ CHILD_DAILY_USAGE_ENABLED: 'true' }, { ...ready, [key]: false }));
    }
});

test('receipt cleanup remains independently enabled when collection is off', () => {
    assert.equal(childDailyUsageReceiptRetentionEnabled({}, true), false);
    assert.equal(childDailyUsageReceiptRetentionEnabled({ CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED: 'true' }, true), true);
    assert.throws(() => childDailyUsageReceiptRetentionEnabled({ CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED: 'true' }, false));
    assert.throws(() => childDailyUsageReceiptRetentionEnabled({ CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED: 'yes' }, true));
});
