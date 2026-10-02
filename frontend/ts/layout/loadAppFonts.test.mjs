import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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
    const url = new URL(links[0].href);
    assert.equal(url.origin, 'https://fonts.googleapis.com');
    assert.equal(url.searchParams.get('display'), 'swap');
    const families = url.searchParams.get('family').split('|').map(value => value.split(':')[0]);
    assert.deepEqual(families, ['Space Mono', 'Roboto', 'Space Grotesk', 'Work Sans', 'Fira Sans']);
    assert.equal(links[0].blocking, undefined);
});

test('layout Sass contains no blocking external font imports and bootstrap starts the loader', async () => {
    const fonts = await readFile(new URL('../../sass/abstracts/_fonts.scss', import.meta.url), 'utf8');
    assert.doesNotMatch(fonts, /@import\s+(?:url\()?['"]?https?:/i);
    assert.match(fonts, /\$paragraph-font: 'Space Grotesk', sans-serif/);
    const main = await readFile(new URL('../main.tsx', import.meta.url), 'utf8');
    assert.match(main, /import \{ loadAppFonts \} from "@\/layout\/loadAppFonts"/);
    assert.match(main, /loadAppFonts\(\);/);
});
