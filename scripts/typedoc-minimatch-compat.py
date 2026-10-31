#!/usr/bin/env python3
"""Rebuild/verify the documented TypeDoc minimatch compatibility tarball."""
import argparse
import gzip
import hashlib
import io
import os
import pathlib
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'vendor/minimatch-compat'
UPSTREAM = VENDOR / 'minimatch-11.0.3-upstream.tgz'
OUTPUT = VENDOR / 'minimatch-11.0.3-typedoc-compat.tgz'
UPSTREAM_SHA256 = '175b2fd9c9d3611e06980341c1be226c7af72b1f414eefb424dca1be9cd9e8ae'
OUTPUT_SHA256 = '2b94f9ae54845e2dfc342774a980325262227d8f595b5c6111dad1333102486f'
JS_TARGETS = {'package/dist/esm/index.js', 'package/dist/commonjs/index.js'}
TYPE_TARGETS = {'package/dist/esm/index.d.ts', 'package/dist/commonjs/index.d.ts'}
JS_MARKER = b'    #matchRow(file, resolved, pattern, partial) {\n'
JS_PATCH = (b'    // Temporary TypeDoc 0.28 compatibility: restore its removed public entrypoint.\n'
            b'    matchOne(file, pattern, partial = false) {\n'
            b'        const resolved = this.#level2 ? this.#levelTwoFileOptimize(file) : file;\n'
            b'        return this.#matchRow(file, resolved, pattern, partial);\n'
            b'    }\n')
TYPE_MARKER = b'    match(f: string, partial?: boolean): boolean;\n'
TYPE_PATCH = b'    matchOne(file: string[], pattern: ParseReturnFiltered[], partial?: boolean): boolean;\n'

def get_members(path):
    raw = path.read_bytes()
    if path == UPSTREAM and hashlib.sha256(raw).hexdigest() != UPSTREAM_SHA256:
        raise ValueError('Official minimatch archive checksum differs')
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        members = {}
        for entry in archive:
            if not entry.isfile() or entry.name in members or not entry.name.startswith('package/'):
                raise ValueError('Unexpected archive member')
            data = archive.extractfile(entry).read()
            members[entry.name] = (entry, data)
    return members

def patched(members):
    if not (JS_TARGETS | TYPE_TARGETS) <= members.keys():
        raise ValueError('Missing expected upstream files')
    result = {}
    for name, (info, data) in members.items():
        if name in JS_TARGETS:
            if data.count(JS_MARKER) != 1: raise ValueError(f'Unexpected JS source: {name}')
            data = data.replace(JS_MARKER, JS_PATCH + JS_MARKER)
        if name in TYPE_TARGETS:
            if data.count(TYPE_MARKER) != 1: raise ValueError(f'Unexpected TypeScript source: {name}')
            data = data.replace(TYPE_MARKER, TYPE_PATCH + TYPE_MARKER)
        result[name] = (info, data)
    return result

def build(members):
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, (info, data) in sorted(members.items()):
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return out.getvalue()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    expected = patched(get_members(UPSTREAM))
    canonical = build(expected)
    if args.write:
        if hashlib.sha256(canonical).hexdigest() != OUTPUT_SHA256:
            raise ValueError('Local compression differs from pinned package; no file was changed')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=VENDOR, prefix='.typedoc-compat-', delete=False) as file:
                temporary = pathlib.Path(file.name)
                file.write(canonical)
            os.replace(temporary, OUTPUT)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    output = OUTPUT.read_bytes()
    # The pinned gzip bytes make the package immutable; compare the full
    # uncompressed tar stream as well because zlib encoders vary by OS.
    if hashlib.sha256(output).hexdigest() != OUTPUT_SHA256 or gzip.decompress(output) != gzip.decompress(canonical):
        raise ValueError('Patched archive bytes or metadata differ from the reproducible build')
    actual = get_members(OUTPUT)
    if set(actual) != set(expected): raise ValueError('Patched archive entries differ')
    for name, (_, data) in expected.items():
        if actual[name][1] != data: raise ValueError(f'Patched archive differs: {name}')
    print('Verified official minimatch 11.0.3 plus TypeDoc compatibility patch')

if __name__ == '__main__':
    main()
