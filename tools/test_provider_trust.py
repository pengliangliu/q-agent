"""Verify launch-time trust without starting real assistants or using credentials."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1] / 'desktop-files'
spec = importlib.util.spec_from_file_location('trust_installer', source / 'install-provider-trust.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
spec = importlib.util.spec_from_file_location('trust_helper', source / 'account-login.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

with tempfile.TemporaryDirectory(prefix='provider-trust-') as temporary:
    root = Path(temporary)
    runtime, binaries, project = root / 'runtime', root / 'bin', root / 'project 中文'
    runtime.mkdir()
    binaries.mkdir()
    project.mkdir()
    nested = project / 'child folder'
    nested.mkdir()
    subprocess.run(['git', 'init', '-q', str(project)], check=True)
    for name in ('provider-launch.py', 'account-login.py'):
        shutil.copy2(source / name, runtime / name)
    stub = '#!/usr/bin/python3\nimport os,sys,json\nprint(json.dumps({"args":sys.argv[1:],"account":os.environ.get("CLAUDE_CONFIG_DIR"),"version":1}))\n'
    for tool in ('claude', 'codex', 'gemini'):
        file = binaries / tool
        file.write_text(stub, encoding='utf-8')
        file.chmod(0o755)
    skills = binaries / 'claude-with-skills'
    skills.write_text('#!/bin/sh\n# source skill-runtime.env\nunset CLAUDE_CONFIG_DIR\nexec "' + str(binaries / 'claude') + '" "$@"\n')
    skills.chmod(0o755)
    installer.install(runtime, binaries)
    installer.install(runtime, binaries)
    env = {
        **os.environ,
        'CODEX_HOME': str(root / 'codex-account'),
        'CLAUDE_CONFIG_DIR': str(root / 'claude-account'),
        'GEMINI_CLI_TRUSTED_FOLDERS_PATH': str(root / 'gemini-trust.json'),
    }

    def run(binary, *args):
        return json.loads(subprocess.check_output(
            [str(binaries / binary), *args], env=env, cwd=project, text=True, timeout=6,
        ))

    for tool in ('claude', 'codex', 'gemini'):
        assert run(tool, '--version')['args'] == ['--version']
    assert not (root / 'codex-account').exists()
    assert not (root / 'claude-account').exists()
    assert not (root / 'gemini-trust.json').exists()
    assert run('codex', 'resume', 'fixture-id', '-C', str(nested))['args'] == ['resume', 'fixture-id', '-C', str(nested)]
    config = helper.parse_config((root / 'codex-account/config.toml').read_text())
    assert config['projects'][str(nested)]['trust_level'] == 'trusted'
    assert config['projects'][str(project)]['trust_level'] == 'trusted'
    assert run('codex', '--cd=' + str(nested))['args'] == ['--cd=' + str(nested)]
    assert run('claude-with-skills')['account'] == env['CLAUDE_CONFIG_DIR']
    claude = json.loads((root / 'claude-account/.claude.json').read_text())
    assert claude['projects'][str(project)]['hasTrustDialogAccepted'] is True
    run('gemini')
    assert json.loads((root / 'gemini-trust.json').read_text())[str(project)] == 'TRUST_FOLDER'
    # A native installer may replace the entry. Reinstalling retains that update.
    (binaries / 'codex').write_text(stub.replace('"version":1', '"version":2'))
    installer.install(runtime, binaries)
    assert run('codex', '--version')['version'] == 2
    assert (binaries / 'claude-with-skills.before-q-agent-trust').is_file()
print('PASS: CLI arguments, directory overrides, repository roots, account isolation, metadata commands, reinstall and updated native launchers.')
