import assert from 'node:assert/strict';
import test from 'node:test';
import { runChildDailyUsageSchema } from './runChildDailyUsageSchema';

test('daily schema CLI rejects arbitrary commands, SQL paths and unbound flags before reading credentials', async () => {
    for (const args of [[], ['apply'], ['verify', '--pins', 'file'], ['plan', '--sql', 'file'],
        ['apply', '--pins', 'file', '--force'], ['rollback'], ['plan', '--pins', '']]) {
        await assert.rejects(runChildDailyUsageSchema(args, {}), /Daily usage schema command blocked/u);
    }
});
