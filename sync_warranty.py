#!/usr/bin/env python3
"""Pull the latest Warranty app from the external warranty-app repo and
re-embed it directly into index.html's src-warranty block.

Usage: python3 sync_warranty.py /path/to/cloned/warranty-app

The warranty-app repo (https://github.com/sitthikraiwong123-lab/warranty-app.git)
is the sole source of truth for the Warranty app; no copy is kept under
apps/ in this repo (see CLAUDE.md). This script reads "Warranty App.html"
from the given clone, escapes it, and replaces the src-warranty block in
index.html in place. It does not touch apps/gasoline.html,
apps/claim_manager.html, or run build.py — those stay independent.
"""
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent
INDEX_PATH = ROOT / "index.html"
SRC_ID = "warranty"
SOURCE_FILENAME = "Warranty App.html"


def esc(content: str) -> str:
    if not content.endswith("\n"):
        content += "\n"
    return content.replace("</script>", "<\\/script>")


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <path-to-warranty-app-clone>")

    clone_dir = pathlib.Path(sys.argv[1])
    src_file = clone_dir / SOURCE_FILENAME
    content = esc(src_file.read_text(encoding="utf-8"))

    index_text = INDEX_PATH.read_text(encoding="utf-8")
    open_tag = f'<script type="text/plain" id="src-{SRC_ID}">'
    start = index_text.index(open_tag) + len(open_tag)
    end = index_text.index("\n</script>\n", start) + 1
    new_index = index_text[:start] + content + index_text[end:]
    INDEX_PATH.write_text(new_index, encoding="utf-8")
    print(f"index.html src-{SRC_ID} block refreshed from {src_file}")


if __name__ == "__main__":
    main()
