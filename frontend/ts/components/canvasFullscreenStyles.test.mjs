import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileString } from 'sass';

const css = compileString(`
    @use 'abstracts/mixins' as mixins;
    .fixture { @include mixins.block-canvas-fullscreen('fixture'); }
`, {
    loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
}).css;

const compactStart = css.indexOf('@media');
const desktopCss = css.slice(0, compactStart);
const compactCss = css.slice(compactStart);

test('compact native, prefixed and fallback fullscreen share aspect-preserving sizing', () => {
    assert.notEqual(compactStart, -1);
    assert.match(compactCss, /__canvas-wrapper:fullscreen .*__canvas/);
    assert.match(compactCss, /__canvas-wrapper:-webkit-full-screen .*__canvas/);
    assert.match(compactCss, /__canvas-wrapper\[data-canvas-fullscreen=fallback\] .*__canvas/);
    for (const declaration of [
        'width: auto;', 'height: auto;', 'max-width: 100%;', 'max-height: 100%;',
        'min-width: 0;', 'min-height: 0;', 'flex: 0 0 auto;',
    ]) assert.ok(compactCss.includes(declaration), declaration);
});

test('height-limited landscape joins the shared narrow-screen breakpoint', () => {
    assert.match(compactCss, /@media only screen and \(max-width: [^)]+\), only screen and \(orientation: landscape\) and \(max-height: [^)]+\)/);
});

test('larger desktop fullscreen keeps its existing width-driven enlargement', () => {
    assert.match(desktopCss, /width: 100%;/);
    assert.match(desktopCss, /height: auto;/);
    assert.match(desktopCss, /max-height: 100dvh;/);
    assert.doesNotMatch(desktopCss, /flex: 0 0 auto;/);
});

test('all fullscreen modes override embedded canvas page gestures', () => {
    for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
        const rule = css.split('}').find(part => part.includes(`__canvas-wrapper${mode} .fixture__canvas`)
            && part.includes('touch-action: none !important;'));
        assert.ok(rule, mode);
    }
});

test('fullscreen removes the embedded decorative frame and canvas corner rounding', () => {
    const frame = desktopCss.split('}').find(part => part.includes('display: flex;'));
    for (const declaration of ['padding: 0;', 'border: 0;', 'border-radius: 0;', 'box-shadow: none;', 'backdrop-filter: none;']) {
        assert.ok(frame?.includes(declaration), declaration);
    }
    const canvas = desktopCss.split('}').find(part => part.includes('touch-action: none !important;'));
    assert.ok(canvas?.includes('border-radius: 0;'));
});

test('p4-Vega disables selection and touch callouts only inside fullscreen gameplay', () => {
    const gameCss = compileString("@use 'pages/p4-vega';", {
        loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
    }).css;
    const selectionRules = gameCss.split('}').filter(part => part.includes('user-select: none;'));
    assert.equal(selectionRules.length, 1);
    const [rule] = selectionRules;
    for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
        assert.ok(rule.includes(`.p4-vega__canvas-wrapper${mode}`));
    }
    assert.ok(rule.includes('-webkit-user-select: none;'));
    assert.ok(rule.includes('-webkit-touch-callout: none;'));
    assert.doesNotMatch(rule, /touch-action:|\.p4-vega__canvas-wrapper\s*\{/);
});

test('p4-Vega fullscreen joystick uses safe bottom corners and leaves the exit button clear', () => {
    const gameCss = compileString("@use 'pages/p4-vega';", {
        loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
    }).css;
    const rule = gameCss.split('}').find(part => part.includes('.p4-vega__joystick--fullscreen')
        && part.includes('bottom: max(2rem, env(safe-area-inset-bottom))'));
    assert.ok(rule);
    for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
        assert.ok(rule.includes(`__canvas-wrapper${mode} .p4-vega__joystick--fullscreen`));
    }
    assert.ok(rule.includes('top: auto;'));
    assert.ok(rule.includes('transform: none;'));
    assert.ok(rule.includes('right: calc(max(1rem, env(safe-area-inset-right)) + 4rem);'));
    assert.ok(rule.includes('width: 10.4rem;'));
    assert.ok(rule.includes('height: 10.4rem;'));
    const leftRule = gameCss.split('}').find(part => part.includes('[data-joystick-side=left]')
        && part.includes('left: max(2rem, env(safe-area-inset-left))'));
    assert.ok(leftRule?.includes('right: auto;'));
});

test('p4-Vega applies device safe insets only to fullscreen HUD controls', () => {
    const gameCss = compileString("@use 'pages/p4-vega';", {
        loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
    }).css;
    for (const [control, side] of [['score', 'left'], ['pause-btn', 'right']]) {
        const selector = `.p4-vega__${control}`;
        const embedded = gameCss.split('}').find(part => part.trim().startsWith(`${selector} {`)
            && part.includes('position: absolute;'));
        assert.ok(embedded, `embedded ${control}`);
        assert.ok(embedded.includes('top: 0.85rem;'));
        assert.ok(embedded.includes(`${side}: 0.85rem;`));
        assert.doesNotMatch(embedded, /safe-area-inset/);

        for (const edge of ['top', side]) {
            const insetRules = gameCss.split('}').filter(part => part.includes(selector)
                && part.includes(`${edge}: max(0.85rem, env(safe-area-inset-${edge}));`));
            assert.equal(insetRules.length, 1, `${control} ${edge} inset`);
            for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
                assert.ok(insetRules[0].includes(`__canvas-wrapper${mode} ${selector}`));
            }
        }
    }
});

test('compact Three Bosses fullscreen keeps the exit control at the safe screen corner', () => {
    const gameCss = compileString("@use 'pages/three-bosses';", {
        loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
    }).css;
    const cornerRules = [...gameCss.matchAll(/@media[^\{]+\{([\s\S]*?)\n\}/g)]
        .map(([rule]) => rule)
        .filter(rule => rule.includes('right: max(0.4rem, env(safe-area-inset-right))'));

    assert.equal(cornerRules.length, 1);
    const [cornerRule] = cornerRules;
    assert.match(cornerRule, /max-width: 48\.75em/);
    assert.match(cornerRule, /orientation: landscape\) and \(max-height: 31\.25em/);
    for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
        assert.ok(cornerRule.includes(`__canvas-wrapper${mode} .three-bosses__fullscreen-btn`));
    }
    assert.ok(cornerRule.includes('bottom: max(0.4rem, env(safe-area-inset-bottom))'));
    assert.doesNotMatch(cornerRule, /calc\(|\b(?:width|height): (?!48\.75em|31\.25em)/);
});

test('short landscape Three Bosses reserves an exit gutter without changing the canvas ratio', () => {
    const gameCss = compileString("@use 'pages/three-bosses';", {
        loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
    }).css;
    const [gutterRule] = [...gameCss.matchAll(/@media[^\{]+\{([\s\S]*?)\n\}/g)]
        .map(([rule]) => rule)
        .filter(rule => rule.includes('--three-bosses-fullscreen-width: calc('));

    assert.ok(gutterRule, 'reserve space only in the short-landscape fullscreen rule');
    assert.match(gutterRule, /orientation: landscape\) and \(max-height: 26\.75em\)/);
    for (const mode of [':fullscreen', ':-webkit-full-screen', '[data-canvas-fullscreen=fallback]']) {
        assert.ok(gutterRule.includes(`__canvas-wrapper${mode} .three-bosses__canvas`));
    }
    assert.match(gutterRule, /3\.4rem \+ max\(0?\.4rem, env\(safe-area-inset-right\)\) \+ 0?\.2rem/);
    assert.ok(gameCss.includes('width: min(var(--three-bosses-fullscreen-width),'));
    assert.ok(gameCss.includes('height: min(100dvh, var(--three-bosses-fullscreen-width) * 9 / 16)'));
    assert.ok(gameCss.includes('--three-bosses-fullscreen-width: 100vw;'));
});
