import os
import plistlib

import discover


def write_plist(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        plistlib.dump(data, f)


def test_document_extensions():
    info = {"CFBundleDocumentTypes": [{"CFBundleTypeExtensions": ["gnucash", ".XAC", "*"]}, {}]}
    assert discover.document_extensions(info) == {"gnucash", "xac"}


def test_candidates_from_prefs_and_support_folders(tmp_path, monkeypatch):
    home = tmp_path / "home"
    app = tmp_path / "GnuCash.app"
    write_plist(app / "Contents" / "Info.plist", {
        "CFBundleName": "GnuCash",
        "CFBundleIdentifier": "org.gnucash.Gnucash",
        "CFBundleDocumentTypes": [{"CFBundleTypeExtensions": ["gnucash"]}],
    })
    book = home / "Documents" / "books.gnucash"
    book.parent.mkdir(parents=True)
    book.write_text("x")
    write_plist(home / "Library" / "Preferences" / "org.gnucash.Gnucash.plist",
                {"history": {"file0": f"file://{book}"}, "missing": "/nope/gone.gnucash"})
    support = home / "Library" / "Application Support" / "GnuCash" / "state.db"
    support.parent.mkdir(parents=True)
    support.write_text("x")
    (support.parent / "notes.txt").write_text("not data")
    os.utime(book, (1, 1))

    spotted = []
    monkeypatch.setattr(discover, "_spotlight_extensions", lambda exts, h: spotted.append(exts) or [book])
    found = discover.candidates(str(app), home=home)

    assert spotted == [{"gnucash"}]
    assert [(c["path"], c["reason"]) for c in found] == [
        (str(support.resolve()), "in Library/Application Support/GnuCash"),
        (str(book.resolve()), "named in the app's preferences"),
    ]
