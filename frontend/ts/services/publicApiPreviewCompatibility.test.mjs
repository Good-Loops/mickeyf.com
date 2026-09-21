import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const google = { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com' };
const scenarios = [
    { name: 'default legacy public preview', mode: 'development', flag: '1', preview: true, legacy: true, apiBase: '/__public-api' },
    { name: 'explicit legacy public preview', mode: 'development', flag: '1', protocol: 'legacy', preview: true, legacy: true, apiBase: '/__public-api' },
    { name: 'renewable public preview', mode: 'development', flag: '1', protocol: 'renewable', preview: true, apiBase: '/__public-api' },
    { name: 'ordinary development', mode: 'development', flag: '0', preview: false, apiBase: 'http://local-api.test' },
    { name: 'ordinary development ignores a public-only protocol setting', mode: 'development', flag: '0', protocol: 'invalid', preview: false, apiBase: 'http://local-api.test' },
    { name: 'native development ignores preview and protocol settings', mode: 'development', native: true, flag: '1', protocol: 'invalid', preview: false, apiBase: 'http://local-api.test' },
    { name: 'production ignores preview and protocol settings', mode: 'production', flag: '1', protocol: 'invalid', preview: false, apiBase: '' },
    { name: 'custom-mode dev server ignores preview and protocol settings', mode: 'staging', dev: true, flag: '1', protocol: 'invalid', preview: false, apiBase: '' },
];

for (const scenario of scenarios) {
    test(`${scenario.name} keeps authentication and UI within the selected backend capabilities`, async (t) => {
        t.mock.method(Capacitor, 'isNativePlatform', () => scenario.native === true);
        const calls = [];
        t.mock.method(globalThis, 'fetch', async (url, init) => {
            calls.push({ url, init });
            if (url === `${scenario.apiBase}/auth/verify-token`) {
                assert.equal(init.method, 'GET');
                return Response.json({ loggedIn: true, user_name: 'synthetic-player' });
            }
            if (!scenario.legacy && url === `${scenario.apiBase}/auth/renew`) {
                assert.equal(init.method, 'POST');
                assert.deepEqual(JSON.parse(init.body), {});
                return Response.json({ loggedIn: true, user_name: 'synthetic-player' });
            }
            if (url === `${scenario.apiBase}/api/users`) {
                const body = JSON.parse(init.body);
                assert.equal(init.method, 'POST');
                if (body.type === 'signup') return Response.json({ success: true });
                if (body.type === 'login') return Response.json({ success: true, user_name: body.user_name });
            }
            if (url === `${scenario.apiBase}/auth/logout`) {
                assert.equal(init.method, 'POST');
                return Response.json({ loggedOut: true });
            }
            assert.fail(`Unexpected request: ${init.method} ${url}`);
        });
        const server = await createViteTestServer({
            root: frontendRoot,
            configFile: `${frontendRoot}/vite.config.ts`,
            mode: scenario.mode,
            appType: 'custom',
            logLevel: 'silent',
            define: {
                'import.meta.env.DEV': JSON.stringify(scenario.dev ?? scenario.mode === 'development'),
                'import.meta.env.VITE_USE_PUBLIC_API': JSON.stringify(scenario.flag),
                'import.meta.env.VITE_PUBLIC_AUTH_PROTOCOL': scenario.protocol === undefined ? 'undefined' : JSON.stringify(scenario.protocol),
                'import.meta.env.VITE_DEV_API_URL': JSON.stringify('http://local-api.test'),
            },
            server: { middlewareMode: true, watch: null, hmr: false },
        });
        try {
            const config = await server.ssrLoadModule('/ts/config/apiConfig.ts');
            assert.equal(config.PUBLIC_API_PREVIEW, scenario.preview);
            assert.equal(config.LEGACY_PUBLIC_API_PREVIEW, scenario.legacy === true);
            assert.equal(config.API_BASE, scenario.apiBase);
            const auth = await server.ssrLoadModule('/ts/services/authService.ts');
            assert.equal(auth.renewRequest === auth.verifyRequest, scenario.legacy === true);
            assert.deepEqual(await auth.renewRequest(), { loggedIn: true, user_name: 'synthetic-player' });
            assert.equal(calls[0].url, `${scenario.apiBase}/auth/${scenario.legacy ? 'verify-token' : 'renew'}`);
            assert.deepEqual(await auth.signupRequest({
                user_name: 'synthetic-player', email: 'synthetic@example.test', user_password: 'synthetic-password',
            }), { success: true });
            assert.deepEqual(await auth.loginRequest({
                user_name: 'synthetic-player', user_password: 'synthetic-password',
            }), { success: true, user_name: 'synthetic-player' });
            assert.equal(calls.at(-1).url, `${scenario.apiBase}/auth/verify-token`);
            await auth.logoutRequest();
            assert.ok(calls.every(({ init }) => init.credentials === 'include'));

            const { AuthProvider } = await server.ssrLoadModule('/ts/context/AuthContext.tsx');
            const render = (Component, props = {}) => renderToStaticMarkup(
                React.createElement(MemoryRouter, null,
                    React.createElement(AuthProvider, null, React.createElement(Component, props)))
            );
            for (const page of ['Login', 'SignUp']) {
                const { default: Page } = await server.ssrLoadModule(`/ts/pages/${page}.tsx`);
                const markup = render(Page);
                assert.equal(markup.includes('name="remember_me"'), !scenario.legacy);
                assert.equal(markup.includes('sessions expire after four hours and do not renew.'), scenario.legacy === true);
                assert.equal(markup.includes('Accounts and scores are saved to the live service.'), scenario.preview);
                assert.equal(markup.includes('Renewable sign-in is enabled; provider options appear when available.'),
                    scenario.preview && !scenario.legacy);
                assert.doesNotMatch(markup, /Continue with Google|Continue with Apple/, 'no dead provider button before discovery');
                assert.match(markup, /type="password"/);
            }

            const { default: ManageAccount } = await server.ssrLoadModule('/ts/pages/ManageAccount.tsx');
            const accountMarkup = render(ManageAccount);
            assert.equal(accountMarkup.includes('Account linking and deletion are not available on this public backend.'), scenario.legacy === true);
            assert.equal(accountMarkup.includes('Accounts and scores are saved to the live service.'), scenario.preview);
            if (scenario.legacy) {
                assert.match(accountMarkup, /mailto:mickeyf\.plays@gmail\.com/);
                assert.doesNotMatch(accountMarkup, /<form|delete-account-password|Type DELETE|Loading account options/);
            }
            const { InlineGoogleSignIn, ProviderSignInButtons } = await server.ssrLoadModule('/ts/components/ProviderSignInControls.tsx');
            assert.equal(render(InlineGoogleSignIn, { client: google }).includes('Continue with Google'), !scenario.legacy);
            assert.equal(render(ProviderSignInButtons, {
                clients: [google], action: 'link', busyClient: null, disabled: false, onSelect() {},
            }).includes('Link a sign-in method'), !scenario.legacy);
            assert.equal(calls.length, 5, 'Rendering must not make additional network requests');
        } finally {
            await server.close();
        }
    });
}

test('an invalid explicit preview protocol fails configuration instead of silently selecting another cookie contract', async () => {
    const server = await createViteTestServer({
        root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`, mode: 'development',
        appType: 'custom', logLevel: 'silent',
        define: {
            'import.meta.env.DEV': 'true',
            'import.meta.env.VITE_USE_PUBLIC_API': '"1"',
            'import.meta.env.VITE_PUBLIC_AUTH_PROTOCOL': '"automatic"',
        },
        server: { middlewareMode: true, watch: null, hmr: false },
    });
    try {
        await assert.rejects(server.ssrLoadModule('/ts/config/apiConfig.ts'),
            /VITE_PUBLIC_AUTH_PROTOCOL must be legacy or renewable/);
    } finally { await server.close(); }
});
