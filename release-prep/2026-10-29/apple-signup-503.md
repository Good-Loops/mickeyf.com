# Apple signup 503 investigation

Current checkpoint: the diagnostic backend is deployed and serving 100 percent
of traffic. Deployed source is `a33c28d9efc35496a05ed73e08ab39387380ecf7`.
The underlying signup failure still needs one controlled provider test; no
signup retry was performed during deployment. The Good-Loops account and its
public scores were preserved. Rollout acceptance is recorded below.

## Verified scope

The October 29 web signup returned HTTP 503 from `/auth/providers/complete`.
The serving source is `d0c04cf1052cbc65fccd986e346654218f55e06a`, not the
unreleased mixed-audience work on the public-release branch. This hotfix branch
starts at that exact serving source and contains diagnostic changes only.

The existing Good-Loops account and its scores are outside the change. During
the initial diagnosis, no
production signup retry, private account lookup or mutation, score write, provider
revocation, SQL/grant change, secret read, deployment or traffic change was
performed. The later authorized deployment is recorded below.

Read-only Apple Developer checks matched the configured team, signing key,
primary app, Services ID, domain and exact return URL. These metadata checks do
not prove that the runtime private key matches the key ID, or that Apple's
token endpoint accepted a request. The observed timing is within the signup
authorization lifetime.

A disposable MySQL reproduction also found that the basic `google-apple`
grant profile cannot insert the private score-permission row required by
general registration. The stronger parent profile grants that operation.
The live runtime's exact privileges have not been independently verified, so
this is not established as the cause of the production failure and no grant
change is included.

## Purpose of the patch

The serving implementation turns Apple token-exchange errors, transactional
registration failures and session failures into the same generic 503 while
discarding their diagnostic category. The patch adds bounded server-side
failure stages and allowlisted error categories. HTTP responses, account
selection, credential processing and transaction behavior must remain the same.

Logs must contain no raw error message/cause, provider payload, authorization
code, token, email, username, provider subject, account/session identifier,
cookie, password, SQL statement or query parameter. Logging failure must not
change an authentication or transaction result.

## Validation

On Node 22.23.3 / npm 11.6.2:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
node --test -r ts-node/register ts/auth/providerAuthDiagnostics.test.ts ts/auth/appleTokenClient.test.ts ts/accounts/providerAccountRepository.test.ts ts/auth/providerAuthFlow.test.ts ts/routers/providerAuthRouter.test.ts
npm run test:unit
npm run test:migrations -- --provider-identities
npm run prod
git diff --check
```

The npm/Node commands ran from `backend`; the Git check ran from the repository
root. TypeScript passed. The focused tests passed 132/132; the full backend unit
suite passed 945/945 with no skips. All four real-SQL provider integration files
passed in the hardened, disposable MySQL 8.0.31 fixture, including existing
account/score preservation, signup collisions and uncertain commit handling.
The runner removed its container and network successfully. The production
Webpack bundle passed with the two existing optional `supports-color` warnings.

The same five focused test files also passed 132/132 on the pinned production
Node 26.12.0 Alpine image, using a read-only backend mount, network disabled,
dropped capabilities and no production configuration or database connection.

An independent source review found no remaining actionable issue. The tests
cover bounded log fields, payload redaction, throwing inspection/logger paths,
unchanged HTTP failures and cookie timing, and transaction outcome distinctions.
These checks validate diagnostic behavior, not the cause of the live failure.

Final read-only production checks still showed generation 156, the same serving
revision and 100 percent traffic. The public Good-Loops entries matched the
protected baseline: p4-Vega position 3 / score 330; Three Bosses position 2 /
score 118417 / time 84447 ms / grade B. No private account data was queried.

## Remaining operational step

This patch is not a verified repair of the live signup failure. Before a
controlled retry, review the tested diff and obtain authorization for an
image-only build and a guarded diagnostic rollout. Recheck the serving
revision, exact source/image, runtime configuration and rollback path then;
preserve existing policy flags, schema, grants and secret-version references.
Do not merge the public-release branch as a way to deploy this hotfix.

After rollout, the next failure stage determines the repair. Check whether
account creation committed before retrying an ambiguous failure. Never merge,
delete, relink or compensate by revoking an existing identity automatically.

## Authorized build: security prerequisites

The owner authorized building and deploying the diagnostic patch on October 29.
The first image-only build succeeded, but completed Artifact Analysis blocked
deployment: body-parser 1.20.6 had a HIGH finding, and musl 1.2.6-r2 had an
unclassified finding. That image was not deployed; the service remained at
generation 156 with its original serving revision and traffic.

The hotfix therefore includes the already reviewed npm security entries from
`1f84329`: body-parser 1.20.9, qs 6.16.1 and ip-address 10.7.4. Express remains
4.22.2. Alpine musl and musl-utils are pinned to 1.2.6-r3 in the existing shared
library update stage, and the final-image smoke test verifies those pins.
See the [body-parser release](https://github.com/expressjs/body-parser/releases/tag/1.20.9)
and [Alpine vulnerability record](https://security.alpinelinux.org/vuln/CVE-2026-107891).

The new parser regression runs real Express in a bounded, isolated child
process. It sends a complete compressed JSON frame plus trailing bytes and
checks that a second request succeeds. An independent negative control with
the upstream vulnerable 1.20.6 implementation crashed on gzip with an unhandled
Z_DATA_ERROR; the patched implementation passed. Deflate also passes as a
compatibility check.

After these prerequisite changes, TypeScript, all 947 backend unit tests,
production Webpack compilation and `npm audit --omit=dev --audit-level=low`
passed (zero runtime dependency vulnerabilities). The fixed Alpine stage built
locally and both exact musl package checks passed. A rebuilt immutable image
must still pass its own provenance, completed Artifact Analysis and isolated
runtime checks before any deployment or traffic update. Operational plans and
receipts are kept privately outside the checkout; they contain no secret
payloads or private account queries.

## Completed diagnostic rollout

The accepted image build was `ff2bdbde-f651-4b1a-bccf-427b2be09059`, from exact
source `a33c28d9efc35496a05ed73e08ab39387380ecf7`. Its immutable digest is
`sha256:4cb006bb8504803fb697d373911ee109b36f1f3dbc058860f3f994686a7cbcd8`.
Source/provenance checks passed, including independent verification of the
retained Google builder's classical DSSE signature. Completed Artifact Analysis
passed the HIGH/CRITICAL gate. The exact production image passed isolated
Node 26.12.0, OpenSSL, musl, crypto/fetch, dependency-version and diagnostic-marker
checks; gzip/deflate regression probes each served two successful requests.

The reviewed template change altered only revision, image and two provenance
labels. Every environment value, secret reference, identity, resource setting,
probe and volume was preserved. A single etag-conditional template update
created the zero-traffic candidate at generation 157. Its actual Ready state
and exact runtime were verified before a separate conditional traffic update.

Revision `mickeyf-org-apple-diag-ff2bdbdef6514b1abccf427b2be09059` now serves
100 percent without tags at generation 158. Four uncached public GET checks
returned 200, and matching Cloud Run request traces confirmed that the new
revision served them. The initial error/5xx log check found no entries.
The previous serving revision remains Ready and its immutable configuration
matches the captured rollback baseline. All build triggers are paused again.

The Good-Loops public entries still show p4-Vega position 3 / score 330 and
Three Bosses position 2 / score 118417 / time 84447 ms / grade B. No account,
score, SQL schema/grant, policy or signing-secret mutation was performed by the
operator. The website frontend and store artifacts were not republished.

Private `deployment-result.json` and the separate plan, signature, scan, image,
traffic and public-check receipts are the operational evidence. A prepared
rollback plan is time bounded and must be regenerated when needed. This hotfix
has not been merged into the draft public-release branch; a later release must
incorporate it before replacing this live image.

## Controlled signup result and follow-up diagnostics

On October 29 (local time), a controlled Apple signup returned HTTP 503 on the
serving diagnostic revision. The sole failure event was `apple-token-exchange`,
category `unclassified`; request latency was approximately 0.78 seconds. This
stage occurs before account creation. The log does not establish which token
response or verification step failed. No automatic retry was performed.

The public Good-Loops entries remained at p4-Vega 330 and Three Bosses 118417,
84447 ms, rank B. The follow-up diagnostic change distinguishes response field,
exchanged-token verification, identity mismatch and a signed token missing a
nonce using fixed labels only. It preserves strict verification and omits token
contents, credentials, personal information and provider subjects. This is
instrumentation, not a confirmed repair.

## Follow-up diagnostic rollout

The refined diagnostic source was committed as `dc9121cf56489d0825e88905686a335c5614d06c`.
TypeScript and 96 focused authentication tests passed. The full backend suite
passed 951/951 with one test worker; a previous concurrent run encountered
subprocess timeouts. Production Webpack compilation passed with two existing
optional supports-color warnings. The exact image passed isolated runtime and
compressed-request checks. Artifact Analysis completed with no blocking HIGH
or CRITICAL findings. Exact source and the classical builder signature were
verified; no claim is made about verifying the post-quantum signature.

The zero-traffic candidate was checked before a separate promotion. Revision
`mickeyf-org-apple-diag-e757242892b74eabb36ab654636dd41f` serves 100 percent
at generation 160. All four public GET traces reached that revision and returned
200, and initial post-promotion logs showed no 5xx. The former diagnostic
revision remains the rollback target, and all build triggers are paused.
Good-Loops public scores remain 330 and 118417 / 84447 ms / rank B. No account
or score mutation was performed. The change is diagnostic and the signup bug
is not yet proven fixed. All operational receipts are in the private
`diagnostic-iteration-2` folder.

## Apple key-cache failure reproduced and repair prepared

A controlled signup on the refined diagnostic revision returned 503 at
`apple-exchange-verification`, before account creation. The Apple public key
endpoint observed from this machine returned `Cache-Control: no-store`. A local
regression reproduced successful first-token verification followed immediately
by `PROVIDER_UNAVAILABLE`: zero cache lifetime conflicted with the 30-second
refresh cooldown. Production egress headers were not independently observed, so
this remains a strongly supported cause rather than a production packet capture.

The fix makes uncacheable results available only to their initiating verification,
refreshes expired short-lived key sets, preserves failure and unknown-key throttles,
and bounds per-provider outgoing fetches and concurrency. The 60-fetch-per-30-second
limit is per verifier instance and may temporarily reject authentication during
bursts or abuse. No expired key fallback or signature/nonce relaxation is added.
A synthetic two-token signup with the real verifier reaches one mocked account
creation; this does not establish successful real Apple signup or rule out a later
unrelated failure.

## Apple key-cache repair rollout

On October 30, the owner approved deploying the reviewed key-cache fix. A fresh
image-only build was required because the prior build exceeded the two-hour
qualification limit. Build `86140067-c7cc-4606-8edb-858075842ef1` resolved exact
source `02c816dbbb0a4556eac8e981136889be1cc62f5a`; its digest is
`sha256:2fa6729abb0683c0a66404b10575576664e686adb929d71b459bb3019c31679b`.
The full backend suite passed 960/960 using one worker; TypeScript, production
Webpack (two existing optional supports-color warnings), exact-image runtime,
focused Node 26 tests and compressed-request probes passed. The completed image
scan had no blocking HIGH or CRITICAL findings. The classical builder signature
and exact source provenance passed verification; the post-quantum signature was
not cryptographically verified.

After a reviewed zero-traffic readiness check and separate guarded promotion,
revision `mickeyf-org-apple-diag-86140067c7cc46068edb858075842ef1` serves
100 percent at generation 162. Four public GET traces reached it with status 200;
initial logs showed no 5xx. The previous diagnostic revision remains Ready for
rollback and build triggers are paused. Good-Loops public scores still match:
p4-Vega 330; Three Bosses 118417 / 84447 ms / rank B. No account or score
mutation was performed by the operator. Runtime flags and secret references
were preserved. A real Apple signup remains necessary to establish end-to-end
success; later failures cannot yet be ruled out. Do not deploy the older draft
public-release branch without incorporating this live fix.

Private operational receipts are in `jwks-fix-rollout-fresh-2026-10-30`.

## Real Apple signup verified

On October 30, the owner completed Apple signup on the repaired live revision
and reported the new username `GL-Test`. The visible success screen confirmed
that the account was ready and logged in. The matching completion request was
HTTP 200 at 2026-10-30T21:54:26Z on the repaired revision, and the queried
period contained no provider-auth failure events. This verifies this real
website signup attempt; it does not establish native-app, store-submission, or
parental-consent acceptance.

A read-only public check afterward confirmed the existing Good-Loops scores
remain p4-Vega 330 and Three Bosses 118417 / 84447 ms / rank B. No login,
linking, deletion, or score mutation of Good-Loops was performed by the
operator. The new test account is left in place.
