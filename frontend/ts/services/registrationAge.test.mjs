import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationAge, readNativeAgeRange, PARENT_RESTRICTION_MS } from './registrationAge.ts';

const shared = (minimumAge, maximumAge) => ({ status: 'shared', minimumAge, maximumAge });
const unavailable = { status: 'unavailable', minimumAge: null, maximumAge: null };
const store = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };
const fixture = (range, storage = store()) => createRegistrationAge({ storage: () => storage, load: async () => ({ request: async () => range }) });

test('native range parser rejects extra identifiers, invalid/open-empty ranges and contradictory statuses', () => {
    for (const invalid of [null, {}, [], shared(null, null), shared(18, 17), shared(-1, 12), shared(13.5, 17),
        shared(151, null), { ...shared(18, null), installId: 'must-not-cross-bridge' },
        { status: 'not-shared', minimumAge: 18, maximumAge: null }, { ...unavailable, status: 'verified-adult' }]) {
        assert.deepEqual(readNativeAgeRange(invalid), unavailable);
    }
    for (const valid of [shared(null, 12), shared(0, 12), shared(13, 15), shared(16, 17), shared(18, null), unavailable]) {
        assert.deepEqual(readNativeAgeRange(valid), valid);
    }
});

test('shared ranges use the youngest possible age and never weaken a selected minor path', async () => {
    for (const [range, selected, threshold, expected] of [
        [shared(null, 12), 'adult', 13, 'parent-required'],
        [shared(12, 18), 'adult', 13, 'parent-required'],
        [shared(13, 15), 'adult', 13, 'minor'],
        [shared(16, 17), 'adult', 18, 'parent-required'],
        [shared(18, null), 'minor', 13, 'minor'],
        [shared(18, null), 'adult', 18, 'adult'],
    ]) assert.equal(await fixture(range).check(selected, threshold), expected);
});

test('native refusal, unsupported OS, verification, failure and malformed data never become adult evidence', async () => {
    for (const status of ['not-shared', 'verification-required', 'unsupported', 'unavailable']) {
        assert.equal(await fixture({ status, minimumAge: null, maximumAge: null }).check('adult', 13), null);
    }
    assert.equal(await fixture({ status: 'shared', minimumAge: null, maximumAge: null }).check('adult', 13), null);
    const throwing = createRegistrationAge({ storage: () => store(), load: async () => { throw new Error('private'); } });
    assert.equal(await throwing.check('adult', 13), null);
    const web = createRegistrationAge({ storage: () => store(), load: async () => null });
    assert.equal(await web.check('minor', 13), 'minor');
});

test('a parent-required observation survives remount, adult retry and country switch without persisting ages', async () => {
    const storage = store();
    assert.equal(await fixture(shared(0, 12), storage).check('adult', 13), 'parent-required');
    assert.equal(storage.values.size, 1);
    assert.match([...storage.values.values()][0], /^[0-9]{13}$/u);
    const remounted = fixture(shared(18, null), storage);
    assert.equal(remounted.parentRequired(), true);
    assert.equal(await remounted.check('adult', 18), 'parent-required');
});

test('restriction expires after24h and cannot be extended by repeatedly reading or retrying', async () => {
    const storage = store(); let now = 1_790_000_000_000;
    const age = createRegistrationAge({ storage: () => storage, now: () => now, load: async () => null });
    assert.equal(await age.check('parent-required', 13), 'parent-required');
    const expiry = [...storage.values.values()][0];
    now += PARENT_RESTRICTION_MS - 1;
    assert.equal(await age.check('adult', 13), 'parent-required');
    assert.equal([...storage.values.values()][0], expiry);
    now++;
    assert.equal(age.parentRequired(), false);
    assert.equal(storage.values.size, 0);
});

test('blocked storage fails protectively; an in-flight adult response cannot erase a later parent requirement', async () => {
    const blocked = createRegistrationAge({ storage: () => { throw new Error('blocked'); }, load: async () => null });
    assert.equal(await blocked.check('adult', 13), 'parent-required');
    let finish; const pending = new Promise(resolve => { finish = resolve; });
    const age = createRegistrationAge({ storage: () => store(), load: async () => ({ request: () => pending }) });
    const earlier = age.check('adult', 13);
    assert.equal(await age.check('parent-required', 13), 'parent-required');
    finish(shared(18, null));
    assert.equal(await earlier, 'parent-required');
});
