"""Installed Mac apps: name, bundle ID, version, path, icon, and what each is built with."""

import plistlib
import subprocess
from pathlib import Path

APP_DIRS = (Path("/Applications"), Path.home() / "Applications", Path("/System/Applications"))
SPOTLIGHT_QUERY = "kMDItemContentType == 'com.apple.application-bundle'"
SPOTLIGHT_TIMEOUT_SECONDS = 10


def _bundles_in(folder: Path) -> list[Path]:
    """.app bundles in a folder and one level of subfolders (e.g. Utilities), not inside apps."""
    if not folder.is_dir():
        return []
    return [*folder.glob("*.app"), *(p for p in folder.glob("*/*.app") if p.parent.suffix != ".app")]


def _spotlight() -> list[Path]:
    try:
        proc = subprocess.run(
            ["mdfind", SPOTLIGHT_QUERY], capture_output=True, text=True, timeout=SPOTLIGHT_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    # Skip helpers nested inside other bundles (".../Foo.app/Contents/.../Helper.app").
    return [Path(line) for line in proc.stdout.splitlines() if line.endswith(".app") and ".app/" not in line]


def _names(*folders: Path) -> set[str]:
    return {p.name for f in folders if f.is_dir() for p in f.iterdir()}


def kind(app: Path) -> str:
    """electron | qt | gtk | java | native, from the frameworks and libraries it ships."""
    contents = app / "Contents"
    names = _names(contents / "Frameworks", contents / "Resources" / "lib", contents / "PlugIns")
    if "Electron Framework.framework" in names:
        return "electron"
    if any(n.startswith(("Qt", "libQt")) for n in names):
        return "qt"
    if any(n.startswith(("libgtk-", "libgdk-")) for n in names):
        return "gtk"
    if (contents / "Java").is_dir() or any("jdk" in n.lower() or "jre" in n.lower() for n in names):
        return "java"
    return "native"


def describe(app: Path) -> dict | None:
    """One app's details from Contents/Info.plist, or None if it isn't a readable bundle."""
    try:
        with open(app / "Contents" / "Info.plist", "rb") as f:
            info = plistlib.load(f)
    except (OSError, plistlib.InvalidFileException, ValueError):
        return None
    icon = info.get("CFBundleIconFile")
    if icon and not Path(icon).suffix:
        icon += ".icns"
    return {
        "name": info.get("CFBundleDisplayName") or info.get("CFBundleName") or app.stem,
        "bundle_id": info.get("CFBundleIdentifier", ""),
        "version": info.get("CFBundleShortVersionString") or info.get("CFBundleVersion", ""),
        "path": str(app),
        "icon": str(app / "Contents" / "Resources" / icon) if icon else "",
        "kind": kind(app),
    }


def scan(dirs: tuple[Path, ...] = APP_DIRS, spotlight: bool = True) -> list[dict]:
    """Every installed app, deduplicated by path, sorted by name."""
    paths = [p for d in dirs for p in _bundles_in(d)] + (_spotlight() if spotlight else [])
    seen: set[Path] = set()
    found = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if app := describe(path):
            found.append(app)
    return sorted(found, key=lambda a: (a["name"].casefold(), a["path"]))
