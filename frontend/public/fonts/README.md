# App fonts

These files replace the app's startup Google Fonts stylesheet with same-origin
assets, including in the packaged native app. `loadAppFonts.ts` loads
`/fonts/app-fonts.css` without delaying the local layout stylesheet.

The WOFF2 binaries are unmodified copies from the official Google Fonts
distribution. `sources.json` records the original stylesheet, each source URL,
SHA-256 digest, byte count, and face/Unicode-subset mapping. The five original
copyright and SIL Open Font License notices are in `licenses/`, pinned to the
recorded Google Fonts repository commit.

The CSS keeps the original Unicode ranges, `font-display: swap`, and static
weight descriptors for faces used by current app styles:

| Family | Normal weights |
| --- | --- |
| Space Mono | 400, 700 |
| Roboto | 400, 700, 900 |
| Space Grotesk | 300, 400, 500, 600, 700 |
| Work Sans | 400, 500, 600, 700 |
| Fira Sans | 700 |

When adding a family, weight, or style, add the matching official font assets
and license/provenance entries together. Preserve these descriptors when
updating files so that existing intermediate CSS weights keep their original
browser font-matching behavior.

Checks from the repository root:

```sh
node --experimental-strip-types --test frontend/ts/layout/loadAppFonts.test.mjs
node --test .github/firebase-deploy/app-fonts-browser.test.mjs
```

The browser test uses disposable Chrome sessions and synthetic API responses;
it loads the actual Home, Login, and Sign Up pages, checks every listed face
with Portuguese accents, and rejects Google Fonts request attempts. It does
not certify native-device appearance or provider behavior.
