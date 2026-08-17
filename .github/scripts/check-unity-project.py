#!/usr/bin/env python3
"""Fail CI when the committed Unity source violates repository invariants."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath


REPOSITORY = Path(__file__).resolve().parents[2]
PROJECT_RELATIVE = PurePosixPath("unity/three-bosses")
PROJECT = REPOSITORY.joinpath(*PROJECT_RELATIVE.parts)
ASSETS = PROJECT / "Assets"

GENERATED_DIRECTORIES = {
    ".gradle",
    ".idea",
    ".vs",
    ".vscode",
    "bin",
    "build",
    "builds",
    "library",
    "logs",
    "memorycaptures",
    "obj",
    "recordings",
    "temp",
    "usersettings",
}
GENERATED_SUFFIXES = {
    ".booproj",
    ".csproj",
    ".mdb",
    ".opendb",
    ".pdb",
    ".pidb",
    ".sln",
    ".slnx",
    ".suo",
    ".svd",
    ".unityproj",
    ".user",
    ".userprefs",
}
SENSITIVE_SUFFIXES = {
    ".aab",
    ".apk",
    ".ipa",
    ".jks",
    ".keystore",
    ".key",
    ".mobileprovision",
    ".p12",
    ".pem",
    ".pfx",
}
SECRET_PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "AWS access key": re.compile(rb"(?:AKIA|ASIA)[0-9A-Z]{16}"),
    "Google API key": re.compile(rb"AIza[0-9A-Za-z_-]{35}"),
    "GitHub token": re.compile(rb"gh[pousr]_[A-Za-z0-9_]{30,}"),
    "OpenAI token": re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    "Slack token": re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}"),
}


def tracked_files() -> list[PurePosixPath]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z", "--", PROJECT_RELATIVE.as_posix()],
        cwd=REPOSITORY,
    )
    return [PurePosixPath(item) for item in output.decode().split("\0") if item]


def check_meta_files(errors: list[str]) -> tuple[int, int]:
    entries = [path for path in ASSETS.rglob("*") if not path.name.endswith(".meta")]
    metas = list(ASSETS.rglob("*.meta"))

    for entry in entries:
        if entry.is_symlink():
            errors.append(f"Unity asset path is a symbolic link: {entry.relative_to(REPOSITORY)}")
        if not Path(f"{entry}.meta").is_file():
            errors.append(f"Missing meta file: {entry.relative_to(REPOSITORY)}.meta")

    guid_owners: dict[str, Path] = {}
    for meta in metas:
        asset = Path(str(meta)[:-5])
        if not asset.exists():
            errors.append(f"Orphan meta file: {meta.relative_to(REPOSITORY)}")

        match = re.search(r"^guid:\s*([0-9a-f]{32})\s*$", meta.read_text(encoding="utf-8"), re.MULTILINE)
        if not match:
            errors.append(f"Missing or malformed GUID: {meta.relative_to(REPOSITORY)}")
            continue

        guid = match.group(1)
        previous = guid_owners.get(guid)
        if previous is not None:
            errors.append(
                "Duplicate Unity GUID "
                f"{guid}: {previous.relative_to(REPOSITORY)} and {meta.relative_to(REPOSITORY)}"
            )
        else:
            guid_owners[guid] = meta

    return len(entries), len(metas)


def check_packages(errors: list[str]) -> int:
    manifest_path = PROJECT / "Packages/manifest.json"
    lock_path = PROJECT / "Packages/packages-lock.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lock = json.loads(lock_path.read_text(encoding="utf-8"))

    direct = manifest.get("dependencies", {})
    locked = lock.get("dependencies", {})
    depth_zero = {
        name: package.get("version")
        for name, package in locked.items()
        if package.get("depth") == 0
    }
    if direct != depth_zero:
        errors.append("Packages/manifest.json does not match depth-zero packages-lock.json entries")

    for name, package in locked.items():
        source = package.get("source")
        if source not in {"builtin", "registry"}:
            errors.append(f"Package {name} uses unexpected source {source!r}")
        if source == "registry" and package.get("url") != "https://packages.unity.com":
            errors.append(f"Package {name} uses a non-Unity registry: {package.get('url')!r}")

    return len(locked)


def check_tracked_content(files: list[PurePosixPath], errors: list[str]) -> None:
    for relative in files:
        project_parts = relative.parts[len(PROJECT_RELATIVE.parts) :]
        lowered_parts = tuple(part.lower() for part in project_parts)
        if any(part in GENERATED_DIRECTORIES for part in lowered_parts):
            errors.append(f"Generated Unity path is tracked: {relative}")
        if lowered_parts[:2] == ("assets", "_recovery"):
            errors.append(f"Unity recovery data is tracked: {relative}")
        if relative.suffix.lower() in GENERATED_SUFFIXES:
            errors.append(f"Generated IDE file is tracked: {relative}")
        if relative.suffix.lower() in SENSITIVE_SUFFIXES:
            errors.append(f"Build or credential file is tracked: {relative}")

        path = REPOSITORY.joinpath(*relative.parts)
        if path.stat().st_size > 95 * 1024 * 1024:
            errors.append(f"Tracked file exceeds the 95 MiB safety threshold: {relative}")

        data = path.read_bytes()
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(data):
                errors.append(f"Possible {label} in tracked file: {relative}")

        if b"\0" in data[:8192]:
            continue
        text = data.decode("utf-8", errors="replace")
        if re.search(r"^(?:<<<<<<<|=======|>>>>>>>)", text, re.MULTILINE):
            errors.append(f"Merge-conflict marker in tracked file: {relative}")
        if "m_Script: {fileID: 0}" in text:
            errors.append(f"Missing Unity script reference in tracked file: {relative}")


def check_security_settings(errors: list[str]) -> None:
    player = (PROJECT / "ProjectSettings/ProjectSettings.asset").read_text(encoding="utf-8")
    connect = (PROJECT / "ProjectSettings/UnityConnectSettings.asset").read_text(encoding="utf-8")

    required_player_values = (
        "submitAnalytics: 0",
        "allowUnsafeCode: 0",
        "enableCrashReportAPI: 0",
        "cloudEnabled: 0",
        "insecureHttpOption: 0",
    )
    for value in required_player_values:
        if value not in player:
            errors.append(f"Unity security setting is missing: {value}")

    for field in ("ps4Passcode", "metroCertificatePassword", "cloudProjectId", "organizationId"):
        if re.search(rf"^[ \t]*{field}:[ \t]*\S+", player, re.MULTILINE):
            errors.append(f"Unity credential or cloud identifier must stay blank: {field}")

    if re.search(r"^\s*m_Enabled:\s*1\s*$", connect, re.MULTILINE):
        errors.append("A Unity Connect service is enabled")
    for value in ("m_EngineDiagnosticsEnabled: 0", "m_EnableCloudDiagnosticsReporting: 0"):
        if value not in connect:
            errors.append(f"Unity diagnostics setting is missing: {value}")


def main() -> int:
    errors: list[str] = []
    files = tracked_files()
    entry_count, meta_count = check_meta_files(errors)
    package_count = check_packages(errors)
    check_tracked_content(files, errors)
    check_security_settings(errors)

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        "Unity static checks passed: "
        f"{len(files)} tracked files, {entry_count} asset entries, "
        f"{meta_count} meta files, {package_count} locked packages."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
