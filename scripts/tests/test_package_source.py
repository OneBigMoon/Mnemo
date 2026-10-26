#!/usr/bin/env python3
"""Offline standard-library tests for scripts/package_source.py.

Run with either:
    python3 scripts/tests/test_package_source.py
    python3 -m unittest discover -s scripts/tests

Every test builds a fabricated fixture tree in a temporary directory; no real
project files are read and no network access is used.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "package_source.py"
_spec = importlib.util.spec_from_file_location("package_source", MODULE_PATH)
ps = importlib.util.module_from_spec(_spec)
sys.modules["package_source"] = ps
_spec.loader.exec_module(ps)

_client_spec = importlib.util.spec_from_file_location("package_client", MODULE_PATH.with_name("package_client.py"))
pc = importlib.util.module_from_spec(_client_spec)
sys.modules["package_client"] = pc
_client_spec.loader.exec_module(pc)

ROOT_NAME = "mori-media-agent-0.1.0"
MANIFEST = f"{ROOT_NAME}/{ps.MANIFEST_NAME}"

BASE_FILES: dict[str, str] = {
    "package.json": '{\n  "name": "mori-media-agent",\n  "version": "0.1.0"\n}\n',
    "package-lock.json": '{"lockfileVersion": 3}\n',
    "README.md": "# Mori\n\nMedia agent.\n",
    "LICENSE": "MIT License\n",
    "index.html": "<!doctype html>\n",
    "tsconfig.json": '{"compilerOptions": {}}\n',
    "vite.config.ts": "export default {};\n",
    "environment.example": "MORI_PORT=8787\n",
    # The three approved launchers; the POSIX pair is what users run directly.
    "start-mori.cmd": "@echo off\r\nrem launcher\r\n",
    "start-mori.command": '#!/bin/sh\nexec sh "$(dirname "$0")/start-mori.sh" "$@"\n',
    "start-mori.sh": '#!/bin/sh\nexec node "$(dirname "$0")/scripts/local.mjs" start "$@"\n',
    "server/index.ts": "export const port = 8787;\n",
    "shared/types.ts": "export type Id = string;\n",
    "src/App.tsx": "export default function App() { return null; }\n",
    "src/styles.css": "body { margin: 0; }\n",
    "tests/app.test.ts": "// smoke\n",
    # The scripts tree the launchers exec: mjs sources/tests and py sources/tests.
    "scripts/local.mjs": "#!/usr/bin/env node\nexport const TOOL_VERSION = '1.0.0';\n",
    "scripts/build_rust.mjs": "export const version = 'mnemo-core 0.1.1 protocol=1';\n",
    "scripts/package_source.py": "#!/usr/bin/env python3\n",
    "scripts/tests/local.test.mjs": "import test from 'node:test';\n",
    "scripts/tests/test_package_source.py": "import unittest\n",
    "docs/guide.md": "# Guide\n",
    "public/icon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>\n",
    "integrations/example.py": "print('ok')\n",
    "rust-core/Cargo.toml": '[package]\nname = "mnemo-core"\nversion = "0.1.1"\n',
    "rust-core/Cargo.lock": "version = 4\n",
    "rust-core/src/main.rs": "fn main() {}\n",
}

RELEASE_LAYOUT = (
    "start-mori.cmd",
    "start-mori.command",
    "start-mori.sh",
    "scripts/local.mjs",
    "scripts/build_rust.mjs",
    "scripts/package_source.py",
    "scripts/tests/local.test.mjs",
    "scripts/tests/test_package_source.py",
)


class PackageSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.src = self.base / "project"
        self.out = self.base / "out"
        self.src.mkdir()
        self.out.mkdir()

    # -- helpers ----------------------------------------------------------

    def make_tree(self, files: dict[str, str | bytes] | None = None, root: Path | None = None) -> Path:
        target = root or self.src
        payload = dict(BASE_FILES)
        payload.update(files or {})
        for rel, content in payload.items():
            path = target / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                path.write_bytes(content)
            else:
                path.write_text(content, encoding="utf-8")
        return target

    def invoke(self, *argv: str) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = ps.main(list(argv))
        return code, stdout.getvalue(), stderr.getvalue()

    def run_pack(self, output: Path | None = None, source: Path | None = None) -> tuple[int, dict | None, str]:
        target = output or (self.out / "mori.zip")
        code, stdout, stderr = self.invoke(
            "--source-root", str(source or self.src), "--output", str(target)
        )
        payload = None
        if stdout.strip():
            payload = json.loads(stdout)
        self.last_stderr = stderr
        return code, payload, stderr

    def names(self, archive: Path) -> list[str]:
        with zipfile.ZipFile(archive) as handle:
            return handle.namelist()

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.out.iterdir())

    # -- determinism ------------------------------------------------------

    def test_repeatable_archive_bytes(self) -> None:
        self.make_tree()
        first, receipt_a, _ = self.run_pack(self.out / "a.zip")
        second, receipt_b, _ = self.run_pack(self.out / "b.zip")
        self.assertEqual((first, second), (0, 0))
        self.assertEqual(
            (self.out / "a.zip").read_bytes(), (self.out / "b.zip").read_bytes()
        )
        self.assertEqual(receipt_a["archive_sha256"], receipt_b["archive_sha256"])

    def test_no_wall_clock_in_archive_bytes(self) -> None:
        self.make_tree()
        tree = ps.validate_source_root(self.src)
        name, version = ps.read_package_identity(tree)
        entries = ps.collect_entries(tree)
        early = ps.build_archive(entries, ROOT_NAME, name, version)
        late = ps.build_archive(entries, ROOT_NAME, name, version)
        self.assertEqual(early.blob, late.blob)
        self.assertNotIn(b"generated_at", early.manifest_bytes)
        self.assertNotIn(b"2026", early.manifest_bytes)

    def test_fixed_zip_metadata(self) -> None:
        self.make_tree()
        self.assertEqual(self.run_pack()[0], 0)
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            self.assertIsNone(handle.testzip())
            for info in handle.infolist():
                self.assertEqual(info.date_time, ps.FIXED_DATE_TIME)
                self.assertEqual(info.compress_type, zipfile.ZIP_DEFLATED)
                self.assertEqual(info.extra, b"")
                self.assertFalse(info.is_dir())
                self.assertEqual(info.create_system, ps.CREATE_SYSTEM_UNIX)
                rel = info.filename.split("/", 1)[1]
                expected = 0o644 if rel == ps.MANIFEST_NAME else ps.entry_mode(rel)
                self.assertEqual(info.external_attr, (stat.S_IFREG | expected) << 16)

    def test_deterministic_entry_order_and_versioned_root(self) -> None:
        self.make_tree()
        self.assertEqual(self.run_pack()[0], 0)
        names = self.names(self.out / "mori.zip")
        self.assertEqual(names[0], MANIFEST)
        self.assertEqual(names[1:], sorted(names[1:]))
        for name in names:
            self.assertTrue(name.startswith(ROOT_NAME + "/"), name)
            self.assertNotIn("..", name.split("/"))

    # -- allowlist --------------------------------------------------------

    def test_exact_allowlist(self) -> None:
        self.make_tree()
        self.assertEqual(self.run_pack()[0], 0)
        names = set(self.names(self.out / "mori.zip"))
        expected = {MANIFEST} | {
            f"{ROOT_NAME}/{rel}" for rel in BASE_FILES if rel != "package-lock.json"
        } | {f"{ROOT_NAME}/package-lock.json"}
        self.assertEqual(names, expected)

    def test_local_state_is_excluded(self) -> None:
        self.make_tree(
            {
                "node_modules/left-pad/index.ts": "module.exports = 1;\n",
                "data/mori.sqlite": b"SQLite format 3\x00",
                "data/mori.sqlite-wal": b"wal",
                "data/secret.key": "k\n",
                "output/report.json": "{}\n",
                "releases/mori-0.0.9.zip": b"PK\x03\x04old",
                "downloads/video.mp4": b"\x00",
                "dist/bundle.js": "var x;\n",
                "docs/notes.log": "log line\n",
                "docs/.env": "TOKEN=abc\n",
                ".env.local": "TOKEN=abc\n",
                "src/.cache/thing.json": "{}\n",
                "src/__pycache__/mod.py": "x = 1\n",
                "tests/.DS_Store": b"\x00",
                "integrations/private.key": "k\n",
                "docs/credentials.json": '{"token": "x"}\n',
                "docs/archive.tar.gz": b"\x1f\x8b",
                "src/server.exe": b"MZ",
            }
        )
        code, receipt, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        names = self.names(self.out / "mori.zip")
        joined = "\n".join(names)
        for forbidden in (
            "node_modules", "sqlite", ".key", "releases", "downloads", "dist/",
            "notes.log", ".env", "__pycache__", ".DS_Store", "credentials",
            ".tar.gz", ".exe", "output/",
        ):
            self.assertNotIn(forbidden, joined)
        self.assertIn(f"{ROOT_NAME}/environment.example", names)

    def test_unsupported_extension_inside_root_is_skipped(self) -> None:
        self.make_tree({"docs/tool.sh": "#!/bin/sh\n", "docs/data.bin": b"\x00\x01"})
        self.assertEqual(self.run_pack()[0], 0)
        names = self.names(self.out / "mori.zip")
        self.assertNotIn(f"{ROOT_NAME}/docs/tool.sh", names)
        self.assertNotIn(f"{ROOT_NAME}/docs/data.bin", names)

    # -- release layout: launchers plus the scripts tree they exec --------

    def test_launchers_and_scripts_tree_are_packaged(self) -> None:
        self.make_tree()
        code, receipt, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        names = set(self.names(self.out / "mori.zip"))
        for rel in RELEASE_LAYOUT:
            self.assertIn(f"{ROOT_NAME}/{rel}", names)
        self.assertEqual(
            receipt["executable_entries"], ["start-mori.command", "start-mori.sh"]
        )

    def test_packaged_layout_matches_launcher_contract(self) -> None:
        """start-mori.sh execs <root>/scripts/local.mjs, so both must ship."""
        self.make_tree()
        self.assertEqual(self.run_pack()[0], 0)
        names = self.names(self.out / "mori.zip")
        self.assertIn(f"{ROOT_NAME}/scripts/local.mjs", names)
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            launcher = handle.read(f"{ROOT_NAME}/start-mori.sh").decode("utf-8")
            wrapper = handle.read(f"{ROOT_NAME}/start-mori.command").decode("utf-8")
        self.assertIn("scripts/local.mjs", launcher)
        self.assertIn("start-mori.sh", wrapper)
        # everything still extracts into the single versioned root
        self.assertTrue(all(name.startswith(ROOT_NAME + "/") for name in names))

    def test_posix_launchers_extract_executable(self) -> None:
        self.make_tree()
        self.assertEqual(self.run_pack()[0], 0)
        dest = self.base / "extracted"
        dest.mkdir()
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            for info in handle.infolist():
                target = dest / info.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(handle.read(info))
                # what a Unix extractor applies from the central directory
                os.chmod(target, stat.S_IMODE(info.external_attr >> 16))
        for rel in ("start-mori.sh", "start-mori.command"):
            path = dest / ROOT_NAME / rel
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755, rel)
            self.assertTrue(os.access(path, os.X_OK), rel)
        for rel in ("start-mori.cmd", "scripts/local.mjs", "README.md"):
            path = dest / ROOT_NAME / rel
            self.assertFalse(os.access(path, os.X_OK), rel)

    def test_launcher_modes_ignore_source_mode(self) -> None:
        """The policy, not the checkout, decides the extracted mode."""
        self.make_tree()
        os.chmod(self.src / "start-mori.sh", 0o600)
        os.chmod(self.src / "start-mori.command", 0o640)
        os.chmod(self.src / "scripts" / "local.mjs", 0o755)
        self.assertEqual(self.run_pack()[0], 0)
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            modes = {
                rel: stat.S_IMODE(handle.getinfo(f"{ROOT_NAME}/{rel}").external_attr >> 16)
                for rel in ("start-mori.sh", "start-mori.command", "scripts/local.mjs")
            }
        self.assertEqual(modes["start-mori.sh"], 0o755)
        self.assertEqual(modes["start-mori.command"], 0o755)
        self.assertEqual(modes["scripts/local.mjs"], 0o644)

    def test_archive_bytes_do_not_depend_on_source_modes(self) -> None:
        self.make_tree()
        self.assertEqual(self.run_pack(self.out / "a.zip")[0], 0)
        os.chmod(self.src / "start-mori.sh", 0o600)
        os.chmod(self.src / "README.md", 0o755)
        self.assertEqual(self.run_pack(self.out / "b.zip")[0], 0)
        self.assertEqual(
            (self.out / "a.zip").read_bytes(), (self.out / "b.zip").read_bytes()
        )

    def test_verification_rejects_lost_launcher_exec_bit(self) -> None:
        self.make_tree()
        root = ps.validate_source_root(self.src)
        name, version = ps.read_package_identity(root)
        entries = ps.collect_entries(root)
        with mock.patch.object(ps, "entry_mode", return_value=0o644):
            built = ps.build_archive(entries, ROOT_NAME, name, version)
        with self.assertRaises(ps.PackagingError) as caught:
            ps.verify_archive(built.blob, entries, ROOT_NAME)
        self.assertEqual(caught.exception.code, "verify-mode")
        self.assertIn("start-mori", caught.exception.message)

    def test_scripts_caches_and_worker_output_are_excluded(self) -> None:
        self.make_tree(
            {
                "scripts/__pycache__/local.cpython-313.pyc": b"\x00",
                "scripts/.cache/state.json": "{}\n",
                "scripts/node_modules/dep/index.mjs": "export {};\n",
                "scripts/output/report.json": "{}\n",
                "scripts/releases/old.zip": b"PK\x03\x04",
                "scripts/tmp/scratch.mjs": "//\n",
                "scripts/notes.log": "log line\n",
                "scripts/.env": "TOKEN=abc\n",
            }
        )
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        joined = "\n".join(self.names(self.out / "mori.zip"))
        for forbidden in (
            "__pycache__", ".cache", "node_modules", "scripts/output",
            "releases", "scripts/tmp", "notes.log", ".env",
        ):
            self.assertNotIn(forbidden, joined)
        self.assertIn(f"{ROOT_NAME}/scripts/local.mjs", joined)

    def test_required_layout_is_declared_consistently(self) -> None:
        self.assertTrue(set(ps.REQUIRED_SOURCE_ROOTS) <= set(ps.SOURCE_ROOTS))
        self.assertTrue(set(ps.REQUIRED_TOP_LEVEL) <= set(ps.TOP_LEVEL_FILES))
        # an executable entry must be packageable, otherwise the policy is dead
        self.assertTrue(ps.EXECUTABLE_ENTRIES <= set(ps.TOP_LEVEL_FILES))
        self.assertTrue(ps.EXECUTABLE_ENTRIES.isdisjoint(ps.SENSITIVE_FILE_NAMES))

    def test_rust_source_and_lock_ship_without_build_products(self) -> None:
        self.make_tree({
            "rust-core/target/release/mnemo-core": b"native",
            "rust-core/target/.rustc_info.json": "{}\n",
            "rust-core/target/debug/deps/generated.rs": "// generated\n",
            "bin/mnemo-core.exe": b"MZ",
        })
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        names = set(self.names(self.out / "mori.zip"))
        for rel in ("rust-core/Cargo.toml", "rust-core/Cargo.lock", "rust-core/src/main.rs", "scripts/build_rust.mjs"):
            self.assertIn(f"{ROOT_NAME}/{rel}", names)
        self.assertFalse(any("/target/" in name or "/bin/" in name for name in names))

    def test_missing_rust_manifest_lock_or_builder_is_rejected(self) -> None:
        for index, rel in enumerate(("rust-core/Cargo.toml", "rust-core/Cargo.lock", "scripts/build_rust.mjs")):
            with self.subTest(rel=rel):
                self.make_tree()
                (self.src / rel).unlink()
                code, _, stderr = self.run_pack(self.out / f"missing-rust-{index}.zip")
                self.assertEqual(code, 2)
                self.assertIn(rel, json.loads(stderr)["message"])

    def test_client_rejects_missing_binary_before_runtime_download(self) -> None:
        self.make_tree()
        with mock.patch.object(pc, "resolve_node_version") as resolve_version:
            with self.assertRaises(pc.PackagingError) as caught:
                pc.package_client(str(self.src), str(self.out / "client.zip"), "windows-x64", None, str(self.base / "cache"))
        self.assertEqual(caught.exception.code, "native-binary-missing")
        resolve_version.assert_not_called()

    def test_client_rejects_a_mac_binary_renamed_as_exe(self) -> None:
        self.make_tree()
        binary = self.src / "bin" / "mnemo-core.exe"
        binary.parent.mkdir()
        binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00" * 60)
        with self.assertRaises(pc.PackagingError) as caught:
            pc.native_binary_entry(self.src, "windows-x64")
        self.assertEqual(caught.exception.code, "native-binary-platform")

    def test_windows_client_requires_target_host_and_verified_protocol(self) -> None:
        self.make_tree()
        data = bytearray(256)
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 60, 128)
        data[128:132] = b"PE\x00\x00"
        struct.pack_into("<H", data, 132, 0x8664)
        struct.pack_into("<H", data, 152, 0x20B)
        binary = self.src / "bin" / "mnemo-core.exe"
        binary.parent.mkdir()
        binary.write_bytes(data)
        with mock.patch.object(pc.sys, "platform", "linux"), mock.patch.object(pc.subprocess, "run") as run:
            with self.assertRaises(pc.PackagingError) as caught:
                pc.native_binary_entry(self.src, "windows-x64")
        self.assertEqual(caught.exception.code, "native-binary-host-required")
        run.assert_not_called()
        for output in ("v22.13.0", "mnemo-core 0.1.0 protocol=1", "mnemo-core 0.1.1 protocol=2"):
            with self.subTest(output=output), mock.patch.object(pc.sys, "platform", "win32"), mock.patch.object(pc.host_platform, "machine", return_value="AMD64"), mock.patch.object(pc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output, "")):
                with self.assertRaises(pc.PackagingError) as caught:
                    pc.native_binary_entry(self.src, "windows-x64")
            self.assertEqual(caught.exception.code, "native-binary-version")
        with mock.patch.object(pc.sys, "platform", "win32"), mock.patch.object(pc.host_platform, "machine", return_value="AMD64"), mock.patch.object(pc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, pc.CORE_VERSION + "\n", "")) as run:
            native, info = pc.native_binary_entry(self.src, "windows-x64")
        run.assert_called_once()
        self.assertTrue(info["protocol_verified"])
        self.assertEqual(info["sha256"], ps.sha256_bytes(bytes(data)))
        entries, _ = pc.collect_bundle(ps, self.src, "windows-x64", "0.1.0", "v22.13.0", False, native)
        by_name = {entry.rel: entry for entry in entries}
        self.assertEqual(by_name["bin/mnemo-core.exe"].data, data)
        self.assertIn("scripts/build_rust.mjs", by_name)
        self.assertFalse(any(name.startswith("rust-core/") for name in by_name))
        self.assertIn("无需安装 Node 或 Rust", by_name["CLIENT-README.txt"].data.decode())

    def test_host_client_rejects_protocol_mismatch(self) -> None:
        self.make_tree()
        data = bytearray(32)
        data[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<I", data, 4, 0x0100000C)
        struct.pack_into("<I", data, 12, 2)
        binary = self.src / "bin" / "mnemo-core"
        binary.parent.mkdir()
        binary.write_bytes(data)
        with mock.patch.object(pc.sys, "platform", "darwin"), mock.patch.object(pc.host_platform, "machine", return_value="arm64"), mock.patch.object(pc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "mnemo-core 0.1.1 protocol=2\n", "")):
            with self.assertRaises(pc.PackagingError) as caught:
                pc.native_binary_entry(self.src, "darwin-arm64")
        self.assertEqual(caught.exception.code, "native-binary-version")

    # -- required inputs --------------------------------------------------

    def test_missing_package_json(self) -> None:
        self.make_tree()
        (self.src / "package.json").unlink()
        code, receipt, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertIsNone(receipt)
        self.assertEqual(json.loads(stderr)["error"], "missing-required-input")
        self.assertFalse((self.out / "mori.zip").exists())

    def test_missing_readme(self) -> None:
        self.make_tree()
        (self.src / "README.md").unlink()
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "missing-required-input")

    def test_missing_source_roots(self) -> None:
        self.make_tree()
        for name in ps.SOURCE_ROOTS:
            if (self.src / name).is_dir():
                for child in sorted((self.src / name).rglob("*"), reverse=True):
                    child.unlink() if child.is_file() else child.rmdir()
                (self.src / name).rmdir()
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "missing-required-input")

    def test_source_root_does_not_exist(self) -> None:
        code, _, stderr = self.run_pack(source=self.base / "absent")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "source-root-missing")

    def test_invalid_package_version(self) -> None:
        self.make_tree({"package.json": '{"name": "mori-media-agent", "version": "../x"}\n'})
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "invalid-package-version")

    def test_missing_launcher_is_rejected(self) -> None:
        """A release without an approved entrypoint must not be produced."""
        for index, name in enumerate(RELEASE_LAYOUT[:3]):
            with self.subTest(name=name):
                self.make_tree()
                (self.src / name).unlink()
                target = self.out / f"missing-{index}.zip"
                code, _, stderr = self.run_pack(target)
                self.assertEqual(code, 2)
                payload = json.loads(stderr)
                self.assertEqual(payload["error"], "missing-required-input")
                self.assertIn(name, payload["message"])
                self.assertFalse(target.exists())
                self.assertEqual(self.leftovers(), [])

    def test_missing_scripts_root_is_rejected(self) -> None:
        """The launchers exec scripts/local.mjs; without the tree nothing works."""
        self.make_tree()
        for child in sorted((self.src / "scripts").rglob("*"), reverse=True):
            child.unlink() if child.is_file() else child.rmdir()
        (self.src / "scripts").rmdir()
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "missing-required-input")
        self.assertIn("scripts", payload["message"])
        self.assertEqual(self.leftovers(), [])

    # -- symlinks and escapes --------------------------------------------

    def test_symlink_file_is_rejected(self) -> None:
        outside = self.base / "outside.ts"
        outside.write_text("export const leaked = 1;\n", encoding="utf-8")
        self.make_tree()
        os.symlink(outside, self.src / "src" / "linked.ts")
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "symlink")
        self.assertFalse((self.out / "mori.zip").exists())
        self.assertEqual(self.leftovers(), [])

    def test_symlink_directory_is_rejected(self) -> None:
        outside = self.base / "outside_dir"
        outside.mkdir()
        (outside / "leak.ts").write_text("export const x = 1;\n", encoding="utf-8")
        self.make_tree()
        os.symlink(outside, self.src / "docs" / "linked")
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "symlink")
        self.assertEqual(self.leftovers(), [])

    def test_top_level_symlink_is_rejected(self) -> None:
        outside = self.base / "real_readme.md"
        outside.write_text("# elsewhere\n", encoding="utf-8")
        self.make_tree()
        (self.src / "README.md").unlink()
        os.symlink(outside, self.src / "README.md")
        code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "symlink")

    def test_unreadable_directory_is_reported(self) -> None:
        self.make_tree()

        def failing_walk(top, **kwargs):
            kwargs["onerror"](OSError(13, "Permission denied", str(top)))
            return iter(())

        with mock.patch.object(ps.os, "walk", side_effect=failing_walk):
            code, _, stderr = self.run_pack()
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "unreadable-directory")
        self.assertEqual(self.leftovers(), [])

    def test_output_inside_source_root_is_rejected(self) -> None:
        self.make_tree()
        code, _, stderr = self.run_pack(self.src / "mori.zip")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "output-inside-source-root")
        self.assertFalse((self.src / "mori.zip").exists())

    def test_output_must_be_zip(self) -> None:
        self.make_tree()
        code, _, stderr = self.run_pack(self.out / "mori.tar")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "output-extension")

    def test_output_parent_must_exist(self) -> None:
        self.make_tree()
        code, _, stderr = self.run_pack(self.base / "nope" / "mori.zip")
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stderr)["error"], "output-parent-missing")

    # -- publication ------------------------------------------------------

    def test_existing_different_destination_is_preserved(self) -> None:
        self.make_tree()
        target = self.out / "mori.zip"
        target.write_bytes(b"PK\x05\x06" + b"\x00" * 18)
        before = target.read_bytes()
        code, receipt, stderr = self.run_pack(target)
        self.assertEqual(code, 3)
        self.assertIsNone(receipt)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "destination-exists")
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((self.out / "mori.zip.sha256").exists())
        self.assertEqual(self.leftovers(), ["mori.zip"])

    def test_identical_destination_is_idempotent(self) -> None:
        self.make_tree()
        target = self.out / "mori.zip"
        self.assertEqual(self.run_pack(target)[0], 0)
        digest = target.read_bytes()
        sidecar = (self.out / "mori.zip.sha256").read_bytes()

        code, receipt, stderr = self.run_pack(target)
        self.assertEqual(code, 0, stderr)
        self.assertEqual(receipt["status"], "already-present")
        self.assertEqual(receipt["written"], [])
        self.assertEqual(target.read_bytes(), digest)
        self.assertEqual((self.out / "mori.zip.sha256").read_bytes(), sidecar)
        self.assertEqual(self.leftovers(), ["mori.zip", "mori.zip.sha256"])

    def test_conflicting_sidecar_is_preserved(self) -> None:
        self.make_tree()
        sidecar = self.out / "mori.zip.sha256"
        sidecar.write_text("0" * 64 + "  mori.zip\n", encoding="utf-8")
        code, _, stderr = self.run_pack(self.out / "mori.zip")
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(stderr)["error"], "destination-exists")
        self.assertFalse((self.out / "mori.zip").exists())
        self.assertEqual(sidecar.read_text(encoding="utf-8"), "0" * 64 + "  mori.zip\n")

    def test_failure_cleans_up_temporary_files(self) -> None:
        self.make_tree()
        with mock.patch.object(
            ps, "verify_archive", side_effect=ps.PackagingError("verify-entry", "boom", 4)
        ):
            code, _, stderr = self.run_pack()
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(stderr)["error"], "verify-entry")
        self.assertEqual(self.leftovers(), [])

    def test_archive_publish_failure_leaves_nothing_behind(self) -> None:
        self.make_tree()
        with mock.patch.object(
            ps, "_link_no_replace", side_effect=OSError("no hard links here")
        ):
            code, _, _ = self.run_pack()
        self.assertEqual(code, 1)
        self.assertEqual(self.leftovers(), [])

    def test_sidecar_failure_keeps_the_published_archive(self) -> None:
        """Publication is ordered, not transactional: no rollback by pathname."""
        self.make_tree()
        (self.out / "keep.txt").write_text("keep\n", encoding="utf-8")
        real_stage = ps._stage
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:  # archive staged, then the sidecar fails
                raise OSError(28, "No space left on device")
            return real_stage(*args, **kwargs)

        with mock.patch.object(ps, "_stage", side_effect=flaky):
            code, _, stderr = self.run_pack()
        self.assertEqual(code, ps.EXIT_PARTIAL)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "partial-publication")
        self.assertEqual(payload["details"]["cause"], "OSError")
        self.assertTrue(payload["details"]["archive_matches"])
        self.assertIn("rerun", payload["message"])
        # the archive is a complete, verified artifact and stays; only the
        # sidecar is missing, and the unrelated file is untouched
        self.assertEqual(self.leftovers(), ["keep.txt", "mori.zip"])
        self.assertEqual(
            payload["details"]["archive_sha256"], ps.sha256_file(self.out / "mori.zip")
        )

    def test_foreign_replacement_of_archive_survives_sidecar_failure(self) -> None:
        """A pathname this invocation once used is not proof of ownership."""
        self.make_tree()
        target = self.out / "mori.zip"
        foreign = b"foreign-owner-sentinel\n"
        real_link = ps._link_no_replace
        calls = {"n": 0}

        def link_then_replace(temp, destination):
            calls["n"] += 1
            if calls["n"] == 1:
                real_link(temp, destination)  # the archive is promoted ...
                destination.unlink()  # ... then another owner takes the name
                destination.write_bytes(foreign)
                return
            raise OSError(5, "Input/output error")  # the sidecar fails

        with mock.patch.object(ps, "_link_no_replace", side_effect=link_then_replace):
            code, _, stderr = self.run_pack()
        self.assertEqual(code, ps.EXIT_PARTIAL)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "partial-publication")
        self.assertEqual(payload["details"]["cause"], "OSError")
        self.assertFalse(payload["details"]["archive_matches"])
        self.assertEqual(target.read_bytes(), foreign)

    def test_retry_after_partial_publication_finishes_the_sidecar(self) -> None:
        self.make_tree()
        real_stage = ps._stage
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError(28, "No space left on device")
            return real_stage(*args, **kwargs)

        with mock.patch.object(ps, "_stage", side_effect=flaky):
            self.assertEqual(self.run_pack()[0], ps.EXIT_PARTIAL)
        archive_bytes = (self.out / "mori.zip").read_bytes()

        code, receipt, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        self.assertEqual(receipt["status"], "published")
        # the receipt reports resolved paths (macOS /var is a /private/var alias)
        self.assertEqual(receipt["written"], [str((self.out / "mori.zip.sha256").resolve())])
        self.assertEqual(receipt["preserved"], [str((self.out / "mori.zip").resolve())])
        self.assertEqual((self.out / "mori.zip").read_bytes(), archive_bytes)
        self.assertEqual(
            (self.out / "mori.zip.sha256").read_text(encoding="utf-8"),
            f"{ps.sha256_file(self.out / 'mori.zip')}  mori.zip\n",
        )

    def test_cleanup_failure_is_reported_not_hidden(self) -> None:
        """A refused unlink must not pass as a clean, complete success."""
        self.make_tree()
        real_unlink = Path.unlink

        def deny_staged_files(self_path, *args, **kwargs):
            if self_path.name.startswith(".") and self_path.name.endswith(".tmp"):
                raise PermissionError(1, "Operation not permitted")
            return real_unlink(self_path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", autospec=True, side_effect=deny_staged_files):
            code, receipt, stderr = self.run_pack()
        self.assertEqual(code, ps.EXIT_CLEANUP)
        self.assertEqual(stderr, "")
        self.assertEqual(receipt["status"], "published")
        self.assertEqual(len(receipt["cleanup_failures"]), 2)
        for failure in receipt["cleanup_failures"]:
            self.assertTrue(failure["path"].endswith(".tmp"), failure["path"])
            self.assertIn("PermissionError", failure["error"])
        # the published release is still valid and was not deleted
        archive = self.out / "mori.zip"
        self.assertEqual(receipt["archive_sha256"], ps.sha256_file(archive))
        self.assertEqual(
            (self.out / "mori.zip.sha256").read_text(encoding="utf-8"),
            f"{ps.sha256_file(archive)}  mori.zip\n",
        )
        self.assertEqual(len(self.leftovers()), 4)

    def test_cleanup_failure_does_not_hide_the_publication_error(self) -> None:
        self.make_tree()
        real_stage = ps._stage
        real_unlink = Path.unlink
        calls = {"n": 0}

        def flaky_stage(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError(28, "No space left on device")
            return real_stage(*args, **kwargs)

        def deny_staged_files(self_path, *args, **kwargs):
            if self_path.name.startswith(".") and self_path.name.endswith(".tmp"):
                raise PermissionError(1, "Operation not permitted")
            return real_unlink(self_path, *args, **kwargs)

        with mock.patch.object(ps, "_stage", side_effect=flaky_stage), \
                mock.patch.object(Path, "unlink", autospec=True, side_effect=deny_staged_files):
            code, _, stderr = self.run_pack()
        self.assertEqual(code, ps.EXIT_PARTIAL)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "partial-publication")
        self.assertEqual(payload["details"]["cause"], "OSError")
        self.assertEqual(len(payload["details"]["cleanup_failures"]), 1)
        self.assertTrue((self.out / "mori.zip").is_file())

    def test_fallback_cleanup_never_removes_a_foreign_replacement(self) -> None:
        """Without hard links, a failed copy must not delete someone else's file."""
        self.make_tree()
        target = self.out / "mori.zip"
        foreign = b"foreign-owner-sentinel\n"

        def replace_then_fail(source, destination):
            target.unlink()
            target.write_bytes(foreign)
            raise OSError(5, "Input/output error")

        with mock.patch.object(ps.os, "link", side_effect=OSError(1, "Operation not permitted")):
            with mock.patch.object(ps.shutil, "copyfileobj", side_effect=replace_then_fail):
                code, _, _ = self.run_pack()
        self.assertEqual(code, 1)
        self.assertEqual(target.read_bytes(), foreign)
        self.assertEqual(self.leftovers(), ["mori.zip"])

    def test_fallback_cleanup_failure_is_reported_and_blocks_retry(self) -> None:
        self.make_tree()
        target = self.out / "mori.zip"
        sidecar = self.out / "mori.zip.sha256"
        real_copy = ps.shutil.copyfileobj
        real_unlink = ps.os.unlink

        def fail_sidecar_copy(source, destination):
            if Path(source.name).name.startswith(".mori.zip.sha256."):
                destination.write(b"incomplete sidecar\n")
                raise OSError(5, "Input/output error")
            return real_copy(source, destination)

        def deny_partial_sidecar(path, *args, **kwargs):
            if Path(path).name == sidecar.name:
                raise PermissionError(1, "Operation not permitted")
            return real_unlink(path, *args, **kwargs)

        with mock.patch.object(ps.os, "link", side_effect=OSError(95, "Operation not supported")), \
                mock.patch.object(ps.shutil, "copyfileobj", side_effect=fail_sidecar_copy), \
                mock.patch.object(ps.os, "unlink", side_effect=deny_partial_sidecar):
            code, _, stderr = self.run_pack(target)

        self.assertEqual(code, ps.EXIT_PARTIAL)
        payload = json.loads(stderr)
        self.assertEqual(payload["error"], "partial-publication")
        self.assertIn("Input/output error", payload["message"])
        self.assertTrue(payload["details"]["archive_matches"])
        failures = payload["details"]["cleanup_failures"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["path"], str(sidecar.resolve()))
        self.assertIn("PermissionError", failures[0]["error"])
        self.assertEqual(sidecar.read_bytes(), b"incomplete sidecar\n")
        self.assertEqual(self.leftovers(), ["mori.zip", "mori.zip.sha256"])

        code, _, stderr = self.run_pack(target)
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(stderr)["error"], "destination-exists")
        self.assertEqual(sidecar.read_bytes(), b"incomplete sidecar\n")

    def test_identical_archive_survives_conflicting_sidecar(self) -> None:
        """Never delete an artifact this invocation did not create."""
        self.make_tree()
        target = self.out / "mori.zip"
        self.assertEqual(self.run_pack(target)[0], 0)
        before = target.read_bytes()

        sidecar = self.out / "mori.zip.sha256"
        sidecar.unlink()
        sidecar.write_text("0" * 64 + "  mori.zip\n", encoding="utf-8")

        code, _, stderr = self.run_pack(target)
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(stderr)["error"], "destination-exists")
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(sidecar.read_text(encoding="utf-8"), "0" * 64 + "  mori.zip\n")
        self.assertEqual(self.leftovers(), ["mori.zip", "mori.zip.sha256"])

    # -- manifest and hashes ---------------------------------------------

    def test_manifest_matches_archive(self) -> None:
        self.make_tree()
        code, receipt, _ = self.run_pack()
        self.assertEqual(code, 0)
        archive = self.out / "mori.zip"
        with zipfile.ZipFile(archive) as handle:
            manifest = json.loads(handle.read(MANIFEST))
            self.assertEqual(manifest["root"], ROOT_NAME)
            self.assertEqual(manifest["file_count"], len(manifest["files"]))
            self.assertNotIn(MANIFEST.split("/", 1)[1], [f["path"] for f in manifest["files"]])
            total = 0
            for record in manifest["files"]:
                data = handle.read(f"{ROOT_NAME}/{record['path']}")
                self.assertEqual(record["size"], len(data))
                self.assertEqual(record["sha256"], ps.sha256_bytes(data))
                total += len(data)
            self.assertEqual(manifest["total_bytes"], total)
            self.assertEqual(receipt["entry_count"], len(manifest["files"]) + 1)

    def test_sidecar_matches_archive(self) -> None:
        self.make_tree()
        code, receipt, _ = self.run_pack()
        self.assertEqual(code, 0)
        archive = self.out / "mori.zip"
        sidecar = (self.out / "mori.zip.sha256").read_text(encoding="utf-8")
        self.assertEqual(sidecar, f"{ps.sha256_file(archive)}  mori.zip\n")
        self.assertEqual(receipt["archive_sha256"], ps.sha256_file(archive))
        self.assertEqual(receipt["archive_bytes"], archive.stat().st_size)

    def test_receipt_has_execution_time_but_archive_does_not(self) -> None:
        self.make_tree()
        code, receipt, _ = self.run_pack()
        self.assertEqual(code, 0)
        self.assertRegex(receipt["generated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(receipt["status"], "published")
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            for name in handle.namelist():
                self.assertNotIn("generated_at", handle.read(name).decode("utf-8", "ignore"))

    # -- unusual paths ----------------------------------------------------

    def test_non_ascii_and_space_paths(self) -> None:
        self.make_tree(
            {
                "docs/设计 说明.md": "# 设计\n",
                "src/über file.ts": "export const u = 1;\n",
                "public/图标 1.svg": "<svg/>\n",
            }
        )
        code, receipt, stderr = self.run_pack()
        self.assertEqual(code, 0, stderr)
        names = self.names(self.out / "mori.zip")
        for rel in ("docs/设计 说明.md", "src/über file.ts", "public/图标 1.svg"):
            self.assertIn(f"{ROOT_NAME}/{rel}", names)
        with zipfile.ZipFile(self.out / "mori.zip") as handle:
            self.assertEqual(handle.read(f"{ROOT_NAME}/docs/设计 说明.md"), "# 设计\n".encode())
            manifest = json.loads(handle.read(MANIFEST))
        self.assertIn("docs/设计 说明.md", [f["path"] for f in manifest["files"]])

        second = self.out / "again.zip"
        self.assertEqual(self.run_pack(second)[0], 0)
        self.assertEqual(receipt["archive_sha256"], ps.sha256_file(second))

    # -- entry point ------------------------------------------------------

    def test_cli_subprocess_receipt_and_exit_code(self) -> None:
        self.make_tree()
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH), "--source-root", str(self.src),
             "--output", str(self.out / "mori.zip")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "published")
        self.assertEqual(receipt["archive_sha256"], ps.sha256_file(self.out / "mori.zip"))

    def test_cli_failure_exit_code(self) -> None:
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH), "--source-root", str(self.base / "absent"),
             "--output", str(self.out / "mori.zip")],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["error"], "source-root-missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
