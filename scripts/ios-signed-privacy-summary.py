#!/usr/bin/env python3
"""Prepare a bounded manifest summary; signature validation is the caller's job.

This is not an Xcode Organizer privacy report and does not determine what data
is actually collected. It is deliberately not connected to any signing job.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('privacy_inventory', Path(__file__).with_name('ios-privacy-manifests.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)

SAFE_TYPES = frozenset('NSPrivacyCollectedDataType' + name for name in (
    'Name', 'EmailAddress', 'PhoneNumber', 'PhysicalAddress', 'OtherUserContactInfo',
    'Health', 'Fitness', 'PaymentInfo', 'CreditInfo', 'OtherFinancialInfo',
    'PreciseLocation', 'CoarseLocation', 'SensitiveInfo', 'Contacts', 'EmailsOrTextMessages',
    'PhotosorVideos', 'AudioData', 'GameplayContent', 'CustomerSupport', 'OtherUserContent',
    'BrowsingHistory', 'SearchHistory', 'UserID', 'DeviceID', 'PurchaseHistory',
    'ProductInteraction', 'AdvertisingData', 'OtherUsageData', 'CrashData',
    'PerformanceData', 'OtherDiagnosticData', 'EnvironmentScanning', 'Hands', 'Head', 'OtherDataTypes',
))
SAFE_PURPOSES = frozenset('NSPrivacyCollectedDataTypePurpose' + name for name in (
    'ThirdPartyAdvertising', 'DeveloperAdvertising', 'Analytics', 'ProductPersonalization',
    'AppFunctionality', 'Other',
))
KNOWN_SDKS = frozenset((
    'AppAuth.framework', 'AppCheckCore.framework', 'Capacitor.framework',
    'GoogleSignIn.framework', 'GoogleUtilities.framework', 'GTMAppAuth.framework',
    'GTMSessionFetcher.framework', 'RecaptchaInterop.framework',
))


def sanitized_bundle_summary(bundle):
    """Return only fixed data-type/purpose vocabulary and opaque source identifiers."""
    raw = privacy.report(bundle)
    manifests = []
    for item in raw['manifests']:
        components = Path(item['path']).parts
        sdk = next((part for part in components if part in KNOWN_SDKS), None)
        collected = []
        unknown_types = 0
        unknown_purposes = 0
        for data in item['collected_data']:
            if data['type'] not in SAFE_TYPES:
                unknown_types += 1
                continue
            known_purposes = [purpose for purpose in data['purposes'] if purpose in SAFE_PURPOSES]
            unknown_purposes += len(data['purposes']) - len(known_purposes)
            collected.append({'type': data['type'], 'linked': data['linked'],
                              'tracking': data['tracking'], 'purposes': known_purposes})
        manifests.append({
            'source_id': hashlib.sha256(item['path'].encode('utf-8')).hexdigest(),
            'recognized_sdk_path_component': sdk,
            'manifest_sha256': item['sha256'],
            'tracking': item['tracking'],
            'tracking_domain_count': len(item['tracking_domains']),
            'collected_data': collected,
            'unknown_collected_type_count': unknown_types,
            'unknown_purpose_count': unknown_purposes,
            'accessed_api_entry_count': len(item['accessed_apis']),
            'unknown_key_count': len(item['other_keys']),
        })
    return {'manifests': manifests, 'skipped_symlinks': raw['skipped_symlinks'],
            'complete': raw['skipped_symlinks'] == 0 and all(
                item['unknown_collected_type_count'] == 0 and item['unknown_purpose_count'] == 0
                and item['unknown_key_count'] == 0 for item in manifests)}


def _real_directory(path):
    path = Path(path)
    if path.is_symlink() or not path.is_dir() or path.resolve() != path.absolute():
        raise ValueError('Expected an owned real directory')
    return path


def owned_signing_root(env):
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('LUDOLUME_SIGNED_PRIVACY_INSPECTION') != '1'
            or env.get('GITHUB_REF') not in ('refs/heads/main', 'refs/heads/feature/auth-family-leaderboards')):
        raise ValueError('Explicit protected inspection is required')
    run_id, attempt = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9]\d*', run_id) or not re.fullmatch(r'[1-9]\d*', attempt):
        raise ValueError('Invalid run identity')
    runner_path = Path(env.get('RUNNER_TEMP', ''))
    if not runner_path.is_absolute():
        raise ValueError('Runner temporary directory must be absolute')
    runner = _real_directory(runner_path)
    root = _real_directory(runner / f'ludolume-testflight-{run_id}-{attempt}')
    owner_file = root / 'owner.json'
    if owner_file.is_symlink() or not owner_file.is_file() or owner_file.stat().st_size > 4096:
        raise ValueError('Owned directory marker unavailable')
    owner = json.loads(owner_file.read_text(encoding='utf-8'))
    if owner != {'runId': run_id, 'attempt': attempt, 'root': str(root)}:
        raise ValueError('Owned directory marker mismatch')
    return root


def bundle_in(root, relative_parent):
    parent = root
    for component in relative_parent:
        parent = _real_directory(parent / component)
    apps = sorted(child for child in parent.iterdir() if child.name.endswith('.app'))
    if len(apps) != 1 or apps[0].is_symlink() or not apps[0].is_dir():
        raise ValueError('Expected exactly one real application bundle')
    return apps[0]


def inspect_owned(env):
    root = owned_signing_root(env)
    archive = sanitized_bundle_summary(bundle_in(root, ('Ludolume.xcarchive', 'Products', 'Applications')))
    export = sanitized_bundle_summary(bundle_in(root, ('ipa-check', 'Payload')))
    archive_items = {(item['source_id'], item['manifest_sha256']) for item in archive['manifests']}
    export_items = {(item['source_id'], item['manifest_sha256']) for item in export['manifests']}
    return {'kind': 'custom signed-build manifest inventory; not an Apple Organizer report',
            'signature_verification': 'not performed by this helper; caller must independently verify both artifacts',
            'limitations': 'Manifests declare SDK data uses; they do not prove actual collection, sharing or runtime behavior.',
            'archive': archive, 'exported_application': export,
            'manifest_path_hash_and_content_sets_match': archive_items == export_items,
            'comparison_complete': archive['complete'] and export['complete']}


def main():
    if len(sys.argv) != 1 or sys.platform != 'darwin':
        raise ValueError('This helper accepts no arguments and requires macOS')
    print(json.dumps(inspect_owned(os.environ), indent=2, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, TypeError):
        # No raw filesystem path, manifest contents, or signing information in logs.
        print('Signed privacy inventory failed; no raw inspection details were logged.', file=sys.stderr)
        sys.exit(1)
