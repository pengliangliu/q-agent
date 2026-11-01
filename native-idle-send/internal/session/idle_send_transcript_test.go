package session

// Test identities, timestamps and messages below are synthetic fixtures.
import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIdleSendClaudeTailProof(t *testing.T) {
	started := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	complete := `{"type":"assistant","sessionId":"native-a","timestamp":"2026-11-01T10:01:00Z","message":{"content":[{"type":"text","text":"fixture"}],"stop_reason":"end_turn"}}`
	for _, tc := range []struct {
		name string
		tail string
		want bool
	}{
		{"final", complete, true},
		{"stop summary", `{"type":"system","subtype":"stop_hook_summary"}`, true},
		{"new user", `{"type":"user","message":{"content":"fixture"}}`, false},
		{"new tool result", `{"type":"user","message":{"content":[{"type":"tool_result"}]}}`, false},
		{"new meta input", `{"type":"user","isMeta":true}`, false},
		{"interim assistant", `{"type":"assistant","sessionId":"native-a","timestamp":"2026-11-01T10:02:00Z","message":{"content":[{"type":"text"}],"stop_reason":"tool_use"}}`, false},
		{"thinking stop", `{"type":"assistant","sessionId":"native-a","timestamp":"2026-11-01T10:02:00Z","message":{"content":[{"type":"thinking"}],"stop_reason":"end_turn"}}`, false},
		{"foreign identity", `{"type":"assistant","sessionId":"native-b","timestamp":"2026-11-01T10:02:00Z","message":{"content":[{"type":"text"}],"stop_reason":"end_turn"}}`, false},
		{"compaction", `{"type":"system","subtype":"compact_boundary"}`, false},
		{"damaged trailing record", `{"type":`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := claudeIdleSendTailComplete([]string{complete, tc.tail}, "native-a", started); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
	if claudeIdleSendTailComplete([]string{complete}, "native-a", started.Add(2*time.Minute)) {
		t.Fatal("previous launch transcript authorized fast readiness")
	}
}

func TestIdleSendCodexTailProof(t *testing.T) {
	started := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	start := `{"type":"event_msg","timestamp":"2026-11-01T10:00:10Z","payload":{"type":"task_started","turn_id":"a"}}`
	complete := `{"type":"event_msg","timestamp":"2026-11-01T10:01:00Z","payload":{"type":"task_complete","turn_id":"a"}}`
	for _, tc := range []struct {
		name       string
		lines      []string
		generation string
		want       bool
	}{
		{"completed latest turn", []string{start, complete}, "native:a", true},
		{"no start proof", []string{complete}, "native:a", false},
		{"different hook generation", []string{start, complete}, "native:b", false},
		{"new start", []string{start, complete, `{"type":"event_msg","payload":{"type":"task_started","turn_id":"b"}}`}, "native:a", false},
		{"new user", []string{start, complete, `{"type":"event_msg","payload":{"type":"user_message"}}`}, "native:a", false},
		{"new response item", []string{start, complete, `{"type":"response_item","payload":{"role":"user"}}`}, "native:a", false},
		{"aborted", []string{start, complete, `{"type":"event_msg","payload":{"type":"turn_aborted"}}`}, "native:a", false},
		{"damaged tail", []string{start, complete, `{"type":`}, "native:a", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := codexIdleSendTailComplete(tc.lines, "native", tc.generation, started); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIdleSendExpiredHookRequiresCurrentTranscript(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	config := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	now := time.Now().Truncate(time.Second)
	inst := &Instance{ID: "idle-expired", Tool: "claude", ProjectPath: t.TempDir(),
		ClaudeSessionID: "00000000-0000-4000-8000-000000000001", LastStartedAt: now.Add(-10 * time.Minute)}
	peers := []*Instance{inst}
	dir := filepath.Join(config, "projects", ConvertToClaudeDirName(inst.ProjectPath))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(dir, inst.ClaudeSessionID+".jsonl")
	final, _ := json.Marshal(map[string]any{"type": "assistant", "sessionId": inst.ClaudeSessionID,
		"timestamp": now.Add(-4 * time.Minute).Format(time.RFC3339Nano),
		"message":   map[string]any{"stop_reason": "end_turn", "content": []map[string]string{{"type": "text", "text": "fixture"}}}})
	if err := os.WriteFile(transcript, append(final, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(GetHooksDir(), 0700); err != nil {
		t.Fatal(err)
	}
	hookPath := filepath.Join(GetHooksDir(), inst.ID+".json")
	hook, _ := json.Marshal(map[string]any{"status": "waiting", "event": "Stop", "session_id": inst.ClaudeSessionID, "ts": now.Add(-3 * time.Minute).Unix()})
	if err := os.WriteFile(hookPath, hook, 0600); err != nil {
		t.Fatal(err)
	}
	if !inst.HasStableIdleSendHook(now, peers) {
		t.Fatal("verified long-idle completion rejected")
	}
	if inst.HasStableIdleSendHook(now, nil) {
		t.Fatal("missing peer identity check accepted")
	}
	if err := os.WriteFile(transcript, append(append(final, '\n'), []byte(`{"type":"user"}`)...), 0600); err != nil {
		t.Fatal(err)
	}
	if inst.HasStableIdleSendHook(now, peers) {
		t.Fatal("new user input reused old completion")
	}
	if err := os.WriteFile(transcript, append(final, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(hookPath); err != nil {
		t.Fatal(err)
	}
	if inst.HasStableIdleSendHook(now, peers) {
		t.Fatal("transcript bypassed missing hook")
	}
}
