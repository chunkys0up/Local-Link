"""Candidate data files for an installed app, for the user to confirm before a run.

No agent involved: the runner looks where apps usually keep their data and lists
what it finds. The user picks one, and only that path is given to the agent.
"""

import plistlib
import subprocess
from pathlib import Path

HOME = Path.home()
DATA_SUFFIXES = {".sqlite", ".sqlite3", ".db", ".json", ".xml", ".csv", ".gnucash", ".ledger", ".qif", ".ofx"}
MAX_CANDIDATES = 25
MAX_FILES_PER_FOLDER = 500
SPOTLIGHT_TIMEOUT_SECONDS = 10


def _info(app: Path) -> dict:
    try:
        with open(app / "Contents" / "Info.plist", "rb") as f:
            return plistlib.load(f)
    except Exception:  # unreadable or malformed plist (bad XML raises ExpatError)
        return {}


def document_extensions(info: dict) -> set[str]:
    """File extensions the app says it opens (CFBundleDocumentTypes)."""
    return {
        ext.lower().lstrip(".")
        for doc in info.get("CFBundleDocumentTypes") or ()
        if isinstance(doc, dict)
        for ext in doc.get("CFBundleTypeExtensions") or ()
        if isinstance(ext, str) and ext and ext != "*"
    }


def _paths_in(value: object) -> list[Path]:
    """Existing file paths mentioned anywhere in a preferences value."""
    if isinstance(value, dict):
        return [p for v in value.values() for p in _paths_in(v)]
    if isinstance(value, list):
        return [p for v in value for p in _paths_in(v)]
    if isinstance(value, str):
        text = value.removeprefix("file://")
        if text.startswith(("/", "~/")):
            try:
                path = Path(text).expanduser()
                if path.is_file():
                    return [path]
            except (OSError, RuntimeError, ValueError):
                pass
    return []


def _spotlight_extensions(extensions: set[str], home: Path) -> list[Path]:
    if not extensions:
        return []
    query = " || ".join(f"kMDItemFSName == '*.{ext}'c" for ext in sorted(extensions))
    try:
        proc = subprocess.run(
            ["mdfind", "-onlyin", str(home), query],
            capture_output=True, text=True, timeout=SPOTLIGHT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [Path(line) for line in proc.stdout.splitlines() if line]


def _data_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    found = []
    try:
        for path in folder.rglob("*"):
            if len(found) >= MAX_FILES_PER_FOLDER:
                break
            if path.suffix.lower() in DATA_SUFFIXES and path.is_file():
                found.append(path)
    except OSError:  # e.g. a sandboxed container we aren't allowed to read
        pass
    return found


def candidates(app_path: str, home: Path = HOME, spotlight: bool = True) -> list[dict]:
    """Likely data files for the app, most recently modified first."""
    app = Path(app_path)
    info = _info(app)
    bundle_id = info.get("CFBundleIdentifier")
    bundle_id = bundle_id if isinstance(bundle_id, str) else ""
    name = info.get("CFBundleName")
    name = name if isinstance(name, str) and name.strip() else app.stem
    extensions = document_extensions(info)

    found: list[tuple[Path, str]] = []
    if bundle_id:
        try:
            with open(home / "Library" / "Preferences" / f"{bundle_id}.plist", "rb") as f:
                found += [(p, "named in the app's preferences") for p in _paths_in(plistlib.load(f))]
        except Exception:  # unreadable or malformed plist (bad XML raises ExpatError)
            pass
    if spotlight:
        found += [(p, "file type the app opens") for p in _spotlight_extensions(extensions, home)]
    folders = [home / "Library" / "Application Support" / name]
    if bundle_id:
        folders += [
            home / "Library" / "Application Support" / bundle_id,
            home / "Library" / "Containers" / bundle_id / "Data",
        ]
    for folder in folders:
        found += [(p, f"in {folder.relative_to(home)}") for p in _data_files(folder)]

    results: dict[Path, dict] = {}
    for path, reason in found:
        try:
            resolved = path.resolve()
            if resolved in results or not resolved.is_file():
                continue
            stat = resolved.stat()
        except OSError:
            continue
        results[resolved] = {"path": str(resolved), "reason": reason, "size": stat.st_size, "modified": stat.st_mtime}
    return sorted(results.values(), key=lambda c: c["modified"], reverse=True)[:MAX_CANDIDATES]
