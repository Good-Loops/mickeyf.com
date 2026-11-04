# Temporary TypeDoc matcher compatibility

TypeDoc 0.28.20 calls the former public `Minimatch.matchOne` method when
traversing glob entry points. The security-fixed minimatch 11 no longer exposes
that method. This temporary package restores that method as a small adapter to
minimatch 11.0.3's existing row matcher; it does not alter TypeDoc or remove the
upstream minimatch security fix. Both the CommonJS and ESM distributions have
the same adapter and matching TypeScript declaration.

`minimatch-11.0.3-upstream.tgz` is the published npm package, including its
BlueOak-1.0.0 license. Its official npm integrity is
`sha512-iny/40PEGkNJQ5/Pv6z3nm6FbRAby32GeZRjCUJk2WnNDbgPSTcdI+DDvLqsgBdD4cD5sMtMheqPPnehCCa8Nw==`.
Source and release: https://github.com/isaacs/minimatch/tree/v11.0.3.
`minimatch-11.0.3-typedoc-compat.tgz` is derived from that archive by
`python scripts/typedoc-minimatch-compat.py --write`. The script pins both
archive hashes and verifies all contents and tar metadata; a different local
gzip implementation is rejected before replacing the checked-in archive.
Run without `--write` to verify it on any supported platform.

The npm override applies the local package to TypeDoc through a direct root
development dependency. npm audit still receives minimatch's real package name
and version; a local audit-registry regression test verifies that behavior.
Installation does not use lifecycle scripts, including with `--ignore-scripts`.
The adapter uses minimatch 11's private row matcher and must be reviewed when
updating this package. Upstream v11 also changed a few matching behaviors
(including some hidden-directory and Windows UNC cases); tests cover the
project's recursive glob, exclusion, symlink and entry-point usage.

Remove this temporary package and override when TypeDoc officially supports a
security-fixed matcher, and rerun the compatibility and documentation checks.
