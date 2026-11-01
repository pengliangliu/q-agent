"""Relay the WSL loopback proxy to current Windows settings, without TLS inspection.

Only this process's connection is closed on a proxy/Clash Verge selection change.
The calling SDK owns retries; this bridge never records or replays requests.
"""
from collections import namedtuple
import ctypes
from ctypes import wintypes
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import threading
from urllib.parse import urlsplit

Settings = namedtuple('Settings', 'proxy bypass pac auto_detect', defaults=('', '', '', False))
MAX_HEADER = 65536
ERROR = (b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n'
         b'Content-Type: text/plain\r\nContent-Length: 37\r\n\r\n'
         b'Windows proxy route is unavailable.\r\n')


class ProxyError(Exception):
    pass


def read_system_proxy():
    # Read settings for the current active LAN/VPN connection; strings are OS-owned.
    class Config(ctypes.Structure):
        _fields_ = [('detect', wintypes.BOOL), ('pac', ctypes.c_void_p),
                    ('proxy', ctypes.c_void_p), ('bypass', ctypes.c_void_p)]

    winhttp = ctypes.WinDLL('winhttp', use_last_error=True)
    get_config = winhttp.WinHttpGetIEProxyConfigForCurrentUser
    get_config.argtypes = [ctypes.POINTER(Config)]
    get_config.restype = wintypes.BOOL
    free = ctypes.WinDLL('kernel32').GlobalFree
    free.argtypes = [ctypes.c_void_p]
    free.restype = ctypes.c_void_p
    config = Config()
    try:
        if not get_config(ctypes.byref(config)):
            raise ProxyError()
        value = lambda pointer: ctypes.wstring_at(pointer) if pointer else ''
        return Settings(value(config.proxy), value(config.bypass), value(config.pac), bool(config.detect))
    finally:
        for pointer in (config.proxy, config.bypass, config.pac):
            if pointer:
                free(pointer)


def proxy_address(settings, scheme, host):
    # PAC/WPAD needs the Windows URL resolver, not a guess or an old proxy fallback.
    if settings.pac or settings.auto_detect:
        raise ProxyError()
    if not settings.proxy:
        return None
    host = host.lower().rstrip('.')
    for bypass in settings.bypass.split(';'):
        bypass = bypass.strip().lower()
        if bypass and ((bypass == '<local>' and '.' not in host and ':' not in host) or
                       fnmatch.fnmatchcase(host, bypass)):
            return None
    server = settings.proxy.strip()
    if '=' in server:
        mappings = {}
        for entry in server.split(';'):
            key, separator, value = entry.partition('=')
            if separator:
                mappings[key.strip().lower()] = value.strip()
        server = mappings.get(scheme, '')
    if not server or ';' in server or any(character.isspace() for character in server):
        raise ProxyError()
    try:
        parsed = urlsplit(server if '://' in server else 'http://' + server)
        if (parsed.scheme != 'http' or not parsed.hostname or parsed.username is not None or
                parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ProxyError()
        port = parsed.port if parsed.port is not None else 80
        if not 1 <= port <= 65535:
            raise ProxyError()
        return parsed.hostname, port
    except ValueError:
        raise ProxyError() from None


def request_target(header):
    try:
        method, target, version = header.split(b'\r\n', 1)[0].decode('ascii').split()
        if version not in ('HTTP/1.0', 'HTTP/1.1'):
            raise ProxyError()
        if method == 'CONNECT':
            parsed = urlsplit('//' + target)
            scheme = 'https'
            if parsed.path or parsed.query or parsed.fragment or not parsed.port:
                raise ProxyError()
        else:
            parsed = urlsplit(target)
            scheme = parsed.scheme
            if scheme != 'http':
                raise ProxyError()
        if not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ProxyError()
        return method, scheme, parsed.hostname, parsed.port or 80
    except (ValueError, UnicodeError):
        raise ProxyError() from None


def yaml_scalar(value):
    """The small scalar subset emitted by Clash Verge; never evaluate YAML tags."""
    value = value.strip()
    if value.startswith('"'):
        decoded = json.loads(value)
        if not isinstance(decoded, str):
            raise ValueError()
        return decoded
    if value.startswith("'"):
        if not value.endswith("'"):
            raise ValueError()
        return value[1:-1].replace("''", "'")
    if not value or value[0] in '!&*[{>|':
        raise ValueError()
    return value.split(' #', 1)[0].rstrip()


def verge_selection(path):
    """Hash only the active profile's persisted selector choices, never its URLs."""
    current, active, selected, found = None, False, False, False
    choices, pending = [], None
    with path.open(encoding='utf-8-sig') as source:
        for line in source:
            if line.startswith('current:'):
                current = yaml_scalar(line.partition(':')[2])
            match = re.match(r'^- uid:\s*(.*)$', line)
            if match:
                if active:
                    break
                active = current is not None and yaml_scalar(match.group(1)) == current
                found = found or active
                continue
            if not active:
                continue
            if line.startswith('  selected:'):
                value = line.partition(':')[2].strip()
                if value not in ('', '[]', 'null'):
                    raise ValueError()
                selected = not value
                continue
            if selected:
                if line.startswith('  - name:'):
                    if pending is not None:
                        raise ValueError()
                    pending = yaml_scalar(line.partition(':')[2])
                elif line.startswith('    now:'):
                    if pending is None:
                        raise ValueError()
                    choices.append((pending, yaml_scalar(line.partition(':')[2])))
                    pending = None
                elif line.strip() and not line.lstrip().startswith('#'):
                    selected = False
    if not found or pending is not None:
        raise ValueError()
    return hashlib.sha256(json.dumps((current, sorted(choices)), ensure_ascii=False).encode()).digest()


class SelectionMonitor:
    def __init__(self, path=None):
        appdata = os.environ.get('APPDATA')
        self.path = path or (Path(appdata) / 'io.github.clash-verge-rev.clash-verge-rev' / 'profiles.yaml' if appdata else None)
        self.stamp, self.selection = None, None

    def read(self):
        try:
            if self.path:
                stat = self.path.stat()
                stamp = stat.st_mtime_ns, stat.st_size
                if stamp != self.stamp and stat.st_size <= 2 * 1024 * 1024:
                    selection = verge_selection(self.path)
                    self.selection, self.stamp = selection, stamp
        except (OSError, ValueError, UnicodeError):
            # A temporary/mid-save file is not evidence that the route changed.
            pass
        return self.selection


def close_socket(upstream):
    try:
        upstream.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def serve(input_stream=None, output_stream=None, settings_reader=read_system_proxy,
          selection_reader=None, poll_interval=2.0):
    input_stream = input_stream or sys.stdin.buffer
    output_stream = output_stream or sys.stdout.buffer
    try:
        descriptor = input_stream.fileno()
        # All pipe reads use the fd: no BufferedReader lock survives in a daemon
        # thread when a route change ends this process while stdin is still open.
        read_input = lambda size: os.read(descriptor, size)
    except (AttributeError, OSError, ValueError):
        read_input = getattr(input_stream, 'read1', input_stream.read)
    selection_reader = selection_reader or SelectionMonitor().read
    upstream, started = None, False
    stop = threading.Event()
    try:
        initial = bytearray()
        while b'\r\n\r\n' not in initial:
            chunk = read_input(4096)
            if not chunk or len(initial) + len(chunk) > MAX_HEADER:
                raise ProxyError()
            initial.extend(chunk)
        end = initial.index(b'\r\n\r\n') + 4
        method, scheme, host, port = request_target(initial[:end])
        settings = settings_reader()
        proxy = proxy_address(settings, scheme, host)
        if proxy is None and method != 'CONNECT':
            raise ProxyError()
        selection = selection_reader()
        source_stamp = Path(__file__).stat().st_mtime_ns
        upstream = socket.create_connection(proxy or (host, port), timeout=10)
        upstream.settimeout(None)
        if proxy:
            upstream.sendall(initial)
        else:
            # The destination receives only tunnel bytes, never proxy headers.
            output_stream.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            output_stream.flush()
            started = True
            if initial[end:]:
                upstream.sendall(initial[end:])

        def send():
            try:
                while not stop.is_set():
                    data = read_input(65536)
                    if not data:
                        # Preserve the final response after a client write half-close.
                        upstream.shutdown(socket.SHUT_WR)
                        return
                    upstream.sendall(data)
            except (OSError, ValueError):
                close_socket(upstream)

        def watch():
            while not stop.wait(poll_interval):
                try:
                    changed = (settings_reader() != settings or selection_reader() != selection or
                               Path(__file__).stat().st_mtime_ns != source_stamp)
                except (OSError, ProxyError):
                    changed = True
                if changed:
                    close_socket(upstream)
                    return

        threading.Thread(target=send, daemon=True).start()
        threading.Thread(target=watch, daemon=True).start()
        while True:
            data = upstream.recv(65536)
            if not data:
                break
            output_stream.write(data)
            output_stream.flush()
            started = True
        return 0
    except (OSError, ProxyError, ValueError):
        if not started:
            try:
                output_stream.write(ERROR)
                output_stream.flush()
            except (OSError, ValueError):
                pass
        return 1
    finally:
        stop.set()
        if upstream is not None:
            close_socket(upstream)
            upstream.close()


if __name__ == '__main__':
    raise SystemExit(serve())
