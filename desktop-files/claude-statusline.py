"""Keep the existing status line while recording native, session-scoped model state."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

CACHE = Path(__file__).resolve().parent.parent / 'runtime' / 'claude-status'
LEVELS = {'low', 'medium', 'high', 'xhigh', 'max'}


def claude_process():
    pid = os.getppid()
    for _ in range(8):
        proc = Path('/proc') / str(pid)
        fields = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
        executable = str((proc / 'exe').resolve())
        if re.search(r'/claude/versions/[^/]+$', executable) or Path(executable).name == 'claude':
            return {'pid': pid, 'startTicks': fields[19],
                    'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        pid = int(fields[1])
        if pid <= 1:
            break
    return None


def capture(payload):
    session_id = payload.get('session_id', '')
    transcript = payload.get('transcript_path', '')
    model_id = payload.get('model', {}).get('id', '')
    level = payload.get('effort', {}).get('level')
    if not re.fullmatch(r'[A-Za-z0-9-]{8,100}', session_id) or not Path(transcript).is_absolute():
        return
    if not isinstance(model_id, str) or not re.fullmatch(r'claude-[A-Za-z0-9.\[\]-]+', model_id):
        return
    process = claude_process()
    tmux_pane = os.environ.get('TMUX_PANE', '')
    tmux_socket = os.environ.get('TMUX', '').split(',')[0]
    if not process or not re.fullmatch(r'%\d+', tmux_pane) or not Path(tmux_socket).is_absolute():
        return
    record = {'sessionId': session_id, 'transcriptPath': transcript, 'modelId': model_id,
              'reasoningEffort': level if level in LEVELS else None,
              'effortPresent': isinstance(payload.get('effort'), dict),
              'capturedAt': int(time.time() * 1000), 'process': process,
              'tmuxPane': tmux_pane, 'tmuxSocket': tmux_socket}
    CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=CACHE, prefix='.' + session_id + '-', delete=False) as output:
            temporary = Path(output.name)
            json.dump(record, output, separators=(',', ':'))
        os.replace(temporary, CACHE / (session_id + '-pane-' + tmux_pane[1:] + '.json'))
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    original = sys.stdin.buffer.read()
    try:
        capture(json.loads(original))
    except (OSError, ValueError, TypeError, AttributeError):
        pass  # Capturing state must never suppress the existing status line.
    if len(sys.argv) == 2:
        sys.exit(subprocess.run(['/bin/sh', '-c', sys.argv[1]], input=original).returncode)
