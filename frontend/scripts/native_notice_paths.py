"""Constrain notice generation to dependency files within the Gradle cache."""

import os
import re
from pathlib import Path


COORDINATE_PART = re.compile(r'[A-Za-z0-9_]+(?:[.\-][A-Za-z0-9_]+)*\Z', re.ASCII)


def dependency_directory(cache, coordinate):
    parts = coordinate.split(':')
    if len(parts) != 3 or any(not COORDINATE_PART.fullmatch(part) for part in parts):
        raise ValueError('Invalid locked dependency coordinate')
    root = os.path.realpath(cache)
    candidate = os.path.realpath(os.path.join(root, *parts))
    if not candidate.startswith(root + os.sep) or not os.path.isdir(candidate):
        raise ValueError('Dependency is outside the Gradle cache or is missing')
    return Path(candidate)


def dependency_files(directory, extension):
    if extension not in ('.pom', '.aar'):
        raise ValueError('Unsupported dependency file extension')
    root = os.path.realpath(directory)
    files = []
    for path in Path(root).rglob('*' + extension):
        resolved = os.path.realpath(path)
        if not resolved.startswith(root + os.sep) or not os.path.isfile(resolved):
            raise ValueError('Dependency file is outside its cache directory')
        files.append(Path(resolved))
    return files
