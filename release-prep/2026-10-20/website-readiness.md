# Website and backend release preparation — 2026-10-20

Read-only production checks completed at 23:43 UTC. Repository source inspected:
`2fd2b831391288fabe57f910e0eb2420aa5a3a1e`, branch
`feature/auth-family-leaderboards`, draft/open [PR #342](https://github.com/Good-Loops/mickeyf.com/pull/342).
The owner's latest message accepts the app on their iPhone. This report carries that
acceptance forward; it does not repeat it or expand it to Android/provider lifecycle tests.

## Verified live state

| Component | Live evidence |
| --- | --- |
| Website | `https://mickeyf.com/` returns 200, title Ludolume, CSP and HSTS present. |
| Hosting version | `sites/noted-reef-387021/versions/65e2e66f73a81522`, FINALIZED. |
| Hosting release | `sites/noted-reef-387021/channels/live/releases/1792264283492000`, released 2026-10-17T19:11:23.492Z. |
| Website source | Release message `codex-owner-release/20261017/454f8170624ab571a208796b9fb8a105291245ce`. Latest PR source has not been published. |
| API | `https://mickeyf-org-j7yuum4tiq-uc.a.run.app`, service `mickeyf-org`, region `us-central1`, project `noted-reef-387021`. |
| Serving backend | Generation 156; 100% traffic to `mickeyf-org-session-active-f4ae47fd8ef44467b5041c42041b3c11`; no tags. Service Ready, ConfigurationsReady and RoutesReady are true; latestCreated and latestReady identify this same revision. |
| Backend source | Label `source-commit=d0c04cf1052cbc65fccd986e346654218f55e06a`; source build `f4ae47fd-8ef4-4467-b504-1c42041b3c11` succeeded 2026-10-17T17:19:48.310129Z. |
| Serving image | `us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy@sha256:03fb4f80809f377dbda060e5fa03e8905a95189084be36f2cb08157afae2fb96`. |
| Compatible dormant fallback | `mickeyf-org-auth-rollback-f4ae47fd8ef44467b5041c42041b3c11` exists with the same D0 source/image. Ready=true, reason Retired; Active=false, reason Retired. No fallback was activated or revalidated through a fresh traffic plan. |
| Backend automation | All six global Cloud Build triggers are disabled, including legacy `main-push-mickeyf-com`. No regional triggers found in `us-central1`. |
| Maintenance | Hourly deletion audit and submission receipt cleanup schedulers are enabled. The cleanup job's latest execution `mickeyf-submission-receipt-cleanup-8h5vp` succeeded at 2026-10-20T23:02:06.669556Z. This is job metadata, not proof of a real Apple revocation/notification cycle. |

Anonymous GETs through both the website rewrite and direct API agree:

- `/auth/providers/config`: Google web/iOS and Apple web/iOS are exposed with `signup:true`; Android is absent.
- `/auth/registration/config`: enabled, mode `general-audience`, policy `registration-general-2026-10-17.1`, no optional details, no new parent registration.
- `/auth/parent-registration/config`: management policy remains configured; `creationEnabled:false`.
- `/api/leaderboards`: Three Bosses is rules version 1, ranked, submissions enabled; p4-Vega is legacy-only.
- `/privacy` returns HTML with HTTP 200. Its live lazy-loaded notice chunk is
  `/assets/privacyNotice-mBQ6wi-5.js`, version `privacy-2026-10-06.1`.

The PR's frontend454f8170 / Hosting65e2e66f73a81522 / backendD0 image checkpoint is
confirmed. The detailed serving revision and active signup configuration above are the
current readback; older September readiness documents must not replace them.

## Website publication order

1. Finish the narrow zero-traffic verifier follow-up and its tests. The inspected
   generated post-deploy check in `scripts/render-frozen-backend-deploy.preflight.py`
   still required `latestReadyRevisionName` to equal the newly created zero-traffic
   revision. The parallel release-verifier task is preparing the correction; this
   report does not claim that correction has passed yet.
2. Freeze the final release source after that change, confirm PR checks on the exact
   resulting SHA, and bind website/store candidates to the intended source. Existing
   green checks on `2fd2b831` are not checks for a later commit.
3. For any new backend candidate, use the provider-aware release path and a fresh
   reviewed baseline/pins/scan/build receipt. The existing serving D0 build is older
   than the release tooling's two-hour source freshness window; it is a serving
   checkpoint, not reusable authority for a new deployment. Do not redeploy its
   deterministic revision name or enable the legacy main trigger.
4. Coordinate the final Android provider/backend choice before public publication.
   The current shared backend already serves the web/iOS signup contract, while the
   Android provider path is not active. Source changes after D0 mainly add Android
   opt-ins, guarded readiness and provider tooling. The website itself does not
   require enabling Android or applying pending migration0027. A Play release that
   enables those paths needs its separate reviewed prerequisites.
5. Integrating frontend changes to `main` triggers `.github/workflows/firebase-hosting-merge.yml`.
   Treat the merge as a website-publication action. This workflow builds the exact
   source, publishes an isolated preview, verifies artifacts/headers and packaged
   Three Bosses, checks renewable sessions and enabled submission contracts, then
   promotes Hosting and verifies the public response.
6. Use the workflow's captured previous Hosting version for a website failure. Its
   rollback checks ownership and refuses to overwrite an intervening foreign
   release. A backend fallback uses fresh, reviewed provider traffic plans and the
   compatible creation-pause image/configuration; old pre-provider binaries do not
   preserve current private profiles and Apple credential obligations.

The iOS and Android build/release workflows are separate. A merge that updates the
website does not submit or publish either public store listing.

## Bounded remaining evidence

- Latest website source is prepared and CI-validated, but not yet the live Hosting source.
- A focused public-notice mismatch was confirmed in original source and the live
  notice chunk above: the children section
  says universally that registration asks for country and a coarse age range, while
  the active general signup flow has no country/age questions. A narrow descriptive
  correction and top-level notice version `privacy-2026-10-20.1` are now prepared in
  `shared/privacyNotice.json` for review before the
  next publication; `frontend/PRIVACY_NOTICE.md` explicitly requires a reviewed
  version change for same-URL content changes. Keep separate consent/form text and
  versions intact unless their substance is deliberately changed. This prepared
  correction changes no consent/form wording or versions and no runtime policy.
- The public `/privacy#privacy-deletion` source section now includes plain browser
  links to `/account` and `/parent-accounts` where available, plus an explicit
  `mailto:mickeyf.plays@gmail.com?subject=Ludolume%20account%20deletion%20request`
  link to initiate deletion of the Ludolume account and associated data without
  reinstalling. It states that account ownership must be verified and warns against
  sending passwords/sign-in codes. This source-only request path still requires
  publication and live operator-process acceptance before making the corresponding
  Play declaration. No email automation, response SLA or new retention period is
  claimed; the existing deletion scope and consent/form content are unchanged.
- The verifier follow-up is a tooling prerequisite for the next backend deployment;
  the current production service is healthy.
- Existing public Google/Apple configuration does not establish real signup/login,
  deletion, revocation, signed notification or parent-management acceptance. Preserve
  earlier accepted checks, add only missing checks applicable to the chosen release,
  and do not reinterpret broad iPhone acceptance as a recorded provider lifecycle matrix.
- Audience/minor classification and store privacy/data declarations remain explicit
  release-ledger items. Runtime `POLICY_REVIEWED` flags prove configuration, not a
  fresh legal review. This pass makes no new legal conclusion or policy changes.
- Android store and signing readiness belongs to the parallel Android release pass.

## Safe recheck commands

Run from the repository root. These read metadata only; no secret payloads are needed.

```powershell
git status --short
git rev-parse HEAD
gh pr view 342 --json headRefOid,state,isDraft,statusCheckRollup,url
gcloud run services describe mickeyf-org --region us-central1 --project noted-reef-387021 --format='json(metadata.generation,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,status.url,status.conditions)'
gcloud run revisions describe mickeyf-org-session-active-f4ae47fd8ef44467b5041c42041b3c11 --region us-central1 --project noted-reef-387021 --format='json(metadata.name,metadata.labels,metadata.creationTimestamp,status.imageDigest,status.conditions)'
gcloud builds triggers list --region global --project noted-reef-387021 --format='json(id,name,disabled,github.push.branch,filename)'
gcloud scheduler jobs list --location us-central1 --project noted-reef-387021 --format='json(name,state,schedule,timeZone,httpTarget.uri,status,lastAttemptTime)'
gcloud run jobs describe mickeyf-submission-receipt-cleanup --region us-central1 --project noted-reef-387021 --format='json(status.latestCreatedExecution,status.conditions)'
Invoke-RestMethod -Uri 'https://mickeyf.com/auth/providers/config' -Method Get
Invoke-RestMethod -Uri 'https://mickeyf.com/auth/registration/config' -Method Get
Invoke-RestMethod -Uri 'https://mickeyf.com/api/leaderboards' -Method Get
```

For Hosting metadata, keep the short-lived access token in memory and do not print it:

```powershell
$releaseAccessToken = gcloud auth print-access-token
$releaseHeaders = @{ Authorization = "Bearer $releaseAccessToken"; 'x-goog-user-project' = 'noted-reef-387021' }
$hostingLive = Invoke-RestMethod -Uri 'https://firebasehosting.googleapis.com/v1beta1/sites/noted-reef-387021/channels/live' -Headers $releaseHeaders -Method Get
[pscustomobject]@{
    name = $hostingLive.name
    version = $hostingLive.release.version.name
    status = $hostingLive.release.version.status
    release = $hostingLive.release.name
    releaseTime = $hostingLive.release.releaseTime
    message = $hostingLive.release.message
} | ConvertTo-Json
```

The first Hosting request without the quota-project header returned403. Adding the
request header above succeeded without changing local or cloud configuration.

No cloud writes, deployments, traffic changes, SQL changes, secret payload reads,
store submissions or PR mutations were performed. Existing dirty documentation was
left intact. This task owns this report and the narrow source correction in
`shared/privacyNotice.json`, plus the public deletion-request links in
`frontend/ts/pages/Privacy.tsx` and their focused static rendering test. Validation passed:

```powershell
# From frontend/:
node --experimental-strip-types --test ts/pages/Privacy.test.mjs ts/components/SignedParentForm.test.mjs ts/services/parentRegistrationApi.test.mjs
# From repository root:
.\frontend\node_modules\.bin\tsc.cmd -p frontend/tsconfig.json --noEmit
```

All 17 focused cases passed, including the public deletion-request section rendered
without an authenticated session; frontend typecheck and `git diff --check` passed. A structural
comparison against HEAD confirmed that only the top-level notice version and the
children section's initial wording changed; every consent/form value and other
paragraph remains identical. The live notice remains `privacy-2026-10-06.1` until a
separately authorized publication.
