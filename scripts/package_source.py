#!/usr/bin/env python3
"""Reproducible source packaging for Mnemo developer releases.

Builds one deterministic ZIP archive from an explicit source root, verifies it,
and publishes it without ever replacing an existing artifact. Standard library
only. This is a developer-release source packager, not an end-user installer.

Contract summary:
  * positive allowlist of source roots, top-level files and extensions;
  * the release carries the launchers and the ``scripts`` tree they call, so an
    extracted archive is runnable without a checkout;
  * deterministic entry order, fixed timestamps, fixed permissions, with a
    deterministic executable-entry policy for the approved POSIX launchers;
  * a manifest of relative path, size and SHA256 inside the archive;
  * full re-verification of every entry and of the ZIP before publication;
  * ordered no-replace publication with a sha256 sidecar: the archive is
    promoted first and is never rolled back, so a sidecar failure leaves a
    valid archive that a hash-checked retry can finish (exit 5);
  * per-invocation temporary files, removed after publication; a refused
    cleanup is reported (exit 6) instead of passing as a clean run;
  * machine-readable receipt on stdout, nonzero exit on failure.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

TOOL = "mori-source-packager"
FORMAT = 1
MANIFEST_NAME = "SOURCE-MANIFEST.json"

# Fixed metadata: 1980-01-01T00:00:00 is the minimum representable ZIP time and
# keeps the archive bytes free of wall-clock data.
FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
CREATE_SYSTEM_UNIX = 3
COMPRESS_LEVEL = 9

# Exit codes beyond the classic 0/1/2/3/4: a release that exists but is not
# fully finished must not look like a plain success.
EXIT_PARTIAL = 5  # archive published; resolve sidecar/cleanup failures before retry
EXIT_CLEANUP = 6  # published, but staging files could not be removed

# Deterministic executable-entry policy. These are the approved entrypoints that
# a user runs directly on macOS/Linux, so they must still carry the exec bit
# after extraction. The mode is derived from this allowlist and never from the
# source file's own mode: a checkout that lost its exec bits (or a Windows
# checkout, which has none) still produces a correct release. The Windows
# launcher is invoked by the shell and is deliberately left at FILE_MODE.
EXECUTABLE_ENTRIES = frozenset({"start-mori.command", "start-mori.sh"})

SOURCE_ROOTS = (
    "docs",
    "integrations",
    "public",
    "rust-core",
    "scripts",
    "server",
    "shared",
    "src",
    "tests",
)

# Roots without which the release cannot start: the launchers exec
# <root>/scripts/local.mjs, so shipping the launchers without this tree would
# produce a package that fails on the first run.
REQUIRED_SOURCE_ROOTS = ("scripts", "rust-core")
REQUIRED_SOURCE_FILES = (
    "scripts/build_rust.mjs",
    "rust-core/Cargo.toml",
    "rust-core/Cargo.lock",
)

TOP_LEVEL_FILES = (
    ".dockerignore",
    ".gitignore",
    "Dockerfile",
    "LICENSE",
    "README.md",
    "compose.yaml",
    "environment.example",
    "index.html",
    "package-lock.json",
    "package.json",
    "start-mori.cmd",
    "start-mori.command",
    "start-mori.sh",
    "tsconfig.json",
    "vite.config.ts",
)

# A source release is meaningless without these.
REQUIRED_TOP_LEVEL = (
    "LICENSE",
    "README.md",
    "package.json",
    "start-mori.cmd",
    "start-mori.command",
    "start-mori.sh",
)

ALLOWED_EXTENSIONS = frozenset(
    {
        ".ts", ".tsx", ".js", ".css", ".py", ".mjs", ".json", ".md", ".yml", ".yaml",
        ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".webmanifest", ".zip", ".lock",
        ".in", ".txt", ".rs", ".toml",
    }
)

# Never descend into these, whatever the root.
SKIP_DIR_NAMES = frozenset(
    {
        "node_modules", "bower_components", ".git", ".hg", ".svn",
        ".venv", "venv", "env", "__pycache__", ".pytest_cache",
        ".mypy_cache", ".ruff_cache", ".cache", "dist", "build",
        "coverage", ".next", ".turbo", "releases", "downloads",
        "output", "data", "logs", "tmp", "temp", ".idea", ".vscode", "target",
    }
)

# Defence in depth: these never enter a package even if an extension matched.
SENSITIVE_FILE_NAMES = frozenset(
    {
        ".env", ".env.local", ".env.production", ".npmrc", ".netrc",
        "credentials.json", "secrets.json", "id_rsa", "id_ed25519",
        ".DS_Store", "Thumbs.db",
    }
)
SENSITIVE_SUFFIXES = frozenset(
    {".key", ".pem", ".p12", ".pfx", ".crt", ".sqlite", ".sqlite3", ".db", ".log", ".bak", ".swp", ".tmp"}
)

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$")


class PackagingError(Exception):
    """A validation, publication or verification failure with a stable code."""

    def __init__(self, code: str, message: str, exit_code: int = 2, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.details = details or {}


@dataclass(frozen=True)
class Entry:
    """One source file staged for the archive."""

    rel: str
    size: int
    sha256: str
    data: bytes


@dataclass(frozen=True)
class Built:
    """The finished archive bytes plus the manifest they contain."""

    blob: bytes
    manifest_bytes: bytes


@dataclass
class Publication:
    """Bookkeeping for one invocation's staging files and published paths."""

    temps: list[Path] = field(default_factory=list)
    written: list[str] = field(default_factory=list)
    preserved: list[str] = field(default_factory=list)
    cleanup_failures: list[dict] = field(default_factory=list)

    def release_temps(self) -> None:
        """Remove this invocation's staging files; safe to call repeatedly.

        A staging file that cannot be removed stays in ``temps`` (so a later
        call can retry) and is recorded in ``cleanup_failures``. Cleanup trouble
        is reported, never swallowed: a leftover ``.tmp`` is not a clean run.
        """
        remaining: list[Path] = []
        failures: list[dict] = []
        for path in self.temps:
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError as exc:
                remaining.append(path)
                failures.append(
                    {
                        "path": str(path),
                        "error": f"{type(exc).__name__}: {exc.strerror or exc}",
                    }
                )
        self.temps = remaining
        self.cleanup_failures = failures


def sha256_bytes(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def entry_mode(rel: str) -> int:
    """Deterministic permission for one archive entry.

    Derived from the approved-entrypoint allowlist only, so the archive bytes
    and the extracted modes never depend on the source checkout's own bits.
    """
    return EXECUTABLE_MODE if rel in EXECUTABLE_ENTRIES else FILE_MODE


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _unlink_if_same_file(path: Path, identity: os.stat_result) -> bool:
    """Remove ``path`` only while it is still the very file we created.

    A pathname is not proof of ownership: another owner can replace the name
    between our create and our failure. The (device, inode) pair captured at
    creation is proof, so a file that no longer matches is left alone.
    """
    try:
        current = os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
        return False
    try:
        os.unlink(path)
    except FileNotFoundError:
        return False
    return True


def _sha256_or_none(path: Path) -> str | None:
    """Hash a regular file, or return None if it is absent or unreadable."""
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return sha256_file(path)
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_source_root(raw: str | os.PathLike[str]) -> Path:
    """Resolve and validate an explicit source root before anything is read."""
    path = Path(raw).expanduser()
    if path.is_symlink():
        raise PackagingError("source-root-symlink", f"source root must not be a symlink: {path}")
    if not path.exists():
        raise PackagingError("source-root-missing", f"source root does not exist: {path}")
    if not path.is_dir():
        raise PackagingError("source-root-not-directory", f"source root is not a directory: {path}")
    resolved = path.resolve()
    if resolved == Path(resolved.anchor):
        raise PackagingError("source-root-too-broad", f"refusing to package a filesystem root: {resolved}")
    return resolved


def validate_output(
    raw: str | os.PathLike[str], source_root: Path
) -> tuple[Path, Path]:
    """Validate the archive target and derive its sha256 sidecar path."""
    path = Path(raw).expanduser()
    if path.name in ("", ".", ".."):
        raise PackagingError("output-invalid", f"output must be a file path: {path}")
    if path.suffix.lower() != ".zip":
        raise PackagingError("output-extension", f"output must end with .zip: {path}")
    if path.name == path.suffix:
        raise PackagingError("output-invalid", f"output needs a name before .zip: {path}")

    parent = path.parent
    if parent.is_symlink():
        raise PackagingError("output-parent-symlink", f"output directory must not be a symlink: {parent}")
    if not parent.exists():
        raise PackagingError("output-parent-missing", f"output directory does not exist: {parent}")
    if not parent.is_dir():
        raise PackagingError("output-parent-not-directory", f"output parent is not a directory: {parent}")

    parent = parent.resolve()
    target = parent / path.name
    if target.is_symlink():
        raise PackagingError("output-symlink", f"refusing to publish through a symlink: {target}")
    if target.is_dir():
        raise PackagingError("output-is-directory", f"output is a directory: {target}")
    if target.is_relative_to(source_root):
        raise PackagingError(
            "output-inside-source-root",
            f"output must live outside the source root: {target}",
        )
    return target, target.with_name(target.name + ".sha256")


def read_package_identity(source_root: Path) -> tuple[str, str]:
    """Read name and version from the source root's package.json."""
    manifest = source_root / "package.json"
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except OSError as exc:
        raise PackagingError("missing-required-input", f"cannot read {manifest}: {exc}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackagingError("invalid-package-json", f"{manifest} is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise PackagingError("invalid-package-json", f"{manifest} must contain a JSON object")

    name = payload.get("name")
    version = payload.get("version")
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise PackagingError("invalid-package-name", f"unsupported package name: {name!r}")
    if not isinstance(version, str) or not _VERSION_RE.match(version):
        raise PackagingError("invalid-package-version", f"unsupported package version: {version!r}")
    return name, version


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _raise_walk_error(exc: OSError) -> None:
    """A directory we cannot read would silently truncate the package."""
    raise PackagingError(
        "unreadable-directory",
        f"cannot read {exc.filename or '<unknown>'}: {exc.strerror or exc}",
    )


def _walk_root(base: Path, source_root: Path) -> list[tuple[str, Path]]:
    """Walk one source root, applying the positive allowlist and symlink policy."""
    found: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(
        base, topdown=True, onerror=_raise_walk_error, followlinks=False
    ):
        current = Path(dirpath)
        kept: list[str] = []
        for dirname in sorted(dirnames):
            candidate = current / dirname
            if dirname in SKIP_DIR_NAMES or dirname.startswith("."):
                continue
            if candidate.is_symlink():
                raise PackagingError("symlink", f"symlink directory is not allowed: {candidate}")
            kept.append(dirname)
        dirnames[:] = kept

        for filename in sorted(filenames):
            candidate = current / filename
            if filename.startswith(".") or filename in SENSITIVE_FILE_NAMES:
                continue
            suffix = candidate.suffix.lower()
            if suffix not in ALLOWED_EXTENSIONS or suffix in SENSITIVE_SUFFIXES:
                continue
            if candidate.is_symlink():
                raise PackagingError("symlink", f"symlink file is not allowed: {candidate}")
            if not candidate.is_file():
                continue
            found.append((candidate.relative_to(source_root).as_posix(), candidate))
    return found


def _load_entry(rel: str, path: Path, source_root: Path) -> Entry:
    parts = PurePosixPath(rel).parts
    if not parts or PurePosixPath(rel).is_absolute() or ".." in parts:
        raise PackagingError("path-escape", f"refusing unsafe relative path: {rel!r}")

    resolved = Path(os.path.realpath(path))
    if not resolved.is_relative_to(Path(os.path.realpath(source_root))):
        raise PackagingError("path-escape", f"entry escapes the source root: {path}")

    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PackagingError("unreadable-entry", f"cannot read {path}: {exc}") from exc
    return Entry(rel=rel, size=len(data), sha256=sha256_bytes(data), data=data)


def collect_entries(source_root: Path) -> list[Entry]:
    """Collect the allowlisted files in deterministic order."""
    for required in (*REQUIRED_TOP_LEVEL, *REQUIRED_SOURCE_FILES):
        candidate = source_root / required
        if candidate.is_symlink():
            raise PackagingError("symlink", f"symlink is not allowed: {candidate}")
        if not candidate.is_file():
            raise PackagingError(
                "missing-required-input", f"required file is missing: {required}"
            )

    discovered: list[tuple[str, Path]] = []
    for name in TOP_LEVEL_FILES:
        candidate = source_root / name
        if candidate.is_symlink():
            raise PackagingError("symlink", f"symlink is not allowed: {candidate}")
        if not candidate.exists():
            continue
        if not candidate.is_file():
            raise PackagingError("not-a-file", f"expected a regular file: {candidate}")
        discovered.append((name, candidate))

    roots_present = []
    for name in REQUIRED_SOURCE_ROOTS:
        candidate = source_root / name
        if candidate.is_symlink():
            raise PackagingError("symlink", f"symlink is not allowed: {candidate}")
        if not candidate.is_dir():
            raise PackagingError(
                "missing-required-input", f"required source root is missing: {name}"
            )

    for name in SOURCE_ROOTS:
        candidate = source_root / name
        if candidate.is_symlink():
            raise PackagingError("symlink", f"symlink is not allowed: {candidate}")
        if candidate.is_dir():
            roots_present.append(candidate)
    if not roots_present:
        raise PackagingError(
            "missing-required-input",
            "no source root present (expected at least one of: "
            + ", ".join(SOURCE_ROOTS)
            + ")",
        )
    for base in roots_present:
        discovered.extend(_walk_root(base, source_root))

    discovered.sort(key=lambda item: item[0])
    seen: set[str] = set()
    for rel, _ in discovered:
        if rel in seen:
            raise PackagingError("duplicate-entry", f"duplicate archive path: {rel}")
        seen.add(rel)

    return [_load_entry(rel, path, source_root) for rel, path in discovered]


# ---------------------------------------------------------------------------
# Archive construction
# ---------------------------------------------------------------------------


def _zipinfo(name: str, mode: int = FILE_MODE) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=name, date_time=FIXED_DATE_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = CREATE_SYSTEM_UNIX
    info.create_version = 20
    info.extract_version = 20
    info.internal_attr = 0
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.extra = b""
    info.comment = b""
    return info


def build_archive(entries: list[Entry], root_name: str, name: str, version: str) -> Built:
    """Build the deterministic archive bytes. No wall-clock data is embedded."""
    manifest = {
        "format": FORMAT,
        "kind": "mori-source-manifest",
        "name": name,
        "version": version,
        "root": root_name,
        "file_count": len(entries),
        "total_bytes": sum(entry.size for entry in entries),
        "files": [
            {"path": entry.rel, "size": entry.size, "sha256": entry.sha256}
            for entry in entries
        ],
    }
    manifest_bytes = (
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode("utf-8")

    buffer = io.BytesIO()
    with zipfile.ZipFile(
        buffer, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=COMPRESS_LEVEL
    ) as archive:
        archive.writestr(_zipinfo(f"{root_name}/{MANIFEST_NAME}"), manifest_bytes)
        for entry in entries:
            archive.writestr(
                _zipinfo(f"{root_name}/{entry.rel}", entry_mode(entry.rel)), entry.data
            )
    return Built(blob=buffer.getvalue(), manifest_bytes=manifest_bytes)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def verify_archive(blob: bytes, entries: list[Entry], root_name: str) -> dict:
    """Re-read the archive and prove it matches the staged entries exactly."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as exc:
        raise PackagingError("verify-archive", f"archive is not a valid ZIP: {exc}", 4) from exc

    with archive:
        corrupt = archive.testzip()
        if corrupt is not None:
            raise PackagingError("verify-crc", f"CRC check failed for {corrupt}", 4)

        expected = [f"{root_name}/{MANIFEST_NAME}"] + [f"{root_name}/{e.rel}" for e in entries]
        names = archive.namelist()
        if names != expected:
            raise PackagingError(
                "verify-order",
                "archive entries do not match the expected deterministic order",
                4,
                {"expected": expected, "actual": names},
            )
        if len(set(names)) != len(names):
            raise PackagingError("verify-duplicate", "archive contains duplicate entries", 4)

        expected_modes = {f"{root_name}/{MANIFEST_NAME}": FILE_MODE}
        expected_modes.update(
            {f"{root_name}/{entry.rel}": entry_mode(entry.rel) for entry in entries}
        )

        for info in archive.infolist():
            if info.date_time != FIXED_DATE_TIME:
                raise PackagingError("verify-timestamp", f"non-deterministic timestamp: {info.filename}", 4)
            expected_mode = expected_modes.get(info.filename, FILE_MODE)
            if info.external_attr != (stat.S_IFREG | expected_mode) << 16:
                raise PackagingError("verify-mode", f"unexpected permissions: {info.filename}", 4)
            if info.extra:
                raise PackagingError("verify-extra", f"unexpected extra field: {info.filename}", 4)
            if info.compress_type != zipfile.ZIP_DEFLATED:
                raise PackagingError("verify-compression", f"unexpected compression: {info.filename}", 4)
            if info.is_dir() or ".." in PurePosixPath(info.filename).parts:
                raise PackagingError("verify-path", f"unsafe entry name: {info.filename}", 4)

        try:
            manifest = json.loads(archive.read(expected[0]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PackagingError("verify-manifest", f"manifest is unreadable: {exc}", 4) from exc

        if not isinstance(manifest, dict):
            raise PackagingError("verify-manifest", "manifest is not a JSON object", 4)
        listed = manifest.get("files")
        if not isinstance(listed, list) or len(listed) != len(entries):
            raise PackagingError("verify-manifest", "manifest file list has the wrong length", 4)

        for record, entry in zip(listed, entries):
            if not isinstance(record, dict):
                raise PackagingError("verify-manifest", "manifest entry is not an object", 4)
            if record.get("path") != entry.rel:
                raise PackagingError("verify-manifest", f"manifest path mismatch: {record.get('path')!r}", 4)
            if record.get("size") != entry.size:
                raise PackagingError("verify-manifest", f"manifest size mismatch: {entry.rel}", 4)
            if record.get("sha256") != entry.sha256:
                raise PackagingError("verify-manifest", f"manifest hash mismatch: {entry.rel}", 4)

        if manifest.get("file_count") != len(entries):
            raise PackagingError("verify-manifest", "manifest file_count mismatch", 4)
        if manifest.get("total_bytes") != sum(entry.size for entry in entries):
            raise PackagingError("verify-manifest", "manifest total_bytes mismatch", 4)
        if manifest.get("root") != root_name:
            raise PackagingError("verify-manifest", "manifest root mismatch", 4)

        for entry in entries:
            data = archive.read(f"{root_name}/{entry.rel}")
            if len(data) != entry.size or sha256_bytes(data) != entry.sha256:
                raise PackagingError("verify-entry", f"stored entry does not match: {entry.rel}", 4)

    return {
        "entry_count": len(entries) + 1,
        "source_file_count": len(entries),
        "archive_bytes": len(blob),
    }


# ---------------------------------------------------------------------------
# Publication
# ---------------------------------------------------------------------------


def _target_state(path: Path, expected_sha: str) -> str:
    if not path.exists() and not path.is_symlink():
        return "absent"
    if path.is_symlink() or not path.is_file():
        return "conflict"
    return "identical" if sha256_file(path) == expected_sha else "conflict"


def _stage(directory: Path, final_name: str, blob: bytes, publication: Publication) -> Path:
    handle, name = tempfile.mkstemp(prefix=f".{final_name}.", suffix=".tmp", dir=str(directory))
    temp = Path(name)
    publication.temps.append(temp)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, FILE_MODE)
    except BaseException:
        _unlink_quietly(temp)
        raise
    return temp


def _link_no_replace(temp: Path, destination: Path) -> None:
    """Publish atomically without ever clobbering an existing file."""
    try:
        os.link(temp, destination)
        return
    except FileExistsError as exc:
        raise PackagingError(
            "destination-exists", f"refusing to replace {destination}", 3
        ) from exc
    except OSError:
        pass  # filesystem without hard links: fall back to exclusive create

    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    except FileExistsError as exc:
        raise PackagingError(
            "destination-exists", f"refusing to replace {destination}", 3
        ) from exc
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as target, open(temp, "rb") as source:
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
    except BaseException as exc:
        # Only the file we created with O_EXCL may be removed; if the name now
        # holds someone else's file, it is not ours to delete.
        try:
            _unlink_if_same_file(destination, identity)
        except OSError as cleanup_exc:
            if not isinstance(exc, Exception):
                raise exc from cleanup_exc
            raise PackagingError(
                "publication-cleanup-failed",
                f"{type(exc).__name__}: {exc}; cannot remove incomplete destination {destination}",
                1,
                {"cleanup_failures": [{
                    "path": str(destination),
                    "error": f"{type(cleanup_exc).__name__}: {cleanup_exc.strerror or cleanup_exc}",
                }]},
            ) from exc
        raise


def _partial_publication(
    archive_path: Path,
    sidecar_path: Path,
    digest: str,
    exc: BaseException,
    publication: Publication,
) -> PackagingError:
    """Report an archive that is published while its sidecar is not.

    The archive is deliberately left in place. It is a complete, verified
    artifact, a rerun pairs it with a sidecar through the normal idempotent
    path, and deleting it would mean deleting a pathname we may no longer own.
    """
    cause = exc.code if isinstance(exc, PackagingError) else type(exc).__name__
    message = exc.message if isinstance(exc, PackagingError) else str(exc)
    return PackagingError(
        "partial-publication",
        f"archive published but the sidecar was not ({cause}): {message}; "
        "resolve the sidecar failure and any cleanup_failures, then rerun",
        EXIT_PARTIAL,
        {
            **(exc.details if isinstance(exc, PackagingError) else {}),
            "archive": str(archive_path),
            "archive_sha256": digest,
            "archive_matches": _sha256_or_none(archive_path) == digest,
            "sidecar": str(sidecar_path),
            "cause": cause,
            "cause_message": message,
            "written": list(publication.written),
            "preserved": list(publication.preserved),
        },
    )


def publish(
    blob: bytes,
    archive_path: Path,
    sidecar_path: Path,
    publication: Publication,
) -> str:
    """Publish archive and sidecar; returns the receipt status.

    Publication is ordered, not transactional: the archive is promoted first and
    is never rolled back. A sidecar failure therefore leaves a usable archive and
    a retry only has to finish the sidecar.
    """
    digest = sha256_bytes(blob)
    sidecar = f"{digest}  {archive_path.name}\n".encode("utf-8")

    states = {
        archive_path: _target_state(archive_path, digest),
        sidecar_path: _target_state(sidecar_path, sha256_bytes(sidecar)),
    }
    conflicts = [
        {
            "path": str(path),
            "sha256": sha256_file(path) if path.is_file() and not path.is_symlink() else None,
        }
        for path, state in states.items()
        if state == "conflict"
    ]
    if conflicts:
        publication.preserved = [item["path"] for item in conflicts]
        raise PackagingError(
            "destination-exists",
            "refusing to replace existing artifacts: "
            + ", ".join(item["path"] for item in conflicts),
            3,
            {"preserved": conflicts},
        )

    if states[archive_path] == "identical":
        publication.preserved.append(str(archive_path))
        archive_promoted = False
    else:
        temp = _stage(archive_path.parent, archive_path.name, blob, publication)
        _link_no_replace(temp, archive_path)
        publication.written.append(str(archive_path))
        archive_promoted = True

    try:
        if states[sidecar_path] == "identical":
            publication.preserved.append(str(sidecar_path))
        else:
            temp = _stage(sidecar_path.parent, sidecar_path.name, sidecar, publication)
            _link_no_replace(temp, sidecar_path)
            publication.written.append(str(sidecar_path))
    except Exception as exc:
        if not archive_promoted:
            raise
        raise _partial_publication(
            archive_path, sidecar_path, digest, exc, publication
        ) from exc

    if _sha256_or_none(archive_path) != digest:
        raise PackagingError(
            "verify-published",
            f"published archive no longer matches what was written (left in place): {archive_path}",
            4,
        )
    if _sha256_or_none(sidecar_path) != sha256_bytes(sidecar):
        raise PackagingError(
            "verify-published",
            f"published sidecar no longer matches what was written (left in place): {sidecar_path}",
            4,
        )

    return "published" if publication.written else "already-present"


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _with_cleanup_failures(exc: Exception, publication: Publication) -> Exception:
    """Attach cleanup trouble to a failure without masking the failure."""
    if not publication.cleanup_failures:
        return exc
    details = dict(getattr(exc, "details", {}) or {})
    details["cleanup_failures"] = details.get("cleanup_failures", []) + publication.cleanup_failures
    if isinstance(exc, PackagingError):
        return PackagingError(exc.code, exc.message, exc.exit_code, details)
    return PackagingError("internal", f"{type(exc).__name__}: {exc}", 1, details)


def package_source(
    source_root: str | os.PathLike[str],
    output: str | os.PathLike[str],
    *,
    generated_at: str | None = None,
) -> dict:
    """Package one source root and publish it. Returns the success receipt."""
    root = validate_source_root(source_root)
    archive_path, sidecar_path = validate_output(output, root)
    name, version = read_package_identity(root)
    root_name = f"{name}-{version}"

    entries = collect_entries(root)
    built = build_archive(entries, root_name, name, version)
    verification = verify_archive(built.blob, entries, root_name)

    publication = Publication()
    try:
        status = publish(built.blob, archive_path, sidecar_path, publication)
    except Exception as exc:
        publication.release_temps()
        replacement = _with_cleanup_failures(exc, publication)
        if replacement is exc:
            raise
        raise replacement from exc
    except BaseException:
        publication.release_temps()
        raise
    publication.release_temps()

    return {
        "format": FORMAT,
        "tool": TOOL,
        "status": status,
        "source_root": str(root),
        "root": root_name,
        "name": name,
        "version": version,
        "archive": str(archive_path),
        "archive_sha256": sha256_bytes(built.blob),
        "archive_bytes": verification["archive_bytes"],
        "sidecar": str(sidecar_path),
        "sidecar_sha256": sha256_bytes(
            f"{sha256_bytes(built.blob)}  {archive_path.name}\n".encode("utf-8")
        ),
        "manifest_path": f"{root_name}/{MANIFEST_NAME}",
        "manifest_sha256": sha256_bytes(built.manifest_bytes),
        "entry_count": verification["entry_count"],
        "source_file_count": verification["source_file_count"],
        "executable_entries": sorted(
            entry.rel for entry in entries if entry_mode(entry.rel) == EXECUTABLE_MODE
        ),
        "total_source_bytes": sum(entry.size for entry in entries),
        "written": publication.written,
        "preserved": publication.preserved,
        "cleanup_failures": publication.cleanup_failures,
        "generated_at": generated_at or _utc_now(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="package_source.py",
        description="Build a reproducible, verified Mnemo source archive.",
    )
    parser.add_argument("--source-root", required=True, help="project directory to package")
    parser.add_argument("--output", required=True, help="destination .zip path")
    parser.add_argument("--quiet", action="store_true", help="suppress the success receipt")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON receipt")
    return parser.parse_args(argv)


def _emit_error(exc: PackagingError) -> None:
    payload = {
        "format": FORMAT,
        "tool": TOOL,
        "status": "error",
        "error": exc.code,
        "message": exc.message,
        "generated_at": _utc_now(),
    }
    if exc.details:
        payload["details"] = exc.details
    print(json.dumps(payload, sort_keys=True, ensure_ascii=False), file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        receipt = package_source(args.source_root, args.output)
    except PackagingError as exc:
        _emit_error(exc)
        return exc.exit_code
    except Exception as exc:  # noqa: BLE001 - last-resort guard, reported not raised
        _emit_error(PackagingError("internal", f"{type(exc).__name__}: {exc}", 1))
        return 1

    if not args.quiet:
        indent = 2 if args.pretty else None
        print(json.dumps(receipt, sort_keys=True, ensure_ascii=False, indent=indent))
    # The release is published either way, so the receipt is still printed and
    # still carries status, hashes and written paths. Only the exit code says
    # that staging files were left behind.
    return EXIT_CLEANUP if receipt.get("cleanup_failures") else 0


if __name__ == "__main__":
    sys.exit(main())
