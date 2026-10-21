# SYNTHETIC TEST ONLY - NOT VALID CONSENT

Local operator rehearsal completed against source baseline `6e2b69130af4d64aa2c0d929cd01d4d1134930a4`, with the added rehearsal files. No real parent, child, signature, consent, email delivery or provider verification was involved. The owner has confirmed they will handle future human reviews; that is not an approval of regional policy or any real request.

## Reproduce locally

From the repository root, with backend dependencies and the already pinned MySQL image available:

```powershell
node --test --test-reporter=spec backend/scripts/run-parent-consent-rehearsal.test.mjs
node backend/scripts/run-parent-consent-rehearsal.mjs
```

The runner accepts no target arguments. It reuses the existing local-Docker-only isolation runner, pinned MySQL 8.0.31 image, fresh project/container identity checks, random loopback port, restricted inherited environment and scoped cleanup. The fixture requires the dedicated synthetic environment and static test credentials, verifies the local database/version, and refuses a database containing any tables. It does not drop existing tables. Ordinary migrations and the exact pending 0028 statement are applied only inside that disposable fixture.

Temporary form files are marked `SYNTHETIC TEST ONLY - NOT VALID CONSENT` and state that nobody signed them. They contain only synthetic request references/countries and are deleted from the verified task-owned temporary directory. Docker cleanup removes the disposable database. No primary-worktree files, production configuration, source policy, shared notice, cloud resources, accounts or existing records were modified.

## Actual operator commands exercised

The test starts the existing `runSignedParentFormReview.ts` CLI as a real subprocess, using a dedicated local operator SQL account rather than the website runtime account. It runs:

```text
node -r ts-node/register ts/accounts/runSignedParentFormReview.ts inspect <synthetic-reference>
node -r ts-node/register ts/accounts/runSignedParentFormReview.ts approve <synthetic-reference> <exact review options>
node -r ts-node/register ts/accounts/runSignedParentFormReview.ts reject <synthetic-reference> <exact review options>
```

The test supplies the exact synthetic parent account, contact, policy digest and temporary form file; `--reviewer=SYNTHETIC TEST ONLY - NOT VALID CONSENT`, `--public-permission=false` and the CLI's required review acknowledgment. That acknowledgment is simulated test input. These unsigned text files are not suitable evidence for approving real accounts. Database name, server UUID and operator account confirmations are supplied only after verifying the disposable target.

For **each of BR and US**, the rehearsal verified:

1. A pending request stores no child nickname/password. CLI inspection shows its country and null nickname. The website SQL user cannot perform operator approval writes.
2. A wrong server confirmation fails without changing the request. A pending form cannot create a child.
3. CLI approval stores the exact synthetic file SHA-256 and reviewer marker, with no public permission. A fresh parent proof then creates one private child with no email; grant/form replay fails.
4. A separate withdrawal proof deletes the child, records the fixture deletion intent and preserves the parent's live session.
5. CLI rejection remains rejected. A subsequent approval attempt and child-creation attempt fail.
6. An expired request cannot be approved or create a child. Expiry cleanup removes it while retaining the unexpired rejected review record.

There were **16 actual CLI subprocess invocations** across the two countries: six inspections, two approvals, two rejections and six expected failed approval attempts. All provider identities, credentials and deletion-journal storage were local test doubles; no email, Google/Apple request or cloud journal write was performed.

## Results and limits

- Runner safety tests: **3 passed, 0 failed**.
- Actual CLI/SQL rehearsal: **2 country scenarios passed, 0 failed, 0 skipped**; test duration about 29 seconds, plus disposable database startup/cleanup. Cleanup completed successfully.
- Backend TypeScript: `.\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit` passed from `backend`.
- `git diff --check` passed.
- Independent review found no concrete correctness/security blocker in the runner, fixture or receipt. The reviewer also ran the new wrapper and reused isolation-harness tests: **14 passed, 0 failed**. The two real SQL country scenarios were not redundantly repeated during that review.

This proves the local operator command sequence and server state transitions with synthetic inputs. It does not prove genuine parental identity/authority/signature review, secure form return/delivery, production operator permissions, regional legal sufficiency, age assurance, retention operations, real provider acceptance or cloud-journal durability. No production cutover, store submission or real consent review occurred.

The exercised sequence obtains a fresh parent proof after approval. The server validates a current single-use five-minute grant and approved form together; it does not separately require that grant issuance occurred after the operator review timestamp. A still-current grant obtained shortly before a rapid review is not independently excluded by this rehearsal.
