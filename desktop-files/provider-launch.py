"""Prepare workspace trust, then replace this process with the native assistant."""

import os
from pathlib import Path
import runpy
import subprocess
import sys


METADATA_COMMANDS = {
    'auth', 'login', 'logout', 'help', 'version', 'update', 'install', 'uninstall',
    'doctor', 'mcp', 'debug', 'features', 'completion', 'app-server', 'exec-server',
}


def workspace(tool, arguments):
    folder = Path.cwd()
    if tool == 'codex':
        index = 0
        while index < len(arguments):
            value = arguments[index]
            if value == '--':
                break
            if value in ('-C', '--cd') and index + 1 < len(arguments):
                folder = Path(arguments[index + 1]).expanduser()
                index += 1
            elif value.startswith('--cd='):
                folder = Path(value.partition('=')[2]).expanduser()
            elif value.startswith('-C') and len(value) > 2:
                folder = Path(value[2:].removeprefix('=')).expanduser()
            index += 1
    return folder.resolve()


def prepare(tool, arguments):
    if any(value in ('--help', '-h', '--version', '-V') for value in arguments):
        return
    if arguments and arguments[0] in METADATA_COMMANDS:
        return
    folder = workspace(tool, arguments)
    if not folder.is_dir():
        return  # Let the native assistant report its own invalid-directory error.
    helpers = runpy.run_path(str(Path(__file__).with_name('account-login.py')))
    folders = {str(folder)}
    try:
        result = subprocess.run(
            ['git', '-C', str(folder), 'rev-parse', '--show-toplevel'],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            folders.add(str(Path(result.stdout.strip()).resolve()))
    except (OSError, subprocess.TimeoutExpired):
        pass
    if tool == 'gemini':
        home = Path(os.environ.get('GEMINI_CLI_HOME', str(Path.home()))) / '.gemini'
        file = Path(os.environ.get('GEMINI_CLI_TRUSTED_FOLDERS_PATH', str(home / 'trustedFolders.json')))
        for project in folders:
            helpers['trust_json'](file, project, False)
    else:
        variable = 'CODEX_HOME' if tool == 'codex' else 'CLAUDE_CONFIG_DIR'
        home = Path(os.environ.get(variable) or str(Path.home() / ('.' + tool))).expanduser()
        for project in folders:
            helpers['trust_account_project'](tool, home, project)


def main():
    tool, native, *arguments = sys.argv[1:]
    if tool not in ('claude', 'codex', 'gemini') or not Path(native).is_absolute():
        return 2
    try:
        prepare(tool, arguments)
    except (OSError, ValueError, KeyError):
        print('Q-agent 无法保存目录信任，请检查当前账号配置文件是否可写。', file=sys.stderr)
        return 1
    os.execv(native, [tool, *arguments])


if __name__ == '__main__':
    sys.exit(main())
