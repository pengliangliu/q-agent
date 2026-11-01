"""Synthetic request-error checks; no model requests or real conversation reads."""
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HISTORY = runpy.run_path(str(ROOT / "desktop-files/chat-history.py"))
TIME = "2026-11-02T00:00:00Z"


def assistant(text="Synthetic response", **extra):
    return {"type": "assistant", "timestamp": TIME, "message": {"id": "synthetic-message",
            "role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": "end_turn"}, **extra}


def retry(**extra):
    return {"type": "system", "subtype": "api_error", "timestamp": TIME,
            "error": {"message": "Connection error. private detail sentinel", "code": "ECONNRESET"},
            "retryAttempt": 2, "maxRetries": 10, "retryInMs": 1000, **extra}


class RequestIssueChecks(unittest.TestCase):
    def read(self, records, **request):
        with tempfile.TemporaryDirectory(prefix="q-agent-request-check-") as folder:
            path = Path(folder) / "synthetic.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            return HISTORY["page"]({"path": str(path), "tool": "claude", **request})

    def test_retry_metadata_is_bounded_and_private(self):
        result = self.read([assistant(), retry()])
        issue = result["requestIssue"]
        self.assertEqual((issue["source"], issue["state"], issue["kind"]), ("transcript", "retrying", "network"))
        self.assertEqual((issue["retryAttempt"], issue["maxRetries"], issue["retryInMs"]), (2, 10, 1000))
        self.assertEqual(issue["timestamp"], TIME)
        self.assertTrue(issue["id"].endswith(":request-issue"))
        self.assertNotIn("private detail sentinel", json.dumps(result))
        self.assertEqual(len(result["messages"]), 1)

    def test_missing_or_invalid_metadata_and_error_kinds(self):
        record = retry(retryAttempt=True, maxRetries="10", retryInMs=-1, timestamp="private detail sentinel")
        issue = self.read([record])["requestIssue"]
        self.assertTrue(all(issue[key] is None for key in ("retryAttempt", "maxRetries", "retryInMs", "timestamp")))
        for code, kind in ((401, "authentication"), (429, "rate_limit"), (503, "server")):
            with self.subTest(code=code):
                issue = self.read([retry(statusCode=code)])["requestIssue"]
                self.assertEqual((issue["statusCode"], issue["kind"]), (code, kind))
        self.assertEqual(self.read([retry(error={})])["requestIssue"]["kind"], "unknown")

    def test_terminal_error_is_neither_reply_nor_completion(self):
        error = assistant("API Error: Connection error. private detail sentinel", isApiErrorMessage=True)
        result = self.read([assistant(), retry(), error])
        self.assertEqual(result["requestIssue"]["state"], "failed")
        self.assertEqual(len(result["messages"]), 1)
        self.assertNotIn("private detail sentinel", json.dumps(result))
        source = """
import { completionFromRecords } from './desktop-files/completion-status.mjs';
let input = ''; for await (const part of process.stdin) input += part;
const records = JSON.parse(input);
console.log(JSON.stringify({failed:completionFromRecords(records,'claude','synthetic'),
  failedMeta:completionFromRecords([records[0],{...records[1],isMeta:true}],'claude','synthetic'),
  recovered:!!completionFromRecords([records[0]],'claude','synthetic')}));
"""
        output = subprocess.run(["node", "--input-type=module", "-e", source], cwd=ROOT,
                                input=json.dumps([assistant(), error]), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(output.stdout), {"failed": None, "failedMeta": None, "recovered": True})
        self.assertEqual(self.read([{**error, "isMeta": True}])["requestIssue"]["state"], "failed")

    def test_real_assistant_output_and_end_turn_clear_issue(self):
        tool = assistant()
        tool["message"]["content"] = [{"type": "tool_use", "id": "synthetic-tool", "name": "Read", "input": {}}]
        empty_end = assistant("")
        for record in (assistant(), tool, empty_end):
            with self.subTest(record=record):
                self.assertIsNone(self.read([retry(), record])["requestIssue"])

    def test_new_user_and_compaction_clear_issue(self):
        records = ({"type": "user", "message": {"role": "user", "content": "Synthetic new turn"}},
                   {"type": "system", "subtype": "compact_boundary"},
                   {"type": "user", "isCompactSummary": True, "message": {"content": "Synthetic summary"}})
        for record in records:
            with self.subTest(record=record):
                self.assertIsNone(self.read([retry(), record])["requestIssue"])

    def test_background_and_tool_events_do_not_hide_foreground_error(self):
        records = (assistant(isSidechain=True), assistant(isMeta=True),
                   {"type": "user", "message": {"role": "user", "content": [
                       {"type": "tool_result", "tool_use_id": "synthetic-tool", "content": "Synthetic result"}]}},
                   {"type": "user", "message": {"role": "user", "content":
                       "<task-notification><status>completed</status></task-notification>"}})
        for record in records:
            with self.subTest(record=record):
                self.assertEqual(self.read([retry(), record])["requestIssue"]["state"], "retrying")

    def test_older_page_has_no_current_request_metadata(self):
        with tempfile.TemporaryDirectory(prefix="q-agent-request-check-") as folder:
            path = Path(folder) / "synthetic.jsonl"
            rows = [assistant(str(index)) for index in range(65)] + [retry()]
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            request = {"path": str(path), "tool": "claude"}
            latest = HISTORY["page"](request)
            self.assertIsNotNone(latest["requestIssue"])
            older = HISTORY["page"]({**request, "before": latest["before"]})
            self.assertNotIn("requestIssue", older)

    def test_updater_notice_and_old_recovered_error_are_not_active(self):
        update = {"type": "system", "subtype": "auto_update", "message": "Auto-update failed"}
        self.assertIsNone(self.read([update])["requestIssue"])
        self.assertIsNone(self.read([retry(), assistant(), update])["requestIssue"])
        self.assertIsNone(HISTORY["page"]({"tool": "claude"})["requestIssue"])


if __name__ == "__main__":
    unittest.main()
