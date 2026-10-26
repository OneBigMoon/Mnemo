#!/usr/bin/env python3
"""Portable client packaging for Mnemo.

Builds a self-contained client bundle per platform: the verified source tree,
an official Node.js runtime (checksum-verified against nodejs.org SHASUMS256),
and on the packaging platform a real ``node_modules`` so the bundle starts
offline. The bundle's launchers prefer ``runtime/`` over the system PATH (see
start-mori.*), so a machine without Node.js can still run the bundle.

Stdlib only. This is a developer-release packager, not an auto-updater.

Contract summary:
  * host source entries come from package_source.collect_entries; Rust native core
    sources are replaced with one verified binary for the selected platform;
  * the Node runtime is downloaded once into a cache dir and verified against
    the official SHASUMS256.txt before anything is staged;
  * ``runtime/`` keeps bin+lib layout on macOS and node.exe+npm on Windows;
  * bundle-only files: install-mori wrapper and CLIENT-README.txt;
  * deterministic ZIP metadata, manifest of path/size/sha256, full re-read
    verification, ordered no-replace publication with a sha256 sidecar
    (reusing package_source.publish);
  * machine-readable receipt on stdout, nonzero exit on failure.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform as host_platform
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
import importlib.util
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

TOOL = "mori-client-packager"
FORMAT = 1

FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
CREATE_SYSTEM_UNIX = 3
COMPRESS_LEVEL = 6
CORE_VERSION = "mnemo-core 0.1.1 protocol=1"

NODE_DIST_BASE = "https://nodejs.org/dist"
PLATFORMS = {
    "darwin-arm64": {
        "dist": "node-{version}-darwin-arm64.tar.gz",
        "kind": "tar",
    },
    "windows-x64": {
        "dist": "node-{version}-win-x64.zip",
        "kind": "zip",
    },
}

# Paths inside each official dist that are extracted into runtime/.
# The tarball's top-level directory name is discovered at runtime.
ZIP_RUNTIME_MEMBERS = (
    "node.exe",
    "npm",
    "npm.cmd",
    "npx",
    "npx.cmd",
    "node_modules/npm/",
    "node_modules/corepack/",
)

# Bundle-only launcher wrappers (generated, not part of the source tree).
EXECUTABLE_ENTRIES = frozenset(
    {"start-mori.command", "start-mori.sh", "install-mori.command"}
)


class PackagingError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 2, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details or {}


@dataclass
class BundleEntry:
    rel: str
    data: bytes
    mode: int
    symlink_target: str | None = None


def _load_package_source(source_root: Path):
    module_path = Path(__file__).with_name("package_source.py")
    spec = importlib.util.spec_from_file_location("mori_package_source", module_path)
    if spec is None or spec.loader is None:
        raise PackagingError("internal", "cannot load package_source.py")
    module = importlib.util.module_from_spec(spec)
    # Python 3.9 的 dataclass 解析需要模块先注册进 sys.modules。
    sys.modules.setdefault("mori_package_source", module)
    spec.loader.exec_module(module)
    # 复用同一允许清单与无覆盖发布逻辑，保证与源码发布一致。
    module.validate_source_root(source_root)
    return module


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def native_binary_entry(source_root: Path, platform: str, supplied: str | None = None) -> tuple[BundleEntry, dict]:
    name = "mnemo-core.exe" if platform == "windows-x64" else "mnemo-core"
    path = Path(supplied).expanduser() if supplied else source_root / "bin" / name
    if path.is_symlink() or not path.is_file():
        raise PackagingError(
            "native-binary-missing",
            f"provide a {platform} mnemo-core binary with --native-binary (expected {path}); build it on the target platform first",
        )
    path = path.resolve()
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PackagingError("native-binary-unreadable", f"cannot read {path}: {exc}") from exc
    if platform == "darwin-arm64":
        matches = len(data) >= 32 and data[:4] == b"\xcf\xfa\xed\xfe" and struct.unpack_from("<I", data, 4)[0] == 0x0100000C and struct.unpack_from("<I", data, 12)[0] == 2
        is_host = sys.platform == "darwin" and host_platform.machine().lower() in ("arm64", "aarch64")
    else:
        pe_offset = struct.unpack_from("<I", data, 60)[0] if len(data) >= 64 else len(data)
        matches = data[:2] == b"MZ" and pe_offset + 26 <= len(data) and data[pe_offset:pe_offset + 4] == b"PE\x00\x00" and struct.unpack_from("<H", data, pe_offset + 4)[0] == 0x8664 and struct.unpack_from("<H", data, pe_offset + 24)[0] == 0x20B
        is_host = sys.platform == "win32" and host_platform.machine().lower() in ("amd64", "x86_64")
    if not matches:
        raise PackagingError("native-binary-platform", f"{path} is not a {platform} executable; renaming a binary cannot change its target platform")
    if not is_host:
        raise PackagingError("native-binary-host-required", f"cannot execute and verify {path} on this host; package the client on a {platform} host")
    try:
        check = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        raise PackagingError("native-binary-version", f"cannot verify {path}: {exc}") from exc
    if check.returncode != 0 or check.stdout.strip() != CORE_VERSION:
        raise PackagingError("native-binary-version", f"{path} must report {CORE_VERSION!r}")
    rel = f"bin/{name}"
    return BundleEntry(rel=rel, data=data, mode=EXECUTABLE_MODE), {
        "path": rel,
        "sha256": sha256_bytes(data),
        "protocol_verified": True,
    }


def fetch(url: str, timeout: int = 120) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except Exception as exc:  # noqa: BLE001 - reported with a stable code
        raise PackagingError("download-failed", f"{url}: {type(exc).__name__}: {exc}") from exc


def resolve_node_version(requested: str | None) -> str:
    if requested:
        if not requested.startswith("v"):
            requested = f"v{requested}"
        return requested
    index = json.loads(fetch(f"{NODE_DIST_BASE}/index.json").decode("utf-8"))
    for release in index:
        if release.get("version", "").startswith("v22."):
            return release["version"]
    raise PackagingError("no-node-version", "dist index has no v22 release")


def cached_runtime(
    cache_dir: Path, version: str, platform: str
) -> tuple[Path, str]:
    """Download once and verify against the official SHASUMS256.txt."""
    spec = PLATFORMS[platform]
    archive_name = spec["dist"].format(version=version)
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path = cache_dir / archive_name
    shasums_path = cache_dir / f"SHASUMS256-{version}.txt"
    if not shasums_path.exists():
        shasums_path.write_bytes(fetch(f"{NODE_DIST_BASE}/{version}/SHASUMS256.txt"))
    wanted: str | None = None
    for line in shasums_path.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        if name.strip() == archive_name:
            wanted = digest
            break
    if not wanted:
        raise PackagingError(
            "node-shasum-missing", f"{archive_name} not in official SHASUMS256.txt"
        )
    if not archive_path.exists():
        archive_path.write_bytes(fetch(f"{NODE_DIST_BASE}/{version}/{archive_name}"))
    actual = sha256_bytes(archive_path.read_bytes())
    if actual != wanted:
        raise PackagingError(
            "node-shasum-mismatch",
            f"{archive_name}: expected {wanted}, got {actual}",
            4,
        )
    return archive_path, wanted


def runtime_entries(version: str, platform: str, archive_path: Path) -> list[BundleEntry]:
    spec = PLATFORMS[platform]
    entries: list[BundleEntry] = []
    if spec["kind"] == "tar":
        with tarfile.open(archive_path, "r:gz") as tar:
            names = tar.getnames()
            top_roots = {name.split("/", 1)[0] for name in names if "/" in name}
            if len(top_roots) != 1:
                raise PackagingError("runtime-layout", "node tarball has an unexpected layout", 4)
            root_prefix = f"{top_roots.pop()}/"
            for member in tar.getmembers():
                if not member.name.startswith(root_prefix):
                    continue
                rel = member.name[len(root_prefix):]
                if not (rel == "bin" or rel.startswith("bin/") or rel.startswith("lib/node_modules")):
                    continue
                if member.isdir() or (not member.isfile() and not member.issym()):
                    continue
                rel_prefix = "runtime/bin" if rel.startswith("bin") else "runtime/lib"
                rel = f"{rel_prefix}/{rel.split('/', 1)[1]}" if "/" in rel else rel_prefix
                if member.isdir():
                    continue
                if member.issym():
                    target = member.linkname
                    # bin 下的 npm/corepack 是指向 ../lib/... 的相对符号链接，原样保留。
                    entries.append(
                        BundleEntry(rel=rel, data=b"", mode=EXECUTABLE_MODE, symlink_target=target)
                    )
                    continue
                data = tar.extractfile(member).read()  # type: ignore[union-attr]
                mode = EXECUTABLE_MODE if member.mode & stat.S_IXUSR else FILE_MODE
                entries.append(BundleEntry(rel=rel, data=data, mode=mode))
    else:
        with zipfile.ZipFile(archive_path) as archive:
            names = archive.namelist()
            # 官方 Windows zip 的所有成员带根目录前缀（node-vX-win-x64/…），先剥离。
            roots = {name.split("/", 1)[0] for name in names if "/" in name}
            if len(roots) != 1:
                raise PackagingError(
                    "runtime-layout", "windows dist zip has an unexpected layout", 4
                )
            root_prefix = f"{roots.pop()}/"
            for name in names:
                if not name.startswith(root_prefix):
                    continue
                rel = name[len(root_prefix):]
                if not any(rel == m or rel.startswith(m) for m in ZIP_RUNTIME_MEMBERS):
                    continue
                if rel.endswith("/"):
                    continue
                info = archive.getinfo(name)
                if stat.S_ISLNK((info.external_attr >> 16) & 0o170000):
                    entries.append(
                        BundleEntry(
                            rel=f"runtime/{rel}",
                            data=b"",
                            mode=EXECUTABLE_MODE,
                            symlink_target=archive.read(name).decode("utf-8"),
                        )
                    )
                    continue
                entries.append(
                    BundleEntry(rel=f"runtime/{rel}", data=archive.read(name), mode=FILE_MODE)
                )
    if not entries:
        raise PackagingError("runtime-empty", "no runtime entries extracted", 4)
    return entries


def client_readme(platform: str, version: str, node_version: str) -> bytes:
    if platform == "windows-x64":
        return (
            "Mnemo 便携客户端（Windows）\n"
            "============================\n\n"
            f"本包自带 Node.js {node_version} 与 Windows x64 mnemo-core，无需安装 Node 或 Rust。\n\n"
            "首次使用：\n"
            "  1. 双击 start-mori.cmd 启动。首次会提示依赖未安装：\n"
            "  2. 双击 install-mori.cmd 安装依赖（需要联网一次），完成后回到第 1 步。\n\n"
            "数据默认保存在本目录的 data/ 与 downloads/ 下。\n"
            "自检：双击 start-mori.cmd 后按提示，或运行 node scripts\\local.mjs doctor。\n"
        ).encode("utf-8")
    return (
        "Mnemo 便携客户端（macOS）\n"
        "===========================\n\n"
        f"本包自带 Node.js {node_version}、macOS arm64 mnemo-core 与全部依赖，无需安装 Node 或 Rust。双击 start-mori.command 即可启动。\n\n"
        "首次从网络下载的包被 Gatekeeper 拦截时：右键 start-mori.command → 打开。\n"
        "数据默认保存在本目录的 data/ 与 downloads/ 下。\n"
        "自检：终端运行 runtime/bin/node scripts/local.mjs doctor。\n"
    ).encode("utf-8")


def install_wrapper(platform: str) -> bytes:
    if platform == "windows-x64":
        return (
            "@echo off\r\n"
            "rem Mnemo 便携客户端：安装依赖（首次需要联网）。\r\n"
            "setlocal\r\n"
            "chcp 65001 >nul\r\n"
            "set \"SCRIPT_DIR=%~dp0\"\r\n"
            "if exist \"%SCRIPT_DIR%runtime\\node.exe\" set \"PATH=%SCRIPT_DIR%runtime;%PATH%\"\r\n"
            "node \"%SCRIPT_DIR%scripts\\local.mjs\" install\r\n"
            "echo.\r\n"
            "pause\r\n"
        ).encode("utf-8")
    return (
        "#!/bin/sh\n"
        "# Mnemo 便携客户端：安装依赖（首次需要联网）。\n"
        "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd) || exit 1\n"
        "if [ -x \"$SCRIPT_DIR/runtime/bin/node\" ]; then\n"
        "  PATH=\"$SCRIPT_DIR/runtime/bin:$PATH\"\n"
        "  export PATH\n"
        "fi\n"
        "node \"$SCRIPT_DIR/scripts/local.mjs\" install\n"
        "printf '\\n按回车键关闭窗口...'\n"
        "IFS= read -r _discard || true\n"
    ).encode("utf-8")


def collect_bundle(
    module, source_root: Path, platform: str, version: str, node_version: str,
    include_node_modules: bool, native: BundleEntry,
) -> tuple[list[BundleEntry], dict]:
    source_entries = [entry for entry in module.collect_entries(source_root) if not entry.rel.startswith("rust-core/")]
    entries: list[BundleEntry] = [native]
    for entry in source_entries:
        mode = EXECUTABLE_MODE if entry.rel in EXECUTABLE_ENTRIES else FILE_MODE
        entries.append(BundleEntry(rel=entry.rel, data=entry.data, mode=mode))
    entries.append(
        BundleEntry(rel="CLIENT-README.txt", data=client_readme(platform, version, node_version), mode=FILE_MODE)
    )
    entries.append(
        BundleEntry(
            rel="install-mori.cmd" if platform == "windows-x64" else "install-mori.command",
            data=install_wrapper(platform),
            mode=EXECUTABLE_MODE,
        )
    )
    node_modules_bytes = 0
    if include_node_modules:
        with tempfile.TemporaryDirectory(prefix="mori-client-nm-") as tmp:
            staging = Path(tmp) / "bundle"
            staging.mkdir()
            for entry in source_entries:
                target = staging / entry.rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(entry.data)
            native_target = staging / native.rel
            native_target.parent.mkdir(parents=True, exist_ok=True)
            native_target.write_bytes(native.data)
            native_target.chmod(EXECUTABLE_MODE)
            ci = subprocess.run(
                ["npm", "ci", "--include=dev"],
                cwd=str(staging),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if ci.returncode != 0:
                raise PackagingError("npm-ci-failed", "npm ci failed inside staging", 1)
            node_dir = staging / "node_modules"
            for path in sorted(node_dir.rglob("*")):
                rel = f"node_modules/{path.relative_to(node_dir).as_posix()}"
                if path.is_symlink():
                    entries.append(
                        BundleEntry(rel=rel, data=b"", mode=EXECUTABLE_MODE, symlink_target=os.readlink(path))
                    )
                elif path.is_file():
                    # 保留真实权限位：node_modules 内的 bin 脚本与 esbuild
                    # 原生二进制必须是可执行的。
                    mode = path.stat().st_mode & 0o777
                    entries.append(BundleEntry(rel=rel, data=path.read_bytes(), mode=mode))
                    node_modules_bytes += path.stat().st_size
            # 独立客户端必须带构建好的前端：源码清单刻意跳过 dist/，
            # 因此在暂存目录里现场构建并把 dist/ 一并打包。
            build = subprocess.run(
                ["npm", "run", "build"],
                cwd=str(staging),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if build.returncode != 0:
                raise PackagingError("client-build-failed", "npm run build failed inside staging", 1)
            dist_dir = staging / "dist"
            for path in sorted(dist_dir.rglob("*")):
                rel = f"dist/{path.relative_to(dist_dir).as_posix()}"
                if path.is_file():
                    entries.append(BundleEntry(rel=rel, data=path.read_bytes(), mode=FILE_MODE))
    return entries, {"node_modules_bytes": node_modules_bytes}


def _zipinfo(name: str, mode: int, symlink_target: str | None) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=name, date_time=FIXED_DATE_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = CREATE_SYSTEM_UNIX
    info.create_version = 20
    info.extract_version = 20
    info.internal_attr = 0
    if symlink_target is not None:
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
    else:
        info.external_attr = (stat.S_IFREG | mode) << 16
    info.extra = b""
    info.comment = b""
    return info


def build_archive(entries: list[BundleEntry], root_name: str) -> tuple[bytes, bytes]:
    manifest = {
        "format": FORMAT,
        "kind": "mori-client-manifest",
        "root": root_name,
        "file_count": len(entries),
        "total_bytes": sum(len(entry.data) for entry in entries),
        "files": [
            {
                "path": entry.rel,
                "size": len(entry.data),
                "sha256": sha256_bytes(entry.data),
                **({"symlink": entry.symlink_target} if entry.symlink_target is not None else {}),
            }
            for entry in entries
        ],
    }
    manifest_bytes = (
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=COMPRESS_LEVEL) as archive:
        archive.writestr(_zipinfo(f"{root_name}/PACKAGE-MANIFEST.json", FILE_MODE, None), manifest_bytes)
        for entry in entries:
            if entry.symlink_target is not None:
                archive.writestr(_zipinfo(f"{root_name}/{entry.rel}", entry.mode, entry.symlink_target), entry.symlink_target)
            else:
                archive.writestr(_zipinfo(f"{root_name}/{entry.rel}", entry.mode, None), entry.data)
    return buffer.getvalue(), manifest_bytes


def verify_archive(blob: bytes, entries: list[BundleEntry], root_name: str) -> dict:
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as exc:
        raise PackagingError("verify-archive", f"archive is not a valid ZIP: {exc}", 4) from exc
    with archive:
        if archive.testzip() is not None:
            raise PackagingError("verify-crc", "CRC check failed", 4)
        expected = [f"{root_name}/PACKAGE-MANIFEST.json"] + [f"{root_name}/{entry.rel}" for entry in entries]
        if archive.namelist() != expected:
            raise PackagingError("verify-order", "archive entries do not match staged order", 4)
        for entry in entries:
            data = archive.read(f"{root_name}/{entry.rel}")
            if len(data) != len(entry.data) and entry.symlink_target is None:
                raise PackagingError("verify-entry", f"size mismatch: {entry.rel}", 4)
            if entry.symlink_target is None and sha256_bytes(data) != sha256_bytes(entry.data):
                raise PackagingError("verify-entry", f"hash mismatch: {entry.rel}", 4)
            if entry.symlink_target is not None and data.decode("utf-8") != entry.symlink_target:
                raise PackagingError("verify-entry", f"symlink target mismatch: {entry.rel}", 4)
    return {"entry_count": len(entries) + 1, "archive_bytes": len(blob)}


def package_client(
    source_root: str, output: str, platform: str, node_version: str | None, cache_dir: str,
    native_binary: str | None = None,
) -> dict:
    module = _load_package_source(Path(source_root))
    root = Path(source_root).resolve()
    if platform not in PLATFORMS:
        raise PackagingError("platform-unsupported", f"unsupported platform: {platform}")
    native, native_info = native_binary_entry(root, platform, native_binary)
    resolved_version = resolve_node_version(node_version)
    identity = json.loads((root / "package.json").read_text(encoding="utf-8"))
    name, version = identity["name"], identity["version"]
    cache = Path(cache_dir).expanduser().resolve()
    archive_path, sidecar_path = module.validate_output(output, root)
    archive_file, wanted_sha = cached_runtime(cache, resolved_version, platform)
    runtime = runtime_entries(resolved_version, platform, archive_file)
    include_node_modules = platform != "windows-x64"
    entries, stats = collect_bundle(
        module, root, platform, version, resolved_version, include_node_modules, native
    )
    entries.extend(runtime)
    seen: set[str] = set()
    for entry in entries:
        if entry.rel in seen:
            raise PackagingError("duplicate-entry", f"duplicate bundle path: {entry.rel}")
        seen.add(entry.rel)
    entries.sort(key=lambda entry: entry.rel)
    root_name = f"mnemo-client-{version}-{platform}"
    blob, manifest_bytes = build_archive(entries, root_name)
    verification = verify_archive(blob, entries, root_name)
    publication = module.Publication()
    try:
        status = module.publish(blob, archive_path, sidecar_path, publication)
    except Exception as exc:
        publication.release_temps()
        raise
    publication.release_temps()
    return {
        "format": FORMAT,
        "tool": TOOL,
        "status": status,
        "platform": platform,
        "native_binary": native_info,
        "node_version": resolved_version,
        "node_archive_sha256": wanted_sha,
        "source_root": str(root),
        "root": root_name,
        "archive": str(archive_path),
        "archive_sha256": sha256_bytes(blob),
        "archive_bytes": verification["archive_bytes"],
        "sidecar": str(sidecar_path),
        "manifest_path": f"{root_name}/PACKAGE-MANIFEST.json",
        "manifest_sha256": sha256_bytes(manifest_bytes),
        "entry_count": verification["entry_count"],
        "source_entries": len(module.collect_entries(root)),
        "runtime_entries": len(runtime),
        "includes_node_modules": include_node_modules,
        "node_modules_bytes": stats["node_modules_bytes"],
        "written": publication.written,
        "preserved": publication.preserved,
        "cleanup_failures": publication.cleanup_failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="package_client.py")
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    parser.add_argument("--output", required=True)
    parser.add_argument("--node-version", default=None)
    parser.add_argument("--native-binary", default=None, help="prebuilt mnemo-core for --platform; defaults to source-root/bin/mnemo-core[.exe]")
    parser.add_argument("--cache-dir", default=str(Path.home() / ".cache" / "mori-node-runtime"))
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        receipt = package_client(args.source_root, args.output, args.platform, args.node_version, args.cache_dir, args.native_binary)
    except PackagingError as exc:
        print(
            json.dumps(
                {"format": FORMAT, "tool": TOOL, "status": "error", "error": exc.code, "message": exc.message},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return exc.exit_code
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"format": FORMAT, "tool": TOOL, "status": "error", "error": "internal", "message": str(exc)}), file=sys.stderr)
        return 1
    if not args.quiet:
        print(json.dumps(receipt, sort_keys=True, ensure_ascii=False, indent=2 if args.pretty else None))
    return 1 if receipt.get("cleanup_failures") else 0


if __name__ == "__main__":
    sys.exit(main())
