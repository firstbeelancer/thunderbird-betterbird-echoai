#!/usr/bin/env python3
"""
Сборка EchoAI в установочный пакет .xpi для Betterbird / Thunderbird
с автоматической валидацией manifest.json и проверкой на случайные секреты.
"""

import hashlib
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
UPDATES_JSON = ROOT / "docs" / "updates.json"
PAGES_BASE_URL = "https://firstbeelancer.github.io/thunderbird-betterbird-echoai"

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

    # updates.json для кнопки «Проверить обновления» (формат Mozilla update manifest).
    # Намеренно НЕ подключён через update_url в manifest.json — проверка только по клику.
    digest = hashlib.sha256(docs_copy.read_bytes()).hexdigest()
    addon_id = manifest["browser_specific_settings"]["gecko"]["id"]
    min_version = manifest["browser_specific_settings"]["gecko"].get("strict_min_version", "128.0")
    updates = {
        "addons": {
            addon_id: {
                "updates": [
                    {
                        "version": version,
                        "update_link": f"{PAGES_BASE_URL}/download/{out_path.name}",
                        "update_hash": f"sha256:{digest}",
                        "applications": {"gecko": {"strict_min_version": min_version}},
                    }
                ]
            }
        }
    }
    UPDATES_JSON.write_text(json.dumps(updates, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Packed {file_count} files -> {out_path.relative_to(ROOT)} ({out_path.stat().st_size} bytes)")
    print(f"Synced -> {docs_copy.relative_to(ROOT)}")
    print(f"Updates manifest -> {UPDATES_JSON.relative_to(ROOT)} (sha256:{digest[:12]}...)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
