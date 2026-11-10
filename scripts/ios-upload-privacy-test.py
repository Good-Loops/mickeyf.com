import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('ios-upload-privacy.py'))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def fixture(temp):
    runner = Path(temp).resolve()
    root = runner / 'ludolume-testflight-123-1'
    app = root / 'ipa-check/Payload/App.app'
    app.mkdir(parents=True)
    (app / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({'NSPrivacyTracking': False}))
    (root / 'export').mkdir()
    (root / 'export/App.ipa').write_bytes(b'synthetic IPA bytes, not a signed app')
    (root / 'owner.json').write_text(json.dumps({'runId': '123', 'attempt': '1', 'root': str(root)}))
    env = dict(GITHUB_ACTIONS='true', GITHUB_EVENT_NAME='workflow_dispatch',
               GITHUB_REF='refs/heads/feature/auth-family-leaderboards', GITHUB_RUN_ID='123',
               GITHUB_RUN_ATTEMPT='1', GITHUB_SHA='a' * 40, GITHUB_RUN_NUMBER='61', RUNNER_TEMP=str(runner))
    return root, app, env


class UploadPrivacyTest(unittest.TestCase):
    def test_inventory_accepts_only_the_reviewed_signing_branches(self):
        with tempfile.TemporaryDirectory() as temp:
            _, _, env = fixture(temp)
            for ref in ('refs/heads/main', 'refs/heads/feature/auth-family-leaderboards',
                        'refs/heads/feat/device-privacy-qualification'):
                with self.subTest(ref=ref):
                    self.assertEqual(inventory.inspect_export({**env, 'GITHUB_REF': ref})['build'], '61.1.0')
            for ref in ('refs/heads/feat/privacy-data-review', 'refs/heads/feat/child-registration-production',
                        'refs/heads/feat/device-privacy-qualification-extra'):
                with self.assertRaisesRegex(ValueError, 'Protected manual signing job'):
                    inventory.inspect_export({**env, 'GITHUB_REF': ref})

    def test_inventory_accepts_every_branch_the_signing_helper_accepts(self):
        source = Path(__file__).with_name('ios-testflight.mjs').read_text(encoding='utf-8')
        declaration = re.search(r'const SIGNING_BRANCHES = new Set\(\[(.*?)\]\)', source)
        self.assertIsNotNone(declaration)
        branches = re.findall(r"'(refs/heads/[^']+)'", declaration.group(1))
        self.assertGreater(len(branches), 0)
        with tempfile.TemporaryDirectory() as temp:
            _, _, env = fixture(temp)
            for ref in branches:
                with self.subTest(ref=ref):
                    self.assertEqual(inventory.inspect_export({**env, 'GITHUB_REF': ref})['build'], '61.1.0')

    def test_receipt_identifies_the_actual_export_and_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root, app, env = fixture(temp)
            result = inventory.inspect_export(env)
            self.assertEqual(result['build'], '61.1.0')
            self.assertEqual(result['source_commit'], 'a' * 40)
            self.assertEqual(result['ipa_sha256'], hashlib.sha256((root / 'export/App.ipa').read_bytes()).hexdigest())
            self.assertEqual(result['manifests'][0]['manifest_sha256'],
                             hashlib.sha256((app / 'PrivacyInfo.xcprivacy').read_bytes()).hexdigest())
            self.assertIn('does not verify signatures', result['limitations'])

    def test_only_allowlisted_vocabulary_and_opaque_identifiers_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            _, app, env = fixture(temp)
            path = app / 'Frameworks/GoogleSignIn.framework/private-marker.bundle/PrivacyInfo.xcprivacy'
            path.parent.mkdir(parents=True)
            path.write_bytes(plistlib.dumps({
                'NSPrivacyTrackingDomains': ['private-domain.example'],
                'NSPrivacyCollectedDataTypes': [
                    dict(NSPrivacyCollectedDataType='NSPrivacyCollectedDataTypeEmailAddress',
                         NSPrivacyCollectedDataTypeLinked=True, NSPrivacyCollectedDataTypeTracking=False,
                         NSPrivacyCollectedDataTypePurposes=['NSPrivacyCollectedDataTypePurposeAppFunctionality', 'private-purpose']),
                    dict(NSPrivacyCollectedDataType='private-type', NSPrivacyCollectedDataTypeLinked=False,
                         NSPrivacyCollectedDataTypeTracking=False, NSPrivacyCollectedDataTypePurposes=[]),
                ],
                'private-key': 'private-value',
            }, fmt=plistlib.FMT_BINARY))
            result = inventory.inspect_export(env)
            sdk = next(m for m in result['manifests'] if m['recognized_sdk_path_component'])
            self.assertEqual(sdk['recognized_sdk_path_component'], 'GoogleSignIn.framework')
            self.assertEqual(sdk['collected_data'][0]['type'], 'NSPrivacyCollectedDataTypeEmailAddress')
            self.assertEqual(sdk['tracking_domain_count'], 1)
            self.assertEqual((sdk['unknown_type_count'], sdk['unknown_purpose_count'], sdk['unknown_top_level_key_count']), (1, 1, 1))
            serialized = json.dumps(result)
            for private in ('private-marker', 'private-domain', 'private-purpose', 'private-type', 'private-key', 'private-value', str(app)):
                self.assertNotIn(private, serialized)

    def test_rejects_unowned_or_unapproved_runs_and_invalid_provenance(self):
        with tempfile.TemporaryDirectory() as temp:
            root, _, env = fixture(temp)
            for field, value in (('GITHUB_ACTIONS', 'false'), ('GITHUB_EVENT_NAME', 'pull_request'),
                                 ('GITHUB_REF', 'refs/heads/unreviewed'), ('GITHUB_RUN_ATTEMPT', '../1'),
                                 ('GITHUB_RUN_NUMBER', '0'), ('GITHUB_SHA', 'raw-secret'), ('RUNNER_TEMP', 'relative')):
                with self.subTest(field=field), self.assertRaises(ValueError):
                    inventory.inspect_export({**env, field: value})
            (root / 'owner.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'marker mismatch'):
                inventory.inspect_export(env)

    def test_missing_ambiguous_and_invalid_exports_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root, app, env = fixture(temp)
            (root / 'export/Other.ipa').write_bytes(b'not this upload')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                inventory.inspect_export(env)
            (root / 'export/Other.ipa').unlink()
            manifest = app / 'PrivacyInfo.xcprivacy'
            manifest.unlink()
            with self.assertRaisesRegex(ValueError, 'No bundled'):
                inventory.inspect_export(env)
            manifest.write_bytes(b'not a plist')
            with self.assertRaises(plistlib.InvalidFileException):
                inventory.inspect_export(env)

    def test_resolved_path_escape_is_rejected_even_without_symlink_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            root, _, _ = fixture(temp)
            with mock.patch.object(Path, 'resolve', return_value=root.parent):
                with self.assertRaisesRegex(ValueError, 'owned real directory'):
                    inventory.real_directory(root)

    def test_symlinked_export_is_rejected_and_nested_links_are_reported_without_following(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            root, app, env = fixture(temp)
            try:
                (app / 'External.bundle').symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('Symlink creation unavailable on this system')
            (Path(outside) / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({'NSPrivacyTracking': True}))
            result = inventory.inspect_export(env)
            self.assertEqual(result['skipped_symlinks'], 1)
            self.assertEqual(len(result['manifests']), 1)
            (root / 'export/App.ipa').unlink()
            (root / 'export/App.ipa').symlink_to(Path(outside) / 'PrivacyInfo.xcprivacy')
            with self.assertRaisesRegex(ValueError, 'redirected'):
                inventory.inspect_export(env)

    def test_cli_rejects_paths_and_redacts_failures(self):
        with mock.patch.object(sys, 'platform', 'darwin'), mock.patch.object(sys, 'argv', ['inventory', '/private/path']):
            with contextlib.redirect_stderr(io.StringIO()) as error:
                self.assertEqual(inventory.run_cli(), 1)
            self.assertNotIn('/private/path', error.getvalue())
        with mock.patch.object(sys, 'platform', 'darwin'), mock.patch.object(sys, 'argv', ['inventory']):
            with mock.patch.object(inventory, 'inspect_export', side_effect=ValueError('private-value')):
                with contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as error:
                    self.assertEqual(inventory.run_cli(), 1)
                self.assertEqual(output.getvalue(), '')
                self.assertNotIn('private-value', error.getvalue())

    def test_upload_requires_inspection_after_signature_verification_and_before_submission(self):
        root = Path(__file__).parents[1]
        source = (root / 'scripts/ios-testflight.mjs').read_text()
        upload = source[source.index('async function upload()'):]
        self.assertLess(upload.index('const info = verifyIpa('), upload.index('Inspect signed export privacy manifests'))
        self.assertLess(upload.index('Inspect signed export privacy manifests'), upload.index("run('Apple build upload'"))
        self.assertIn('} finally { cleanup(config); }', upload)
        workflow = (root / '.github/workflows/ios-build.yml').read_text()
        protected = workflow[workflow.index('  testflight:'):workflow.index('  android:')]
        self.assertIn('python3 ../scripts/ios-upload-privacy-test.py', protected)
        self.assertNotIn('upload-artifact@', protected)


if __name__ == '__main__':
    unittest.main()
