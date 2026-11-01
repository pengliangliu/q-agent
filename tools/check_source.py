"""Small source checks; does not start services or access model accounts."""
from pathlib import Path
import ast
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
ignored = {'.git', 'packages', 'dist', '.build', 'build', '__pycache__', 'node_modules'}
files = [p for p in root.rglob('*') if p.is_file() and not ignored.intersection(p.relative_to(root).parts)]
for file in files:
    if file.suffix == '.py':
        ast.parse(file.read_text(encoding='utf-8-sig'), filename=str(file.relative_to(root)))
    elif file.suffix in {'.json', '.webmanifest'}:
        json.loads(file.read_text(encoding='utf-8-sig'))
node = shutil.which('node')
if not node:
    raise SystemExit('Install Node.js to check JavaScript sources.')
for file in files:
    if file.suffix in {'.js', '.mjs'}:
        subprocess.run([node, '--check', str(file)], check=True, capture_output=True)
print('Python, JSON and JavaScript syntax checks passed.')
