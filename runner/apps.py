"""Installed Mac apps: name, bundle ID, version, path, icon, and what each is built with."""

import plistlib
from pathlib import Path

APPS_DIR = Path("/Applications")


def _bundles_in(folder: Path) -> list[Path]:
    """.app bundles in a folder and one level of subfolders (e.g. Utilities), not inside apps."""
    try:
        return [*folder.glob("*.app"), *(p for p in folder.glob("*/*.app") if p.parent.suffix != ".app")]
    except OSError:
        return []


def _names(*folders: Path) -> set[str]:
    names: set[str] = set()
    for folder in folders:
        try:
            names.update(p.name for p in folder.iterdir())
        except OSError:  # missing, or not readable (common under /System)
            pass
    return names


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
    except Exception:  # unreadable or malformed plist (bad XML raises ExpatError)
        return None
    if not isinstance(info, dict):
        return None

    def text(*keys: str) -> str:
        # Some apps ship odd plists (numbers, empty values), so keep only real strings.
        return next((v for k in keys if isinstance(v := info.get(k), str) and v.strip()), "")

    icon = text("CFBundleIconFile")
    if icon and not Path(icon).suffix:
        icon += ".icns"
    return {
        "name": text("CFBundleDisplayName", "CFBundleName") or app.stem,
        "bundle_id": text("CFBundleIdentifier"),
        "version": text("CFBundleShortVersionString", "CFBundleVersion"),
        "path": str(app),
        "icon": str(app / "Contents" / "Resources" / icon) if icon else "",
        "kind": kind(app),
    }


def scan(folder: Path = APPS_DIR) -> list[dict]:
    """Every app in /Applications (and its subfolders like Utilities), sorted by name."""
    found = []
    for path in _bundles_in(folder):
        try:
            app = describe(path)
        except Exception:  # one broken bundle shouldn't break the whole list
            continue
        if app:
            found.append(app)
    return sorted(found, key=lambda a: (a["name"].casefold(), a["path"]))
