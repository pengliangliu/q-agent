"""Focused bootstrap checks. No network, apt, real home, or system configuration writes."""
import argparse
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bootstrap", Path(__file__).with_name("bootstrap-wsl.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapChecks(unittest.TestCase):
    def test_version_parsing(self):
        for name, output, expected in (("node", "v22.23.4", "22.23.4"),
                                       ("claude", "2.1.316 (Claude Code)", "2.1.316"),
                                       ("codex", "codex-cli 0.163.0", "0.163.0"),
                                       ("agent-deck", "Agent Deck v1.16.35 (update available: v1.17.0)", "1.16.35")):
            with patch.object(bootstrap, "run", return_value=output):
                self.assertEqual(bootstrap.version(name, name), expected)

    def test_wsl_config_preserves_sections_and_is_idempotent(self):
        before = "# Keep me\n[automount]\nroot=/mnt/\n[boot]\ncommand=echo ready\nsystemd=false\n[user]\ndefault=example\n"
        after = bootstrap.systemd_config(before)
        self.assertEqual(after, before.replace("systemd=false", "systemd=true"))
        self.assertEqual(bootstrap.systemd_config(after), after)
        self.assertEqual(bootstrap.systemd_config("[user]\ndefault=example"),
                         "[user]\ndefault=example\n\n[boot]\nsystemd=true\n")

    def test_download_rejects_checksum_mismatch(self):
        class Response(io.BytesIO):
            url = "https://example.invalid/archive"
        with tempfile.TemporaryDirectory() as tmp, patch.object(bootstrap.urllib.request, "urlopen", return_value=Response(b"changed")):
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                bootstrap.download(Response.url, Path(tmp) / "download", hashlib.sha256(b"expected").hexdigest())

    def test_archive_rejects_escape_and_allows_npm_link(self):
        root = "node-" + bootstrap.NODE_VERSION + "-linux-x64"
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            for bad in ("../escape", root + "/../../escape"):
                archive = stage / "bad.tar"
                with tarfile.open(archive, "w") as tar:
                    tar.addfile(tarfile.TarInfo(bad))
                with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                    bootstrap.unpack_node(archive, stage / "out")
            archive = stage / "valid.tar"
            with tarfile.open(archive, "w") as tar:
                npm = tarfile.TarInfo(root + "/bin/npm")
                npm.type = tarfile.SYMTYPE
                npm.linkname = "../lib/node_modules/npm/bin/npm-cli.js"
                tar.addfile(npm)
            out = stage / "out"
            bootstrap.unpack_node(archive, out)
            self.assertTrue((out / root / "bin/npm").is_symlink())
            with tarfile.open(archive, "w") as tar:
                npm.linkname = "/etc/passwd"
                tar.addfile(npm)
            with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                bootstrap.unpack_node(archive, stage / "other")

    def test_existing_launcher_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            original = stage / "node"
            original.write_bytes(b"keep")
            with self.assertRaisesRegex(RuntimeError, "preserved"):
                bootstrap.link_new(stage / "new-node", original)
            self.assertEqual(original.read_bytes(), b"keep")

    def test_incompatible_deck_fails_before_download(self):
        with patch.object(bootstrap, "require_wsl"), patch.object(bootstrap, "find_binary", return_value=Path("/existing/tool")), \
                patch.object(bootstrap, "version", return_value="1.0.0"), patch.object(bootstrap, "download") as download:
            with self.assertRaisesRegex(RuntimeError, "preserved"):
                bootstrap.install_user(argparse.Namespace(claude=True, codex=True))
            download.assert_not_called()

    def test_existing_supported_tools_are_reused(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bootstrap, "require_wsl"), \
                patch.object(Path, "home", return_value=Path(tmp)), \
                patch.object(bootstrap, "find_binary", side_effect=lambda name: Path("/existing") / name), \
                patch.object(bootstrap, "version", side_effect=lambda binary, name: "1.16.35" if name == "agent-deck" else "24.1.0"), \
                patch.object(bootstrap, "download") as download:
            result = bootstrap.install_user(argparse.Namespace(claude=True, codex=True))
            self.assertTrue(result["ok"])
            self.assertEqual(result["login_required"], [])
            download.assert_not_called()

    def test_claude_rejects_wrong_signing_key_before_binary_download(self):
        urls = []
        with tempfile.TemporaryDirectory() as tmp, patch.object(bootstrap, "download", side_effect=lambda url, *args: urls.append(url)), \
                patch.object(bootstrap, "run", return_value="fpr:::::::::WRONG:"):
            stage = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "fingerprint"):
                bootstrap.install_claude(stage, stage / "bin")
            self.assertFalse(any(url.endswith("/linux-x64/claude") for url in urls))


if __name__ == "__main__":
    unittest.main()
