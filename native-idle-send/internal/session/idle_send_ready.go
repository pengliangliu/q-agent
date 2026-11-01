package session

import "time"

// HasStableIdleSendHook reads completion proof afresh for a guarded queued send.
// It never binds identities or falls back to a cached hook on read failure.
// Pane readiness and the normal input/acceptance guards still run afterwards.
func (i *Instance) HasStableIdleSendHook(now time.Time, peers []*Instance) bool {
	if i == nil || i.IsSSH() || i.IsSandboxed() {
		return false
	}
	i.mu.RLock()
	id, tool, started := i.ID, i.Tool, i.LastStartedAt
	nativeID := i.ClaudeSessionID
	if IsCodexCompatible(tool) {
		nativeID = i.CodexSessionID
	}
	i.mu.RUnlock()
	// The durable start time is written after a spawn succeeds. While it is
	// still running, the spawn lock/stamp prevents reusing the previous process.
	if instanceSpawnLockHeld(id) {
		return false
	}
	if began, known := spawnBeganAt(id); known && now.Sub(began) < 2*time.Minute {
		return false
	}
	hook := readHookStatusFile(id)
	if !validIdleSendCompletion(tool, nativeID, started, hook, now) {
		return false
	}
	if stableIdleSendHook(tool, nativeID, started, hook, now) {
		return true
	}
	return i.idleSendTranscriptComplete(nativeID, started, hook, peers)
}

func stableIdleSendHook(tool, nativeID string, started time.Time, hook *HookStatus, now time.Time) bool {
	return validIdleSendCompletion(tool, nativeID, started, hook, now) &&
		now.Sub(hook.UpdatedAt) < hookFastPathFreshnessForTool(tool, hook.Status)
}

func validIdleSendCompletion(tool, nativeID string, started time.Time, hook *HookStatus, now time.Time) bool {
	// Match the native startup window; unknown or recent launches keep the old wait.
	if started.IsZero() || now.Sub(started) < 2*time.Minute || nativeID == "" || hook == nil ||
		hook.SessionID != nativeID || hook.UpdatedAt.Before(started) ||
		(hook.Status != "waiting" && hook.Status != "idle") {
		return false
	}
	age := now.Sub(hook.UpdatedAt)
	if age < time.Second {
		return false
	}
	if IsClaudeCompatible(tool) {
		return hook.Event == "Stop"
	}
	if IsCodexCompatible(tool) {
		return hook.Event == "agent-turn-complete" && hook.CodexStartedGeneration != "" &&
			hook.CodexStartedGeneration == hook.CodexCompletedGeneration &&
			hook.CodexStartedSessionID == nativeID && hook.CodexCompletedSessionID == nativeID
	}
	return false
}
