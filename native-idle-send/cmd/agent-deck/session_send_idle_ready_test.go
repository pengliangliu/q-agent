package main

// Test identities, timestamps and messages below are synthetic fixtures.
import (
	"errors"
	"testing"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

func TestFastQueuedReadyScope(t *testing.T) {
	for _, tc := range []struct {
		name            string
		worker, guarded bool
		inst            *session.Instance
	}{
		{"ordinary send", false, true, &session.Instance{Tool: "claude"}},
		{"unguarded", true, false, &session.Instance{Tool: "claude"}},
		{"remote", true, true, &session.Instance{Tool: "claude", SSHHost: "remote"}},
		{"sandbox", true, true, &session.Instance{Tool: "claude", Sandbox: &session.SandboxConfig{Enabled: true}}},
		{"other tool", true, true, &session.Instance{Tool: "gemini"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pane := &mockSendRetryTarget{panes: []string{claudeComposer("")}}
			if fastQueuedReady("", tc.inst, pane, tc.worker, tc.guarded, nil) || pane.paneIdx.Load() != 0 {
				t.Fatal("out-of-scope send entered fast readiness")
			}
		})
	}
}

func TestFastQueuedReadyGenerationFence(t *testing.T) {
	for _, tc := range []struct {
		name     string
		pids     []int
		errs     []error
		registry bool
		want     bool
	}{
		{"unchanged", []int{100, 100}, nil, true, true},
		{"respawn during probes", []int{100, 101}, nil, true, false},
		{"registry changed during probes", []int{100, 100}, nil, false, false},
		{"missing pane", []int{0, 0}, nil, true, false},
		{"initial pid failed", []int{100, 100}, []error{errors.New("unavailable"), nil}, true, false},
		{"final pid failed", []int{100, 100}, []error{nil, errors.New("unavailable")}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			got := confirmIdleSendGeneration(func() bool { return true }, func() (int, error) {
				i := calls
				calls++
				var err error
				if len(tc.errs) > i {
					err = tc.errs[i]
				}
				return tc.pids[i], err
			}, func() bool { return tc.registry })
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFastQueuedReadyRegistryIdentity(t *testing.T) {
	makeInstance := func() *session.Instance {
		i := &session.Instance{ID: "fixture-id", Tool: "claude", ClaudeSessionID: "native-id", LastStartedAt: time.Unix(1793534400, 0)}
		i.SetTmuxSessionForTest(&tmux.Session{Name: "fixture-pane", SocketName: "fixture-socket"})
		return i
	}
	before := makeInstance()
	if !sameIdleSendTarget(before, makeInstance()) {
		t.Fatal("unchanged registry identity rejected")
	}
	for _, tc := range []struct {
		name   string
		change func(*session.Instance)
	}{
		{"restart", func(i *session.Instance) { i.LastStartedAt = i.LastStartedAt.Add(time.Second) }},
		{"native rebind", func(i *session.Instance) { i.ClaudeSessionID = "different-native" }},
		{"harness switch", func(i *session.Instance) { i.Tool = "codex" }},
		{"different tmux", func(i *session.Instance) {
			i.SetTmuxSessionForTest(&tmux.Session{Name: "other-pane", SocketName: "fixture-socket"})
		}},
		{"different socket", func(i *session.Instance) {
			i.SetTmuxSessionForTest(&tmux.Session{Name: "fixture-pane", SocketName: "other-socket"})
		}},
		{"missing tmux", func(i *session.Instance) { i.SetTmuxSessionForTest(nil) }},
		{"remote", func(i *session.Instance) { i.SSHHost = "remote" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := makeInstance()
			tc.change(current)
			if sameIdleSendTarget(before, current) {
				t.Fatal("changed registry identity qualified")
			}
		})
	}
}

func TestStableIdleComposerChecks(t *testing.T) {
	for _, tc := range []struct {
		name, tool string
		panes      []string
		errs       []error
		want       bool
	}{
		{"claude empty", "claude", []string{claudeComposer("")}, nil, true},
		{"claude suggestion", "claude", []string{claudeComposer("\x1b[2mrun the tests\x1b[0m")}, nil, true},
		{"claude draft", "claude", []string{claudeComposer("my unsent draft")}, nil, false},
		{"claude busy", "claude", []string{claudeComposer("") + "esc to interrupt\n"}, nil, false},
		{"menu during confirmation", "claude", []string{claudeComposer(""), guardedMenu}, nil, false},
		{"startup", "claude", []string{"Starting Claude…"}, nil, false},
		{"capture failed", "claude", []string{claudeComposer("")}, []error{errors.New("capture unavailable")}, false},
		{"codex empty", "codex", []string{"› Ask Codex to do anything\n  gpt-5 high · 100% context left"}, nil, true},
		{"codex draft", "codex", []string{"› my unsent draft\n  gpt-5 high · 100% context left"}, nil, false},
		{"codex busy", "codex", []string{"• Working (1s • esc to interrupt)\n› Ask Codex to do anything\n  gpt-5 high · 100% context left"}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pane := &mockSendRetryTarget{panes: tc.panes, paneErrs: tc.errs}
			var waited time.Duration
			got := confirmStableIdleComposer(pane, tc.tool, func() bool { return true }, func(d time.Duration) { waited += d })
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			if got && (pane.paneIdx.Load() != 3 || waited != 200*time.Millisecond) {
				t.Fatalf("captures=%d wait=%v", pane.paneIdx.Load(), waited)
			}
			if pane.sendKeysCalls+pane.sendEnterCalls+pane.sendChunkedCalls+pane.sendCtrlCCalls != 0 {
				t.Fatal("readiness check sent keys")
			}
		})
	}
}

func TestStableIdleComposerHookChanges(t *testing.T) {
	for failAt := 1; failAt <= 4; failAt++ {
		pane := &mockSendRetryTarget{panes: []string{claudeComposer("")}}
		calls := 0
		got := confirmStableIdleComposer(pane, "claude", func() bool { calls++; return calls != failAt }, func(time.Duration) {})
		if got {
			t.Fatalf("hook change at check %d was ignored", failAt)
		}
	}
}

func TestFastQueuedReadyKeepsSendGuard(t *testing.T) {
	pane := &mockSendRetryTarget{panes: []string{claudeComposer(""), claudeComposer(""), claudeComposer(""), guardedMenu}}
	if !confirmStableIdleComposer(pane, "claude", func() bool { return true }, func(time.Duration) {}) {
		t.Fatal("idle checks failed")
	}
	tun := testGuardTuning(sendRetryOptions{maxRetries: 1, checkDelay: 0, verifyDelivery: true})
	tun.requireInputPrompt = true
	result, err := executeSend(pane, "claude", "fixture message", false, tun)
	if err == nil || result.delivery != deliveryMenuOpen || pane.sendKeysCalls+pane.sendEnterCalls+pane.sendChunkedCalls+pane.sendCtrlCCalls != 0 {
		t.Fatalf("menu after readiness was not protected: delivery=%s error=%v", result.delivery, err)
	}
}

func TestStableIdleReadyTiming(t *testing.T) {
	pane := &mockSendRetryTarget{statuses: []string{"waiting"}, panes: []string{claudeComposer("")}}
	start := time.Now()
	if err := send.WaitForAgentReady(pane, "claude", 5*time.Second, send.PromptGates{ClaudeComposer: true}); err != nil {
		t.Fatal(err)
	}
	baseline := time.Since(start)
	start = time.Now()
	if !confirmStableIdleComposer(pane, "claude", func() bool { return true }, time.Sleep) {
		t.Fatal("fast readiness failed")
	}
	fast := time.Since(start)
	t.Logf("idle readiness only: original=%v guarded_fast=%v", baseline, fast)
	if fast >= baseline {
		t.Fatal("stable-idle readiness did not improve")
	}
}
