The owner approved a temporary exception on October 6, 2026 for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
in the pinned Firebase Hosting deployment CLI only. It expires after October 13,
2026 in America/Sao_Paulo (2026-10-14T03:00:00Z).

The accepted chain is firebase-tools 15.32.0 → chokidar 3.6.0 → braces 3.0.3.
Deeply nested patterns can exhaust the stack. This CLI processes the reviewed
repository's Hosting configuration; this acceptance does not cover an application
server, public pattern input, or use of Firebase emulators. No braces backport is
applied. The raw npm advisory remains present.

`npm run audit:hosting` checks locked and installed versions and permits only
this exact advisory and its two transitive high-severity entries. Audit failures,
expiry, altered pins, and any other high or critical finding block release.
Root, frontend and backend retain their existing low-severity audit thresholds.
Recheck for a published fix and remove this exception when the dependency is fixed;
extension requires a new explicit owner decision.
