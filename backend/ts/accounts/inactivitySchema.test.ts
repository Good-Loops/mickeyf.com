import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ACTIVITY_DRAFT_SQL, WARNING_DRAFT_SQL, assertActivityDraft, assertWarningDraft } from './inactivitySchema.testFixture';

test('fixed test SQL matches both reviewed drafts and rejects changed statements', () => {
    const draft = (name: string) => readFileSync(path.resolve(__dirname, '../../migrations/pending', name), 'utf8');
    assertActivityDraft(draft('draft_create_parent_managed_child_activity.sql'));
    assertWarningDraft(draft('draft_parent_child_inactivity_warnings.sql'));
    for (const [check, sql] of [[assertActivityDraft, ACTIVITY_DRAFT_SQL], [assertWarningDraft, WARNING_DRAFT_SQL]] as const) {
        assert.doesNotThrow(() => check(`${sql.replace(/\n/gu, '\r\n')}\r\n`));
        assert.throws(() => check(`${sql}\nDROP TABLE users;\n`));
    }
});
