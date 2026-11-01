#!/usr/bin/env python3
"""WSL prerequisite setup. Each phase is explicit; credentials are never imported."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

# Official versioned releases, checked 2026-11-01. See bootstrap-sources.md.
DECK_VERSION = "1.16.35"
DECK_URL = "https://github.com/asheshgoplani/agent-deck/releases/download/v1.16.35/agent-deck_1.16.35_linux_amd64.tar.gz"
DECK_SHA256 = "369990183649b5016d9d542efb5179a3405fa26ff24ed31aed6a4edcb2f6cdb9"
NODE_VERSION = "v22.23.4"
NODE_URL = "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz"
NODE_SHA256 = "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"
CLAUDE_VERSION = "2.1.316"
CLAUDE_REPO = "https://downloads.claude.ai/claude-code-releases/2.1.316"
CLAUDE_SHA256 = "fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824"
CLAUDE_KEY = "https://downloads.claude.ai/keys/claude-code.asc"
CLAUDE_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"
CODEX_VERSION = "0.163.0"


def fail(message):
    raise RuntimeError(message)


def run(args, **kwargs):
    # Do not echo commands/environment: callers may have unrelated credentials.
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=kwargs.pop("timeout", 30), **kwargs)
    if result.returncode:
        fail(f"{Path(args[0]).name} failed (exit {result.returncode}). Check its installation and retry.")
    return result.stdout.strip()


def version(binary, name):
    output = run([str(binary), "version" if name == "agent-deck" else "--version"])
    # Report version numbers only; never copy arbitrary command output into logs.
    pattern = r"Agent Deck v(\d+\.\d+\.\d+)" if name == "agent-deck" else r"(?:^|\s)v?(\d+\.\d+\.\d+)\b"
    match = re.search(pattern, output)
    if not match:
        fail(f"Cannot identify the installed {name} version.")
    return match.group(1)


def find_binary(name):
    local = Path.home() / ".local/bin" / name
    # Include user installs even before a fresh login has added .local/bin to PATH.
    if local.exists() or local.is_symlink():
        if not local.is_file() or not os.access(local, os.X_OK):
            fail(f"Existing ~/.local/bin/{name} is not executable. Resolve this conflict first.")
        return local
    found = shutil.which(name)
    return Path(found) if found else None


def require_wsl(root=False):
    if platform.system() != "Linux" or not os.environ.get("WSL_DISTRO_NAME"):
        fail("Run this installer inside the intended WSL distribution.")
    if platform.machine() != "x86_64":
        fail("This installer release supports Linux x64 only.")
    if root and os.geteuid() != 0:
        fail("Run configure-systemd as root.")
    if not root and os.geteuid() == 0:
        fail("Select a normal Linux user before running user setup or check.")


def download(url, target, sha256=None):
    request = urllib.request.Request(url, headers={"User-Agent": "Q-agent-setup/1.0"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=60) as response, target.open("xb") as out:
        if not response.url.startswith("https://"):
            fail("Refusing a download redirected away from HTTPS.")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            out.write(chunk)
    if sha256 and digest.hexdigest() != sha256:
        fail("Download checksum does not match the official release. Nothing was installed.")


def unpack_node(archive, destination):
    # Node contains relative npm/npx symlinks. Permit only links within the archive root.
    root = f"node-{NODE_VERSION}-linux-x64"
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != root or ".." in parts or member.name.startswith("/"):
                fail("Unsafe Node archive path.")
            if not (member.isfile() or member.isdir() or member.issym()):
                fail("Unsupported Node archive entry.")
            if member.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                if member.linkname.startswith("/") or not target.startswith(root + "/"):
                    fail("Unsafe Node archive link.")
        tar.extractall(destination, members=members)
    return destination / root


def link_new(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        if target.resolve() == source.resolve():
            return
        fail(f"Existing {target.name} launcher was preserved. Resolve the conflict and retry.")
    target.symlink_to(source)


def install_deck(runtime, bindir):
    dest = runtime / f"agent-deck-{DECK_VERSION}"
    if not dest.exists():
        with tempfile.TemporaryDirectory(prefix="deck-", dir=runtime) as tmp:
            stage = Path(tmp)
            archive = stage / "download.tar.gz"
            download(DECK_URL, archive, DECK_SHA256)
            with tarfile.open(archive) as tar:
                members = [m for m in tar.getmembers() if m.name == "agent-deck" and m.isfile()]
                if len(members) != 1:
                    fail("The Agent Deck release does not contain its expected executable.")
                with tar.extractfile(members[0]) as src, (stage / "agent-deck").open("xb") as out:
                    shutil.copyfileobj(src, out)
            binary = stage / "agent-deck"
            binary.chmod(0o755)
            if version(binary, "agent-deck") != DECK_VERSION:
                fail("Agent Deck release version did not match.")
            dest.mkdir()
            binary.rename(dest / "agent-deck")
    if version(dest / "agent-deck", "agent-deck") != DECK_VERSION:
        fail("Existing Q-agent runtime contains a different Agent Deck. It was preserved.")
    link_new(dest / "agent-deck", bindir / "agent-deck")


def install_node(runtime, bindir):
    dest = runtime / f"node-{NODE_VERSION}-linux-x64"
    if not dest.exists():
        with tempfile.TemporaryDirectory(prefix="node-", dir=runtime) as tmp:
            stage = Path(tmp)
            archive = stage / "download.tar.xz"
            download(NODE_URL, archive, NODE_SHA256)
            unpacked = unpack_node(archive, stage)
            if version(unpacked / "bin/node", "node") != NODE_VERSION[1:]:
                fail("Node release version did not match.")
            unpacked.rename(dest)
    if version(dest / "bin/node", "node") != NODE_VERSION[1:]:
        fail("Existing Q-agent Node runtime is incompatible. It was preserved.")
    for name in ("node", "npm", "npx"):
        link_new(dest / "bin" / name, bindir / name)


def install_claude(runtime, bindir):
    dest = runtime / f"claude-{CLAUDE_VERSION}"
    if not dest.exists():
        with tempfile.TemporaryDirectory(prefix="claude-", dir=runtime) as tmp:
            stage = Path(tmp)
            for url, filename in ((CLAUDE_KEY, "key.asc"), (CLAUDE_REPO + "/manifest.json", "manifest.json"),
                                  (CLAUDE_REPO + "/manifest.json.sig", "manifest.json.sig")):
                download(url, stage / filename)
            keyring = stage / "gnupg"
            keyring.mkdir(mode=0o700)
            gpg = ["gpg", "--batch", "--no-options", "--homedir", str(keyring)]
            keys = run(gpg + ["--with-colons", "--show-keys", str(stage / "key.asc")])
            fingerprints = [line.split(":")[9] for line in keys.splitlines() if line.startswith("fpr:")]
            if not fingerprints or fingerprints[0] != CLAUDE_FINGERPRINT:
                fail("Claude release signing key fingerprint does not match.")
            run(gpg + ["--import", str(stage / "key.asc")])
            run(gpg + ["--verify", str(stage / "manifest.json.sig"), str(stage / "manifest.json")])
            manifest = json.loads((stage / "manifest.json").read_text())
            release = manifest["platforms"]["linux-x64"]
            if manifest["version"] != CLAUDE_VERSION or release["checksum"] != CLAUDE_SHA256:
                fail("Claude signed manifest does not match the pinned release.")
            binary = stage / "claude"
            download(CLAUDE_REPO + "/linux-x64/claude", binary, CLAUDE_SHA256)
            binary.chmod(0o755)
            if version(binary, "claude") != CLAUDE_VERSION:
                fail("Claude release version did not match.")
            dest.mkdir()
            binary.rename(dest / "claude")
    if version(dest / "claude", "claude") != CLAUDE_VERSION:
        fail("Existing Q-agent Claude runtime is incompatible. It was preserved.")
    link_new(dest / "claude", bindir / "claude")


def install_codex(runtime, bindir, node):
    npm = find_binary("npm")
    if not npm:
        fail("npm is missing from the existing Node installation. Install npm, then retry Codex setup.")
    prefix = runtime / f"codex-{CODEX_VERSION}"
    binary = prefix / "bin/codex"
    env = os.environ.copy()
    env["PATH"] = str(Path(node).parent) + ":" + str(bindir) + ":" + env.get("PATH", "")
    if not binary.exists():
        # Dedicated prefix and temporary empty npm configs avoid reading personal registry tokens.
        with tempfile.TemporaryDirectory(prefix="codex-", dir=runtime) as tmp:
            stage = Path(tmp)
            config = stage / "npmrc"
            config.touch()
            for key in list(env):
                if key.lower().startswith("npm_config_") or key in {"NPM_TOKEN", "NODE_AUTH_TOKEN"}:
                    del env[key]
            env["NPM_CONFIG_USERCONFIG"] = str(config)
            env["NPM_CONFIG_GLOBALCONFIG"] = str(config)
            run([str(npm), "install", "--global", "--prefix", str(stage / "prefix"),
                 "--registry=https://registry.npmjs.org", "--ignore-scripts", "--no-audit", "--no-fund",
                 f"@openai/codex@{CODEX_VERSION}"], env=env, cwd=tmp, timeout=600)
            installed = stage / "prefix/bin/codex"
            if run([str(installed), "--version"], env=env) != "codex-cli " + CODEX_VERSION:
                fail("Codex package version did not match.")
            if prefix.exists():
                fail("An incomplete Codex runtime already exists. It was preserved.")
            (stage / "prefix").rename(prefix)
    if version(binary, "codex") != CODEX_VERSION:
        fail("Existing Q-agent Codex runtime is incompatible. It was preserved.")
    link_new(binary, bindir / "codex")


def systemd_config(text):
    lines = text.splitlines(keepends=True)
    boot = False
    saw_boot = False
    found = False
    result = []
    for line in lines:
        section = re.match(r"\s*\[([^]]+)\]\s*(?:[#;].*)?$", line.strip())
        if section:
            if boot and not found:
                result.append("systemd=true\n")
                found = True
            boot = section.group(1).lower() == "boot"
            saw_boot |= boot
        if boot and re.match(r"\s*systemd\s*=", line, re.I):
            if not found:
                result.append("systemd=true\n")
                found = True
            continue
        result.append(line if line.endswith("\n") else line + "\n")
    if not saw_boot:
        result.append("\n[boot]\nsystemd=true\n")
    elif not found:
        result.append("systemd=true\n")
    return "".join(result)


def configure_systemd():
    require_wsl(root=True)
    config = Path("/etc/wsl.conf")
    if config.is_symlink():
        fail("/etc/wsl.conf is a symbolic link. Configure systemd manually to preserve its target.")
    before = config.read_text() if config.exists() else ""
    after = systemd_config(before)
    changed = before != after
    if changed:
        if config.exists():
            shutil.copy2(config, config.with_name("wsl.conf.q-agent-" + str(time.time_ns()) + ".bak"))
        descriptor, temp = tempfile.mkstemp(prefix=".wsl-q-agent-", dir="/etc")
        try:
            with os.fdopen(descriptor, "w") as out:
                out.write(after)
            os.chmod(temp, config.stat().st_mode & 0o777 if config.exists() else 0o644)
            os.replace(temp, config)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    return {"ok": True, "phase": "configure-systemd", "changed": changed,
            "restart_required": changed or Path("/proc/1/comm").read_text().strip() != "systemd"}


def inspect():
    require_wsl()
    commands = {}
    for name in ("agent-deck", "node", "npm", "claude", "codex", "tmux", "git"):
        try:
            binary = find_binary(name)
            value = version(binary, name) if binary and name not in ("tmux", "git") else None
            compatible = bool(binary)
            if name == "agent-deck":
                compatible = value == DECK_VERSION
            if name == "node":
                compatible = bool(value) and int(value.split(".")[0]) >= 22
            commands[name] = {"path": str(binary) if binary else None, "version": value, "ok": compatible}
        except RuntimeError as error:
            commands[name] = {"ok": False, "error": str(error)}
    systemd = Path("/proc/1/comm").read_text().strip() == "systemd"
    user_bus = subprocess.run(["systemctl", "--user", "show-environment"], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode == 0 if shutil.which("systemctl") else False
    ready = systemd and user_bus and all(commands[name]["ok"] for name in ("agent-deck", "node", "tmux", "git"))
    return {"ok": ready, "phase": "check", "systemd": systemd, "user_bus": user_bus, "commands": commands}


def install_user(args):
    require_wsl()
    existing = {name: find_binary(name) for name in ("agent-deck", "node", "claude", "codex")}
    # Detect conflicts before downloading or changing any user launchers.
    if existing["agent-deck"] and version(existing["agent-deck"], "agent-deck") != DECK_VERSION:
        fail("Existing Agent Deck is not v1.16.35. It was preserved; select a clean WSL environment or resolve its version first.")
    if existing["node"] and int(version(existing["node"], "node").split(".")[0]) < 22:
        fail("Existing Node is older than 22. It was preserved; upgrade Node or select a clean WSL environment.")
    runtime = Path.home() / ".local/share/q-agent/runtime"
    bindir = Path.home() / ".local/bin"
    if not existing["node"]:
        for name in ("npm", "npx"):
            if (bindir / name).exists() or (bindir / name).is_symlink():
                fail(f"Existing {name} launcher was preserved. Resolve its conflict before installing Node.")
    runtime.mkdir(parents=True, exist_ok=True)
    if not existing["agent-deck"]:
        print("Installing Agent Deck v" + DECK_VERSION, flush=True)
        install_deck(runtime, bindir)
    if not existing["node"]:
        print("Installing Node " + NODE_VERSION, flush=True)
        install_node(runtime, bindir)
    os.environ["PATH"] = str(bindir) + ":" + os.environ.get("PATH", "")
    if args.claude and not existing["claude"]:
        print("Installing Claude Code " + CLAUDE_VERSION, flush=True)
        install_claude(runtime, bindir)
    if args.codex and not existing["codex"]:
        print("Installing Codex CLI " + CODEX_VERSION, flush=True)
        install_codex(runtime, bindir, find_binary("node"))
    return {"ok": True, "phase": "user", "login_required": [name for name in ("claude", "codex")
            if getattr(args, name) and not existing[name]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    phases = parser.add_subparsers(dest="phase", required=True)
    phases.add_parser("configure-systemd")
    phases.add_parser("check")
    user = phases.add_parser("user")
    user.add_argument("--claude", action="store_true")
    user.add_argument("--codex", action="store_true")
    args = parser.parse_args()
    try:
        result = configure_systemd() if args.phase == "configure-systemd" else inspect() if args.phase == "check" else install_user(args)
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError, KeyError, tarfile.TarError) as error:
        # Keep network/error diagnostics concise; never dump environment or config data.
        message = str(error) if isinstance(error, RuntimeError) else f"{type(error).__name__}: setup could not complete; retry after checking prerequisites and network access."
        print(json.dumps({"ok": False, "phase": args.phase, "error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
