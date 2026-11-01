"""Idempotently wrap the existing user status line; keep its original behavior."""
from datetime import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import tempfile

root = Path(__file__).resolve().parent
helper = root / 'claude-statusline.py'
settings = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))) / 'settings.json'
data = json.loads(settings.read_text())
status = data.get('statusLine')
if not isinstance(status, dict) or status.get('type') != 'command' or not isinstance(status.get('command'), str):
    raise SystemExit('Existing command status line was not found; settings left unchanged.')
command = status['command']
prefix = shlex.join(['/usr/bin/python3', str(helper)]) + ' '
if command.startswith(prefix):
    print('Native Claude status capture already installed; settings unchanged.')
else:
    if not helper.is_file():
        raise SystemExit('Native Claude status capture helper is missing; settings left unchanged.')
    backup = root / 'backups' / ('claude-statusline-' + datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(settings, backup / 'settings.json')
    status['command'] = prefix + shlex.quote(command)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=settings.parent, prefix='.settings-statusline-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.chmod(temporary, settings.stat().st_mode & 0o777)
        os.replace(temporary, settings)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print('Native Claude status capture installed; existing status line and other settings preserved.')
