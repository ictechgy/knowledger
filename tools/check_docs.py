#!/usr/bin/env python3
"""Check local design references, code fences, and Python syntax without network access.

This does not render Mermaid or validate its complete grammar.
"""
from pathlib import Path
from urllib.parse import unquote
import ast
import json
import re

ROOT = Path(__file__).resolve().parents[1]
errors = []
links = 0
mermaid = 0
markdown = sorted(ROOT.rglob("*.md"))
for path in markdown:
    text = path.read_text(encoding="utf-8")
    fences = [line for line in text.splitlines() if line.startswith("```")]
    if len(fences) % 2:
        errors.append(str(path.relative_to(ROOT)) + ": unbalanced code fences")
    mermaid += text.count("```mermaid")
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
        target = target.strip("<>").split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z]+:", target):
            continue
        links += 1
        resolved = (path.parent / unquote(target)).resolve()
        if not resolved.is_relative_to(ROOT):
            errors.append(str(path.relative_to(ROOT)) + ": external local path forbidden")
        elif not resolved.exists():
            errors.append(str(path.relative_to(ROOT)) + ": missing " + target)
for path in sorted((ROOT / "tools").glob("*.py")):
    try:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        errors.append(str(path.relative_to(ROOT)) + ": " + str(exc))
print(json.dumps({"markdown_files": len(markdown), "local_links": links,
                  "balanced_mermaid_blocks": mermaid, "python_syntax": "pass" if not errors else "check errors",
                  "errors": errors}, ensure_ascii=False))
raise SystemExit(1 if errors else 0)
