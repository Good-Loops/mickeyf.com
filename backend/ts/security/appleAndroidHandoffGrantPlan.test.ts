import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAppleAndroidHandoffGrantPlan } from './appleAndroidHandoffGrantPlan';

test('Android handoff proposal grants only exact table/columns to the existing runtime identity', () => {
    const plan = renderAppleAndroidHandoffGrantPlan();
    assert.equal(plan.length, 4);
    assert.equal(Object.isFrozen(plan), true);
    for (const sql of plan) {
        assert.match(sql, / ON `cms`\.`apple_android_handoffs` TO 'cms_mickeyf'@'%';$/u);
        assert.doesNotMatch(sql, /\b(?:ALL|WITH GRANT|ALTER|CREATE|DROP|EXECUTE|IDENTIFIED)\b/iu);
    }
    assert.match(plan[1], /^GRANT INSERT \([^)]*phase, created_at, expires_at\)/u);
    assert.doesNotMatch(plan[1], /encrypted_credential/u);
    assert.match(plan[2], /^GRANT UPDATE \(phase, encrypted_credential\)/u);
});
