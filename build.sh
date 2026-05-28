#!/usr/bin/env python3
"""
Assemble src/index.html + src/style.css + src/app.js → index.html
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).parent
SRC  = ROOT / "src"
OUT  = ROOT / "index.html"

html = (SRC / "index.html").read_text(encoding="utf-8")
css  = (SRC / "style.css").read_text(encoding="utf-8")
js   = (SRC / "app.js").read_text(encoding="utf-8")

html = html.replace(
    '  <link rel="stylesheet" href="style.css">',
    f'  <style>\n{css}\n  </style>'
)
html = html.replace(
    '<script src="app.js" defer></script>',
    f'<script>\n{js}\n</script>'
)

OUT.write_text(html, encoding="utf-8")
print(f"✓ {OUT}  ({OUT.stat().st_size // 1024} Ko)")
