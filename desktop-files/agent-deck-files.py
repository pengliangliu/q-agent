#!/usr/bin/env python3
"""Windows file dialogs for local Agent Deck sessions in WSL."""
import argparse
import glob
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

ROOT = Path.home() / '.local/share/agent-deck/desktop-files'
DECK = os.environ.get('AGENT_DECK_BIN') or shutil.which('agent-deck') or str(Path.home() / '.local/bin/agent-deck')
SOCKET = 'agent-deck'
POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'


def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                          errors='replace', check=True, **kwargs).stdout.strip()


def tmux(*args):
    return run(['tmux', '-L', SOCKET, *args], timeout=10)


def notify(pane, message):
    if pane:
        subprocess.run(['tmux', '-L', SOCKET, 'display-message', '-t', pane,
                        '-d', '7000', message], capture_output=True, timeout=10)
    print(message)


def windows_path(path):
    return run(['wslpath', '-w', str(path)], timeout=10)


def local_path(value, base):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
        value = value[1:-1]
    if not value:
        raise ValueError('请提供文件或目录路径。')
    if value.startswith('\\\\'):
        match = re.match(r'^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\', value, re.I)
        distro = os.environ.get('WSL_DISTRO_NAME', '')
        if not match or not distro or match[1].lower() != distro.lower():
            raise ValueError('仅支持本机 Windows 或当前 WSL 的文件路径。')
    if any(ord(c) < 32 for c in value):
        raise ValueError('路径含有换行或控制字符，请重新选择。')
    if re.match(r'^[A-Za-z]:[\\/]', value) or value.startswith('\\\\'):
        value = run(['wslpath', '-u', value], timeout=10)
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path(base) / path
    # Preserve symlink spelling so Explorer selects the path the user supplied.
    path = Path(os.path.abspath(path))
    if not path.exists():
        raise ValueError('路径不存在，请复制完整的本地文件或目录路径。')
    return path


def windows(action, **params):
    config = json.loads((ROOT / 'windows.json').read_text())
    cmd = [POWERSHELL, '-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden',
           '-ExecutionPolicy', 'Bypass', '-File', config['script'], '-Action', action]
    for key, value in params.items():
        cmd.extend(['-' + key, str(value)])
    env = os.environ.copy()
    # A tmux server can outlive the WSL interop socket of its original terminal.
    if not Path(env.get('WSL_INTEROP', '/nonexistent')).exists():
        sockets = sorted(glob.glob('/run/WSL/*_interop'), key=os.path.getmtime, reverse=True)
        if sockets:
            env['WSL_INTEROP'] = sockets[0]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8',
                            errors='replace', env=env)
    try:
        response = json.loads(result.stdout.lstrip('\ufeff').strip())
    except ValueError:
        raise ValueError('Windows 文件窗口未能启动，请重新打开 Agent Deck 后再试。') from None
    if result.returncode or response.get('error'):
        raise ValueError(response.get('error', 'Windows 文件操作失败。'))
    return response


def open_terminal(session_id, profile):
    if not session_id or not re.fullmatch(r'[A-Za-z0-9-]{1,120}', session_id):
        raise ValueError('请选择有效会话。')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', profile):
        raise ValueError('当前配置名称不受终端入口支持。')
    row = json.loads(run([DECK, '-p', profile, 'session', 'show', session_id, '--json'], timeout=20))
    if row.get('id') != session_id:
        raise ValueError('会话标识已变化，请刷新后重试。')
    if row.get('status') not in ('running', 'waiting', 'idle') or not row.get('tmux_session'):
        raise ValueError('当前会话未运行，请先启动会话。')
    tmux('has-session', '-t', '=' + row['tmux_session'])
    result = windows('terminal', SessionId=session_id, TerminalProfile=profile)
    if not result.get('success') or result.get('sessionId') != session_id:
        raise ValueError('未能确认终端已打开，请检查窗口后重试。')
    return result


def session_for(pane):
    if not pane or not re.fullmatch(r'%\d+', pane):
        raise ValueError('请进入 Claude 或 Codex 会话后使用此快捷键。')
    name = tmux('display-message', '-p', '-t', pane, '#{session_name}')
    rows = json.loads(run([DECK, 'list', '--json'], timeout=20))
    row = next((r for r in rows if r.get('tmux_session') == name), None)
    if not row or row.get('tool') not in ('claude', 'codex'):
        raise ValueError('当前窗口不是已登记的 Claude/Codex 会话。')
    details = json.loads(run([DECK, 'session', 'show', row['id'], '--json'], timeout=20))
    if re.search(r'\b(ssh|mosh|docker|podman)\b', details.get('wrapper', '') + ' ' + details.get('command', '')):
        raise ValueError('此功能用于本机 WSL 会话；远端文件需要先下载到本地。')
    primary = tmux('list-panes', '-t', name + ':0', '-F', '#{pane_id}').splitlines()[0]
    if pane != primary:
        raise ValueError('请回到该会话的主对话窗口后添加附件。')
    if pane != tmux('display-message', '-p', '-t', name, '#{pane_id}'):
        raise ValueError('当前窗口已切换，请回到主对话窗口后重试。')
    if tmux('display-message', '-p', '-t', pane, '#{pane_current_command}') not in ('claude', 'codex'):
        raise ValueError('当前窗口未运行本地 Claude/Codex，请先进入对话。')
    return row


def draft(pane, session, paths):
    fresh = session_for(pane)
    if fresh['id'] != session['id']:
        raise ValueError('会话已切换，请在目标会话中重新选择附件。')
    if fresh.get('status') not in ('waiting', 'idle'):
        raise ValueError('当前会话正在工作，请等它回到输入框后再添加附件。')
    for path in paths:
        if not path.is_file():
            raise ValueError('附件必须是文件，请重新选择。')
    screen = tmux('capture-pane', '-p', '-t', pane)
    prompts = re.findall(r'(?m)^\s*[❯›](.*)$', screen)
    if (not prompts or re.search(r'(?i)(menu|approval|permission|selection)', fresh.get('substate', ''))
            or re.match(r'\s*(?:[1-9][.)]\s|Yes\b|No\b)', prompts[-1])):
        raise ValueError('当前未显示普通输入框，请先关闭菜单或处理确认提示。')
    # One literal line, to the exact pane: no Enter/Ctrl+C/Escape, even if the
    # harness disables bracketed paste. Agent Deck --draft waits for an EMPTY
    # composer, so it cannot safely append to the user's existing draft.
    message = ' 请读取本地附件（图片请查看画面内容）：' + '；'.join(
        json.dumps(str(path), ensure_ascii=False) for path in paths) + ' '
    buffer = 'desktop-files-' + uuid.uuid4().hex
    run(['tmux', '-L', SOCKET, 'load-buffer', '-b', buffer, '-'], input=message, timeout=10)
    try:
        tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', pane)
    finally:
        subprocess.run(['tmux', '-L', SOCKET, 'delete-buffer', '-b', buffer], capture_output=True)
    notify(pane, f'已加入 {len(paths)} 个本地文件引用；补充说明后按 Enter 发送。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['pick', 'clipboard', 'project', 'locate', 'open', 'open-file', 'attach', 'pick-directory', 'terminal'])
    parser.add_argument('path', nargs='?')
    parser.add_argument('--pane', default=os.environ.get('TMUX_PANE'))
    parser.add_argument('--session')
    parser.add_argument('--profile', default='default')
    parser.add_argument('--paths-json')
    args = parser.parse_args()
    try:
        if args.action == 'terminal':
            print(json.dumps(open_terminal(args.session, args.profile), ensure_ascii=False))
            return 0
        if args.action == 'pick-directory':
            selected = windows('folder')
            if selected.get('path'):
                selected['path'] = str(local_path(selected['path'], Path.home()))
            print(json.dumps(selected, ensure_ascii=False))
            return 0
        if args.action == 'attach':
            row = json.loads(run([DECK, 'session', 'show', args.session, '--json'], timeout=20))
            args.pane = tmux('list-panes', '-t', row['tmux_session'] + ':0', '-F', '#{pane_id}').splitlines()[0]
            paths = [local_path(p, row['path']) for p in json.loads(args.paths_json)]
            draft(args.pane, row, paths)
            return 0
        if args.action == 'open':
            if not args.path:
                raise ValueError('用法：agent-deck-open 文件或目录路径')
            path = local_path(args.path, Path.cwd())
            windows('reveal', Path=windows_path(path))
            notify(args.pane, '已在 Windows 文件管理器中打开。')
            return
        if args.action == 'open-file':
            if not args.path:
                raise ValueError('请提供要打开的文件路径。')
            path = local_path(args.path, Path.cwd())
            allowed = {'.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.tsv',
                       '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.ico',
                       '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.m4a'}
            if not path.is_file() or path.suffix.lower() not in allowed or path.resolve().suffix.lower() not in allowed:
                raise ValueError('此类型请使用“显示位置”查看。')
            print(json.dumps(windows('open-file', Path=windows_path(path)), ensure_ascii=False))
            return 0
        session = session_for(args.pane)
        base = session['path']
        if args.action == 'project':
            windows('reveal', Path=windows_path(local_path(base, Path.cwd())))
            notify(args.pane, '已打开当前会话的项目目录。')
            return
        if args.action == 'locate':
            selected = windows('prompt')
            if selected.get('cancelled'):
                return
            path = local_path(selected['path'], base)
            windows('reveal', Path=windows_path(path))
            notify(args.pane, '已在文件管理器中定位。')
            return
        # Refuse before opening a dialog if the target is currently busy.
        if session.get('status') not in ('waiting', 'idle'):
            raise ValueError('当前会话正在工作，请等它回到输入框后再添加附件。')
        if args.action == 'pick':
            selected = windows('pick', InitialDirectory=windows_path(base))
        else:
            folder = Path.home() / '.local/share/agent-deck/attachments'
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            selected = windows('clipboard', SavePath=windows_path(folder / (uuid.uuid4().hex + '.png')))
        if selected.get('cancelled'):
            return
        paths = [local_path(p, base) for p in selected.get('paths', [])]
        if paths:
            draft(args.pane, session, paths)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, ValueError) else '操作未完成；请确认会话在输入框且 Windows 可访问。'
        notify(args.pane, message)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
