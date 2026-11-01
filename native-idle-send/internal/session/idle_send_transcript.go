package session

import (
	"encoding/json"
	"time"
)

// idleSendTranscriptComplete supplements an expired completion hook with the
// latest exact native turn. Unknown, partial and newer work all keep the old wait.
func (i *Instance) idleSendTranscriptComplete(nativeID string, started time.Time, hook *HookStatus, peers []*Instance) bool {
	var path string
	var err error
	if IsClaudeCompatible(i.Tool) {
		if len(peers) == 0 {
			return false
		}
		path, err = i.GetJSONLPathChecked(peers)
	} else {
		path, err = i.codexRolloutPath()
	}
	if err != nil || path == "" {
		return false
	}
	// The shared reader is capped at 512 KB and drops a cut leading record.
	lines, err := TranscriptTailLines(path, 200)
	if err != nil {
		return false
	}
	if IsClaudeCompatible(i.Tool) {
		return claudeIdleSendTailComplete(lines, nativeID, started)
	}
	return codexIdleSendTailComplete(lines, nativeID, hook.CodexCompletedGeneration, started)
}

func claudeIdleSendTailComplete(lines []string, nativeID string, started time.Time) bool {
	for n := len(lines) - 1; n >= 0; n-- {
		var rec struct {
			turnRecord
			Subtype string `json:"subtype"`
		}
		if json.Unmarshal([]byte(lines[n]), &rec) != nil {
			return false
		}
		if rec.IsSidechain {
			continue
		}
		if rec.Type == "system" && (rec.Subtype == "stop_hook_summary" || rec.Subtype == "turn_duration") {
			continue
		}
		if rec.Type != "assistant" || rec.SessionID != nativeID {
			return false
		}
		at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
		if err != nil || at.Before(started) {
			return false
		}
		var msg turnMessage
		if json.Unmarshal(rec.Message, &msg) != nil || msg.StopReason == nil {
			return false
		}
		// A thinking block can carry end_turn before the text block arrives.
		return turnEnded(*msg.StopReason) && contentHasBlock(msg.Content, "text")
	}
	return false
}

func codexIdleSendTailComplete(lines []string, nativeID, generation string, started time.Time) bool {
	completed := ""
	for n := len(lines) - 1; n >= 0; n-- {
		var rec codexRolloutRecord
		if json.Unmarshal([]byte(lines[n]), &rec) != nil {
			return false
		}
		if rec.Type != "event_msg" {
			if completed == "" {
				return false
			}
			continue
		}
		switch rec.Payload.Type {
		case "task_complete", "turn_complete":
			at, err := time.Parse(time.RFC3339Nano, rec.Timestamp)
			if completed != "" || rec.Payload.TurnID == "" || nativeID+":"+rec.Payload.TurnID != generation || err != nil || at.Before(started) {
				return false
			}
			completed = rec.Payload.TurnID
		case "task_started", "turn_started":
			return completed != "" && rec.Payload.TurnID == completed
		default:
			if completed == "" {
				return false
			}
		}
	}
	return false
}
