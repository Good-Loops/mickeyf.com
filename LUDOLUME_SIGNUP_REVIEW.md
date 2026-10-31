# Ludolume signup: US and Brazil review

Prepared on October 6, 2026. The owner approved the staged US/Brazil matrix and the signed-form operator workflow/retention commitment below. Approval is recorded in this conversation. No signup activation or production schema/grant operation has occurred.

## Approved staged eligibility

| Country | New account eligibility | Parent route | Optional public leaderboard |
| --- | --- | --- | --- |
| US | Under 13 through the reviewed parent flow; ages 13–17 and 18+ through self-service | A linked parent signs and returns the exact form; the operator reviews it before the child can choose a password and activate. The same verification applies to older children using the managed route. | Private initially. Managed children require the separate signed public choice and a fresh parent confirmation. Eligible self-service teens/adults choose separately. |
| Brazil | Adults 18+ initially; owner approved this temporary limit | New minor creation remains paused until the Brazil safeguards are completed and reviewed. | Adults choose separately. New minor public participation remains paused. |
| Other countries | No new account creation in this initial bundle | Closed | No new publication approval |

This proposal preserves the intended future minor audience. It is a staged launch choice, not a claim that Brazilian minors cannot legally use Ludolume. Existing-account management/deletion and guest play are separate from new-account creation; this proposal does not by itself establish that those flows meet every ECA Digital obligation.

The prepared approved configuration in `scripts/provider-release-us-br.json` uses `REGISTRATION_COUNTRY_RULES={"US":{"parentRequiredBelow":13},"BR":{"parentRequiredBelow":18}}`, `PARENT_REGISTRATION_COUNTRIES=["US"]`, and `PUBLIC_SCORE_COUNTRY_RULES={"US":{"parentManaged":true,"selfAgeBands":["minor","adult"]},"BR":{"parentManaged":false,"selfAgeBands":["adult"]}}`. No defaults are inserted into runtime configuration. Prepared versions are registration-us-br-2026-10-06.1, parent-us-2026-10-06.1 and public-scores-us-br-2026-10-06.1. Its canonical provider-configuration SHA256 is `bae2a99922489ecd66eb12d2b37513e3515a6dfce409db2ae0437474d41c5da0`. Bind this configuration to the fresh source/image and reviewed deployment plan before activation.

The owner chose the staged matrix above. Brazil minor safeguards remain a separate, explicitly tracked follow-up; do not enable that route by copying the US form logic.

## Brazil requirements still requiring a focused implementation decision

Brazil's [Law 15.211/2025](https://www2.camara.leg.br/legin/fed/lei/2025/lei-15211-17-setembro-2025-797997-normaatualizada-pl.html) covers products directed to or likely accessed by children/adolescents, including connected games. Articles 7, 10–18 address protective defaults, age information and parental supervision, including time-of-use controls and information in Portuguese. The signed US form establishes a consent record; it does not implement these product controls.

[Decree 12.880/2026](https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2026/decreto/d12880.htm), article 24, requires age-assurance mechanisms proportionate to service risk and data minimization. Its prohibition on retaining identity-document images for age assurance is distinct from retaining a signed US consent form. No identity-document collection is proposed. The native/browser platform age-signal paths are not implemented or accepted in this release.

Article 24 of the law sits in the social-network chapter but its first paragraph uses broader product/service wording. We should not assume that chapter placement exempts a game; the application of account-linking thresholds needs an explicit review. A public nickname leaderboard also needs a documented product-risk/classification assessment. A simple age-threshold JSON is insufficient to settle either question.

[ANPD's September 22 update](https://www.gov.br/anpd/pt-br/assuntos/noticias/eca-digital-completa-um-ano-e-e-marco-na-protecao-de-criancas-e-adolescentes-na-internet) says implementation guidance is still developing and monitoring continues. The timetable is not a blanket exemption from the law. Retain these as explicit activation gaps, not assertions of complete compliance.

## Signed US form: owner operation

The approved public contact is Michel Silveira Dias Fingergut, Avenida Santa Luzia, 379, Horto Florestal, Salvador, Bahia, CEP 40295-050, Brazil; +55 71 99910 2221; mickeyf.plays@gmail.com. The notice and form use these supplied contacts.

1. The parent authenticates a linked provider, receives a request bound to their verified email, chosen child nickname, country and exact policy, and prints it. No child account/password is stored at this point.
2. The parent marks the private-account choice, optionally marks the separate public-disclosure choice, signs by hand, dates it and sends a scan/photo from the displayed email to the operator. Do not request identity documents or passwords.
3. The owner personally checks the sender, signature, guardian declaration, matching reference/nickname/country, notice/consent versions and each marked choice. Reject incomplete or inconsistent submissions. Provider sign-in alone is not a verified parental-consent decision. A scanned signed form is an accepted method in [COPPA section 312.5](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.5); this implementation still needs operational acceptance before activation.
4. Run `npm --prefix backend run parent-form:review -- inspect <reference>` privately with the isolated `MIGRATION_DB_*` credential route and exact `SIGNED_FORM_CONFIRM_DATABASE`, `SIGNED_FORM_CONFIRM_SERVER_UUID`, `MIGRATION_CONFIRM_ACCOUNT`. This prints parent metadata to the owner's terminal. Do not paste it into chat or commit it.
5. Approval uses `npm --prefix backend run parent-form:review -- approve <reference>` with all seven unique `--name=value` options: `--contact`, `--form-file`, `--parent-account`, `--policy-digest`, `--public-permission=true|false`, `--reviewer`, `--signed-parent-reviewed=true`. Set public permission true only when the separate choice is marked. The helper hashes the local form without printing/copying/uploading its content. Use `reject` with the same options for a reviewed rejection. After an uncertain outcome, inspect before retrying.
6. The parent refreshes the request and authenticates the linked provider again before activation. Creation consumes one approved proof transactionally. Runtime credentials cannot approve forms, change the owner review or grant signed public permission.

Owner-approved retention commitment: unused SQL requests expire after 14 days; incomplete/rejected form messages are deleted within 14 days; approved forms stay in owner-private storage while the child account remains active and are deleted within 14 days after account-consent withdrawal or child deletion. The owner must remove email attachments, mailbox copies, local files and recoverable trash according to this commitment. SQL cleanup cannot perform this mailbox/file work. The notice must not be activated unless the operator can actually fulfill it. Public-display withdrawal alone preserves private-account consent, while blocking reuse of its old signed public permission.

After public permission is withdrawn, the current implementation does not support reviewing a new signed public choice for an existing child. It keeps the account private. A renewal workflow is a separate future change; do not suggest the old signature can be reused.

## Database and deployment gate

Migration `0026_create_signed_parent_forms.sql` is additive and prepared only. Do not repeat migrations 0013–0025. The new `migrations:signed-parent-forms:plan` command binds the one pending migration to the exact database/server/account, prior 25 records, SQL checksum and recovery state. `migrations:signed-parent-forms:apply` requires the normal target/apply confirmations plus the exact `MIGRATION_CONFIRM_SERVER_UUID` and `MIGRATION_APPROVED_PLAN_SHA256`, checked under the migration lock. A changed or partially recovered plan requires fresh review. Neither command has been run against production.

The proposed `google-apple-parent-signed` runtime grant profile adds one table grant with column-level INSERT/UPDATE restrictions. The owner review fields/public approval cannot be written by runtime credentials. Obtain a fresh runtime-grant plan and review its exact delta before applying. Enable `PARENT_SIGNED_FORMS_ENABLED` only after migration/grant/readiness verification, completed operator acceptance and country-policy approval.

Candidate session secret version 3 and compatible fallback version 4 are confirmed; retain enabled legacy version 2. The fallback is the same candidate image with new creation switches closed and management/deletion retained. Provider acceptance, a fresh candidate build/scan, maintenance receiver routing, zero-traffic candidate/fallback and explicit promotion review remain separate release gates. No signed native/device acceptance is inferred from web or source tests.

## Cumulative security and release checkpoint

| State | Item | Evidence/remaining action |
| --- | --- | --- |
| Fixed in source | Root braces and shell-quote chains | Direct Chokidar 4 replaces chokidar-cli; a scoped concurrently override uses patched shell-quote 1.11.0 for [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv). Locked install, watcher tests and concurrently CLI smoke pass. |
| Fixed in source | Backend ip-address/proxy-addr, frontend source-map-js | Narrow lock updates; fresh root/frontend/backend audits report zero vulnerabilities. |
| Fixed in source | Hosting compression | Pinned deployment lock update. |
| Accepted, bounded | Hosting CLI GHSA-vfj7-8cjw-p6xm | Owner exception through Oct 13, 2026 Sao Paulo; exact-chain audit gate rejects other high/critical findings. No braces backport. |
| Prepared | US signed parent-form flow and migration 0026 | 659 frontend and 900 backend unit tests passed before the final small fixes; final targeted checks pass 27 consent tests, 33 disposable-MySQL tests, 2 migration-plan tests and 39 release/watcher/audit-gate tests. Frontend/backend production builds pass. Production schema/grants and operational acceptance remain pending. |
| Approved and prepared | Staged US/BR rules and operator retention | Owner approved the matrix and operator commitment; production activation remains pending. |
| Deferred and gated | Brazil minor safeguards | New Brazil minor creation/public participation remains paused until the safeguards are completed and reviewed. |
| Pending | Real Google/Apple acceptance | Mocked/synthetic provider tests are not real provider acceptance. |
| Pending | Fresh candidate/fallback build, scan and rollout | No deployment, traffic change or main merge in this checkpoint. |
| Separate serving-image issue | Previous OpenSSL exception ends Oct 7 | Serving image has a different runtime lineage; candidate acceptance does not extend it and expiry does not itself cause an outage. |

The owner's 22 pre-existing dirty documentation files remain excluded from these changes. This checkpoint does not replace or overwrite them.
