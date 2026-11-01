package main

import (
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

// fastQueuedReady only replaces the generic readiness dwell for established,
// guarded local chat deliveries. It sends no keys and grants no input authority.
func fastQueuedReady(profile string, inst *session.Instance, target send.ComposerGuardTarget, queueWorker, requireInputPrompt bool, peers []*session.Instance) bool {
	if !queueWorker || !requireInputPrompt || inst == nil || inst.IsSSH() || inst.IsSandboxed() ||
		(!session.IsClaudeCompatible(inst.Tool) && !session.IsCodexCompatible(inst.Tool)) {
		return false
	}
	pidTarget, ok := target.(interface{ PrimaryPanePID() (int, error) })
	if !ok {
		return false
	}
	return confirmIdleSendGeneration(func() bool {
		return confirmStableIdleComposer(target, inst.Tool, func() bool {
			return inst.HasStableIdleSendHook(time.Now(), peers)
		}, time.Sleep)
	}, pidTarget.PrimaryPanePID, func() bool {
		storage, currentPeers, _, err := loadSessionData(profile)
		if err != nil {
			return false
		}
		defer func() { _ = storage.Close() }()
		current := instanceByID(currentPeers, inst.ID)
		return sameIdleSendTarget(inst, current) && current.HasStableIdleSendHook(time.Now(), currentPeers)
	})
}

// A restart can preserve both the native conversation ID and its old final reply.
// Fence the short probes with the live pane PID and a newly loaded registry row.
func confirmIdleSendGeneration(probe func() bool, panePID func() (int, error), registryUnchanged func() bool) bool {
	before, err := panePID()
	if err != nil || before <= 0 || !probe() || !registryUnchanged() {
		return false
	}
	after, err := panePID()
	return err == nil && after == before
}

func sameIdleSendTarget(before, current *session.Instance) bool {
	if before == nil || current == nil || current.IsArchived() || current.IsSSH() || current.IsSandboxed() ||
		before.ID != current.ID || before.Tool != current.Tool || !before.LastStartedAt.Equal(current.LastStartedAt) {
		return false
	}
	if session.IsClaudeCompatible(before.Tool) && before.ClaudeSessionID != current.ClaudeSessionID ||
		session.IsCodexCompatible(before.Tool) && before.CodexSessionID != current.CodexSessionID {
		return false
	}
	a, b := before.GetTmuxSession(), current.GetTmuxSession()
	return a != nil && b != nil && a.TmuxName() == b.TmuxName() && a.SocketName == b.SocketName
}

func confirmStableIdleComposer(target send.ComposerGuardTarget, tool string, idleHook func() bool, sleep func(time.Duration)) bool {
	for check := 0; check < 3; check++ {
		if check > 0 {
			sleep(100 * time.Millisecond)
		}
		if !idleHook() {
			return false
		}
		raw, err := target.CapturePaneFresh()
		if err != nil {
			return false
		}
		content := tmux.StripANSI(raw)
		if session.InteractiveMenuOpen(tool, content) {
			return false
		}
		if session.IsClaudeCompatible(tool) {
			if !send.ClaudeComposerReady(raw).Ready {
				return false
			}
		} else {
			draft, visible := send.CodexComposerDraft(raw, tmux.StripANSI)
			if !visible || draft != "" || !tmux.NewPromptDetector("codex").HasPrompt(content) {
				return false
			}
		}
	}
	// A new prompt/turn hook arriving during the last capture revokes the shortcut.
	return idleHook()
}
