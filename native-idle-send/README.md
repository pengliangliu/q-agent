# Optional guarded idle sender

This patch targets **Agent Deck v1.16.35** and its **Go 1.26.10** toolchain. It builds a separate executable for the desktop bridge's queued sends and receipt recovery. The official `agent-deck` executable remains unchanged. Other releases require a new source review and build; these scripts refuse a different release.

Established local Claude/Codex sessions can replace the generic readiness delay with three fresh composer checks, spaced 100 ms apart. The fast path requires an empty composer, matching native identity and completion evidence, no active startup, and unchanged pane process and registry identity. An expired completion hook needs a bounded read of the latest exact native turn. Unknown state, menus, drafts, running turns and restarts retain the original wait. The normal input guards and at-most-once queue receipts still run after this check.

## Apply and build

Use a clean source checkout of the official tag. Keep the source checkout separate from this repository. Run the following in WSL/Linux; replace `/path/to/...` with your local directories:

```sh
git clone --depth 1 --branch v1.16.35 https://github.com/asheshgoplani/agent-deck.git /path/to/agent-deck-source
python3 native-idle-send/apply.py /path/to/agent-deck-source --check
python3 native-idle-send/apply.py /path/to/agent-deck-source
python3 native-idle-send/apply.py /path/to/agent-deck-source --verify
python3 native-idle-send/manage.py build /path/to/agent-deck-source --base-cli "$HOME/.local/bin/agent-deck"
```

Application preflights every target before writing, preserves unrelated source edits, and is idempotent. An existing helper with different contents or an unexpected call site stops the operation. `readiness-callsite.patch` contains only the upstream call-site change; the six helper/test files are copied separately by `apply.py`.

Builds may download the official Go toolchain and modules through Go's normal mechanism. `--go` selects an existing Go executable. `--output` selects a separate build destination. The default is `native-idle-send/build/agent-deck-idle-send`; the adjacent `.build.json` records versions and hashes without local paths. `-trimpath` excludes source checkout paths from the Go build.

## Verification

Follow the upstream checkout's `AGENTS.md`: **run Go tests only inside an isolated container**. Do not mount a real agent configuration, authentication directory, HOME or tmux socket into the test container. Do not set `AGENTDECK_TEST_CONTAINER=1` on a host as a substitute for isolation. The new fixtures are synthetic and make no model requests.

Inside that container, after applying the patch, run the relevant checks:

```sh
go test ./internal/session ./cmd/agent-deck \
  -run '^(TestStableIdleSendHook|TestIdleSend|TestFastQueuedReady|TestStableIdleComposer|TestStableIdleReadyTiming|TestPromptGuard|TestGuardedSendKeepsOrdinaryDeliveryEvidence)' \
  -count=1
```

The timing check covers readiness only; it does not measure actual message delivery or model response time.

## Install

Install the desktop bridge first, then run:

```sh
python3 native-idle-send/manage.py install native-idle-send/build/agent-deck-idle-send \
  --base-cli "$HOME/.local/bin/agent-deck"
```

The installer verifies the build receipt, patch bundle and current official CLI. It backs up an existing optional helper, installs atomically, and writes the bridge's `agent-deck-idle-send.json` manifest. It does not restart services, model sessions or queue workers. If the bridge uses a non-default installation directory or official CLI, supply the same values with `--install-dir` and `--base-cli`.

The bridge checks the official CLI and helper metadata before selecting this executable. An official CLI upgrade, missing helper or changed manifest falls back to the official send path. To disable this optional feature, move its manifest out of the bridge directory; do not delete or replace the official CLI.

## Source and license

This is an extension to [Agent Deck](https://github.com/asheshgoplani/agent-deck/tree/v1.16.35), not an upstream release. Preserve the upstream project's license and attribution when distributing modified source or binaries; see this repository's license and third-party notices. No production transcripts, accounts, credentials, runtime reports or installed binaries are included here.
