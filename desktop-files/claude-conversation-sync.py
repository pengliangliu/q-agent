"""Record Claude conversation changes for the local desktop bridge."""

import json
import hashlib
import os
from pathlib import Path
import re
import runpy
import shlex
import sys
import tempfile
import time


STATE = Path.home() / '.local/share/agent-deck/runtime/claude-conversation-sync'
SCRIPT = Path(__file__).resolve()
UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', re.I)
INSTANCE = re.compile(r'[a-zA-Z0-9-]{8,100}')


def write_json(file, data, original=None):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent, delete=False) as stream:
        temp = Path(stream.name)
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    try:
        if original is not None and (file.read_bytes() if file.exists() else b'') != original:
            return False
        if file.exists():
            temp.chmod(file.stat().st_mode & 0o777)
        os.replace(temp, file)
        return True
    finally:
        temp.unlink(missing_ok=True)


def install(config_dir):
    config_dir = Path(config_dir).resolve()
    settings = config_dir / 'settings.json'
    command = shlex.join(['/usr/bin/python3', str(SCRIPT), 'hook'])
    for _ in range(3):
        original = settings.read_bytes() if settings.exists() else b''
        data = json.loads(original or b'{}')
        hooks = data.setdefault('hooks', {})
        changed = False
        for event in ('SessionEnd', 'SessionStart'):
            matcher = 'clear'
            group = {'matcher': matcher, 'hooks': [{'type': 'command', 'command': command}]}
            groups = hooks.setdefault(event, [])
            if group not in groups:
                groups.append(group)
                changed = True
        if not changed or write_json(settings, data, original):
            name = hashlib.sha256(str(config_dir).encode()).hexdigest()
            home_record = STATE / 'homes' / name
            if not home_record.exists():
                write_json(home_record, str(config_dir))
            return
    raise RuntimeError('Claude settings changed during hook installation')


def hook(payload):
    instance = os.environ.get('AGENTDECK_INSTANCE_ID', '')
    native_id = payload.get('session_id', '')
    cwd = payload.get('cwd', '')
    transcript = Path(payload.get('transcript_path') or '')
    if not INSTANCE.fullmatch(instance) or not UUID.fullmatch(native_id):
        return
    if not Path(cwd).is_absolute() or not transcript.is_absolute() or transcript.name != native_id + '.jsonl':
        return
    config_dir = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').resolve()
    if transcript.resolve().parent.parent != (config_dir / 'projects').resolve():
        return
    profile = os.environ.get('AGENTDECK_PROFILE', '')
    process = runpy.run_path(str(SCRIPT.with_name('claude-statusline.py')))['claude_process']()
    if not process:
        return
    record = {'instance': instance, 'profile': profile, 'cwd': cwd, 'configDir': str(config_dir),
              'nativeId': native_id, 'transcript': str(transcript), 'process': process,
              'pane': os.environ.get('TMUX_PANE', ''), 'time': time.time()}
    previous = STATE / 'previous' / (instance + '.json')
    if payload.get('hook_event_name') == 'SessionEnd' and payload.get('reason') == 'clear':
        write_json(previous, record)
    elif payload.get('hook_event_name') == 'SessionStart' and payload.get('source') == 'clear':
        old = json.loads(previous.read_bytes())
        if old['nativeId'] == native_id or any(old[key] != record[key] for key in ('process', 'pane', 'configDir', 'cwd', 'profile')):
            return
        write_json(STATE / 'pending' / (old['nativeId'] + '.json'), {'old': old, 'current': record})
        previous.unlink(missing_ok=True)
if __name__ == '__main__':
    if sys.argv[1] == 'install':
        install(sys.argv[2])
    elif sys.argv[1] == 'hook':
        try:
            hook(json.load(sys.stdin))
        except (OSError, ValueError, TypeError, KeyError):
            pass
    elif sys.argv[1] == 'attach' and re.fullmatch(r'[a-f0-9]{8}', sys.argv[2], re.I):
        binary = str(Path.home() / '.local/bin/claude')
        os.execv(binary, [binary, 'attach', sys.argv[2]])
