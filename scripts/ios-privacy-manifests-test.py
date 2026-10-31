import importlib.util
import plistlib
from pathlib import Path
import tempfile
import unittest
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('privacy', Path(__file__).with_name('ios-privacy-manifests.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PrivacyManifestsTest(unittest.TestCase):
    def test_discovers_xml_and_binary_manifests_and_summarizes_known_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / 'App.app'
            first = app / 'PrivacyInfo.xcprivacy'
            second = app / 'Frameworks' / 'Provider.bundle' / 'PrivacyInfo.xcprivacy'
            second.parent.mkdir(parents=True)
            first.write_bytes(plistlib.dumps({'NSPrivacyTracking': False}))
            second.write_bytes(plistlib.dumps({
                'NSPrivacyTracking': False,
                'NSPrivacyCollectedDataTypes': [{
                    'NSPrivacyCollectedDataType': 'NSPrivacyCollectedDataTypeEmailAddress',
                    'NSPrivacyCollectedDataTypeLinked': True,
                    'NSPrivacyCollectedDataTypeTracking': False,
                    'NSPrivacyCollectedDataTypePurposes': ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
                }],
                'NSPrivacyAccessedAPITypes': [{
                    'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPICategoryUserDefaults',
                    'NSPrivacyAccessedAPITypeReasons': ['CA92.1'],
                }],
                'unrelated': 'must not be included',
            }, fmt=plistlib.FMT_BINARY))
            result = privacy.report(app)
            self.assertEqual(len(result['manifests']), 2)
            provider = next(item for item in result['manifests'] if 'Provider.bundle' in item['path'])
            self.assertEqual(provider['collected_data'][0]['type'], 'NSPrivacyCollectedDataTypeEmailAddress')
            self.assertTrue(provider['collected_data'][0]['linked'])
            self.assertEqual(provider['accessed_apis'][0]['reasons'], ['CA92.1'])
            self.assertEqual(provider['other_keys'], ['unrelated'])
            self.assertNotIn('must not be included', str(result))

    def test_missing_and_malformed_manifests_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / 'App.app'
            app.mkdir()
            with self.assertRaisesRegex(ValueError, 'No bundled'):
                privacy.report(app)
            (app / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({
                'NSPrivacyCollectedDataTypes': [{'NSPrivacyCollectedDataType': 'Email'}],
            }))
            with self.assertRaisesRegex(ValueError, 'boolean'):
                privacy.report(app)

    def test_non_manifest_paths_and_non_app_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'simulator .app'):
                privacy.report(temp)
        with self.assertRaisesRegex(ValueError, 'token'):
            privacy.summarize_manifest({'NSPrivacyTrackingDomains': ['bad.example/secret']})

    def test_workflow_keeps_inspection_separate_from_signing_and_artifacts(self):
        workflow = (Path(__file__).parents[1] / '.github' / 'workflows' / 'ios-build.yml').read_text()
        self.assertIn('inputs.audit_privacy_manifests && (!inputs.compile_only || inputs.upload_testflight', workflow)
        self.assertIn('inputs.upload_testflight && !inputs.audit_privacy_manifests', workflow)
        self.assertIn('inputs.compile_only && !inputs.upload_testflight && !inputs.audit_privacy_manifests', workflow)
        self.assertIn('if: ${{ !inputs.compile_only && !inputs.capture_store_screenshots }}', workflow)

    def test_symlinks_are_counted_but_never_followed(self):
        with tempfile.TemporaryDirectory() as temp:
            app = Path(temp) / 'App.app'
            app.mkdir()
            (app / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({}))
            outside = Path(temp) / 'outside'
            outside.mkdir()
            (outside / 'PrivacyInfo.xcprivacy').write_bytes(plistlib.dumps({'NSPrivacyTracking': True}))
            try:
                (app / 'External.bundle').symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('Symlink creation unavailable on this system')
            result = privacy.report(app)
            self.assertEqual(result['skipped_symlinks'], 1)
            self.assertEqual(len(result['manifests']), 1)


if __name__ == '__main__':
    unittest.main()
