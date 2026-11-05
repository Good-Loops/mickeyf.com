#!/usr/bin/env python3
"""Inventory the verified export before upload; never log raw signing files."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('privacy', Path(__file__).with_name('ios-privacy-manifests.py'))
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


def real_directory(path):
    path = Path(path)
    if path.is_symlink() or not path.is_dir() or path.resolve() != path.absolute():
        raise ValueError('Expected an owned real directory')
    return path


def owned_root(env):
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('GITHUB_REF') not in ('refs/heads/main', 'refs/heads/feature/auth-family-leaderboards',
                                              'refs/heads/feat/ludolume-release')):
        raise ValueError('Protected manual signing job required')
    run_id, attempt = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9]\d*', run_id) or not re.fullmatch(r'[1-9]\d?', attempt):
        raise ValueError('Invalid run identity')
    runner = Path(env.get('RUNNER_TEMP', ''))
    if not runner.is_absolute():
        raise ValueError('Runner temporary directory must be absolute')
    root = real_directory(real_directory(runner) / f'ludolume-testflight-{run_id}-{attempt}')
    marker = root / 'owner.json'
    if marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 4096:
        raise ValueError('Ownership marker unavailable')
    if json.loads(marker.read_text(encoding='utf-8')) != {'runId': run_id, 'attempt': attempt, 'root': str(root)}:
        raise ValueError('Ownership marker mismatch')
    return root


def one_real_child(parent, suffix, directory=False):
    matches = [child for child in parent.iterdir() if child.name.endswith(suffix)]
    if len(matches) != 1:
        raise ValueError('Expected exactly one export')
    child = matches[0]
    if child.is_symlink() or (not child.is_dir() if directory else not child.is_file()):
        raise ValueError('Export must not be redirected')
    return child


def sanitized_manifests(app):
    raw = privacy.report(app)
    manifests = []
    for item in raw['manifests']:
        data = item['collected_data']
        manifests.append({
            'source_path_sha256': hashlib.sha256(item['path'].encode('utf-8')).hexdigest(),
            'recognized_sdk_path_component': next((part for part in Path(item['path']).parts if part in KNOWN_SDKS), None),
            'manifest_sha256': item['sha256'],
            'tracking': item['tracking'],
            'tracking_domain_count': len(item['tracking_domains']),
            'collected_data': [dict(type=d['type'], linked=d['linked'], tracking=d['tracking'],
                                    purposes=[p for p in d['purposes'] if p in SAFE_PURPOSES])
                               for d in data if d['type'] in SAFE_TYPES],
            'unknown_type_count': sum(d['type'] not in SAFE_TYPES for d in data),
            'unknown_purpose_count': sum(p not in SAFE_PURPOSES for d in data for p in d['purposes']),
            'unknown_top_level_key_count': len(item['other_keys']),
            'accessed_api_entry_count': len(item['accessed_apis']),
        })
    return {'manifests': manifests, 'skipped_symlinks': raw['skipped_symlinks']}


def inspect_export(env):
    root = owned_root(env)
    source = env.get('GITHUB_SHA', '')
    number = env.get('GITHUB_RUN_NUMBER', '')
    if not re.fullmatch(r'[0-9a-f]{40}', source) or not re.fullmatch(r'[1-9]\d{0,3}', number):
        raise ValueError('Invalid build provenance')
    payload = real_directory(real_directory(root / 'ipa-check') / 'Payload')
    app = one_real_child(payload, '.app', directory=True)
    ipa = one_real_child(real_directory(root / 'export'), '.ipa')
    digest = hashlib.sha256()
    with ipa.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return {
        'scope': 'Verified signed IPA export before Apple upload; custom manifest inventory',
        'source_commit': source,
        'build': f"{int(number)}.{int(env['GITHUB_RUN_ATTEMPT'])}.0",
        'ipa_sha256': digest.hexdigest(),
        **sanitized_manifests(app),
        'limitations': 'The caller verifies the IPA signature and identity before inspection. This helper does not verify signatures. Not an Apple Organizer report or proof of runtime collection, sharing or legal compliance. Unknown nested fields and required-reason API details are not assessed. SDK labels identify recognized path components only; skipped symlinks and unknown counts require review.',
    }


def run_cli():
    try:
        if len(sys.argv) != 1 or sys.platform != 'darwin':
            raise ValueError('No arguments; macOS signing job only')
        print(json.dumps(inspect_export(os.environ), indent=2, sort_keys=True))
        return 0
    except Exception:
        # Parser failures can contain raw paths or manifest values from signed outputs.
        print('Signed export privacy inventory failed; raw details were not logged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(run_cli())
