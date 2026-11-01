package session

// Test identities, timestamps and messages below are synthetic fixtures.
import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStableIdleSendHookProof(t *testing.T) {
	now := time.Unix(1793534400, 0)
	for _, tc := range []struct {
		name   string
		change func(*string, *string, *time.Time, *HookStatus)
		want   bool
	}{
		{"claude completion", func(*string, *string, *time.Time, *HookStatus) {}, true},
		{"unknown start", func(_ *string, _ *string, start *time.Time, _ *HookStatus) { *start = time.Time{} }, false},
		{"recent start", func(_ *string, _ *string, start *time.Time, _ *HookStatus) { *start = now.Add(-time.Minute) }, false},
		{"future start", func(_ *string, _ *string, start *time.Time, _ *HookStatus) { *start = now.Add(time.Minute) }, false},
		{"unknown native identity", func(_ *string, id *string, _ *time.Time, _ *HookStatus) { *id = "" }, false},
		{"foreign native identity", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.SessionID = "foreign" }, false},
		{"running", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.Status = "running" }, false},
		{"permission", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.Event = "PermissionRequest" }, false},
		{"startup event", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.Event = "SessionStart" }, false},
		{"unsettled completion", func(_ *string, _ *string, _ *time.Time, h *HookStatus) {
			h.UpdatedAt = now.Add(-500 * time.Millisecond)
		}, false},
		{"future completion", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.UpdatedAt = now.Add(time.Second) }, false},
		{"expired completion", func(_ *string, _ *string, _ *time.Time, h *HookStatus) { h.UpdatedAt = now.Add(-hookFastPathWindow) }, false},
		{"previous launch", func(_ *string, _ *string, start *time.Time, h *HookStatus) { h.UpdatedAt = start.Add(-time.Second) }, false},
		{"other harness", func(tool *string, _ *string, _ *time.Time, _ *HookStatus) { *tool = "gemini" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tool, id, started := "claude", "native-id", now.Add(-3*time.Minute)
			hook := HookStatus{Status: "waiting", Event: "Stop", SessionID: id, UpdatedAt: now.Add(-2 * time.Second)}
			tc.change(&tool, &id, &started, &hook)
			if got := stableIdleSendHook(tool, id, started, &hook, now); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
	if stableIdleSendHook("claude", "native-id", now.Add(-3*time.Minute), nil, now) {
		t.Fatal("missing hook authorized fast readiness")
	}
}

func TestStableIdleSendHookCodexGeneration(t *testing.T) {
	now := time.Unix(1793534400, 0)
	for _, tc := range []struct {
		name   string
		change func(*HookStatus)
		want   bool
	}{
		{"matching", func(*HookStatus) {}, true},
		{"missing start", func(h *HookStatus) { h.CodexStartedGeneration = "" }, false},
		{"different turn", func(h *HookStatus) { h.CodexCompletedGeneration = "turn-b" }, false},
		{"foreign start", func(h *HookStatus) { h.CodexStartedSessionID = "foreign" }, false},
		{"foreign completion", func(h *HookStatus) { h.CodexCompletedSessionID = "foreign" }, false},
		{"wrong event", func(h *HookStatus) { h.Event = "PermissionRequest" }, false},
		{"stale", func(h *HookStatus) { h.UpdatedAt = now.Add(-codexHookWaitingFastPathWindow) }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hook := HookStatus{Status: "waiting", Event: "agent-turn-complete", SessionID: "codex-id", UpdatedAt: now.Add(-2 * time.Second),
				CodexStartedGeneration: "turn-a", CodexCompletedGeneration: "turn-a", CodexStartedSessionID: "codex-id", CodexCompletedSessionID: "codex-id"}
			tc.change(&hook)
			if got := stableIdleSendHook("codex", "codex-id", now.Add(-3*time.Minute), &hook, now); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStableIdleSendHookReadsCurrentFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	now := time.Now().Truncate(time.Second)
	inst := &Instance{ID: "idle-send-hook", Tool: "claude", ClaudeSessionID: "native-id", LastStartedAt: now.Add(-3 * time.Minute)}
	filename := filepath.Join(GetHooksDir(), inst.ID+".json")
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(generation string) {
		t.Helper()
		body, err := json.Marshal(map[string]any{"status": "waiting", "event": "Stop", "session_id": inst.ClaudeSessionID, "ts": now.Add(-2 * time.Second).Unix(), "hook_generation": generation})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("")
	if !inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("valid completion rejected")
	}
	inst.SSHHost = "fixture-remote"
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("remote session qualified")
	}
	inst.SSHHost = ""
	inst.Sandbox = &SandboxConfig{Enabled: true}
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("sandbox session qualified")
	}
	inst.Sandbox = nil
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("missing file reused previous proof")
	}
	if err := os.WriteFile(filename, []byte("invalid json"), 0600); err != nil {
		t.Fatal(err)
	}
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("unreadable file qualified")
	}
	write("old-generation")
	control := filepath.Join(GetHooksDir(), inst.ID+".generation.json")
	if err := os.WriteFile(control, []byte(`{"generation":"current-generation"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("previous hook generation qualified")
	}
	write("current-generation")
	if !inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("current hook generation rejected")
	}
	release, err := acquireInstanceSpawnLock(inst.ID)
	if err != nil {
		t.Fatal(err)
	}
	blocked := inst.HasStableIdleSendHook(now, nil)
	release()
	if blocked {
		t.Fatal("spawn in progress reused old completion")
	}
	MarkInstanceSpawnedForTest(inst.ID, now.Add(-time.Second))
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("recent respawn reused stale registry start time")
	}
	MarkInstanceSpawnedForTest(inst.ID, now.Add(-3*time.Minute))
	if !inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("established spawn rejected")
	}
}
