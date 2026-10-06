import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const viteServer = await createViteTestServer({
    root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
});
after(() => viteServer.close());
const { default: MusicUpload } = await viteServer.ssrLoadModule('/ts/components/MusicUpload.tsx');
const { default: siteAlert } = await viteServer.ssrLoadModule('/ts/components/siteAlert.ts');

function control(onFileSelect = () => {}) {
    return MusicUpload({ id: 'music-upload', classPrefix: 'dancing-circles', onFileSelect });
}

for (const [classPrefix, id] of [
    ['dancing-circles', 'dancing-circles-file-upload'],
    ['dancing-fractals', 'fractal-music-upload'],
]) {
    test(`${classPrefix} keeps its existing upload styling and accessible label association`, () => {
        const markup = renderToStaticMarkup(MusicUpload({ id, classPrefix, onFileSelect() {} }));
        assert.ok(markup.includes(`class="${classPrefix}__upload"`));
        assert.ok(markup.includes(`class="${classPrefix}__upload-btn" for="${id}" role="button" tabindex="0"`));
        assert.ok(markup.includes(`id="${id}" type="file"`));
        assert.ok(markup.includes(`class="${classPrefix}__input"`));
        assert.match(markup, />Upload Music<\/label>/);
        assert.doesNotMatch(markup, /disabled|multiple|capture=/);
    });
}

test('picker hints include extensions as well as the audio family, without broadening to all files', () => {
    const [, input] = control().props.children;
    const tokens = input.props.accept.split(',');
    for (const hint of ['audio/*', '.mp3', '.m4a', '.aac', '.wav', '.aiff', '.flac', '.ogg', '.opus']) {
        assert.ok(tokens.includes(hint), `${hint} must remain selectable`);
    }
    assert.equal(new Set(tokens).size, tokens.length);
    assert.ok(tokens.every(token => token === 'audio/*' || /^\.[a-z0-9]+$/.test(token)));
});

test('selection forwards the original file even when its MIME type is missing or generic', () => {
    const selected = [];
    const [, input] = control(file => selected.push(file)).props.children;
    for (const type of ['', 'application/octet-stream', 'audio/mpeg']) {
        const file = new File(['synthetic fixture'], 'music.MP3', { type });
        input.props.onChange({ currentTarget: { files: [file, new File([], 'ignored.wav')] } });
        assert.equal(selected.at(-1), file);
    }
    assert.equal(selected.length, 3);
    input.props.onChange({ currentTarget: { files: [] } });
    input.props.onChange({ currentTarget: { files: null } });
    assert.equal(selected.length, 3, 'cancelling the picker must not load or replace audio');
});

test('Enter and Space open the associated input synchronously; other keys do not', () => {
    const [label] = control().props.children;
    const calls = [];
    const event = {
        preventDefault() { calls.push('prevent-default'); },
        currentTarget: { control: { click() { calls.push('open-picker'); } } },
    };
    for (const key of ['Enter', ' ']) {
        calls.length = 0;
        label.props.onKeyDown({ ...event, key });
        assert.deepEqual(calls, ['prevent-default', 'open-picker']);
    }
    calls.length = 0;
    label.props.onKeyDown({ ...event, key: 'ArrowDown' });
    assert.deepEqual(calls, []);
    assert.doesNotThrow(() => label.props.onKeyDown({ ...event, key: 'Enter', currentTarget: { control: null } }));
});

test('selection clears the input before loading so the same file can be retried', async () => {
    const file = new File([], 'retry.mp3');
    const target = { files: [file], value: 'retry.mp3' };
    let selection;
    const [, input] = control(selected => {
        selection = { file: selected, inputValue: target.value };
    }).props.children;
    await input.props.onChange({ currentTarget: target });
    assert.equal(selection.file, file);
    assert.equal(selection.inputValue, '');
});

for (const asynchronous of [false, true]) {
    test(`a ${asynchronous ? 'rejected' : 'thrown'} loading error is reported with the shared alert`, async t => {
        const failure = new Error('Audio setup failed');
        const errors = t.mock.method(console, 'error', () => {});
        const alerts = t.mock.method(siteAlert, 'fire', async () => ({}));
        const [, input] = control(() => {
            if (asynchronous) return Promise.reject(failure);
            throw failure;
        }).props.children;
        await input.props.onChange({ currentTarget: {
            files: [new File([], 'retry.mp3')], value: 'retry.mp3', isConnected: true,
        } });
        assert.equal(errors.mock.callCount(), 1);
        assert.equal(errors.mock.calls[0].arguments[1], failure);
        assert.equal(alerts.mock.callCount(), 1);
        assert.equal(alerts.mock.calls[0].arguments[0].icon, 'error');
        assert.equal(alerts.mock.calls[0].arguments[0].title, 'Music could not load');
    });
}

test('a loading error after navigation does not open an alert on the next page', async t => {
    t.mock.method(console, 'error', () => {});
    const alerts = t.mock.method(siteAlert, 'fire', async () => ({}));
    let reject;
    const pending = new Promise((resolve, fail) => { reject = fail; });
    const [, input] = control(() => pending).props.children;
    const target = { files: [new File([], 'music.mp3')], value: 'music.mp3', isConnected: true };
    const loading = input.props.onChange({ currentTarget: target });
    target.isConnected = false;
    reject(new Error('Late initialization error'));
    await loading;
    assert.equal(alerts.mock.callCount(), 0);
});
