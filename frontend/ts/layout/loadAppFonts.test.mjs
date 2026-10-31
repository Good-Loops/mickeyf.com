import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadAppFonts } from './loadAppFonts.ts';

test('font loading adds one independent stylesheet and is safe to call again', () => {
    const links = [];
    const documentRoot = {
        getElementById: id => links.find(link => link.id === id),
        createElement: tag => { assert.equal(tag, 'link'); return {}; },
        head: { appendChild: link => links.push(link) },
    };
    loadAppFonts(documentRoot);
    loadAppFonts(documentRoot);
    assert.equal(links.length, 1);
    assert.equal(links[0].rel, 'stylesheet');
    assert.equal(links[0].href, '/fonts/app-fonts.css');
    assert.equal(links[0].blocking, undefined);
});

test('all current app font faces use intact local WOFF2 assets and retain upstream licenses', async () => {
    const base = new URL('../../public/fonts/', import.meta.url);
    const css = await readFile(new URL('app-fonts.css', base), 'utf8');
    const sources = JSON.parse(await readFile(new URL('sources.json', base), 'utf8'));
    assert.doesNotMatch(css, /https?:|@import|local\(/iu);
    const urls = [...css.matchAll(/url\(([^)]+)\)/gu)].map(match => match[1]);
    assert.ok(urls.length > 0);
    assert.ok(urls.every(url => /^\.\/[a-z0-9-]+\.woff2$/u.test(url)));
    assert.deepEqual([...new Set(sources.faceRules.map(face => face.family))].sort(),
        ['Fira Sans', 'Roboto', 'Space Grotesk', 'Space Mono', 'Work Sans']);
    const expectedWeights = { 'Fira Sans': [700], Roboto: [400, 700, 900], 'Space Grotesk': [300, 400, 500, 600, 700],
        'Space Mono': [400, 700], 'Work Sans': [400, 500, 600, 700] };
    for (const [family, weights] of Object.entries(expectedWeights)) {
        assert.deepEqual([...new Set(sources.faceRules.filter(face => face.family === family).map(face => face.weight))].sort((a, b) => a - b), weights);
        assert.ok(sources.faceRules.some(face => face.family === family && face.subset === 'latin'));
    }
    assert.equal((css.match(/font-display:\s*swap/gu) ?? []).length, sources.faceRules.length);
    assert.deepEqual([...new Set(urls.map(url => url.slice(2)))].sort(), sources.fontFiles.map(file => file.file).sort());
    for (const font of sources.fontFiles) {
        const bytes = await readFile(new URL(font.file, base));
        assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
        assert.equal(bytes.length, font.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256);
        assert.equal(new URL(font.sourceUrl).origin, 'https://fonts.gstatic.com');
    }
    assert.equal(sources.licenses.length, 5);
    for (const license of sources.licenses) {
        const bytes = await readFile(new URL(license.file, base));
        assert.match(bytes.toString(), /SIL OPEN FONT LICENSE/iu);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), license.sha256);
        assert.ok(license.sourceUrl.startsWith(`https://raw.githubusercontent.com/google/fonts/${sources.licenseRepositoryCommit}/`));
    }
});

test('Hosting CSP no longer permits third-party Google font styles or binaries', async () => {
    const config = JSON.parse(await readFile(new URL('../../../firebase.json', import.meta.url), 'utf8'));
    const policy = config.hosting.headers.flatMap(rule => rule.headers)
        .find(header => header.key.toLowerCase() === 'content-security-policy').value;
    assert.doesNotMatch(policy, /fonts\.(?:googleapis|gstatic)\.com/iu);
    assert.match(policy, /font-src 'self' data:;/u);
});

test('layout Sass contains no blocking external font imports and bootstrap starts the loader', async () => {
    const fonts = await readFile(new URL('../../sass/abstracts/_fonts.scss', import.meta.url), 'utf8');
    assert.doesNotMatch(fonts, /@import\s+(?:url\()?['"]?https?:/i);
    assert.match(fonts, /\$paragraph-font: 'Space Grotesk', sans-serif/);
    const main = await readFile(new URL('../main.tsx', import.meta.url), 'utf8');
    assert.match(main, /import \{ loadAppFonts \} from "@\/layout\/loadAppFonts"/);
    assert.match(main, /loadAppFonts\(\);/);
});
