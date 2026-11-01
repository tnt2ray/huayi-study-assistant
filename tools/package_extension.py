#!/usr/bin/env python3
"""Build a ZIP with installation and usage instructions and verify its contents."""

import hashlib
import json
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parent.parent


def main():
    source_files = (
        "manifest.json", "content-main.js", "session-observer.js", "connection-bridge.js",
        "background.js", "magpie-config.js", "magpie-client.js", "exam-background.js",
        "exam-content.js", "study-bridge.js", "popup.html", "popup.js", "popup.css", "安装说明.txt",
        "icons/icon-16.png", "icons/icon-24.png", "icons/icon-32.png", "icons/icon-48.png",
        "icons/icon-128.png",
    )
    sources = {name: (ROOT / name).read_bytes() for name in source_files}
    manifest = json.loads(sources["manifest.json"])
    version = manifest["version"]
    if manifest["manifest_version"] != 3 or not re.fullmatch(r"\d+(?:\.\d+){0,3}", version):
        raise ValueError("Invalid extension manifest or version")

    contents = sources

    output_dir = ROOT / "dist"
    output_dir.mkdir(exist_ok=True)
    zip_path = output_dir / f"华医网课件免打扰学习助手-{version}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in contents.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)

    # Check the actual delivered ZIP: CRC, exact entries, instructions and source bytes.
    with zipfile.ZipFile(zip_path) as archive:
        if (archive.testzip() is not None or len(archive.namelist()) != len(contents)
                or set(archive.namelist()) != set(contents)):
            raise ValueError("ZIP entry validation failed")
        for name, expected in contents.items():
            if archive.read(name) != expected:
                raise ValueError("Packaged file mismatch: " + name)
    for name, expected in sources.items():
        if (ROOT / name).read_bytes() != expected:
            raise RuntimeError("Source changed during packaging: " + name)

    print(json.dumps({
        "version": version,
        "zip": str(zip_path),
        "bytes": zip_path.stat().st_size,
        "sha256": hashlib.sha256(zip_path.read_bytes()).hexdigest(),
        "packaged_files": list(contents),
        "zip_crc_valid": True,
        "source_matches": True,
        "automated_tests_run": False,
        "verified": True,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
