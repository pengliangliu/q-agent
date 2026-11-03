#!/usr/bin/env bash
# Run from Windows with: wsl.exe -d DISTRO [-u root] -- bash /path/bootstrap-wsl.sh PHASE
set -euo pipefail
phase="${1:-}"
if [[ "$phase" == "system" ]]; then
    [[ $# == 1 ]] || { echo 'system does not accept arguments.' >&2; exit 2; }
    [[ $EUID == 0 ]] || { echo 'Run the system phase as root.' >&2; exit 1; }
    [[ -n "${WSL_DISTRO_NAME:-}" ]] || { echo 'Run this installer inside WSL.' >&2; exit 1; }
    [[ "$(uname -m)" == x86_64 ]] || { echo 'This release supports Linux x64 only.' >&2; exit 1; }
    command -v apt-get >/dev/null || { echo 'Automatic setup supports Ubuntu or Debian with apt-get.' >&2; exit 1; }
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=120 update
    apt-get -o DPkg::Lock::Timeout=120 install -y --no-upgrade --no-install-recommends \
        python3 python3-tomli tmux curl ca-certificates git xz-utils systemd dbus-user-session gnupg libstdc++6
    printf '%s\n' '{"ok":true,"phase":"system"}'
elif [[ "$phase" == "configure-systemd" || "$phase" == "user" || "$phase" == "check" ]]; then
    command -v python3 >/dev/null || { echo 'Install system dependencies first.' >&2; exit 1; }
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
    exec python3 "$script_dir/bootstrap-wsl.py" "$@"
else
    echo 'Usage: bootstrap-wsl.sh system | configure-systemd | user [--claude] [--codex] | check' >&2
    exit 2
fi
