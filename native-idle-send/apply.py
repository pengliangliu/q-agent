#!/usr/bin/env python3
"""Apply the optional readiness patch to an Agent Deck v1.16.35 source tree."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile

ROOT = Path(__file__).resolve().parent
VERSION = '1.16.35'
GO_VERSION = '1.26.10'
CALLSITE = 'cmd/agent-deck/session_send_cmd.go'
FILES = (
    'internal/session/idle_send_ready.go',
    'internal/session/idle_send_ready_test.go',
    'internal/session/idle_send_transcript.go',
    'internal/session/idle_send_transcript_test.go',
    'cmd/agent-deck/session_send_idle_ready.go',
    'cmd/agent-deck/session_send_idle_ready_test.go',
)


def bundle_digest():
    digest = hashlib.sha256()
    for name in (*FILES, 'readiness-callsite.patch'):
        digest.update(name.encode() + b'\0')
        digest.update((ROOT / name).read_bytes())
    return digest.hexdigest()


def checked_target(source, name):
    target = source / name
    current = target
    while current != source:
        if current.is_symlink():
            raise ValueError('Refusing a linked patch target: ' + name)
        current = current.parent
    if source not in target.resolve().parents:
        raise ValueError('Patch target is outside the source tree: ' + name)
    if not target.parent.is_dir():
        raise ValueError('Incomplete upstream source directory: ' + name)
    return target


def callsite_fragments():
    lines = (ROOT / 'readiness-callsite.patch').read_text(encoding='utf-8').splitlines(keepends=True)
    if lines[:2] != ['--- a/' + CALLSITE + '\n', '+++ b/' + CALLSITE + '\n']:
        raise ValueError('Unexpected call-site patch headers')
    if sum(line.startswith('@@ ') for line in lines) != 1:
        raise ValueError('Expected exactly one call-site hunk')
    hunk = lines[next(i for i, line in enumerate(lines) if line.startswith('@@ ')) + 1:]
    if not hunk or any(line[:1] not in (' ', '+', '-') for line in hunk):
        raise ValueError('Unexpected call-site patch format')
    return (''.join(line[1:] for line in hunk if line[0] in ' -'),
            ''.join(line[1:] for line in hunk if line[0] in ' +'))


def plan(source):
    source = source.expanduser().resolve(strict=True)
    main = checked_target(source, 'cmd/agent-deck/main.go').read_text(encoding='utf-8')
    module = checked_target(source, 'go.mod').read_text(encoding='utf-8')
    if not re.search(r'^var Version = "' + re.escape(VERSION) + r'"', main, re.M):
        raise ValueError('This patch supports only Agent Deck v' + VERSION)
    if not re.search(r'^go ' + re.escape(GO_VERSION) + r'\s*$', module, re.M):
        raise ValueError('Unexpected upstream Go toolchain requirement')
    target = checked_target(source, CALLSITE)
    text = target.read_text(encoding='utf-8')
    old, new = callsite_fragments()
    changes = []
    if text.count(old) == 1 and new not in text:
        changes.append((target, text.replace(old, new, 1).encode('utf-8')))
    elif text.count(new) != 1 or old in text:
        raise ValueError('Readiness call site differs from the supported upstream version')
    for name in FILES:
        target = checked_target(source, name)
        expected = (ROOT / name).read_bytes()
        if target.exists():
            if not target.is_file() or target.read_bytes() != expected:
                raise ValueError('Existing helper differs; no files changed: ' + name)
        else:
            changes.append((target, expected))
    return changes


def write_atomic(target, content):
    mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
    handle, temporary = tempfile.mkstemp(prefix='.' + target.name + '-', dir=target.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Source checkout or unpacked official v1.16.35 release')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true', help='Validate all targets without writing')
    modes.add_argument('--verify', action='store_true', help='Require every patch file to be already applied')
    args = parser.parse_args()
    try:
        changes = plan(args.source)
        if args.verify and changes:
            raise ValueError('Patch has not been fully applied')
        if not args.check and not args.verify:
            for target, content in changes:
                write_atomic(target, content)
        print('Patch verified' if not changes else
              'Patch can be applied' if args.check else 'Patch applied; rerunning is safe')
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
