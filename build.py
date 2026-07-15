#!/usr/bin/env python3
"""Assemble index.html from index.template.html + apps/*.html.

Usage: python3 build.py

Reads apps/gasoline.html, apps/claim_manager.html, apps/warranty.html,
escapes '</script>' as '<\\/script>' (matching the unesc() helper in the
template's launcher script), and substitutes them into the {{PLACEHOLDER}}
markers in index.template.html to produce index.html.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
APPS = {
    "{{GASOLINE}}": ROOT / "apps" / "gasoline.html",
    "{{CLAIM}}": ROOT / "apps" / "claim_manager.html",
    "{{WARRANTY}}": ROOT / "apps" / "warranty.html",
}


def esc(path: pathlib.Path) -> str:
    content = path.read_text(encoding="utf-8")
    if not content.endswith("\n"):
        content += "\n"
    return content.replace("</script>", "<\\/script>")


def main():
    template = (ROOT / "index.template.html").read_text(encoding="utf-8")
    for placeholder, path in APPS.items():
        template = template.replace(placeholder, esc(path))
    (ROOT / "index.html").write_text(template, encoding="utf-8")
    print("index.html written from index.template.html + apps/*.html")


if __name__ == "__main__":
    main()
