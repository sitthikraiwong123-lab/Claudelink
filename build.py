#!/usr/bin/env python3
"""Assemble index.html from index.template.html + apps/*.html.

Usage: python3 build.py

For each app, if apps/<name>.html exists it is used as the fresh source
(escaped and substituted into the matching {{PLACEHOLDER}}). If the file is
missing — currently true for warranty, whose source of truth is the
separate warranty-app repo and is not mirrored here, see CLAUDE.md and
sync_warranty.py — the block already embedded in the existing index.html
is carried over unchanged instead of being wiped out.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
TEMPLATE_PATH = ROOT / "index.template.html"
INDEX_PATH = ROOT / "index.html"

APPS = [
    ("{{GASOLINE}}", "gasoline", ROOT / "apps" / "gasoline.html"),
    ("{{CLAIM}}", "claim", ROOT / "apps" / "claim_manager.html"),
    ("{{WARRANTY}}", "warranty", ROOT / "apps" / "warranty.html"),
]


def esc(content: str) -> str:
    if not content.endswith("\n"):
        content += "\n"
    return content.replace("</script>", "<\\/script>")


def existing_block(src_id: str, index_text: str) -> str:
    open_tag = f'<script type="text/plain" id="src-{src_id}">'
    start = index_text.index(open_tag) + len(open_tag)
    end = index_text.index("\n</script>\n", start) + 1
    return index_text[start:end]


def main():
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    index_text = INDEX_PATH.read_text(encoding="utf-8") if INDEX_PATH.exists() else None

    for placeholder, src_id, path in APPS:
        if path.exists():
            content = esc(path.read_text(encoding="utf-8"))
        elif index_text is not None:
            content = existing_block(src_id, index_text)
            print(f"{path} not found — carrying over existing embedded {src_id} block")
        else:
            raise SystemExit(f"{path} is missing and there is no existing index.html to fall back on")
        template = template.replace(placeholder, content)

    INDEX_PATH.write_text(template, encoding="utf-8")
    print("index.html written from index.template.html + apps/*.html")


if __name__ == "__main__":
    main()
