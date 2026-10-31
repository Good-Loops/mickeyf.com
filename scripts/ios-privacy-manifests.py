#!/usr/bin/env python3
"""Summarize bundled privacy manifests without publishing an app or raw files."""

import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sys

MAX_MANIFEST_BYTES = 1024 * 1024
SAFE_TOKEN = re.compile(r'^[A-Za-z0-9_.-]{1,240}$')
SAFE_PATH = re.compile(r'^[A-Za-z0-9_./ -]{1,1000}$')


def token(value):
    if not isinstance(value, str) or not SAFE_TOKEN.fullmatch(value):
        raise ValueError('Manifest contains an invalid or unexpected token')
    return value


def boolean(value):
    if type(value) is not bool:
        raise ValueError('Manifest contains a missing or invalid boolean')
    return value


def entries(value):
    if not isinstance(value, list):
        raise ValueError('Manifest field must be an array')
    return value


def summarize_manifest(data):
    if not isinstance(data, dict):
        raise ValueError('Privacy manifest must be a dictionary')
    collected = []
    for item in entries(data.get('NSPrivacyCollectedDataTypes', [])):
        if not isinstance(item, dict):
            raise ValueError('Invalid collected data entry')
        collected.append({
            'type': token(item.get('NSPrivacyCollectedDataType')),
            'linked': boolean(item.get('NSPrivacyCollectedDataTypeLinked')),
            'tracking': boolean(item.get('NSPrivacyCollectedDataTypeTracking')),
            'purposes': sorted(token(p) for p in entries(item.get('NSPrivacyCollectedDataTypePurposes'))),
        })
    accessed = []
    for item in entries(data.get('NSPrivacyAccessedAPITypes', [])):
        if not isinstance(item, dict):
            raise ValueError('Invalid accessed API entry')
        accessed.append({
            'type': token(item.get('NSPrivacyAccessedAPIType')),
            'reasons': sorted(token(r) for r in entries(item.get('NSPrivacyAccessedAPITypeReasons'))),
        })
    tracking = data.get('NSPrivacyTracking')
    known_keys = {'NSPrivacyTracking', 'NSPrivacyTrackingDomains', 'NSPrivacyCollectedDataTypes', 'NSPrivacyAccessedAPITypes'}
    return {
        'tracking': None if tracking is None else boolean(tracking),
        'tracking_domains': sorted(token(d) for d in entries(data.get('NSPrivacyTrackingDomains', []))),
        'collected_data': sorted(collected, key=lambda item: item['type']),
        'accessed_apis': sorted(accessed, key=lambda item: item['type']),
        'other_keys': sorted(token(key) for key in data if key not in known_keys),
    }


def report(bundle):
    bundle = Path(bundle)
    if bundle.is_symlink() or not bundle.is_dir() or bundle.suffix != '.app':
        raise ValueError('Expected a real simulator .app directory')
    manifests = []
    skipped_symlinks = 0
    def fail_scan(error):
        raise ValueError('Could not completely scan the app bundle') from error
    for root, directories, filenames in os.walk(bundle, followlinks=False, onerror=fail_scan):
        directories.sort()
        filenames.sort()
        skipped_symlinks += sum((Path(root) / name).is_symlink() for name in directories + filenames)
        directories[:] = [name for name in directories if not (Path(root) / name).is_symlink()]
        for name in filenames:
            manifest = Path(root) / name
            if name != 'PrivacyInfo.xcprivacy' or manifest.is_symlink():
                continue
            relative = manifest.relative_to(bundle).as_posix()
            if not SAFE_PATH.fullmatch(relative):
                raise ValueError('Unexpected manifest path')
            if manifest.stat().st_size > MAX_MANIFEST_BYTES:
                raise ValueError('Privacy manifest exceeds size limit')
            content = manifest.read_bytes()
            manifests.append({'path': relative, 'sha256': hashlib.sha256(content).hexdigest(),
                              **summarize_manifest(plistlib.loads(content))})
    if not manifests:
        raise ValueError('No bundled privacy manifests found; manual investigation required')
    return {'scope': 'unsigned iOS simulator app', 'skipped_symlinks': skipped_symlinks,
            'manifests': manifests,
            'limitations': 'Manifest declarations only; not a distribution archive report or proof of runtime behavior.'}


def main():
    if len(sys.argv) != 2:
        raise ValueError('Pass the path to the unsigned simulator .app bundle')
    print(json.dumps(report(sys.argv[1]), indent=2, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        print(f'Privacy manifest inspection failed: {error}', file=sys.stderr)
        sys.exit(1)
