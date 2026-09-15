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
