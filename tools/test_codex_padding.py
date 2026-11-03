import json
import fcntl
from pathlib import Path
import runpy
import tempfile
import unittest

repair = runpy.run_path(str(Path(__file__).resolve().parents[1] / "desktop-files/repair-codex-padding.py"))["repair"]


class PaddingRecovery(unittest.TestCase):
    def test_preserves_records_offsets_and_backup_without_repeat_repair(self):
        with tempfile.TemporaryDirectory(prefix="codex-padding-") as folder:
            root = Path(folder)
            native_id = "12345678-1234-4234-9234-123456789abc"
            history = root / "codex" / ("rollout-test-" + native_id + ".jsonl")
            history.parent.mkdir()
            header = json.dumps({"type": "session_meta", "payload": {"id": native_id}}).encode() + b"\n"
            message = json.dumps({"type": "response_item", "payload": {"role": "user", "content": "fixture"}}).encode() + b"\n"
            original = header + b"\0 \0\t\0\n" + message
            history.write_bytes(original)
            inode = history.stat().st_ino
            row = {"id": "fixture-session", "tool": "codex", "status": "waiting",
                   "codex_session_id": native_id, "resolved_codex_home": str(history.parent),
                   "transcript_path": str(history)}
            state = root / "state.json"
            state.write_text(json.dumps(row))
            cli = root / "deck"
            cli.write_text("#!/usr/bin/python3\nfrom pathlib import Path\nprint(Path(" + repr(str(state)) + ").read_text())\n")
            cli.chmod(0o700)
            request = {"deck": str(cli), "sessionId": row["id"], "nativeId": native_id, "account": "",
                       "sendLock": str(root / "runtime/send-locks/fixture-session.lock")}
            result = repair(request)
            self.assertTrue(result["repaired"])
            self.assertEqual(history.read_bytes(), original.replace(b"\0", b" "))
            self.assertEqual(history.stat().st_ino, inode)
            backups = list((root / "history-repairs").glob("*/original.jsonl"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertFalse(repair(request)["repaired"])
            self.assertEqual(len(list((root / "history-repairs").glob("*/original.jsonl"))), 1)
            for invalid in (header + b"broken-json\n" + message, header + b"\0\0\n"):
                history.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    repair(request)
                self.assertEqual(history.read_bytes(), invalid)
            history.write_bytes(original)
            row["account"] = "another-account"
            state.write_text(json.dumps(row))
            with self.assertRaises(ValueError):
                repair(request)
            self.assertEqual(history.read_bytes(), original)
            row.pop("account")
            state.write_text(json.dumps(row))
            lock = Path(request["sendLock"])
            with lock.open("a+") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    repair(request)
            self.assertEqual(history.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
