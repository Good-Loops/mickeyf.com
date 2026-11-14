import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'postcss';
import { compileString } from 'sass';

const stylesheet = parse(compileString("@use 'pages/games'; @use 'pages/animations';", {
    loadPaths: [fileURLToPath(new URL('../../sass', import.meta.url))],
}).css);

// These visuals use class-only descendant selectors. Resolve their animation
// declarations by specificity and source order, including the motion media rule.
function animationFor(classes, reducedMotion) {
    let winner = { specificity: -1, value: undefined };
    stylesheet.walkDecls('animation', declaration => {
        const rule = declaration.parent;
        if (rule.parent.type === 'atrule') {
            assert.equal(rule.parent.name, 'media');
            assert.equal(rule.parent.params, '(prefers-reduced-motion: reduce)');
            if (!reducedMotion) return;
        }

        for (const selector of rule.selectors) {
            assert.match(selector, /^\.[\w-]+(?:\s+\.[\w-]+)*$/);
            const selectorClasses = selector.split(/\s+/).map(value => value.slice(1));
            if (selectorClasses.at(-1) !== classes.at(-1)) continue;
            let previousIndex = -1;
            const matches = selectorClasses.every(className => {
                const index = classes.indexOf(className, previousIndex + 1);
                previousIndex = index;
                return index !== -1;
            });
            if (matches && selectorClasses.length >= winner.specificity) {
                winner = { specificity: selectorClasses.length, value: declaration.value };
            }
        }
    });
    return winner.value;
}

for (const [page, variant, animation] of [
    ['games', 'p4', 'games-vega-drift'],
    ['games', 'three-bosses', 'games-boss-signal'],
    ['animations', 'circles', 'animations-orbit'],
    ['animations', 'fractals', 'animations-fractal-breathe'],
]) {
    const classes = [page, `${page}__card--${variant}`, `${page}__visual`];

    test(`${variant} keeps its decorative animation with no motion preference`, () => {
        assert.equal(animationFor(classes, false)?.split(' ')[0], animation);
    });

    test(`${variant} stops its decorative animation with reduced motion`, () => {
        assert.equal(animationFor(classes, true), 'none');
    });
}
