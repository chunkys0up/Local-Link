import plistlib

import apps


def make_app(root, name, info=None, files=()):
    app = root / f"{name}.app"
    (app / "Contents").mkdir(parents=True)
    with open(app / "Contents" / "Info.plist", "wb") as f:
        plistlib.dump(info if info is not None else {"CFBundleName": name}, f)
    for rel in files:
        (app / "Contents" / rel).mkdir(parents=True)
    return app


def test_kind_from_frameworks(tmp_path):
    assert apps.kind(make_app(tmp_path, "Obsidian", files=["Frameworks/Electron Framework.framework"])) == "electron"
    assert apps.kind(make_app(tmp_path, "Calibre", files=["Frameworks/QtCore.framework"])) == "qt"
    assert apps.kind(make_app(tmp_path, "GnuCash", files=["Resources/lib/libgtk-3.0.dylib"])) == "gtk"
    assert apps.kind(make_app(tmp_path, "Moneydance", files=["PlugIns/jdk-21.jdk"])) == "java"
    assert apps.kind(make_app(tmp_path, "Notes")) == "native"


def test_describe_reads_info_plist(tmp_path):
    app = make_app(tmp_path, "GnuCash", {
        "CFBundleName": "Gnucash",
        "CFBundleDisplayName": "GnuCash",
        "CFBundleIdentifier": "org.gnucash.Gnucash",
        "CFBundleShortVersionString": "5.17",
        "CFBundleIconFile": "gnucash",
    })
    assert apps.describe(app) == {
        "name": "GnuCash",
        "bundle_id": "org.gnucash.Gnucash",
        "version": "5.17",
        "path": str(app),
        "icon": str(app / "Contents" / "Resources" / "gnucash.icns"),
        "kind": "native",
    }


def test_scan_finds_nested_dedupes_and_skips_broken(tmp_path, monkeypatch):
    make_app(tmp_path, "Zed")
    make_app(tmp_path / "Utilities", "Activity Monitor")
    make_app(tmp_path / "Zed.app" / "Contents" / "Frameworks", "Zed Helper")  # inside a bundle
    (tmp_path / "Broken.app").mkdir()
    monkeypatch.setattr(apps, "_spotlight", lambda: [tmp_path / "Zed.app"])
    assert [a["name"] for a in apps.scan((tmp_path,))] == ["Activity Monitor", "Zed"]
