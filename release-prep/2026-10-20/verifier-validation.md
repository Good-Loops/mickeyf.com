# Deployment verifier validation — 2026-10-20

Base commit: `2fd2b831391288fabe57f910e0eb2420aa5a3a1e`.
These are local, uncommitted source changes. No cloud deployment, traffic change,
store submission or other external mutation was performed for this validation.

## Corrected behavior

Cloud Run may retain the captured serving revision in `latestReadyRevision` when
a newly prepared zero-traffic revision is dormant or retired. The generated
frozen/session/provider preflight and session/provider rollback verification now
permit only that exact captured pointer or the exact new revision. They retain
the exact created revision, generation increment, runtime, traffic and tag checks.
Rollback planning also accepts the exact pinned baseline serving pointer when
the latest created template is the candidate. Independent candidate Ready,
runtime and deployment receipt validation remains mandatory.

Traffic reconciliation permits the captured pointer or the exact target while it
settles. Completed frozen/session/provider traffic changes require the serving
pointer to equal the exact approved target. Foreign pointers remain rejected.

## Changed files

- `scripts/render-frozen-backend-deploy.preflight.py`
- `scripts/render-frozen-backend-deploy.test.mjs`
- `scripts/frozen-backend-traffic.mjs`
- `scripts/frozen-backend-traffic.test.mjs`
- `scripts/session-backend-rollback.mjs`
- `scripts/session-backend-rollback.test.mjs`
- `scripts/session-backend-traffic.mjs`
- `scripts/session-backend-traffic.test.mjs`
- `scripts/provider-backend-release.test.mjs`
- `scripts/test-support/session-release-fixture.mjs`

## Validation

```powershell
node --test scripts/render-frozen-backend-deploy.test.mjs scripts/render-session-backend-deploy.test.mjs scripts/frozen-backend-traffic.test.mjs scripts/session-backend-rollback.test.mjs scripts/session-backend-traffic.test.mjs scripts/provider-backend-release.test.mjs scripts/provider-backend-activation.test.mjs
```

Result after independent-review correction: **221 passed, 0 failed, 0 skipped**.
`git diff --check` also passed for the ten changed source/test files; Git printed
only CRLF normalization notices for two files.

The generated preflight test directly exercises captured/new/foreign/null
serving pointers, created-pointer drift, generation drift, changed traffic and
changed/extra tags. Its existing service check still requires `Ready=True`, and
the generated runtime verifier still requires the candidate revision's
`Ready=True`. Those readiness checks were preserved; the generated preflight's
new test does not independently simulate retired and failed revision conditions.
Separate session/provider rollback and provider-active tests directly cover a
successful Ready condition with an informational `Active=FAILED` / `RETIRED`
condition, reject failed Ready conditions, and reject foreign pointers. Generated
Bash syntax and embedded Python compilation are included in the passing suites.
New session and provider integration cases feed a retained baseline pointer
accepted by the actual generated preflight helper into rollback planning and
application. Negative cases reject foreign/unreviewed old pointers, altered
candidate template containers and failed candidate Ready conditions.
Independent review found no further findings after the correction and ran:
`node --test --test-name-pattern="rollback planning accepts|captured baseline pointer|candidate serving pointer" scripts/session-backend-rollback.test.mjs`
with **6 passed, 0 failed, 0 skipped**.

## Action-time limit

Regenerate saved traffic and rollback preparation plans. Captured before-state
fields and configuration fingerprints changed; the fresh-plan comparison rejects
old plans. Generated deployment step fingerprints also change with the updated
preflight, so previously rendered packages and dispatch approvals are not fresh
evidence for this source. Live deployment/reconciliation of this change remains
unverified and requires the reviewed release workflow.
