#!/usr/bin/env python3
"""Read a bounded page from an authoritative Agent Deck transcript. Never writes it."""
import base64
import ctypes
import ctypes.util
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import tempfile

PAGE = 60
MAX_SCAN = 24 * 1024 * 1024
MAX_LINE = 8 * 1024 * 1024
MAX_TEXT = 24000


def clean(value):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"<system-reminder>.*?</system-reminder>", "", value, flags=re.S)
    return value[:MAX_TEXT] + ("\n[内容较长，已截断显示]" if len(value) > MAX_TEXT else "")


def content_text(content):
    if isinstance(content, str):
        return clean(content)
    if not isinstance(content, list):
        return ""
    return clean("\n".join(str(p.get("text", "")) for p in content
                           if isinstance(p, dict) and p.get("type") in ("text", "input_text", "output_text")))


def classify_claude_notification(item):
    if item["role"] != "user" or item.get("attachments"):
        return item
    task = re.fullmatch(r"\s*<task-notification>(.*?)</task-notification>\s*", item["text"], re.S)
    if task:
        fields = []
        for tag, label in (("status", "状态"), ("summary", "摘要"), ("output-file", "输出"), ("output_file", "输出")):
            value = re.search(r"<" + tag + r">(.*?)</" + tag + r">", task[1], re.S)
            if value:
                fields.append(label + "：" + html.unescape(value[1].strip()))
        return {**item, "role": "tool", "toolName": "后台任务通知", "status": "notification",
                "text": clean("\n".join(fields) if fields else task[1].strip())}
    stdout = re.fullmatch(r"\s*<local-command-stdout>(.*?)</local-command-stdout>\s*", item["text"], re.S)
    if stdout:
        return {**item, "role": "tool", "toolName": "本地命令输出", "status": "result",
                "text": clean(html.unescape(stdout[1].strip()))}
    return item


def directory_hints(text):
    """Only explicit directory tokens in the message, not inferred filenames."""
    hints = []
    tokens = [match.group(2) for match in re.finditer(r"(`+)([^`\n]+)\1", text)]
    tokens += [match.group(1) or match.group(2) for match in
               re.finditer(r"\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s()]+))(?:\s+\"[^\"]*\")?\)", text)]
    for value in tokens:
        value = value.strip()
        if (not value or len(value) > 4096 or not value.endswith(("/", "\\")) or
                re.search(r"[\x00-\x1f\x7f]", value) or re.match(r"^[A-Za-z][\w+.-]*:", value)):
            continue
        if value not in hints:
            hints.append(value)
        if len(hints) == 24:
            break
    return hints


def messages(record):
    kind = record.get("type")
    payload = record.get("payload", {})
    timestamp = record.get("timestamp", "")
    result = []

    def emit(role, text, **extra):
        text = clean(text)
        if text.strip() or extra.get("attachments"):
            result.append({"role": role, "text": text, "timestamp": timestamp, **extra})

    if kind == "response_item" and isinstance(payload, dict):
        subtype = payload.get("type")
        if subtype == "message":
            role = payload.get("role")
            if role not in ("user", "assistant") or payload.get("channel", payload.get("phase")) in ("analysis", "summary", "justify", "confidence"):
                return []
            blocks = payload.get("content", [])
            attachments = []
            if isinstance(blocks, list):
                for block in blocks:
                    if isinstance(block, dict) and block.get("type") in ("input_image", "image"):
                        attachments.append({"name": "图片附件", "mime": "image/*"})
            text = content_text(blocks)
            if role == "user" and (text.startswith("# AGENTS.md instructions\n\n<INSTRUCTIONS>")
                                    or text.strip().startswith("<environment_context>")):
                emit("tool", text, toolName="项目指导与运行上下文", status="context")
            else:
                emit(role, text, **({"attachments": attachments} if attachments else {}))
        elif subtype in ("function_call", "custom_tool_call"):
            emit("tool", payload.get("arguments", payload.get("input", "")),
                 toolName=payload.get("name", "工具调用"), status="call", callId=payload.get("call_id", ""))
        elif subtype in ("function_call_output", "custom_tool_call_output"):
            output = payload.get("output", "")
            emit("tool", content_text(output) if isinstance(output, list) else output,
                 toolName="工具结果", status="result", callId=payload.get("call_id", ""))
    elif kind in ("user", "assistant") and not record.get("isSidechain"):
        message = record.get("message", {})
        role = message.get("role", kind)
        if role not in ("user", "assistant") or record.get("isMeta") or record.get("isCompactSummary"):
            return []
        blocks = message.get("content", [])
        if isinstance(blocks, str):
            emit(role, blocks)
        elif isinstance(blocks, list):
            text = []
            attachments = []
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text.append(block.get("text", ""))
                elif btype in ("image", "document"):
                    source = block.get("source", {})
                    attachments.append({"name": "图片附件" if btype == "image" else "文档附件",
                                        "mime": source.get("media_type", "")})
                elif btype == "tool_use":
                    emit("tool", block.get("input", {}), toolName=block.get("name", "工具调用"),
                         status="call", callId=block.get("id", ""))
                elif btype == "tool_result":
                    emit("tool", content_text(block.get("content", "")), toolName="工具结果",
                         status="error" if block.get("is_error") else "result", callId=block.get("tool_use_id", ""))
            if text or attachments:
                result.insert(0, {"role": role, "text": clean("\n".join(text)), "timestamp": timestamp,
                                  **({"attachments": attachments} if attachments else {})})
        result = [classify_claude_notification(item) for item in result]
    cwd = record.get("cwd")
    for item in result:
        if isinstance(cwd, str) and len(cwd) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", cwd):
            item["cwd"] = cwd
        hints = directory_hints(item["text"])
        if hints:
            item["directoryHints"] = hints
    # event_msg duplicates response_item; reasoning, system, snapshots and API blobs are never rendered.
    return result


def native_session(record):
    first, second = record.get("sessionId"), record.get("session_id")
    if first and second and first != second:
        return None
    value = first or second
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9-]{8,100}", value) else None


def has_relative_reference(text):
    text = re.sub(r"(```|~~~)[^\n]*\n.*?(?:\1|$)", "", text, flags=re.S)
    tokens = [match.group(2) for match in re.finditer(r"(`+)([^`\n]+)\1", text)]
    tokens += [match.group(1) or match.group(2) for match in
               re.finditer(r"\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s()]+))(?:\s+\"[^\"]*\")?\)", text)]
    for value in tokens:
        if (not value or len(value) > 4096 or value.startswith(("/", "\\\\")) or
                re.match(r"^[A-Za-z][\w+.-]*:", value) or re.search(r"[\x00-\x1f\x7f<>]", value)):
            continue
        if re.match(r"^(?:\.{1,2}[\\/]|[^\s]+[\\/])", value) or re.search(r"\.(?:py|js|mjs|ts|tsx|jsx|json|md|yaml|yml|txt|pdf|docx?|xlsx?|pptx?|csv|tsv|html|css|scss|go|rs|java|c|h|cpp|hpp|m|sh|bat|ps1|png|jpe?g|webp|svg|zip|gz|toml|ini|log|sql|ipynb)(?::\d+(?::\d+)?)?$", value, re.I):
            return True
    return False


def previous_working_directories(record):
    """Read native directory changes, never paths guessed from tool output."""
    attachment = record.get("attachment")
    if record.get("type") != "attachment" or record.get("isSidechain") or not isinstance(attachment, dict) or attachment.get("type") != "environment":
        return []
    directories = []
    for change in attachment.get("changes", []) if isinstance(attachment.get("changes"), list) else []:
        value = change.get("from") if isinstance(change, dict) and change.get("field") == "workingDirectory" else None
        if isinstance(value, str) and value.startswith("/") and len(value) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", value):
            directory = os.path.normpath(value).rstrip("/") + "/"
            if directory not in directories:
                directories.append(directory)
    return directories[:24]


def uncompress(source):
    """Use WSL's existing libzstd, with a bounded cache and no package installation."""
    stat = source.stat()
    key = hashlib.sha256(f"{source}:{stat.st_size}:{stat.st_mtime_ns}".encode()).hexdigest()
    cache = Path.home() / ".cache/agent-deck-chat"
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = cache / (key + ".jsonl")
    if target.is_file():
        return target
    name = ctypes.util.find_library("zstd")
    if not name:
        raise ValueError("本机缺少读取压缩历史所需的 libzstd。原记录未更改。")
    lib = ctypes.CDLL(name)

    class Buffer(ctypes.Structure):
        _fields_ = [("data", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]

    lib.ZSTD_createDStream.restype = ctypes.c_void_p
    lib.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_initDStream.restype = ctypes.c_size_t
    lib.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_decompressStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(Buffer), ctypes.POINTER(Buffer)]
    lib.ZSTD_decompressStream.restype = ctypes.c_size_t
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    lib.ZSTD_isError.restype = ctypes.c_uint
    stream = lib.ZSTD_createDStream()
    if not stream or lib.ZSTD_isError(lib.ZSTD_initDStream(stream)):
        raise ValueError("无法打开压缩历史。")
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as output, source.open("rb") as incoming:
            temp = Path(output.name)
            total, remaining = 0, 0
            while chunk := incoming.read(131072):
                src = ctypes.create_string_buffer(chunk)
                ib = Buffer(ctypes.cast(src, ctypes.c_void_p), len(chunk), 0)
                while ib.pos < ib.size:
                    dst = ctypes.create_string_buffer(131072)
                    ob = Buffer(ctypes.cast(dst, ctypes.c_void_p), len(dst), 0)
                    remaining = lib.ZSTD_decompressStream(stream, ctypes.byref(ob), ctypes.byref(ib))
                    if lib.ZSTD_isError(remaining):
                        raise ValueError("压缩记录损坏，无法读取。")
                    total += ob.pos
                    if total > 512 * 1024 * 1024:
                        raise ValueError("压缩历史超过本次读取上限（512 MB），请在原客户端查看。")
                    output.write(dst.raw[:ob.pos])
            if remaining:
                raise ValueError("压缩记录尚未完整写入。")
        os.replace(temp, target)
        return target
    finally:
        lib.ZSTD_freeDStream(stream)
        if temp and temp.exists():
            temp.unlink()


def resolve_source(request):
    raw = request.get("path")
    if raw:
        source = Path(raw)
        if not source.exists() and Path(raw + ".zst").is_file():
            source = Path(raw + ".zst")
        if source.is_file():
            return source
    # Agent Deck's native resolver currently skips compressed Codex rolls. Match the exact stored ID.
    native_id = request.get("nativeId", "")
    home = request.get("codexHome")
    if request.get("tool") == "codex" and home and re.fullmatch(r"[a-f0-9-]{36}", native_id):
        root = Path(home) / "sessions"
        matches = list(root.glob(f"*/*/*/rollout-*-{native_id}.jsonl*"))[:2]
        if len(matches) == 1 and matches[0].is_file():
            return matches[0]
    return None


def page(request):
    source = resolve_source(request)
    if source is None:
        return {"messages": [], "hasMore": False, "notice": "此会话尚无可读取的原生聊天记录。"}
    if not source.is_absolute() or not (source.name.endswith(".jsonl") or source.name.endswith(".jsonl.zst")):
        raise ValueError("不支持此记录格式。")
    original = source.resolve()
    source = uncompress(original) if source.suffix == ".zst" else original
    tag = hashlib.sha256(str(original).encode()).hexdigest()[:16]
    size = source.stat().st_size
    boundary, boundary_index = size, None
    if request.get("before"):
        try:
            cursor = json.loads(base64.urlsafe_b64decode(request["before"] + "==="))
            if cursor[0] != tag or not 0 <= cursor[1] <= size or not 0 <= cursor[2] < 10000:
                raise ValueError()
            boundary, boundary_index = cursor[1], cursor[2]
        except Exception:
            raise ValueError("历史分页位置已失效，请刷新会话。")
    found, notice = [], ""
    context_pending = []
    claude_context = request.get("tool") == "claude"
    with source.open("rb") as handle:
        # Include the boundary row so multiple blocks in the same native record paginate without loss.
        end = boundary
        if boundary_index is not None:
            handle.seek(boundary)
            line = handle.readline(MAX_LINE + 1)
            end = boundary + len(line)
        floor = max(0, end - MAX_SCAN)
        position, carry = end, b""
        # Relative file references may need the nearest native cwd change just
        # beyond the visible page, within this page's original MAX_SCAN bound.
        while position > floor and (len(found) <= PAGE or context_pending):
            start = max(floor, position - 262144)
            handle.seek(start)
            chunk = handle.read(position - start) + carry
            parts = chunk.split(b"\n")
            carry = parts[0]
            offsets = []
            offset = start + len(parts[0]) + 1
            for line in parts[1:]:
                offsets.append((offset, line))
                offset += len(line) + 1
            if start == 0:
                offsets.insert(0, (0, carry))
                carry = b""
            for offset, line in reversed(offsets):
                if not line or offset > boundary:
                    continue
                if len(line) > MAX_LINE:
                    context_pending.clear()
                    continue
                try:
                    record = json.loads(line)
                    normalized = messages(record) if len(found) <= PAGE or record.get("type") == "user" else []
                except (ValueError, TypeError, AttributeError):
                    context_pending.clear()
                    continue  # A writer may not have finished its final JSONL row yet.
                if claude_context:
                    # Tool results and native task notices have role=tool;
                    # only a real user input closes the preceding turn.
                    if (record.get("type") == "user" and any(item["role"] == "user" for item in normalized)) or record.get("isCompactSummary") or (record.get("type") == "system" and record.get("subtype") == "compact_boundary"):
                        context_pending.clear()
                    session_id = native_session(record)
                    directories = previous_working_directories(record)
                    if session_id and directories:
                        directory = directories[-1]
                        remaining = []
                        for item, owner in context_pending:
                            if owner == session_id:
                                hints = item.setdefault("directoryHints", [])
                                if directory not in hints and len(hints) < 24:
                                    hints.append(directory)
                            else:
                                remaining.append((item, owner))
                        context_pending = remaining
                for index in range(len(normalized) - 1, -1, -1) if len(found) <= PAGE else []:
                    if boundary_index is not None and offset == boundary and index >= boundary_index:
                        continue
                    item = normalized[index]
                    item["id"] = f"{tag}:{offset}:{index}"
                    item["_cursor"] = [tag, offset, index]
                    if claude_context and len(found) < PAGE and item["role"] == "assistant" and native_session(record) and len(item.get("directoryHints", [])) < 24 and has_relative_reference(item["text"]):
                        context_pending.append((item, native_session(record)))
                    found.append(item)
                    if len(found) > PAGE:
                        break
                if len(found) > PAGE and not context_pending:
                    break
            position = start
            if len(carry) > MAX_LINE:
                carry = b""
                context_pending.clear()
                notice = "个别超长记录未展开；原记录保持完整。"
        has_more = len(found) > PAGE or position > 0
        selected = found[:PAGE]
        cursor = selected[-1]["_cursor"] if selected else [tag, position, 0]
        if not selected and position == 0:
            has_more = False
        selected.reverse()
        names = {item["callId"]: item["toolName"] for item in selected if item.get("callId") and item.get("status") == "call"}
        for item in selected:
            item.pop("_cursor", None)
            if item.get("callId") in names:
                item["toolName"] = names[item["callId"]]
            item.pop("callId", None)
        result = {"messages": selected, "hasMore": has_more}
        if has_more:
            result["before"] = base64.urlsafe_b64encode(json.dumps(cursor).encode()).decode().rstrip("=")
        if notice:
            result["notice"] = notice
        return result


if __name__ == "__main__":
    try:
        print(json.dumps(page(json.loads(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
