# WSL bootstrap sources

The setup wizard downloads dependencies from the publishers; none of these binaries,
login credentials, API keys, or conversation data are bundled in Q-agent.
Existing Claude/Codex installations are reused. Existing Agent Deck must match the
bridge's supported version; existing Node must be version 22 or newer.

Pinned releases checked on 2026-11-01:

| Component | Release | Integrity source |
| --- | --- | --- |
| Agent Deck | 1.16.35, Linux amd64 | [Official release checksums](https://github.com/asheshgoplani/agent-deck/releases/download/v1.16.35/checksums.txt); SHA256 `369990183649b5016d9d542efb5179a3405fa26ff24ed31aed6a4edcb2f6cdb9` |
| Node.js | 22.23.4 LTS, Linux x64 | [Official SHA256 list](https://nodejs.org/dist/v22.23.4/SHASUMS256.txt); SHA256 `1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce` |
| Claude Code | 2.1.316, Linux x64 | [Official signed manifest](https://downloads.claude.ai/claude-code-releases/2.1.316/manifest.json); SHA256 `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824` |
| Codex CLI | 0.163.0 | [Official npm package metadata](https://registry.npmjs.org/@openai/codex/0.163.0); npm verifies package integrity, optional platform dependency included |

Claude's detached manifest signature is checked in a temporary keyring against
the [official signing key](https://downloads.claude.ai/keys/claude-code.asc),
fingerprint `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`, before the binary is installed.
See [Claude installation and integrity documentation](https://code.claude.com/docs/en/setup)
and [Codex installation documentation](https://github.com/openai/codex#installing-and-running-codex-cli).

The shell entry point has four explicit phases:

- `system`: root; install Ubuntu/Debian packages with apt. Does not enable systemd.
- `configure-systemd`: root; back up and merge only `[boot] systemd=true` in `/etc/wsl.conf`.
  Returns `restart_required`. The Windows wizard handles the user's restart choice;
  this script never terminates a distribution.
- `user [--claude] [--codex]`: normal Linux user; install missing components below
  `~/.local/share/q-agent/runtime` and add launchers in `~/.local/bin`. Never overwrite
  an incompatible existing launcher. Does not log in to any provider.
- `check`: normal Linux user; read-only JSON status containing command paths,
  version numbers, systemd and the user bus status. Exit 1 means prerequisites are incomplete.

The Windows caller must run under the selected distribution and normal user,
prepend `~/.local/bin` when invoking later install/login steps, and run the first
two phases as root only after the corresponding setup action is selected.
For systemd requirements, see [Microsoft's WSL systemd guide](https://learn.microsoft.com/en-us/windows/wsl/systemd).
