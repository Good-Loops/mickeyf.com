# Child-registration production cutover plan

Prepared during the 2026-10-20 local release window. Read-only production metadata
was refreshed on **2026-10-21 01:18–01:25 UTC**. Source inspected:
`6e2b69130af4d64aa2c0d929cd01d4d1134930a4`. The isolated worktree was clean before
this report. No frontend removal edits were made during the owner's brief change
of direction; parent-led registration remains in scope.

**Status: planning only; not executable deployment approval.** The owner has
confirmed that they will personally review emailed parent forms. This confirms
the reviewer role. It does not approve BR/US policy, age assurance, guardian
verification standards, retention, public disclosure or a production schema
operation. The synthetic rehearsal and the operational runbook remain separate
acceptance evidence.

Source follow-up: the first three configuration/activation/smoke findings below
have now received the bounded implementation and 233-test qualification described
in [rollout-config-safeguards.md](rollout-config-safeguards.md). The original
findings remain as the inspected baseline. The subsequent source implementation
of the exact0028 operation and real activation metadata verifier is described in
[child-schema-operation.md](child-schema-operation.md). Production execution and
policy gates remain pending. No production state changed.

## Fresh production readback

| Item | Observed metadata |
| --- | --- |
| Project/service/region | `noted-reef-387021` / `mickeyf-org` / `us-central1` |
| Service generation/resource version | `156` / `AAZeDh8yTgU`; unchanged on the closing readback |
| Traffic | Exactly 100% to `mickeyf-org-session-active-f4ae47fd8ef44467b5041c42041b3c11`; no tags |
| Readiness/pointers | Ready, ConfigurationsReady and RoutesReady true; latestCreated/latestReady both identify the serving revision |
| Serving source/build | `d0c04cf1052cbc65fccd986e346654218f55e06a` / `f4ae47fd-8ef4-4467-b504-1c42041b3c11` |
| Serving image | `us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy@sha256:03fb4f80809f377dbda060e5fa03e8905a95189084be36f2cb08157afae2fb96` |
| Existing auth fallback | `mickeyf-org-auth-rollback-f4ae47fd8ef44467b5041c42041b3c11`, same D0 image; Ready=True/Retired, Active=False/Retired |
| Secret references, metadata only | Serving: `SESSION_SECRET` version `3`; existing auth fallback: version `4`; both use `DB_PASS` version `1`. Enabled session versions observed: `2`, `3`, `4`. No payload was accessed. |
| Runtime | `mickeyf-runtime@noted-reef-387021.iam.gserviceaccount.com`, concurrency 80, timeout 300s, min 0/max 10; Cloud SQL attachment `noted-reef-387021:us-central1:cms-mickeyf` |
| Public registration metadata | Still general-audience policy `registration-general-2026-10-17.1`; parent creation false; parent countries US only |
| Cloud Build | All six global triggers disabled; regional trigger inventory empty; ongoing global/regional build inventories empty |

Disabled global triggers: `9fbd63bf-d129-4877-bb26-26d38e1ca468`,
`181b8f84-2303-4c2b-a03e-92dae4b1938c`,
`1c9c6502-f53f-4e04-ac9e-06bf49668acf`,
`648fadca-3cd1-4b57-9d35-0f62a1468443`,
`d71109da-8350-4f2f-a3be-2053bb6ccd45`, and legacy
`ef5a2981-95be-4f4d-af91-f997fde73356`. Keep them disabled. Any future dedicated
approved build is a separate operation; enabling the legacy main trigger is not
part of this plan.

## Backup and recovery facts

`cms-mickeyf` is RUNNABLE, regional, MySQL `MYSQL_8_0_31`, with deletion protection.
Automated backups are enabled at 20:00 UTC, retaining eight scheduled backups in
`us`. Binary logging is enabled with seven days of transaction logs in Cloud
Storage. Latest automated backup `1792526400000` completed successfully at
`2026-10-20T20:58:14.759Z`; the newest six SQL operations observed were completed
backup operations with no reported error.

`get-latest-recovery-time` returned an earliest recovery time of
`2026-10-13T21:45:51.663Z` and latest time
`2026-10-21T01:13:27.410270117Z`. These are recoverability metadata, not a restore
rehearsal or a guaranteed recovery duration. A release-window backup and recovery
checkpoint must be refreshed immediately before any approved DDL operation.

Cloud SQL PITR creates a **new instance**; it cannot restore into the existing
instance. Recovery therefore also needs a reviewed connection/runtime identity
change, a new exact server UUID confirmation, deletion-journal replay and restored
public-permission invalidation before traffic. It must account for intervening
valid writes and deletions rather than silently replacing them with old data.
[Cloud SQL PITR documentation](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/pitr).

No production database connection, row query, schema query, grant query, backup,
clone, restore or SQL statement was performed in this task. Current SQL server
UUID, migration checksums, schema and grants remain **unverified live gates**.

## Pending schema operation and exact compatibility boundary

File: [`0028_extend_child_signed_parent_forms.sql`](../../backend/migrations/pending/0028_extend_child_signed_parent_forms.sql).
Raw file SHA256 at the inspected source:
`8dddfdda37f24f9842d5ed43b950412ab7218260a3c5a49d01eff9564a951cf8`.

The file contains one ALTER of `parent_signed_forms`: make `user_name VARCHAR(64)`
nullable, replace `chk_signed_form_status` with its US/BR country equivalent, and
retain the existing status/review/public-permission requirements. It adds no
runtime privileges, accounts, credentials, history rows or child records.

It is deliberately outside the ordinary migration manifest. Existing
`migrations:signed-parent-forms:plan` / `:apply` operate on **0026**, not this
extension; they must not be repurposed or rerun as an 0028 operation. The new
separate `migrations:child-signed-forms:plan`, `:apply` and `:verify` commands bind
the SQL bytes, clean source, target identity, baseline schema, recovery and
postconditions. See the operation guide before preparing any execution request.
Never fabricate an applied0028 history row to satisfy readiness.

The new source's `verifySignedParentFormReadiness` checks the 0026 receipt and exact
observed capability: table engine/collation, all columns and nullability, indexes,
foreign keys, enforced CHECK expression and absence of unexpected triggers.
Changing only nullability fails. New strict child creation requires the full
extension. With creation closed, the new binary accepts either exact legacy
schema or exact extended schema. **D0 is not a restart-safe fallback after 0028.**

Before an approved operation, the owner/operator must obtain private, fresh
metadata-only preflight evidence for:

1. Project/instance attachment; database `cms`; exact administrative `CURRENT_USER()`;
   fresh `@@server_uuid`, version and server identity. The source's maintenance
   UUID `d1e6865c-ecad-11ee-a6b0-42010a400002` is an expected pin, not a fresh SQL
   observation in this report.
2. Exact 0001–0026 history/checksums and current signed-form schema, plus disposition
   of unrelated pending0027. Do not apply0027 incidentally; Android remains closed.
3. Runtime account `cms_mickeyf`@`%` and exact `google-apple-parent-signed` grant
   profile. Preserve existing column-scoped SELECT/INSERT, UPDATE only for
   `status`, `child_uuid`, `public_withdrawn`, and table DELETE. Runtime must not
   receive review-field/public-approval mutation rights, DDL, broad DML or owner
   credentials. Review columns remain owner-only; metadata verification may use
   SHOW CREATE for columns hidden by runtime grants.
4. A new compatible creation-closed serving candidate and separately verified
   compatible fallback, the exact release-window backup/PITR point, exclusive
   schema-operation coordination and expected metadata-lock/DDL timeout handling.

The future DDL receipt must record identity, before/after schema fingerprints,
exact SQL hash, operation start/end/outcome and unchanged grants. If delivery is
uncertain, inspect exact metadata before retrying. Do not blindly replay ALTER.
MySQL's supported InnoDB DDL is atomic but is not an application transaction that
can be undone with ROLLBACK; ALTER causes implicit commit.
[MySQL atomic DDL](https://dev.mysql.com/doc/refman/8.0/en/atomic-ddl.html),
[implicit commit rules](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html).

## Concrete tooling blockers before any cutover

These are source findings at `6e2b6913`, not a production defect or permission to
widen the tools. Three offline assertions reproduced the configuration refusals;
the existing provider release/activation suites passed **53/53**.

| Blocker | Bounded future correction and required proof |
| --- | --- |
| `validateProviderActivationPins` requires general signup=true and parent creation=false. It rejects a valid strict child bundle. | Add an explicit, exact strict-child activation branch bound to reviewed staged countries, signed-country coverage, policy/schema/rehearsal receipts and compatible fallback. Preserve general legacy validation; never remove the general check without replacing its authority. Add positive child and negative mixed/general/unreviewed/schema/fallback/stale-plan cases. |
| `providerReleaseEnvironment` cannot express the first strict creation-closed deployment. `prepare` forbids the child policy and disables provider login; `active` insists all creation flags are true. | Introduce one explicit reviewed strict creation-closed preparation contract, retaining eligible provider login, password login, management, deletion, Apple lifecycle/notifications/cleanup and private-profile handling while all four account creation flags stay false. Bind its exact digest in baseline, rendering, receipts and rollback validation. Prove startup on both legacy and extended schemas. |
| Generated HTTP smoke still expects the old staged config without `audience`/`creationEnabled`, assumes parentRegistrationAvailable=false and derives provider signup from phase. | Probe the exact strict open/closed public contracts and per-client signup capabilities from reviewed flags, including parent availability after complete schema readiness. Fail on absent fields, wrong country coverage, unsafe headers, unexpected client/Android activation and credential issuance during closure. |
| 0028 has no reviewed target-bound production operation/receipt path. | Add a narrow plan/verify/apply operation only after exact preflight and backup/recovery review. Reuse the existing migration identity/hash confirmation pattern without registering unrelated migrations or reading/printing data. Require single ALTER and reject changed schema/grants/identity/SQL or ambiguous retry. |

The draft policy's false review markers must continue to fail validation. The
owner's reviewer decision must not automatically set `POLICY_REVIEWED` or
`ASSURANCE_REVIEWED`. Android presenter pins remain empty; do not add Android
provider clients in this release without its separate Play certificate review.

## Reviewable future sequence

Each cloud/SQL/policy/traffic operation below needs its own concrete reviewed
release-window inputs. None was executed here.

1. **Finish gates and source.** Accept the synthetic owner-review rehearsal and
   private operator runbook; separately resolve intended-region policy/age
   assurance, notice/form versions, retention and optional disclosure decisions.
   Implement/review/test the four bounded tooling prerequisites above. Freeze the
   final source and CI, exact frontend/native contract, policy digest and rollback
   behavior. A fresh current baseline must match production; September/October D0
   pins are historical evidence, not an executable new plan.
2. **Prepare compatible closed candidate and fallback first.** Build the frozen
   source under a dedicated reviewed image-only path; bind provenance, immutable
   digest and completed continuous OS/NPM/SECRET analysis with no HIGH/CRITICAL
   findings. Use fresh owner-provisioned numbered signing references (distinct
   candidate/fallback, above existing version4; never payloads or `latest`). Bind
   exact runtime, Cloud SQL attachment, service account and previous provider
   config. Prepare an untagged zero-traffic creation-closed candidate, then its
   compatible creation-closed fallback with the newer signing reference. Prove
   both start against the current exact legacy schema, permit existing password
   and eligible provider login/management, and deny all new password/provider/
   parent account creation. Do not substitute the D0 auth fallback for this pair.
3. **Serve the new closed binary before schema.** Review a fresh traffic-only plan
   to move 100% to the compatible closed candidate, with no tags. Verify settled
   traffic, exact source/config/runtime and usable fallback, then record the
   reader boundary and drain at least the pinned 300-second request deadline.
   Close all creation paths and eliminate old readers before DDL. Website/native
   publication must remain coordinated; new strict source refuses the old general
   contract, and the old public site does not prove the new age gate.
4. **Apply schema second, after explicit schema approval.** Refresh target/schema/
   history/grants, backup/PITR and closed-reader evidence; review the single0028
   plan hash and exclusive operation. The owner/operator then executes only the
   approved ALTER. Verify exact extended readiness through both compatible closed
   binaries and unchanged grants; record the receipt. Leave all creation closed
   if any postcondition is uncertain.
5. **Activate strict policy last.** Only after regional/policy/owner-operation,
   schema, candidate and real-provider gates pass, prepare the exact active
   strict bundle and its matching creation-closed fallback first. Preserve
   Google/Apple login, child password login, private profiles, withdrawal,
   deletion and Apple maintenance in fallback. Review fresh source/scan,
   baseline/reader-boundary and template receipts, then a separate five-minute
   traffic plan. Make no implicit public-score disclosure or Android activation.
6. **Publish matching surfaces and verify.** Publish coordinated website/notice
   and qualify the actual native candidates; test approved/pending/rejected/
   expired/replayed parent flows, adult sign-in, guest entry and existing family
   deletion/withdrawal. Website promotion and store submission remain distinct
   operations. Keep the ability to close new creation using the verified new
   compatible fallback; monitor runtime readiness and maintenance failures.

New signing versions intentionally change session acceptance: candidate/fallback
rotation can require existing users to sign in again. Record that expected effect
and verify session establishment after either promotion or fallback.

## Existing guard tools to reuse, not bypass

- `scripts/render-provider-backend-deploy.mjs`: offline frozen rendering and
  build/trigger-bound step hash; no implicit deployment.
- `scripts/provider-backend-release.mjs baseline --previous-configuration ...
  --output <new.json>`: read-only exact previous provider baseline.
- `plan-rollback`, `plan-traffic --operation promote|rollback`: separate reviewed
  zero-traffic fallback and traffic plans.
- `observe-reader-boundary`, `plan-active-revision --kind fallback|candidate`,
  `plan-active-traffic --operation activate|close-active`: receipt-bound reader,
  template and traffic preparation after the strict-contract gaps are fixed.
- Existing apply commands require exact plan SHA and their explicit operation
  confirmation. This document supplies neither executable pins nor confirmation.

Do not use session-only tooling for a provider/child-policy mutation. Do not run
old 0026 migration commands for0028 or turn on a historical main trigger.

## Stale-plan and recovery stop conditions

Discard and recapture plans after any source/policy/SQL hash change, image/tag/
provenance/scan drift, deployment receipt change, signing-version state change,
service etag/generation/template/traffic/tag change, foreign revision, changed
Ready/runtime/Cloud SQL identity, automation re-enable/new build, schema/history/
grant drift, changed reader boundary, expired five-minute plan, or two-hour
source freshness failure. A zero-traffic revision being Ready/Retired is accepted
only with exact independent source/runtime/receipt proof; it does not authorize a
foreign latestReady pointer or relax traffic settlement.

Before0028, the old source remains a possible fallback only while its exact schema
and configuration are still valid. After0028, recover by routing to the **new
compatible creation-closed fallback** and retaining the extended schema. Do not
route to D0 or depend on its currently warm container surviving a restart.

There is no approved inverse0028 statement. Reinstating NOT NULL/US-only checks
could fail or destroy valid new requests/accounts once null pending names or BR
records exist. Do not invent names, delete records or weaken constraints to make
an old binary start. Any inverse needs a private compatibility audit and separate
review. Prefer forward repair on the compatible closed binary. PITR/backup
recovery is a separately approved incident operation with reconciliation and
deletion/privacy replay, not the routine traffic rollback.

## Read-only commands executed

From the isolated worktree, using existing credentials:

```powershell
git status --short
git rev-parse HEAD
Get-FileHash backend/migrations/pending/0028_extend_child_signed_parent_forms.sql -Algorithm SHA256
gcloud run services describe mickeyf-org --region us-central1 --project noted-reef-387021 --format='json(metadata.generation,metadata.resourceVersion,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,status.url,status.conditions,spec.template.metadata.annotations,spec.template.spec.serviceAccountName,spec.template.spec.timeoutSeconds,spec.template.spec.containerConcurrency)'
gcloud run revisions list --service mickeyf-org --region us-central1 --project noted-reef-387021 --limit 4 --format='json(metadata.name,metadata.labels.source-commit,metadata.labels.source-build-id,status.imageDigest,status.conditions)'
gcloud builds triggers list --region global --project noted-reef-387021 --format='json(id,name,disabled,filename)'
gcloud builds triggers list --region us-central1 --project noted-reef-387021 --format='json(id,name,disabled,filename)'
gcloud builds list --ongoing --region global --project noted-reef-387021 --format='json(id,status,buildTriggerId,createTime)'
gcloud builds list --ongoing --region us-central1 --project noted-reef-387021 --format='json(id,status,buildTriggerId,createTime)'
gcloud sql instances describe cms-mickeyf --project noted-reef-387021 --format='json(name,connectionName,databaseVersion,region,state,settings.backupConfiguration,settings.deletionProtectionEnabled,settings.availabilityType,settings.databaseFlags)'
gcloud sql backups list --instance cms-mickeyf --project noted-reef-387021 --limit 10 --format='json(id,status,type,windowStartTime,startTime,endTime,location,backupKind)'
gcloud sql instances get-latest-recovery-time cms-mickeyf --project noted-reef-387021 --format=json
gcloud sql operations list --instance cms-mickeyf --project noted-reef-387021 --limit 6 --format='json(name,operationType,status,startTime,endTime,error)'
node --test scripts/provider-backend-release.test.mjs scripts/provider-backend-activation.test.mjs
```

Public GET registration/parent configuration was checked. Cloud Run v2 revision
GETs requested only `name,containers(env(name,valueSource))` to read signing/DB
secret references, using an access token kept in memory and never printed. Two
CLI projections returned null and were superseded by these narrow API GETs.
The larger revision inventory was metadata-only; the report limits analysis to
the four current D0 revisions. No secret payload, database contents, production
SQL or synthetic approval was accessed or written.

**Verification:** three offline blocker assertions passed; the two existing
provider suites passed 53/53 with zero failures/skips. Their output is retained
at `$env:TEMP\ludolume-cutover-planner-source-tests.log`. Only this report was
created; no source/tooling changes, install, commit, cloud image build, deployment,
flag change, traffic change, SQL execution, merge or publication occurred.
