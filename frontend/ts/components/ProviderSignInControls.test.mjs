import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const viteServer = await createViteTestServer({ root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"' },
    server: { middlewareMode: true } });
after(() => viteServer.close());
const { default: ProviderSignInControls, ProviderSignInButtons, InlineGoogleSignIn, providerSignInErrorMessage } =
    await viteServer.ssrLoadModule('/ts/components/ProviderSignInControls.tsx');
const { AuthProvider } = await viteServer.ssrLoadModule('/ts/context/AuthContext.tsx');
const { requestProviderUsername } = await viteServer.ssrLoadModule('/ts/components/providerSignupPrompt.ts');
const { default: alert } = await viteServer.ssrLoadModule('/ts/components/siteAlert.ts');
const google = { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com' };
const apple = { clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: 'com.example.synthetic' };
const appleWeb = { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.synthetic.web',
    redirectUri: 'https://example.test/return' };

function markup(options = {}) {
    return renderToStaticMarkup(React.createElement(ProviderSignInButtons, {
        clients: [google], action: 'login', disabled: false, busyClient: null, onSelect() {}, ...options,
    }));
}

test('discovery shows branded disabled choices without advertising a ready provider', () => {
    assert.equal(markup({ clients: [] }), '');
    const pending = renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(ProviderSignInControls, { action: 'login' })));
    assert.match(pending, /aria-busy="true"/);
    assert.equal((pending.match(/type="button" disabled=""/g) ?? []).length, 2);
    assert.match(pending, /Continue with Google/);
    assert.match(pending, /Continue with Apple/);
    assert.match(pending, /google-sign-in-logo\.svg/);
    assert.match(pending, /apple-sign-in-logo-white\.png/);
    assert.doesNotMatch(pending, /<iframe|<script/);
});

test('Google login has a direct official-widget host and no extra selector, heading or popup markup', () => {
    assert.equal(markup(), '');
    const rendered = renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(InlineGoogleSignIn, { client: google })));
    assert.match(rendered, /class="provider-sign-in__google-host" role="group" aria-label="Continue with Google"/);
    assert.match(rendered, /provider-sign-in__button--placeholder" type="button" disabled="" aria-label="Continue with Google"/);
    assert.match(rendered, /google-sign-in-logo\.svg/);
    assert.match(rendered, /class="u-visually-hidden" role="status">Preparing Google sign-in/);
    assert.doesNotMatch(rendered, /Loading Google|Or sign in with|<h2|<form|<iframe|<script|dialog|synthetic\.apps/);
});

test('both entry pages render the same direct Google control without an upfront username prompt', () => {
    const render = action => renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(InlineGoogleSignIn, { client: google, action })));
    assert.equal(render('signup'), render('login'));
    assert.doesNotMatch(render('signup'), /Choose your username|Create account|Link a sign-in method/);
});

test('direct Google host is inert while password login is busy and does not start a replacement selector', () => {
    const rendered = renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(InlineGoogleSignIn, { client: google, disabled: true })));
    assert.match(rendered, /inert="" aria-disabled="true"/);
    assert.match(rendered, /provider-sign-in__button--placeholder" type="button" disabled=""/);
    assert.doesNotMatch(rendered, /Loading Google sign-in|Or sign in with/);
});

test('native login has a Continue with Apple control without a login heading', () => {
    const rendered = markup({ clients: [apple] });
    assert.match(rendered, /aria-label="Other sign-in methods"/);
    assert.match(rendered, />Continue with Apple<\/span>/);
    assert.match(rendered, /apple-sign-in-logo-white\.png/);
    assert.doesNotMatch(rendered, /<h2|Or sign in with|google/);
});

test('unavailable Apple issuance keeps native/login/link closed and retains the web signup availability choice', () => {
    for (const action of ['login', 'signup', 'link']) {
        assert.equal(markup({ clients: [{ ...apple, issuance: false }], action }), '');
    }
    assert.match(markup({ clients: [{ ...appleWeb, issuance: false }], action: 'signup' }), />Continue with Apple<\/span>/);
    const rendered = renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(InlineGoogleSignIn, { client: { ...google, issuance: false } })));
    assert.equal(rendered, '');
});

test('signup keeps configured availability choices visible while active Google still uses only its official widget', () => {
    const closed = markup({ clients: [google, appleWeb], action: 'signup' });
    assert.match(closed, />Continue with Google<\/span>/);
    assert.match(closed, /google-sign-in-logo\.svg/);
    assert.match(closed, />Continue with Apple<\/span>/);
    assert.equal((closed.match(/<button/g) ?? []).length, 2);
    const rendered = markup({ clients: [{ ...google, signup: true }, { ...apple, signup: true }], action: 'signup' });
    assert.match(rendered, />Continue with Apple<\/span>/);
    assert.match(rendered, /aria-label="Other sign-in methods"/);
    assert.equal((rendered.match(/<button/g) ?? []).length, 1);
    assert.doesNotMatch(rendered, /Google|google|Link a sign-in method|<h2/);
});

test('Apple linking keeps its explicit heading while matching the branded entry control', () => {
    const rendered = markup({ clients: [apple], action: 'link' });
    assert.match(rendered, /Link a sign-in method/);
    assert.match(rendered, />Continue with Apple<\/span>/);
    assert.match(rendered, /provider-sign-in__button--apple/);
    assert.match(rendered, /apple-sign-in-logo-white\.png/);
    assert.doesNotMatch(rendered, /Sign in with Apple|>google<|Delete account|Create account|Sign up/);
});

test('external form activity disables every linking choice', () => {
    const rendered = markup({ clients: [google, apple], action: 'link', disabled: true });
    assert.equal((rendered.match(/ disabled=""/g) ?? []).length, 2);
    assert.equal((rendered.match(/<button/g) ?? []).length, 2);
});

test('provider activity announces progress and disables all other choices', () => {
    const rendered = markup({ clients: [google, apple], action: 'link', busyClient: google.clientKey });
    assert.match(rendered, /aria-busy="true"/);
    assert.match(rendered, /aria-busy="true"/);
    assert.match(rendered, />Continue with Google<\/span>/);
    assert.match(rendered, /Signing in/);
    assert.equal((rendered.match(/ disabled=""/g) ?? []).length, 2);
});

test('unlinked login guidance stays compact and does not imply automatic signup or matching by email', () => {
    const message = providerSignInErrorMessage('NOT_LINKED', 'login');
    assert.match(message, /isn’t linked yet/);
    assert(message.length < 60);
    assert.doesNotMatch(message, /automatically|email/i);
});

test('Apple onboarding and deletion failures name Apple without prescribing Google accounts', () => {
    for (const error of ['NOT_LINKED', 'ALREADY_LINKED', 'DUPLICATE_USER', 'INVALID_EMAIL', 'ACCOUNT_DELETION_UNAVAILABLE']) {
        const message = providerSignInErrorMessage(error, 'signup', 'apple');
        assert.match(message, /Apple/);
        assert.doesNotMatch(message, /Google|Gmail|Workspace/);
    }
    assert.match(providerSignInErrorMessage('NOT_LINKED', 'login', 'apple'), /isn’t linked yet/);
});

for (const [provider, expectedName] of [['google', 'Google'], ['apple', 'Apple']]) {
    test(`${provider} onboarding asks for a public username using the actual sign-in method`, async t => {
        t.mock.method(alert, 'fire', async options => {
            assert.match(options.text, new RegExp(`sign in with ${expectedName}—no password needed`));
            assert.doesNotMatch(options.text, /link|password account/i);
            assert.equal(options.inputValue, 'Initial name');
            assert.equal(options.inputValidator(''), 'Enter a username (1–64 characters).');
            assert.equal(options.inputValidator('New Player'), undefined);
            options.didDestroy();
            return { isConfirmed: true, value: ' New Player ' };
        });
        assert.equal(await requestProviderUsername('Initial name', new AbortController().signal, provider), 'New Player');
    });
}

test('cancelled Apple onboarding closes only its own prompt and returns no registration consent', async t => {
    const controller = new AbortController();
    const popup = {};
    let closeCount = 0;
    let finish;
    t.mock.method(alert, 'getPopup', () => popup);
    t.mock.method(alert, 'close', () => { closeCount++; finish(); });
    t.mock.method(alert, 'fire', options => new Promise(resolve => {
        finish = () => { options.didDestroy(); resolve({ isConfirmed: false }); };
        options.didOpen(popup);
    }));
    const pending = requestProviderUsername('', controller.signal, 'apple');
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(closeCount, 1);
    assert.equal(await requestProviderUsername('', controller.signal, 'apple'), null);
    assert.equal(closeCount, 1, 'an already-cancelled operation never opens another prompt');
});

test('cancellation is quiet and unknown errors cannot inject provider details or claim an unconfirmed result', () => {
    assert.equal(providerSignInErrorMessage('CANCELLED', 'login'), null);
    assert.equal(providerSignInErrorMessage('CANCELLED', 'link'), null);
    for (const action of ['login', 'link']) {
        const message = providerSignInErrorMessage('private-token-claims-and-password', action);
        assert.match(message, /could not confirm/);
        assert.doesNotMatch(message, /private-token|was cancelled|was undone|success/i);
    }
    assert.match(providerSignInErrorMessage('INVALID_PASSWORD', 'link'), /current password/);
    assert.match(providerSignInErrorMessage('INVALID_ATTEMPT', 'login'), /start again/);
    assert.match(providerSignInErrorMessage('RATE_LIMITED', 'link'), /15 minutes/);
});


test('native Google keeps the same labeled logo control for login, signup, linking and busy states', () => {
    for (const platform of ['ios', 'android']) {
        const client = { ...google, clientKey: `google-${platform}`, platform };
        assert.equal(markup({ clients: [client], action: 'signup' }), '');
        for (const action of ['login', 'signup', 'link']) {
            const options = { clients: [{ ...client, signup: true }], action };
            const ready = markup(options), busy = markup({ ...options, busyClient: client.clientKey });
            for (const rendered of [ready, busy]) {
                assert.match(rendered, /provider-sign-in__button--google/);
                assert.match(rendered, /google-sign-in-logo\.svg/);
                assert.match(rendered, />Continue with Google<\/span>/);
                assert.doesNotMatch(rendered, /google-sign-in-(ios|android)\.png|Sign in with Google|Please wait/);
            }
            assert.match(busy, /disabled=""/);
            assert.match(busy, /role="status">Signing in/);
        }
    }
});
