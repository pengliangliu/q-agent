"""Install runtime sources for the current WSL user; preserve native sessions."""
from datetime import datetime
from pathlib import Path
import os
import re
import shutil
import subprocess

source = Path(__file__).resolve().parent
home = Path.home()
root = home / '.local/share/agent-deck/desktop-files'
deck = shutil.which('agent-deck') or str(home / '.local/bin/agent-deck')
node = shutil.which('node') or str(home / '.local/bin/node')
for binary in (deck, node):
    if not Path(binary).is_file():
        raise SystemExit('Install Agent Deck and Node.js in this WSL user environment first.')
version = subprocess.check_output([deck, 'version'], text=True).strip()
if not re.fullmatch(r'Agent Deck v1\.16\.35(?: \(update available: v[^)]+\))?', version):
    raise SystemExit('This release targets Agent Deck v1.16.35. Install that upstream version before continuing.')
if int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True)) < 22:
    raise SystemExit('Node.js 22 or newer is required.')
distro = os.environ.get('WSL_DISTRO_NAME', '')
if not distro:
    raise SystemExit('Run this installer inside the intended WSL distribution.')
root.mkdir(parents=True, exist_ok=True)
backup = root / 'backups' / ('web-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True)
names = [file.name for file in source.iterdir() if file.suffix in {'.mjs', '.py', '.json'} and not file.name.startswith('install')]
names.append('install-claude-statusline.py')
for name in names:
    target = root / name
    if target.exists():
        shutil.copy2(target, backup / name)
    shutil.copy2(source / name, target)
if (root / 'web-ui/overrides').exists():
    shutil.copytree(root / 'web-ui/overrides', backup / 'overrides')
shutil.copytree(source / 'web-ui/overrides', root / 'web-ui/overrides', dirs_exist_ok=True)

def systemd_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

environment = '\n'.join('Environment=' + systemd_quote(value) for value in [
    'PATH=' + str(home / '.local/bin') + ':' + str(Path(deck).parent) + ':' + str(Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin',
    'AGENT_DECK_BIN=' + deck, 'WSL_DISTRO_NAME=' + distro,
])
units = {
    'agent-deck-web-local.service': '[Unit]\nDescription=Agent Deck local web backend\n[Service]\n' + environment +
        '\nEnvironment=AGENTDECK_WEB_BUNDLE=0\nExecStart=' + systemd_quote(deck) +
        ' web --no-tui --listen 127.0.0.1:8420\nRestart=on-failure\n[Install]\nWantedBy=default.target\n',
    'agent-deck-desktop.service': '[Unit]\nDescription=Agent Deck desktop bridge\nWants=agent-deck-web-local.service\nAfter=agent-deck-web-local.service\n[Service]\n' + environment +
        '\nExecStart=' + systemd_quote(node) + ' ' + systemd_quote(root / 'web-server.mjs') +
        '\nRestart=on-failure\n[Install]\nWantedBy=default.target\n',
}
for name, text in units.items():
    target = home / '.config/systemd/user' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.copy2(target, backup / name)
    target.write_text(text)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
subprocess.run(['systemctl', '--user', 'enable', '--now', *units], check=True)
subprocess.run(['systemctl', '--user', 'restart', 'agent-deck-desktop.service'], check=True)
print('Installed desktop bridge for the current WSL user; native sessions were not restarted.')
