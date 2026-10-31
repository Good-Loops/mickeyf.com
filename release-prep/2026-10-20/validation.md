# Local closeout validation — 2026-10-20

Base committed source: `2fd2b831391288fabe57f910e0eb2420aa5a3a1e`; local changes remain uncommitted. Earlier green PR checks do not validate this new batch.

## Executed checks

- Release verifier suites: **221 passed, zero failed/skipped**. See [exact command and scope](verifier-validation.md). Independent review additionally ran the six targeted new integration/negative cases and found no remaining findings within that diff.
- Privacy/consent rendering: **17 passed** using `node --experimental-strip-types --test frontend/ts/pages/Privacy.test.mjs frontend/ts/components/SignedParentForm.test.mjs frontend/ts/services/parentRegistrationApi.test.mjs`.
- Frontend typecheck: `frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json` passed.
- Production build, from PowerShell:

```powershell
$releaseBuildOutput = Join-Path $env:TEMP ('ludolume-public-release-prep-' + [guid]::NewGuid().ToString('N'))
$env:VITE_PROD_API_URL='https://mickeyf-org-j7yuum4tiq-uc.a.run.app'
$env:VITE_ENABLE_THREE_BOSSES_RELEASE='1'
npm --prefix frontend run build -- --outDir $releaseBuildOutput
```

Result: Vite 7.3.6 production build passed, 1,885 modules transformed, 7.92 seconds. Output: `C:\Users\User\AppData\Local\Temp\ludolume-public-release-prep-428d8b63dcc9488a9584adc488c9b007`. Existing warnings identify modules used by both static and dynamic imports; no build error. This is compilation, not hosted or device acceptance.

- Parsed `store-listings.json`; asserted free pricing, exact `[BR, US]` country set, and en-US/pt-BR field limits: subtitle 30, short description 80, promotional text 170, description 4,000, keywords 100 characters. All passed.
- Resolved every relative Markdown link in this release folder with Node's `path.resolve`/`fs.existsSync`. All passed after correcting the iOS report's relative paths.
- `git diff --check` passed. `git check-ignore --no-index -v release-upload.jks release-upload.keystore` returned both expected root ignore rules with exit code 0.

## Limits

No fresh signed native build, Android emulator/device test, physical iPhone retest, cloud deployment, traffic change, public store submission/publication, repository transfer or billing change was performed. Existing Android outputs retain their dates and unsigned/source-binding limitations.

After the owner's explicit action-time authorization, accepted the three Google Play app-creation declarations and created Ludolume draft app `4974292717500321843`. Verified the resulting dashboard: app name Ludolume, required closed-testing release, at least 12 opted-in testers for 14 days, 0 testers currently opted in, production application disabled. No artifact uploaded, tester added, test release rolled out or public app published. Screenshot: [created draft dashboard](play-draft.jpg).
