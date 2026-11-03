"""Launch a provider's native login in an interactive terminal in this WSL user."""
import argparse
import configparser
import errno
import fcntl
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import re
import shlex

ROOT = Path(__file__).resolve().parent
LOGIN = {'claude': ['auth', 'login'], 'codex': ['login']}
CONFIG_ENV = {'claude': 'CLAUDE_CONFIG_DIR', 'codex': 'CODEX_HOME'}

def deck(*args):
    binary = os.environ.get('AGENT_DECK_BIN') or shutil.which('agent-deck') or str(Path.home()/'.local/bin/agent-deck')
    output = subprocess.check_output([binary, *args, '--json'], timeout=20, stderr=subprocess.DEVNULL)
    return json.loads(output)

def parse_config(text):
    try:
        import tomllib
    except ImportError:
        try:
            import tomli as tomllib
        except ImportError:
            from pip._vendor import tomli as tomllib
    return tomllib.loads(text)

def add_slot(tool, name, existing=False):
    if not re.fullmatch(r'[^\W_][\w.-]{0,47}', name) or name.casefold() == 'default':
        raise ValueError('账号名须以字母、汉字或数字开头，最多 48 字，不能使用 default。')
    file = Path(deck('config', 'get', 'claude.config_dir')['path']).resolve()
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    slots = {item['name']:item['config_dir'] for item in deck('accounts', '--harness', tool)}
    directory = default_dir(tool, slots) if existing else Path.home()/'.local/share/q-agent/accounts'/tool/name
    with open(str(file) + '.lock', 'a', opener=lambda p, f: os.open(p, f, 0o600)) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        original = file.read_bytes() if file.exists() else b''
        config = parse_config(original.decode('utf-8'))
        if tool in config.get('profiles', {}).get(name, {}):
            raise ValueError('此助手已存在同名账号配置。')
        profiles = deck('profile', 'list')
        if name == profiles.get('default_profile') or name in {row['name'] for row in profiles.get('profiles') or []}:
            raise ValueError('此名称已用于 Agent Deck 会话配置，请换一个账号名。')
        # Append a single TOML table, preserving comments and all original bytes.
        table = '\n[profiles.' + json.dumps(name, ensure_ascii=False) + '.' + tool + ']\nconfig_dir = ' + json.dumps(str(directory), ensure_ascii=False) + '\n'
        replacement = original + table.encode('utf-8')
        parse_config(replacement.decode('utf-8'))
        if existing:
            if not directory.is_dir():
                raise ValueError('默认账号目录尚不存在，请先登录。')
        else:
            directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.mkdir(mode=0o700)
        try:
            with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as tmp:
                try:
                    tmp.write(replacement); tmp.flush(); os.fsync(tmp.fileno())
                    os.replace(tmp.name, file)
                finally:
                    Path(tmp.name).unlink(missing_ok=True)
        except BaseException:
            if not existing: directory.rmdir()
            raise

def default_dir(tool, slots):
    variable = os.environ.get(CONFIG_ENV[tool])
    if variable:
        return Path(variable).expanduser()
    profile = os.environ.get('AGENTDECK_PROFILE') or deck('profile', 'default')['default_profile']
    if profile in slots:
        return Path(slots[profile]).expanduser()
    setting = deck('config', 'get', 'claude.config_dir')
    if tool == 'claude':
        configured = setting['value']
    else:
        # The native config path includes XDG and legacy installations. Codex's
        # global config_dir is not exposed by config get in Agent Deck v1.16.35.
        file = Path(setting['path'])
        configured = ''
        if file.is_file():
            configured = parse_config(file.read_text(encoding='utf-8')).get('codex', {}).get('config_dir', '')
    return Path(configured).expanduser() if configured else Path.home()/('.' + tool)

def login_target(tool, slot):
    info = deck('harness', 'status', tool)
    slots = {entry['name']: entry['config_dir'] for entry in info['accounts']}
    if slot and slot not in slots:
        raise ValueError('unknown slot')
    directory = Path(slots[slot]).expanduser() if slot else default_dir(tool, slots)
    binary = Path(info.get('path') or '')
    if not directory.is_absolute() or not info.get('installed') or not binary.is_absolute() or str(binary).startswith('/mnt/') or not os.access(binary, os.X_OK):
        raise ValueError('native tool unavailable')
    if info.get('login_command') != ' '.join([tool, *LOGIN[tool]]):
        raise ValueError('custom login command')
    return binary, directory

def wsl_distribution():
    distro = os.environ.get('WSL_DISTRO_NAME')
    if not distro:
        # Older systemd user services don't inherit WSL_DISTRO_NAME. The
        # Windows path for this instance's Linux root names the same distro.
        root = subprocess.check_output(['wslpath', '-w', '/'], text=True, timeout=5).rstrip('\r\n')
        match = re.fullmatch(r'\\\\(?:wsl\.localhost|wsl\$)\\([^\\/]+)\\?', root, re.IGNORECASE)
        distro = match.group(1) if match else ''
    if not re.fullmatch(r'[^\x00-\x1f"\\/-][^\x00-\x1f"\\/]*', distro):
        raise ValueError('invalid WSL distribution')
    return distro

def open_login(tool, slot):
    binary, directory = login_target(tool, slot)
    payload = dict(distro=wsl_distribution(), user=pwd.getpwuid(os.getuid()).pw_name,
                   helper=str(ROOT/'account-login.py'), tool=tool, binary=str(binary), directory=str(directory))
    env = os.environ.copy()
    if not Path(env.get('WSL_INTEROP', '/nonexistent')).exists():
        sockets = sorted(Path('/run/WSL').glob('*_interop'), key=lambda f: f.stat().st_mtime, reverse=True)
        if sockets:
            env['WSL_INTEROP'] = str(sockets[0])
    script = subprocess.check_output(['wslpath', '-w', str(ROOT/'account-terminal.ps1')], text=True).strip()
    command = ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-NonInteractive',
               '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script]
    options = dict(input=json.dumps(payload, ensure_ascii=True).encode('ascii'), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, env=env, check=True, timeout=12)
    try:
        subprocess.run(command, **options)
    except OSError as error:
        # A running WSL interop server can lose its binfmt registration.
        # ENOEXEC means Windows never received the original launch request.
        config = configparser.ConfigParser(interpolation=None, strict=False)
        config.read('/etc/wsl.conf')
        if error.errno != errno.ENOEXEC or not config.getboolean('interop', 'enabled', fallback=True) or not Path(env.get('WSL_INTEROP', '/nonexistent')).is_socket():
            raise
        subprocess.run(['qagent-interop', *command], executable='/init', **options)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['open', 'interactive', 'manual', 'add'])
    parser.add_argument('tool', choices=list(LOGIN))
    parser.add_argument('--slot', default='')
    parser.add_argument('--bind-default', action='store_true')
    parser.add_argument('--binary')
    parser.add_argument('--directory')
    args = parser.parse_args()
    if args.action == 'add':
        try:
            add_slot(args.tool, args.slot, args.bind_default)
        except FileExistsError:
            sys.exit('账号目录已存在，请换一个账号名。')
        except ValueError as error:
            # Only return our fixed validation errors, never a config parser exception.
            if type(error) is ValueError: sys.exit(str(error))
            raise
        return 0
    if args.action == 'open':
        open_login(args.tool, args.slot)
        return 0
    if args.action == 'manual':
        binary, directory = login_target(args.tool, args.slot)
    else:
        if not sys.stdin.isatty():
            raise ValueError('interactive terminal required')
        binary, directory = Path(args.binary), Path(args.directory)
    if not binary.is_absolute() or not directory.is_absolute():
        raise ValueError('native path required')
    os.environ[CONFIG_ENV[args.tool]] = str(directory)
    # Claude uses a separate credential namespace when this variable is set.
    if args.tool == 'claude' and 'CLAUDE_SECURESTORAGE_CONFIG_DIR' in os.environ:
        os.environ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = str(directory)
    os.environ['PATH'] = str(Path.home()/'.local/bin') + ':' + os.environ.get('PATH', '/usr/bin:/bin')
    os.chdir(Path.home())
    if args.action == 'manual':
        command = [str(binary), *LOGIN[args.tool]]
        if args.tool == 'codex': command.append('--device-auth')
        os.environ.update(BROWSER='/bin/false', SHELL='/bin/sh', TERM='dumb', NO_COLOR='1')
        # script provides the real CLI's interactive prompt. Disable input echo
        # and send its typescript to /dev/null, including on authentication error.
        os.execv('/usr/bin/script', ['script','-qef','-E','never','-c','exec ' + shlex.join(command),'/dev/null'])
    status = subprocess.call([str(binary), *LOGIN[args.tool]])
    print('登录流程已结束，请返回 Q-agent 刷新账号状态。' if status == 0 else '登录未完成，请查看上方的原生提示。')
    try:
        input('按 Enter 关闭窗口。')
    except EOFError:
        pass
    return status

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyError, ValueError, OSError, ImportError, subprocess.SubprocessError):
        sys.exit('无法打开原生登录，请检查 WSL 用户、助手安装和账号配置。')
