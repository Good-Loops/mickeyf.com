import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRegionalAge } from './regionalAge.ts';

const shared = { status: 'shared', minimumAge: 13, maximumAge: 15 };
const make = (region, range = shared) => {
    let prompts = 0;
    return {
        prompts: () => prompts,
        options: { isIos: () => true, load: () => ({
            checkRegionalAge: async () => region,
            requestAgeRange: async () => { prompts++; return range; },
        }) },
    };
};

test('web and Android do not invoke the iOS regional bridge', async () => {
    assert.equal(await checkRegionalAge({ isIos: () => false, load: () => { throw Error('must not load'); } }), 'continue');
});

test('unregulated and unsupported iOS versions do not ask for age', async () => {
    for (const [status, expected] of [['not-required', 'continue'], ['unsupported', 'unknown']]) {
        const fixture = make({ status });
        assert.equal(await checkRegionalAge(fixture.options), expected);
        assert.equal(fixture.prompts(), 0);
    }
});

test('regulated users need a valid shared range; no range is returned to the caller', async () => {
    for (const range of [shared, { status: 'shared', minimumAge: 18, maximumAge: null }]) {
        const fixture = make({ status: 'required' }, range);
        assert.equal(await checkRegionalAge(fixture.options), 'shared');
        assert.equal(fixture.prompts(), 1);
    }
    for (const range of [null, {}, { status: 'not-shared', minimumAge: null, maximumAge: null },
        { status: 'shared', minimumAge: 16, maximumAge: 12 }, { ...shared, identifier: 'not-accepted' }]) {
        assert.equal(await checkRegionalAge(make({ status: 'required' }, range).options), 'required-unavailable');
    }
});

test('unavailable or malformed regional status never implies that age was checked', async () => {
    for (const region of [null, {}, { status: 'unavailable' }, { status: 'required', identifier: 'not-accepted' }]) {
        const fixture = make(region);
        assert.equal(await checkRegionalAge(fixture.options), 'unknown');
        assert.equal(fixture.prompts(), 0);
    }
    assert.equal(await checkRegionalAge({ isIos: () => true, load: () => { throw Error('private'); } }), 'unknown');
});

test('timed-out region checks and mandatory age requests have distinct outcomes', async () => {
    const never = () => new Promise(() => {});
    assert.equal(await checkRegionalAge({ isIos: () => true, regionTimeoutMs: 5,
        load: () => ({ checkRegionalAge: never, requestAgeRange: never }) }), 'unknown');
    assert.equal(await checkRegionalAge({ isIos: () => true, promptTimeoutMs: 5,
        load: () => ({ checkRegionalAge: async () => ({ status: 'required' }), requestAgeRange: never }) }), 'required-unavailable');
});
