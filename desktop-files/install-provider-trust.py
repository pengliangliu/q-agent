"""Wrap the local CLI entries while retaining the original native launchers."""

from pathlib import Path
import os
import shlex
import shutil
import tempfile


MARKER = '# q-agent: workspace-trust'


def install(root, bin_directory=None):
    directory = bin_directory or Path.home() / '.local/bin'
    installed = []
    for tool in ('claude', 'codex', 'gemini'):
        entry = directory / tool
        native = directory / (tool + '.q-agent-native')
        if not entry.is_file():
            continue
        with entry.open('rb') as source:
            wrapped = MARKER.encode() in source.read(256)
        if not wrapped:
            reference = native.with_name(native.name + '.new')
            reference.unlink(missing_ok=True)
            if entry.is_symlink():
                reference.symlink_to(os.readlink(entry))
            else:
                os.link(entry, reference)
            os.replace(reference, native)
        if not native.is_file():
            raise RuntimeError('The native assistant launcher is unavailable')
        command = ' '.join(map(shlex.quote, ['/usr/bin/python3', str(root / 'provider-launch.py'), tool, str(native)]))
        contents = '#!/bin/sh\n' + MARKER + '\nexec ' + command + ' "$@"\n'
        fd, temporary = tempfile.mkstemp(prefix='.' + tool + '.trust-', dir=directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as output:
                output.write(contents)
            os.chmod(temporary, 0o755)
            os.replace(temporary, entry)
        finally:
            Path(temporary).unlink(missing_ok=True)
        installed.append(tool)
    skills = directory / 'claude-with-skills'
    if skills.is_file():
        text = skills.read_text(encoding='utf-8')
        if 'skill-runtime.env' in text and '\nunset CLAUDE_CONFIG_DIR\n' in text:
            backup = skills.with_name(skills.name + '.before-q-agent-trust')
            if not backup.exists():
                shutil.copy2(skills, backup)
            fd, temporary = tempfile.mkstemp(prefix='.claude-skills-', dir=directory)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as output:
                    output.write(text.replace('\nunset CLAUDE_CONFIG_DIR\n', '\n'))
                os.chmod(temporary, skills.stat().st_mode & 0o777)
                os.replace(temporary, skills)
            finally:
                Path(temporary).unlink(missing_ok=True)
    return installed


if __name__ == '__main__':
    print('Workspace trust enabled for: ' + ', '.join(install(Path(__file__).resolve().parent)))
