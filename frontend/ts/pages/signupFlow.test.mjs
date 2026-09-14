import assert from 'node:assert/strict';
import test from 'node:test';
import { signupAndLogin } from './signupFlow.ts';

const payload = {
    user_name: '  New Player  ',
    email: 'player@example.test',
    user_password: '  unchanged password  ',
};

function deferred() {
    let resolve;
    const promise = new Promise((finish) => { resolve = finish; });
    return { promise, resolve };
}

test('waits for account creation, then login, preserving the exact credentials', async () => {
    const registration = deferred();
    const authentication = deferred();
    const calls = [];
    let settled = false;
    const resultPromise = signupAndLogin(payload, {
        signup: (received) => {
            assert.equal(received, payload);
            calls.push('signup');
            return registration.promise;
        },
        login: (userName, password, options) => {
            calls.push(['login', userName, password, options]);
            return authentication.promise;
        },
    }).then((result) => {
        settled = true;
        return result;
    });

    assert.deepEqual(calls, ['signup']);
    assert.equal(settled, false);
    registration.resolve({ success: true });
    await Promise.resolve();
    assert.deepEqual(calls, ['signup', ['login', payload.user_name, payload.user_password, { rememberMe: false }]]);
    assert.equal(settled, false);

    authentication.resolve(true);
    assert.deepEqual(await resultPromise, { status: 'authenticated' });
    assert.equal(calls.length, 2);
});

for (const rememberMe of [false, true]) {
    test(`passes stay-signed-in ${rememberMe} only to automatic login, not account creation`, async () => {
        let loginCalls = 0;
        const result = await signupAndLogin(payload, {
            signup: async (received) => {
                assert.equal(received, payload);
                assert.deepEqual(Object.keys(received).sort(), ['email', 'user_name', 'user_password']);
                return { success: true };
            },
            login: async (userName, password, options) => {
                loginCalls += 1;
                assert.equal(userName, payload.user_name);
                assert.equal(password, payload.user_password);
                assert.deepEqual(options, { rememberMe });
                return true;
            },
        }, { rememberMe });
        assert.deepEqual(result, { status: 'authenticated' });
        assert.equal(loginCalls, 1);
    });
}

test('returns registration errors and their messages without attempting login', async () => {
    const result = await signupAndLogin(payload, {
        signup: async () => ({ error: 'USER_EXISTS', message: 'Choose another username.' }),
        login: async () => assert.fail('A rejected registration must not trigger login'),
    });
    assert.deepEqual(result, {
        status: 'rejected',
        error: 'USER_EXISTS',
        message: 'Choose another username.',
    });
});

test('requires explicit registration success before attempting login', async () => {
    for (const response of [null, undefined, {}, { success: false }, { success: 'true' }, { error: '' }]) {
        await assert.rejects(signupAndLogin(payload, {
            signup: async () => response,
            login: async () => assert.fail('An unconfirmed registration must not trigger login'),
        }), { message: 'Unexpected signup response' });
    }
});

test('propagates signup transport failures without attempting login', async () => {
    const networkError = new TypeError('Network request failed');
    await assert.rejects(signupAndLogin(payload, {
        signup: async () => { throw networkError; },
        login: async () => assert.fail('A failed signup request must not trigger login'),
    }), (error) => error === networkError);
});

for (const loginFailsBy of ['returning false', 'rejecting']) {
    test(`preserves account creation when login fails by ${loginFailsBy}`, async () => {
        let signupCalls = 0;
        let loginCalls = 0;
        const result = await signupAndLogin(payload, {
            signup: async () => {
                signupCalls += 1;
                return { success: true };
            },
            login: async (_userName, _password, options) => {
                loginCalls += 1;
                assert.deepEqual(options, { rememberMe: true });
                if (loginFailsBy === 'rejecting') throw new Error('Login network failure');
                return false;
            },
        }, { rememberMe: true });
        assert.deepEqual(result, { status: 'login-required' });
        assert.equal(signupCalls, 1);
        assert.equal(loginCalls, 1);
    });
}
