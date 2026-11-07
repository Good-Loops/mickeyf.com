import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { androidReleaseEnvironment } from './build-child-release.mjs';

test('qualified Android build explicitly packages both child lifecycle features', () => {
    assert.throws(() => androidReleaseEnvironment([], {}), /qualified-android/);
    assert.throws(() => androidReleaseEnvironment(['--qualified-android'], { VITE_ENABLE_CHILD_ONLINE_ACTIVITY: '0' }), /conflicts/);
    const env = androidReleaseEnvironment(['--qualified-android'], {});
    assert.equal(env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY, '1');
    assert.equal(env.VITE_ENABLE_CHILD_INACTIVITY_WARNING, '1');
    assert.equal(env.VITE_ENABLE_CHILD_DAILY_USAGE, '0');
    assert.equal(env.VITE_PROD_API_URL, 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app');
    assert.equal(androidReleaseEnvironment(['--qualified-android', '--qualified-daily-usage'], {}).VITE_ENABLE_CHILD_DAILY_USAGE, '1');
    assert.throws(() => androidReleaseEnvironment(['--qualified-daily-usage'], {}), /qualified-android/);
    assert.throws(() => androidReleaseEnvironment(['--qualified-android'], { VITE_ENABLE_CHILD_DAILY_USAGE: '1' }), /conflicts/);
});

test('website and native workflows use the same paired opt-in and default-off selection', async () => {
    const expression = "${{ (inputs.child_lifecycle == 'on' || (inputs.child_lifecycle != 'off' && vars.LUDOLUME_CHILD_LIFECYCLE_RELEASE == '1')) && '1' || '0' }}";
    const usageExpression = "${{ (inputs.child_daily_usage == 'on' || (inputs.child_daily_usage != 'off' && vars.LUDOLUME_CHILD_DAILY_USAGE_RELEASE == '1')) && '1' || '0' }}";
    for (const [name, expected] of [['ios-build.yml', 3], ['firebase-hosting-merge.yml', 1], ['registration-pause-website.yml', 1]]) {
        const source = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
        assert.match(source, /default: follow-repository/);
        for (const flag of ['VITE_ENABLE_CHILD_ONLINE_ACTIVITY', 'VITE_ENABLE_CHILD_INACTIVITY_WARNING']) {
            const values = [...source.matchAll(new RegExp(`^\\s*${flag}: (.+)$`, 'gm'))].map(match => match[1].trim());
            assert.equal(values.length, expected, `${name}: ${flag}`);
            for (const value of values) assert.equal(value, expression, `${name}: ${flag}`);
        }
        const usage = [...source.matchAll(/^\s*VITE_ENABLE_CHILD_DAILY_USAGE: (.+)$/gm)].map(match => match[1].trim());
        assert.equal(usage.length, expected, `${name}: daily usage`);
        for (const value of usage) assert.equal(value, usageExpression, `${name}: daily usage`);
    }
});
