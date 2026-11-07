# Release asset and third-party notice review

Checked 31 October 2026. This is an evidence record, not a legal opinion or
an assertion that every store content-rights requirement has been satisfied.

## Traced material

- The owner confirmed in the release conversation that they created the
  `frontend/ts/assets/audio/bg-sound-p4.mp3` background track. The file has no
  ID3v1 or ID3v2 metadata identifying its creator.
- `frontend/resources/README.md` records that the current controller-and-notes
  native icon was generated with the built-in image tool and selected by the
  owner. The old `frontend/android/app/src/main/ic_launcher-playstore.png` is a
  different rainbow treble-clef design from 2024; it is not the current Android
  launcher. Play listing artwork should match the final app branding.
- `frontend/public/fonts/README.md` and `sources.json` record the pinned
  provenance and SIL Open Font License texts for the bundled frontend fonts.
- `unity/three-bosses/ASSET_PROVENANCE.md` records the owner's earlier rights
  confirmation for project-controlled Three Bosses content and identifies
  generated material. Its `THIRD_PARTY_NOTICES.md`, Unity Companion notice and
  font licenses record the associated third-party terms.
- The locked frontend production dependency set declares MIT, BSD-3-Clause,
  ISC or 0BSD licenses. The locally bundled `third-party-notices.txt` preserves
  their complete installed license texts, font notices and the project's
  existing Unity notices. The published `@pixi/colord` package lacks a license
  file, so its v2.9.6 source-repository license is pinned in
  `frontend/vendor-licenses/`; `fft.js` includes its MIT license in its README.
  The list is regenerated with
  `node scripts/generate-frontend-third-party-notices.mjs`, and the frontend
  test suite checks it against the installed lockfile. Native Android/iOS SDK
  dependencies may require additional notices; this is not a complete native
  binary inventory.
- `AudioEngine.processAudio` creates a local blob URL for a user-selected file
  and analyzes it with Web Audio; this method has no audio upload call. Local
  playback does not establish the provenance or licensing of a user's music.
- Apple and Google provide branding guidance for their sign-in buttons. Verify
  the final implementations against [Apple's guidance](https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple/)
  and [Google's guidance](https://developers.google.com/identity/branding-guidelines).

## Owner confirmation for frontend artwork

The repository history and PNG metadata did not establish who created the five
p4-Vega sprite sheets or each final celestial background. On 31 October 2026,
the owner confirmed that they created or generated those assets. See the
bounded record in `frontend/ASSET_PROVENANCE.md`; it does not cover future
assets or claim exclusive copyright in generated content.

The content-rating questionnaire is a separate issue. Source and inspected
still assets show projectile combat, enemy defeat/explosion effects, a
collapsing humanoid player, and dark monster/cyborg screens. These observations
do not establish the rating or prove the absence of other content. Answer the
actual IARC questionnaire using the final game; do not infer a completed rating
from an empty questionnaire or select answers simply to obtain an age band.

Apple states that apps containing, showing or accessing third-party material
need the relevant rights or legal permission for the regions of availability:
[App Store Connect content rights](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/).
