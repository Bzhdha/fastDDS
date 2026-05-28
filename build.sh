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

# Replace the strict src/ CSP with a monolithic-compatible one (unsafe-inline needed for inlined scripts/styles)
import re
csp_built = (
    "default-src 'none'; "
    "script-src 'self' 'unsafe-inline' https://unpkg.com; "
    "style-src 'self' 'unsafe-inline' https://unpkg.com; "
    "img-src 'self' https://*.tile.openstreetmap.org data:; "
    "connect-src https://oudonner.api.efs.sante.fr https://api-adresse.data.gouv.fr; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'none';"
)
html = re.sub(
    r'<meta http-equiv="Content-Security-Policy"[^>]*>',
    f'<meta http-equiv="Content-Security-Policy" content="{csp_built}">',
    html,
)

OUT.write_text(html, encoding="utf-8")
print(f"✓ {OUT}  ({OUT.stat().st_size // 1024} Ko)")
