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
