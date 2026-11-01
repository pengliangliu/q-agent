#!/usr/bin/env python3
"""Build or install the optional sender; never replace the official CLI."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from apply import ROOT, VERSION, GO_VERSION, bundle_digest, plan


def identity(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    info = file.stat()
    return {'size': info.st_size, 'mtimeMs': info.st_mtime_ns // 1_000_000, 'sha256': digest.hexdigest()}


def official_cli(value):
    candidate = value or shutil.which('agent-deck') or str(Path.home() / '.local/bin/agent-deck')
    result = Path(candidate).expanduser().resolve(strict=True)
    if not result.is_file():
        raise ValueError('Official Agent Deck CLI is not a file')
    return result


def verify_version(binary):
    output = subprocess.check_output([str(binary), 'version'], text=True, timeout=20,
        env={**os.environ, 'AGENTDECK_SKIP_UPDATE_CHECK': '1'}).strip()
    if not re.fullmatch(r'Agent Deck v' + re.escape(VERSION) + r'(?: \(update available: v[^)]+\))?', output):
        raise ValueError('Expected Agent Deck v' + VERSION + '; do not use this patch for a different release')


def json_atomic(target, data):
    handle, temporary = tempfile.mkstemp(prefix='.' + target.name + '-', dir=target.parent)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build(args):
    source = args.source.expanduser().resolve(strict=True)
    if plan(source):
        raise ValueError('Apply the complete patch with apply.py before building')
    base = official_cli(args.base_cli)
    verify_version(base)
    before = identity(base)
    output = args.output.expanduser().absolute()
    if output.resolve() == base or output.is_symlink():
        raise ValueError('Build output must not replace or link to the official CLI')
    output.parent.mkdir(parents=True, exist_ok=True)
    go = args.go or shutil.which('go')
    if not go:
        raise ValueError('Install Go ' + GO_VERSION + ' first, or supply --go')
    env = {**os.environ, 'GOTOOLCHAIN': 'go' + GO_VERSION, 'CGO_ENABLED': '0'}
    subprocess.run([go, 'build', '-trimpath', '-ldflags=-s -w', '-o', str(output), './cmd/agent-deck'],
                   cwd=source, env=env, check=True)
    verify_version(output)
    if identity(base) != before:
        raise ValueError('Official CLI changed during build; rebuild against the installed release')
    record = {'upstreamVersion': VERSION, 'base': before, 'helper': identity(output),
              'bundleSha256': bundle_digest(),
              'patchSha256': hashlib.sha256((ROOT / 'readiness-callsite.patch').read_bytes()).hexdigest()}
    json_atomic(Path(str(output) + '.build.json'), record)
    print('Sender built. Build receipt contains version and hashes, not local paths.')


def install(args):
    if os.name != 'posix':
        raise ValueError('Install the sender inside WSL/Linux')
    artifact = args.artifact.expanduser().resolve(strict=True)
    record = json.loads(Path(str(artifact) + '.build.json').read_text(encoding='utf-8'))
    base = official_cli(args.base_cli)
    verify_version(base)
    if record.get('upstreamVersion') != VERSION or record.get('bundleSha256') != bundle_digest():
        raise ValueError('Build receipt does not match this patch bundle; rebuild first')
    if identity(base) != record.get('base') or identity(artifact) != record.get('helper'):
        raise ValueError('Official CLI or build artifact changed; rebuild first')
    root = args.install_dir.expanduser().resolve()
    if not root.is_dir():
        raise ValueError('Install the desktop bridge before its optional sender')
    target = root / 'agent-deck-idle-send'
    manifest = root / 'agent-deck-idle-send.json'
    if target.resolve() == base or target.is_symlink() or manifest.is_symlink():
        raise ValueError('Installation must not replace the official CLI or a linked file')
    if artifact == target:
        raise ValueError('Use a separate build output, not the installed helper')
    backup = root / 'backups' / ('idle-send-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, exist_ok=False)
    for file in (target, manifest):
        if file.exists():
            shutil.copy2(file, backup / file.name)
    handle, temporary = tempfile.mkstemp(prefix='.idle-send-', dir=root)
    os.close(handle)
    try:
        shutil.copyfile(artifact, temporary)
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    record['helper'] = identity(target)
    json_atomic(manifest, record)
    print('Optional sender installed. Official CLI and running sessions were not restarted.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    builder = commands.add_parser('build', help='Build from an already patched source tree')
    builder.add_argument('source', type=Path)
    builder.add_argument('--go', help='Path to a Go executable')
    builder.add_argument('--base-cli', help='Official CLI used by the desktop bridge')
    builder.add_argument('--output', type=Path, default=ROOT / 'build/agent-deck-idle-send')
    installer = commands.add_parser('install', help='Install a built sender and its matching receipt')
    installer.add_argument('artifact', type=Path)
    installer.add_argument('--base-cli', help='Official CLI used by the desktop bridge')
    installer.add_argument('--install-dir', type=Path,
                           default=Path.home() / '.local/share/agent-deck/desktop-files')
    args = parser.parse_args()
    try:
        (build if args.command == 'build' else install)(args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
