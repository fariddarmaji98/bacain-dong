#!/usr/bin/env python3
"""Build store-ready zip. Usage: python build.py [version]"""
import json, sys, zipfile, pathlib

ROOT = pathlib.Path(__file__).parent
FILES = ["manifest.json", "background.js", "db.js", "offscreen.html", "offscreen.js",
         "text.js", "content.js", "popup.html", "popup.js",
         "icon16.png", "icon48.png", "icon128.png"]

mf = json.loads((ROOT / "manifest.json").read_text())
if len(sys.argv) > 1:
    mf["version"] = sys.argv[1]
    (ROOT / "manifest.json").write_text(json.dumps(mf, indent=2) + "\n")

missing = [f for f in FILES if not (ROOT / f).exists()]
if missing:
    sys.exit(f"missing files: {missing}")

out = ROOT / "build" / f"bacain-dong-v{mf['version']}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(ROOT / f, f)
print(f"{out.name}  ({out.stat().st_size} bytes, {len(FILES)} files)  v{mf['version']}")
