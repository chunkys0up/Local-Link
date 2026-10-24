"""Fingerprint of a data source's structure (not its values).

A saved extractor is only trusted while the layout it was written against is
unchanged: SQLite tables and columns, XML element paths, CSV headers, JSON keys.
"""

import csv
import gzip
import json
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_FILES = 200


def describe(path: Path) -> list[str]:
    """Sorted structure entries for a file, or for every file in a folder."""
    if path.is_dir():
        files = sorted(p for p in path.rglob("*") if p.is_file() and not p.name.startswith("."))
        return sorted(
            f"{f.relative_to(path)}: {entry}" for f in files[:MAX_FILES] for entry in _describe_file(f)
        )
    return sorted(_describe_file(path))


def diff(before: list[str], after: list[str]) -> tuple[list[str], list[str]]:
    """(added, removed) structure entries."""
    old, new = set(before), set(after)
    return sorted(new - old), sorted(old - new)


def _describe_file(path: Path) -> list[str]:
    with path.open("rb") as f:
        head = f.read(16)
    if head.startswith(b"SQLite format 3\x00"):
        return _sqlite(path)
    opener = gzip.open if head[:2] == b"\x1f\x8b" else open
    try:
        with opener(path, "rb") as f:
            start = f.read(512).lstrip()
        if start.startswith(b"<"):
            with opener(path, "rb") as f:
                return _xml(f)
        if start[:1] in (b"{", b"["):
            with opener(path, "rb") as f:
                return _json(json.load(f))
        if path.suffix.lower() in (".csv", ".tsv"):
            with open(path, newline="", encoding="utf-8-sig") as f:
                header = next(csv.reader(f, delimiter="\t" if path.suffix.lower() == ".tsv" else ","), [])
            return [f"csv columns({', '.join(header)})"]
    except (OSError, ET.ParseError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    return [f"unrecognized file {path.suffix or '(no extension)'}"]


def _sqlite(path: Path) -> list[str]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        objects = conn.execute(
            "select type, name from sqlite_master where type in ('table', 'view')"
            " and name not like 'sqlite_%' order by name"
        ).fetchall()
        entries = []
        for kind, name in objects:
            columns = [row[1] for row in conn.execute(f'pragma table_info("{name}")')]
            entries.append(f"{kind} {name}({', '.join(columns)})")
        return entries
    finally:
        conn.close()


def _xml(f) -> list[str]:
    paths: set[str] = set()
    stack: list[str] = []
    for event, element in ET.iterparse(f, events=("start", "end")):
        if event == "start":
            stack.append(element.tag)
            paths.add("xml " + "/".join(stack))
        else:
            stack.pop()
            element.clear()
    return sorted(paths)


def _json(value, prefix: str = "json $") -> list[str]:
    entries = {prefix}
    if isinstance(value, dict):
        for key, child in value.items():
            entries.update(_json(child, f"{prefix}.{key}"))
    elif isinstance(value, list):
        for child in value:
            entries.update(_json(child, f"{prefix}[]"))
    return sorted(entries)
