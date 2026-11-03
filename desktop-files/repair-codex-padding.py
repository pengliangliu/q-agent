"""Recover interior NUL-only JSONL padding after a native export refusal."""
from contextlib import ExitStack
from pathlib import Path
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time


def sha256(file):
    result = hashlib.sha256()
    with file.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def repair(request):
    send_lock = Path(request["sendLock"])
    source_lock = send_lock.parent.parent / "harness-switch" / (
        hashlib.sha256(request["sessionId"].encode()).hexdigest()[:24] + ".source-transaction.lock"
    )
    with ExitStack() as stack:
        for lock in (send_lock, source_lock):
            lock.parent.mkdir(parents=True, exist_ok=True)
            handle = stack.enter_context(lock.open("a+"))
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        args = [request["deck"]]
        if request.get("profile"):
            args.extend(["-p", request["profile"]])

        def current():
            raw = subprocess.check_output(args + ["session", "show", request["sessionId"], "--json"],
                                          timeout=15, stderr=subprocess.DEVNULL)
            row = json.loads(raw)
            if (row.get("id") != request["sessionId"] or row.get("tool") != "codex" or row.get("ssh_host")
                    or row.get("codex_session_id") != request["nativeId"]
                    or (row.get("account") or "") != request["account"]
                    or row.get("status") not in ("running", "waiting", "idle")):
                raise ValueError("session-changed")
            return row

        row = current()
        source = Path(row["transcript_path"])
        home = Path(row["resolved_codex_home"]).resolve()
        if (not source.is_absolute() or source.is_symlink() or not source.resolve().is_relative_to(home)
                or not source.name.endswith("-" + request["nativeId"] + ".jsonl")):
            raise ValueError("source-changed")
        before = source.stat()
        changes, padding, offset, records = [], {}, 0, 0
        with source.open("rb") as handle:
            for number, line in enumerate(handle, 1):
                if line.strip():
                    try:
                        value = json.loads(line)
                        if number == 1 and (value.get("type") != "session_meta"
                                            or value.get("payload", {}).get("id") != request["nativeId"]):
                            raise ValueError("source identity mismatch")
                        records += 1
                    except (ValueError, UnicodeError):
                        # Only complete interior lines made entirely of NULs.
                        # All other damage needs its own diagnosis.
                        if (not line.endswith(b"\n") or b"\0" not in line[:-1] or line[:-1].strip(b"\0 \t\r")
                                or offset + len(line) >= before.st_size):
                            raise ValueError("unsupported-damage")
                        changes.append({"line": number, "offset": offset, "length": len(line) - 1})
                        padding[offset] = line[:-1]
                offset += len(line)
        if not changes:
            return {"repaired": False}
        backup_dir = send_lock.parent.parent.parent / "history-repairs" / ("nul-padding-" + str(time.time_ns()))
        backup_dir.mkdir(parents=True, mode=0o700)
        backup = backup_dir / "original.jsonl"
        shutil.copy2(source, backup)
        os.chmod(backup, 0o600)
        with backup.open("rb") as handle:
            os.fsync(handle.fileno())
        original_hash = sha256(backup)
        if sha256(source) != original_hash:
            raise ValueError("source-changed")
        fresh = current()
        if fresh["transcript_path"] != str(source):
            raise ValueError("source-changed")
        applied = []
        with source.open("r+b", buffering=0) as handle:
            stat = os.fstat(handle.fileno())
            if (stat.st_ino, stat.st_size, stat.st_mtime_ns) != (before.st_ino, before.st_size, before.st_mtime_ns):
                raise ValueError("source-changed")
            try:
                for change in changes:
                    handle.seek(change["offset"])
                    if handle.read(change["length"]) != padding[change["offset"]]:
                        raise ValueError("source-changed")
                    handle.seek(change["offset"])
                    applied.append(change)
                    if handle.write(padding[change["offset"]].replace(b"\0", b" ")) != change["length"]:
                        raise OSError("short repair write")
                os.fsync(handle.fileno())
                with source.open("rb") as repaired, backup.open("rb") as prior:
                    offsets = {change["line"] for change in changes}
                    for number, line in enumerate(repaired, 1):
                        previous = prior.readline()
                        if number in offsets:
                            if line != previous.replace(b"\0", b" "):
                                raise ValueError("repair-mismatch")
                        elif line != previous:
                            raise ValueError("source-changed")
            except BaseException:
                # Restore only our ranges, preserving an independently appended tail.
                for change in applied:
                    handle.seek(change["offset"])
                    handle.write(padding[change["offset"]])
                os.fsync(handle.fileno())
                raise
        receipt = {"originalPath": str(source), "beforeSHA256": original_hash,
                   "afterSHA256": sha256(source), "changes": changes, "validRecords": records}
        receipt_file = backup_dir / "receipt.json"
        receipt_file.write_text(json.dumps(receipt), encoding="utf-8")
        os.chmod(receipt_file, 0o600)
        return {"repaired": True, "lines": len(changes), "records": records}


if __name__ == "__main__":
    try:
        print(json.dumps(repair(json.loads(sys.argv[1]))))
    except (ValueError, OSError, KeyError, subprocess.SubprocessError):
        print(json.dumps({"repaired": False, "error": "history-recovery-unavailable"}))
        sys.exit(1)
