"""Install the local WSL bridge without restarting any Agent Deck session."""
from datetime import datetime
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys

source = Path(__file__).resolve().parent
if len(sys.argv) != 2 or not re.match(r'^[A-Za-z]:[\\/]', sys.argv[1]):
    raise SystemExit('Pass an absolute Windows script path using wsl.exe --exec.')
home = Path.home()
root = home / '.local/share/agent-deck/desktop-files'
root.mkdir(parents=True, exist_ok=True)
backup = root / 'backups' / datetime.now().strftime('%Y%m%d-%H%M%S')
backup.mkdir(parents=True)
changed = []


def write(path, content, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.read_text() if path.exists() else None
    if old == content:
        return
    if old is not None:
        destination = backup / path.relative_to(home)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    path.write_text(content)
    if executable:
        path.chmod(0o755)
    changed.append({'path': str(path), 'existed': old is not None})


def append_block(path, content):
    start = '# BEGIN Agent Deck desktop files'
    end = '# END Agent Deck desktop files'
    old = path.read_text() if path.exists() else ''
    block = start + '\n' + content.rstrip() + '\n' + end
    if start in old:
        before, rest = old.split(start, 1)
        _, after = rest.split(end, 1)
        updated = before + block + after
    else:
        updated = old.rstrip() + ('\n\n' if old.strip() else '') + block + '\n'
    write(path, updated)


write(root / 'agent-deck-files.py', (source / 'agent-deck-files.py').read_text(), True)
write(root / 'windows.json', json.dumps({'script': sys.argv[1]}, ensure_ascii=False) + '\n')
write(home / '.local/bin/agent-deck-files', '#!/bin/sh\nexec /usr/bin/python3 "$HOME/.local/share/agent-deck/desktop-files/agent-deck-files.py" "$@"\n', True)
write(home / '.local/bin/agent-deck-open', '#!/bin/sh\nexec "$HOME/.local/bin/agent-deck-files" open "$@"\n', True)


def quote(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


actions = [('F6', '选择图片 / 文件', 'pick'), ('F7', '粘贴截图 / 复制的文件', 'clipboard'),
           ('F8', '打开项目目录', 'project'), ('F9', '定位指定文件', 'locate')]
commands = {key: 'run-shell -b ' + quote(str(home / '.local/bin/agent-deck-files') + ' ' + action + ' --pane #{pane_id}')
            for key, _, action in actions}
menu = 'display-menu -T "图片与文件" -x C -y C '
menu += ' '.join(quote(label + '  [' + key + ']') + ' ' + key + ' ' + quote(commands[key]) for key, label, _ in actions)
commands['F4'] = menu
bindings = '\n'.join('bind-key -n ' + key + ' if-shell -F "#{m:agentdeck_*,#{session_name}}" ' + quote(command) + ' ' + quote('send-keys ' + key)
                     for key, command in commands.items())
conf = home / '.config/agent-deck/desktop-files.tmux.conf'
write(conf, '# Local Windows file actions; only the Agent Deck socket loads this file.\n' + bindings + '\n')
socket_path = '/tmp/tmux-' + str(__import__('os').getuid()) + '/agent-deck'
append_block(home / '.tmux.conf', 'if-shell -F ' + quote('#{==:#{socket_path},' + socket_path + '}') + ' ' + quote('source-file ' + str(conf)))

guidance = f'''## Agent Deck 本地文件操作

仅在本机 WSL Agent Deck 会话中适用：用户要求打开文件夹、显示文件所在位置时，执行
`{home / '.local/bin/agent-deck-open'} '/完整/本地/路径'`。文件会在 Windows 资源管理器中选中，目录会直接打开。
也接受 Windows 完整路径；命令参数用可靠的 shell 引号，路径不拼接为可执行代码。
用户通过 F6/F7 添加的本地附件应按其任务读取；图片用可用的 Read/view_image 工具查看实际画面。
F4 是文件菜单，F6 选择图片/文件，F7 粘贴截图或复制的文件，F8 打开项目目录，F9 输入路径定位。
这些操作用于本机文件，远端服务器路径须先按项目要求下载到本地。
'''
write(home / '.claude/rules/agent-deck-desktop-files.md', guidance)
append_block(home / '.codex/AGENTS.md', guidance)
(backup / 'manifest.json').write_text(json.dumps(changed, ensure_ascii=False, indent=2))
if subprocess.run(['tmux', '-L', 'agent-deck', 'has-session'], capture_output=True).returncode == 0:
    subprocess.run(['tmux', '-L', 'agent-deck', 'source-file', str(conf)], check=True)
print(json.dumps({'installed': str(root), 'backup': str(backup), 'changed': len(changed), 'active_sessions_restarted': 0}))
