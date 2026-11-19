#!/usr/bin/env python3
"""
Сборка EchoAI в установочный пакет .xpi для Betterbird / Thunderbird
с автоматической валидацией manifest.json и проверкой на случайные секреты.
"""

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT_DIR = ROOT / "extension"
DIST_DIR = ROOT / "dist"
DOCS_DOWNLOAD_DIR = ROOT / "docs" / "download"

SECRET_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]


def scan_for_secrets(directory: Path) -> list[str]:
    hits = []
    for path in directory.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".ico", ".woff2", ".xpi"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pat in SECRET_PATTERNS:
            if pat.search(text):
                hits.append(f"{path.relative_to(ROOT)} (matched {pat.pattern})")
    return hits


def main() -> int:
    manifest_path = EXT_DIR / "manifest.json"
    if not manifest_path.exists():
        print("ERROR: extension/manifest.json not found", file=sys.stderr)
        return 1

    with manifest_path.open("r", encoding="utf-8") as f:
        manifest = json.load(f)

    version = manifest.get("version", "0.0.0")
    hits = scan_for_secrets(EXT_DIR)
    if hits:
        print("ERROR: Potential secret detected in extension/:", file=sys.stderr)
        for h in hits:
            print(f"  - {h}", file=sys.stderr)
        return 2

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DIST_DIR / f"echoai-{version}.xpi"

    file_count = 0
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(EXT_DIR.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(EXT_DIR).as_posix()
            zf.write(path, arcname=rel)
            file_count += 1

    DOCS_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    docs_copy = DOCS_DOWNLOAD_DIR / out_path.name
    shutil.copy2(out_path, docs_copy)

    print(f"Packed {file_count} files -> {out_path.relative_to(ROOT)} ({out_path.stat().st_size} bytes)")
    print(f"Synced -> {docs_copy.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
