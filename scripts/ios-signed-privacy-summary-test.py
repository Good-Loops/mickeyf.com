import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest
from unittest import mock
from xml.parsers.expat import ExpatError

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('summary', Path(__file__).with_name('ios-signed-privacy-summary.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class SignedPrivacySummaryTest(unittest.TestCase):
    def make_fixture(self, directory):
        root = Path(directory) / 'ludolume-testflight-41-1'
        root.mkdir()
        (root / 'owner.json').write_text(json.dumps({'runId': '41', 'attempt': '1', 'root': str(root)}))
        for relative in (('Ludolume.xcarchive', 'Products', 'Applications'), ('ipa-check', 'Payload')):
            app = root.joinpath(*relative, 'App.app')
            framework = app / 'Frameworks' / 'GoogleSignIn.framework' / 'Resources'
            framework.mkdir(parents=True)
            (framework / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({
                'NSPrivacyTracking': False,
                'NSPrivacyTrackingDomains': ['private-source-name.example'],
                'NSPrivacyCollectedDataTypes': [{
                    'NSPrivacyCollectedDataType': 'NSPrivacyCollectedDataTypeEmailAddress',
                    'NSPrivacyCollectedDataTypeLinked': True,
                    'NSPrivacyCollectedDataTypeTracking': False,
                    'NSPrivacyCollectedDataTypePurposes': ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
                }],
            }))
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'LUDOLUME_SIGNED_PRIVACY_INSPECTION': '1', 'GITHUB_RUN_ID': '41',
               'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_TEMP': directory,
               'GITHUB_REF': 'refs/heads/feature/auth-family-leaderboards'}
        return root, env

    def test_summary_produces_only_bounded_fields_and_does_not_claim_signature(self):
        with tempfile.TemporaryDirectory() as temp:
            root, env = self.make_fixture(temp)
            result = summary.inspect_owned(env)
            self.assertTrue(result['manifest_path_hash_and_content_sets_match'])
            self.assertTrue(result['known_collection_vocabulary_complete_in_both'])
            self.assertIn('not performed', result['signature_verification'])
            text = json.dumps(result)
            self.assertNotIn('private-source-name.example', text)
            self.assertNotIn(str(root), text)
            self.assertIn('NSPrivacyCollectedDataTypeEmailAddress', text)
            self.assertIn('GoogleSignIn.framework', text)

    def test_unexpected_manifest_fields_are_counted_without_raw_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root, env = self.make_fixture(temp)
            manifest = next((root / 'ipa-check').rglob('PrivacyInfo.xcprivacy'))
            manifest.write_bytes(plistlib.dumps({
                'SecretCustomKey': 'SensitivePayloadValue',
                'NSPrivacyCollectedDataTypes': [{
                    'NSPrivacyCollectedDataType': 'SensitiveCustomDataType',
                    'NSPrivacyCollectedDataTypeLinked': True,
                    'NSPrivacyCollectedDataTypeTracking': False,
                    'NSPrivacyCollectedDataTypePurposes': ['SensitiveCustomPurpose'],
                }],
            }))
            result = summary.inspect_owned(env)
            encoded = json.dumps(result)
            for value in ('SensitivePayloadValue', 'SecretCustomKey', 'SensitiveCustomDataType', 'SensitiveCustomPurpose'):
                self.assertNotIn(value, encoded)
            self.assertFalse(result['known_collection_vocabulary_complete_in_both'])
            self.assertFalse(result['manifest_path_hash_and_content_sets_match'])
            item = result['exported_application']['manifests'][0]
            self.assertEqual(item['unknown_collected_type_count'], 1)
            self.assertEqual(item['unknown_key_count'], 1)

    def test_refuses_unowned_or_non_opted_in_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root, env = self.make_fixture(temp)
            for key, value in [('GITHUB_ACTIONS', 'false'), ('GITHUB_EVENT_NAME', 'push'),
                               ('LUDOLUME_SIGNED_PRIVACY_INSPECTION', '0'), ('GITHUB_RUN_ID', '../bad'),
                               ('GITHUB_REF', 'refs/pull/1/merge'), ('RUNNER_TEMP', '.')]:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    summary.inspect_owned({**env, key: value})
            (root / 'owner.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'marker mismatch'):
                summary.inspect_owned(env)

    def test_refuses_extra_apps_and_unscoped_symlink_bundles(self):
        with tempfile.TemporaryDirectory() as temp:
            root, env = self.make_fixture(temp)
            (root / 'ipa-check' / 'Payload' / 'Other.app').mkdir()
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                summary.inspect_owned(env)
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            root, env = self.make_fixture(temp)
            target = root / 'ipa-check' / 'Payload' / 'Outside.app'
            try:
                target.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('Symlink creation unavailable on this system')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                summary.inspect_owned(env)

    def test_skipped_symlinks_are_reported_as_incomplete(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            root, env = self.make_fixture(temp)
            link = root / 'ipa-check' / 'Payload' / 'App.app' / 'Outside.bundle'
            try:
                link.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('Symlink creation unavailable on this system')
            result = summary.inspect_owned(env)
            self.assertEqual(result['exported_application']['skipped_symlinks'], 1)
            self.assertFalse(result['known_collection_vocabulary_complete_in_both'])

    def test_real_directory_rejects_a_resolved_path_escape_without_symlink_privilege(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            original = Path.resolve
            def redirected(path, *args, **kwargs):
                return Path(outside) if path == Path(temp) else original(path, *args, **kwargs)
            with mock.patch.object(Path, 'resolve', redirected):
                with self.assertRaisesRegex(ValueError, 'real directory'):
                    summary._real_directory(temp)

    def test_command_line_requires_macos_and_accepts_no_arbitrary_path(self):
        with mock.patch.object(summary.sys, 'platform', 'win32'), mock.patch.object(summary.sys, 'argv', ['summary']):
            with self.assertRaisesRegex(ValueError, 'requires macOS'):
                summary.main()
        with mock.patch.object(summary.sys, 'platform', 'darwin'), mock.patch.object(summary.sys, 'argv', ['summary', 'other.app']):
            with self.assertRaisesRegex(ValueError, 'no arguments'):
                summary.main()

    def test_cli_redacts_unexpected_parser_errors_and_paths(self):
        with mock.patch.object(summary, 'main', side_effect=ExpatError('secret path or raw data')):
            with contextlib.redirect_stderr(io.StringIO()) as error:
                self.assertEqual(summary.run_cli(), 1)
            self.assertIn('no raw inspection details', error.getvalue())
            self.assertNotIn('secret path or raw data', error.getvalue())


if __name__ == '__main__':
    unittest.main()
