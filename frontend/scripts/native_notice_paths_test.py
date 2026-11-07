import tempfile
import unittest
from pathlib import Path

from native_notice_paths import dependency_directory, dependency_files


class NoticePathTests(unittest.TestCase):
    def test_locked_coordinate_resolves_in_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'com.google' / 'sdk-name' / '1.2.3'
            directory.mkdir(parents=True)
            (directory / 'license.pom').write_text('<project/>')
            self.assertEqual(dependency_files(dependency_directory(temp, 'com.google:sdk-name:1.2.3'), '.pom'),
                             [(directory / 'license.pom').resolve()])

    def test_invalid_and_traversal_coordinates_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            for coordinate in ('../../private:x:1', 'group:/absolute:1', 'group:x:..',
                               'group:x:1/../../private', 'group:x', 'group:x:1:extra'):
                with self.subTest(coordinate=coordinate), self.assertRaises(ValueError):
                    dependency_directory(temp, coordinate)

    def test_cache_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as outside:
            link = Path(temp) / 'group'
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('Creating symlinks requires additional permissions')
            (Path(outside) / 'artifact' / '1').mkdir(parents=True)
            with self.assertRaises(ValueError):
                dependency_directory(temp, 'group:artifact:1')


if __name__ == '__main__':
    unittest.main()
