import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const viteServer = await createServer({ root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
after(() => viteServer.close());
const { default: ProviderSignInControls, ProviderSignInButtons, providerSignInErrorMessage } =
    await viteServer.ssrLoadModule('/ts/components/ProviderSignInControls.tsx');
const { AuthProvider } = await viteServer.ssrLoadModule('/ts/context/AuthContext.tsx');
const google = { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com' };
const apple = { clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: 'com.example.synthetic' };

function markup(options = {}) {
    return renderToStaticMarkup(React.createElement(ProviderSignInButtons, {
        clients: [google], action: 'login', disabled: false, busyClient: null, onSelect() {}, ...options,
    }));
}

test('provider controls remain absent until capability discovery supplies a supported client', () => {
    assert.equal(markup({ clients: [] }), '');
    assert.equal(renderToStaticMarkup(React.createElement(AuthProvider, null,
        React.createElement(ProviderSignInControls, { action: 'login' }))), '');
});

test('Google entry is a labelled ordinary button and does not imitate the official sign-in widget', () => {
    const rendered = markup();
    assert.match(rendered, /role="group" aria-labelledby="[^"]+" aria-busy="false"/);
    assert.match(rendered, /<h2[^>]*>Or sign in with:<\/h2>/);
    assert.match(rendered, /<button[^>]*type="button"[^>]*>google<\/button>/);
    assert.doesNotMatch(rendered, /Apple account|<form|<iframe|<script|synthetic\.apps/);
});

test('native Apple entry is a neutral account selector and link controls have a distinct heading', () => {
    const rendered = markup({ clients: [apple], action: 'link' });
    assert.match(rendered, /Link a sign-in method/);
    assert.match(rendered, />Apple account<\/button>/);
    assert.doesNotMatch(rendered, /Sign in with Apple|>google<|Delete account|Create account|Sign up/);
});

test('external form activity disables every provider choice', () => {
    const rendered = markup({ clients: [google, apple], disabled: true });
    assert.equal((rendered.match(/ disabled=""/g) ?? []).length, 2);
    assert.equal((rendered.match(/<button/g) ?? []).length, 2);
});

test('provider activity announces progress and disables all other choices', () => {
    const rendered = markup({ clients: [google, apple], busyClient: google.clientKey });
    assert.match(rendered, /aria-busy="true"/);
    assert.match(rendered, />Please wait…<\/button>/);
    assert.equal((rendered.match(/ disabled=""/g) ?? []).length, 2);
});

test('unlinked identity guidance names the password and Manage account recovery path', () => {
    const message = providerSignInErrorMessage('NOT_LINKED', 'login');
    assert.match(message, /username and password/);
    assert.match(message, /Manage account/);
    assert.doesNotMatch(message, /automatically|sign up|email/i);
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
