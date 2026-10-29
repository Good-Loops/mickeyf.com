# Apple signup 503 investigation

## Verified scope

The October 29 web signup returned HTTP 503 from `/auth/providers/complete`.
The serving source is `d0c04cf1052cbc65fccd986e346654218f55e06a`, not the
unreleased mixed-audience work on the public-release branch. This hotfix branch
starts at that exact serving source and contains diagnostic changes only.

The existing Good-Loops account and its scores are outside the change. No
production signup retry, private account lookup or mutation, score write, provider
revocation, SQL/grant change, secret read, deployment or traffic change was
performed for this investigation.

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
