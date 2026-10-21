"""Regression coverage for Unity metadata checks and hidden-file boundaries."""

import importlib.util
import io
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "check_unity_project", Path(__file__).with_name("check-unity-project.py")
)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class UnityMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.repository = Path(temporary.name)
        self.assets = self.repository / "unity/three-bosses/Assets"
        self.assets.mkdir(parents=True)
        self.enterContext(patch.object(checker, "REPOSITORY", self.repository))
        self.enterContext(patch.object(checker, "ASSETS", self.assets))

    def write(self, relative, content=""):
        path = self.assets / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def metadata_errors(self):
        errors = []
        checker.check_meta_files(errors)
        return errors

    def test_dot_files_and_nested_dot_folders_are_not_imported(self):
        self.write("Figma.meta", "guid: " + "1" * 32)
        self.write("Figma/.figma-manifest.json", "{}")
        self.write(".cache/nested/data.json", "{}")
        self.write(".cache/broken.meta", "not Unity metadata")
        self.assertEqual([], self.metadata_errors())

    def test_visible_files_and_folders_require_metadata(self):
        self.write("UI/timer.json", "{}")
        expected = [
            f"Missing meta file: {Path('unity/three-bosses/Assets') / relative}.meta"
            for relative in ("UI", "UI/timer.json")
        ]
        self.assertCountEqual(expected, self.metadata_errors())

    def test_visible_metadata_still_rejects_duplicate_orphan_and_malformed_guids(self):
        for name in ("first", "second", "malformed"):
            self.write(name)
        for name in ("first", "second", "orphan"):
            self.write(f"{name}.meta", "guid: " + ("2" if name == "orphan" else "1") * 32)
        self.write("malformed.meta", "guid: invalid")
        errors = self.metadata_errors()
        self.assertEqual(3, len(errors))
        for prefix in ("Duplicate Unity GUID", "Orphan meta file", "Missing or malformed GUID"):
            self.assertTrue(any(error.startswith(prefix) for error in errors), errors)

    def test_streaming_assets_dot_files_and_folders_require_metadata(self):
        self.write("StreamingAssets.meta", "guid: " + "1" * 32)
        self.write("StreamingAssets/.data.json", "{}")
        self.write("StreamingAssets/.content/nested.json", "{}")
        expected = [
            f"Missing meta file: {Path('unity/three-bosses/Assets/StreamingAssets') / relative}.meta"
            for relative in (".data.json", ".content", ".content/nested.json")
        ]
        self.assertCountEqual(expected, self.metadata_errors())

    def test_streaming_assets_dot_file_guids_are_validated(self):
        self.write("StreamingAssets.meta", "guid: " + "1" * 32)
        self.write("StreamingAssets/.data.json", "{}")
        self.write("StreamingAssets/.data.json.meta", "guid: invalid")
        errors = self.metadata_errors()
        self.assertEqual(1, len(errors))
        self.assertTrue(errors[0].startswith("Missing or malformed GUID"), errors)

    def test_hidden_tracked_files_still_receive_secret_checks(self):
        self.write(".manifest.json", "-----BEGIN PRIVATE KEY-----")
        errors = []
        checker.check_tracked_content(
            [PurePosixPath("unity/three-bosses/Assets/.manifest.json")], errors
        )
        self.assertEqual(1, len(errors))
        self.assertTrue(errors[0].startswith("Possible private key"), errors)

    def test_security_diagnostics_never_print_credential_values(self):
        project = self.assets.parent
        settings = project / "ProjectSettings"
        settings.mkdir()
        sentinels = ["synthetic-passcode", "synthetic-password", "synthetic-cloud-id", "synthetic-org-id"]
        fields = ["ps4Passcode", "metroCertificatePassword", "cloudProjectId", "organizationId"]
        (settings / "ProjectSettings.asset").write_text(
            "\n".join(f"{field}: {value}" for field, value in zip(fields, sentinels)),
            encoding="utf-8",
        )
        (settings / "UnityConnectSettings.asset").write_text("", encoding="utf-8")
        matched_content = "-----BEGIN PRIVATE KEY-----\nsynthetic-content-must-not-leak"
        self.write(".manifest.json", matched_content)
        output = io.StringIO()
        with patch.object(checker, "PROJECT", project), \
                patch.object(checker, "tracked_files", return_value=[
                    PurePosixPath("unity/three-bosses/Assets/.manifest.json")
                ]), \
                patch.object(checker, "check_packages", return_value=0), \
                patch.object(checker.sys, "stderr", output):
            self.assertEqual(1, checker.main())
        diagnostic = output.getvalue()
        self.assertIn("Unity PS4 passcode must stay blank", diagnostic)
        self.assertIn("metroCertificatePassword", diagnostic)
        self.assertIn("Possible private key", diagnostic)
        for value in [*sentinels, *matched_content.splitlines()]:
            self.assertNotIn(value, diagnostic)


if __name__ == "__main__":
    unittest.main()
