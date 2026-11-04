# Serving-image child schema rehearsal

On 4 November 2026, read-only Cloud Run metadata identified the serving revision
`mickeyf-org-session-active-cd5b0564f37f45eaa477a59e12ce528e` at 100% traffic and
image digest `sha256:1bb849217045edb86764177a10014d366f230f3e249c881cf91a984574148360`.
The release source was `10c899faf419678d305a1cbd4b1c0a38e7f6e20a`.

The manual command below runs that **cached, unmodified image**, rather than
trying to import a TypeScript module absent from its bundled deployment output.
It extends the existing disposable MySQL 8.0.31 rehearsal. No production
credentials, cloud connections, real accounts or parent forms are needed.

```powershell
node backend/scripts/run-child-schema-image-tests.mjs
node --test backend/scripts/run-child-schema-tests.test.mjs
npm --prefix backend test
git diff --check
```

| Database capability | Child creation configuration | Observed image behavior |
| --- | --- | --- |
| Exact legacy 0026 | Closed | Starts and serves parent-registration configuration |
| Exact legacy 0026 | Enabled | Exits with startup failure before listening |
| Exact pending-0028 extension | Closed | Starts and serves parent-registration configuration |
| Exact pending-0028 extension | Enabled | Starts and serves parent-registration configuration |

The integration suite passed **11/11** tests, with no skips. It also checks
history and grants, exact ALTER execution, preservation of synthetic legacy
requests, rejection of partial schema changes, and retention observations.
TypeScript and the harness tests passed. The retained local log is
`C:\Users\User\Ludolume-Release-Evidence-2026-11-01\child-schema-exact-image-2026-11-04.log`.

The runtime containers use `NODE_ENV=production`, the image's normal entrypoint,
the column-scoped runtime account and a disposable MySQL Unix socket. They have
no network, a read-only root filesystem, an unprivileged UID and no capabilities.
Only the private test socket is mounted. MySQL's host port remains loopback-only;
the runner validates the exact disposable container before connecting. The socket
volume and runtime containers belong to the unique Compose project so outer
cleanup can remove orphaned probes if the inner test process stops unexpectedly.
Normal completion also verifies and removes each probe by its ownership label.

This is **schema compatibility evidence**, not full production qualification.
The fixture substitutes synthetic provider/policy/identity configuration, does
not load real Apple secrets, send email, invoke deletion or prove a cloud restore.
Its enabled flags are local test inputs, not consent or policy certifications.
The image's production error deliberately omits the failed readiness detail;
the negative control asserts exit status and no listener, and the source-level
test independently identifies the missing child schema.

Production migration still needs the exact fresh preparation candidate/fallback,
live target/grants, backup/restore and deletion-replay evidence, creation closure,
traffic drain and a fresh guarded plan. Child registration still needs the
qualified owner form workflow and regional/privacy review. None was enabled by
this test. The current Apple build and Google declarations remain separate gates.

The ordinary source-only test launcher remains unchanged in behavior and does
not require the private runtime image. This optional local image test cannot run
on a public CI runner without separately provisioning that exact image.
