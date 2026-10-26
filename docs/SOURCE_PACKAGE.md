# Reproducible source packaging

`scripts/package_source.py` builds a deterministic ZIP source archive for Mnemo
developer releases from an explicit source root, verifies it, and publishes it
without ever replacing an existing artifact.

A release is meant to be runnable after extraction, so the archive carries the
three launchers (`start-mori.cmd`, `start-mori.command`, `start-mori.sh`) and
the whole `scripts/` tree they exec, including the `.mjs` and `.py` sources and
tests. The two POSIX launchers are stored with the exec bit set, so
`./start-mori.command` works straight out of the extracted directory.

It is **not** an end-user installer, a license audit, a GitHub publisher or a
matching/download implementation. It does not read credentials, databases or
user media, and it never publishes anything anywhere.

Standard library only. Python 3.9+.

## Usage

```bash
python3 scripts/package_source.py \
  --source-root /path/to/mori \
  --output /path/to/dist/mori-media-agent-0.1.0-source.zip
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--source-root` | yes | project directory to package (validated before any read) |
| `--output` | yes | destination `.zip`; must end in `.zip` and live outside the source root |
| `--quiet` | no | suppress the success receipt (exit code only) |
| `--pretty` | no | indent the JSON receipt |

On success the tool prints one JSON receipt on stdout and writes two files:
the archive and `<archive>.sha256`.

```bash
python3 scripts/package_source.py --source-root . --output /tmp/mori.zip --quiet
shasum -a 256 -c /tmp/mori.zip.sha256   # run from /tmp
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | published, or already present and byte-identical |
| `1` | unexpected internal error |
| `2` | usage or validation error (paths, allowlist inputs, package identity) |
| `3` | destination conflict — existing artifact preserved, nothing written |
| `4` | verification failure (archive, manifest, entry or published file) |
| `5` | partial publication — archive published; resolve sidecar/cleanup failures before retry |
| `6` | published, but staging files could not be removed (`cleanup_failures`) |

Codes `5` and `6` both mean "something exists on disk that a release script must
look at", so neither is a plain success. A `6` still prints the normal receipt:
the release itself is complete and valid, only the cleanup is not.

Failures print a single JSON object on stderr:

```json
{"status":"error","error":"destination-exists","message":"...","details":{"preserved":[{"path":"...","sha256":"..."}]}}
```

## What goes into the archive

Everything is stored under one versioned root, `<package-name>-<version>`,
taken from the source root's `package.json` (currently
`mori-media-agent-0.1.0`). The archive therefore extracts into a single
directory and never scatters files into the caller's working directory.

**Top-level files** (exact names only):
`.dockerignore`, `.gitignore`, `Dockerfile`, `LICENSE`, `README.md`,
`compose.yaml`, `environment.example`, `index.html`, `package-lock.json`,
`package.json`, `start-mori.cmd`, `start-mori.command`, `start-mori.sh`,
`tsconfig.json`, `vite.config.ts`.

**Source roots:** `docs`, `integrations`, `public`, `rust-core`, `scripts`, `server`,
`shared`, `src`, `tests`. `scripts` and `rust-core` must exist; the rest are optional.

**Extensions inside those roots:**
`.ts .tsx .js .css .py .mjs .json .md .yml .yaml .svg .png .jpg .jpeg .webp .ico .webmanifest .zip .lock .in .txt .rs .toml`.

The list is a positive allowlist: a file is packaged only if its root, its
name (top level) or its extension (inside a root) matches. Nothing is included
by default. Top-level files match by exact name, so the launchers are the only
`.sh`/`.command`/`.cmd` files in a release.

### Launchers and the `scripts` tree

The launchers are thin wrappers around one implementation:

| File | Platform | What it does |
| --- | --- | --- |
| `start-mori.cmd` | Windows | `node "%SCRIPT_DIR%scripts\local.mjs" start %*` |
| `start-mori.sh` | macOS / Linux | `node "$SCRIPT_DIR/scripts/local.mjs" start "$@"` |
| `start-mori.command` | macOS (double-click) | `exec sh "$SCRIPT_DIR/start-mori.sh" "$@"` |

`scripts/local.mjs` locates the project root as `dirname(<itself>)/..`, so the
archive must keep `<root>/scripts/local.mjs` exactly there. The packager
therefore requires the `scripts` root and packages everything under it that
matches the extension allowlist — `scripts/local.mjs`,
`scripts/package_source.py`, `scripts/tests/*.mjs` and `scripts/tests/*.py`.
`package.json`'s `local` / `local:test` scripts keep working after extraction.

### Rust native core source and first build

The archive includes the canonical `rust-core/` crate, `Cargo.toml`,
`Cargo.lock`, and `scripts/build_rust.mjs`. These three files are required
inputs. `rust-core/target/` and every other `target/` directory are excluded;
the archive does not depend on candidates under `output/` and does not include
native binaries from `bin/`.

For a default source installation, install a Rust toolchain with Cargo as well
as Node.js. `npm run build` runs the locked release build and places the host
executable at `bin/mnemo-core` (`bin/mnemo-core.exe` on Windows), then checks
TypeScript and builds the frontend. `npm start` verifies an existing executable
before using it and builds it only when it is missing or incompatible. The
required version response is `mnemo-core 0.1.1 protocol=1`; a `0.1.0` executable
is rebuilt when sources are available and rejected otherwise.

The native core handles CMS / RSS / Atom parsing, pure `password_verify`, and
pure `download_response`. TypeScript retains password setup writes, the existing
password storage format, and database ownership. Passwords reach the native
core only through stdin, never argv, environment variables, or logs.
`download_response` receives no URL or credentials and performs no network or
file operations.

If you already have a matching prebuilt executable, put it in `bin/` and use
`npm ci --include=dev`, `node scripts/build_rust.mjs --if-missing`,
`npm run check`, and `npx vite build` before `npm start`. This path verifies the
prebuilt executable without Cargo. The default `npm run build` deliberately
rebuilds Rust whenever the source manifest is present.

An already built portable client carries the target executable and omits the
Rust source tree, so its install/build step verifies that executable without
requiring Cargo. To create such a client, see [CLIENT_PACKAGES.md](CLIENT_PACKAGES.md).
`MNEMO_CORE=typescript` (or legacy `MORI_CORE=typescript`) explicitly skips the
native build for existing CMS behavior; RSS/Atom parsing requires Rust.

### Never packaged

* `node_modules`, `dist`, `build`, `coverage`, `.venv`/`venv`, `__pycache__`,
  `releases`, `downloads`, `output`, `data`, `logs`, `tmp`, VCS and IDE
  directories — pruned by name, at any depth;
* dot-files and dot-directories inside a source root;
* anything whose extension is not on the allowlist (`.log`, `.db`, `.key`,
  `.pem`, `.sh`, `.bin`, `.tar.gz`, …) — including `scripts/*.sh`, which is why
  the launchers are allowlisted by exact name instead;
* credential-shaped names even when the extension would match —
  `.env*`, `.npmrc`, `.netrc`, `credentials.json`, `secrets.json`,
  `id_rsa`, `id_ed25519`, `*.key`, `*.pem`, `*.sqlite`, `*.db`, `*.log`;
* **symlinks**: a symlink that would otherwise be packaged is a hard error,
  not a skip, so a linked tree can never smuggle in outside content.

Only `environment.example` — the public template — is packaged. Real `.env`
files are excluded at every level.

### Required inputs

`package.json`, `README.md`, `LICENSE`, `start-mori.cmd`, `start-mori.command`
and `start-mori.sh` must exist, plus the `scripts` root and at least one source
root. `package.json` must parse and carry a simple `name`
(`^[a-z0-9][a-z0-9._-]{0,63}$`) and `version` (`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`)
— the version is also used for the archive root, so path separators are rejected.

Requiring the launchers and `scripts` is deliberate: a package that ships
`start-mori.command` without `scripts/local.mjs` fails on the first run, so the
packager refuses to build it rather than produce a plausible-looking archive.

## Determinism

The archive bytes depend only on the source content, never on when or where it
was built:

* entries are sorted by their POSIX relative path (the manifest is always first);
* every entry uses the fixed timestamp `1980-01-01T00:00:00` and a fixed mode
  — `0644`, or `0755` for the approved launchers — with `create_system = 3`
  (Unix), no extra fields, no comment;
* the archive is written with `ZIP_DEFLATED` at a fixed level 9;
* the embedded manifest contains no timestamp, host name or build id.

Consequence: packaging the same tree twice yields the same SHA256. The receipt
carries `generated_at` because it is a separate document, not part of the
archive.

Two caveats, stated honestly:

1. Byte-identical output across *different* Python/zlib builds is not
   guaranteed — the deflate stream is produced by the local zlib. Entries,
   ordering, names, timestamps and permissions are stable everywhere; the
   compressed bytes are stable for a given toolchain. If you need
   cross-toolchain byte equality, pin the Python version.
2. Source files are staged in memory, so the tree size is bounded by available
   RAM. That is fine for Mnemo's source roots (a few MB); it is not a
   multi-gigabyte archiver.

### Executable-entry policy

The mode comes from `EXECUTABLE_ENTRIES` in the module — a two-name allowlist,
`start-mori.sh` and `start-mori.command` — and **never** from the source file's
own permissions. That keeps the decision deterministic and makes the archive
independent of the checkout:

* a checkout that lost its exec bits (a Windows clone, a ZIP round-trip, an
  `umask 077` extraction) still produces a runnable release;
* the same tree packaged on two machines produces identical bytes even if the
  working copies differ in mode;
* `start-mori.cmd` stays `0644` — Windows runs it through the shell and ignores
  the bit; `scripts/local.mjs` stays `0644` because the launchers invoke it
  through `node`, not by exec'ing it directly.

`verify_archive` re-checks the expected mode per entry before publication, so a
lost exec bit fails the run with exit `4` instead of shipping.

## Manifest

`<root>/SOURCE-MANIFEST.json` is the first archive entry and is UTF-8 JSON with
sorted keys:

```json
{
  "format": 1,
  "kind": "mori-source-manifest",
  "name": "mori-media-agent",
  "version": "0.1.0",
  "root": "mori-media-agent-0.1.0",
  "file_count": 28,
  "total_bytes": 306,
  "files": [
    {"path": ".dockerignore", "size": 13, "sha256": "16d3..."}
  ]
}
```

`files` lists every packaged source file in archive order with its relative
path (inside the root), byte size and SHA256. The manifest does not list
itself. Paths are stored as UTF-8 and non-ASCII or space-containing names are
preserved verbatim.

## Verification before publication

Before anything is published the tool re-opens the built archive in memory and
checks, in order:

1. the ZIP parses and every entry passes a CRC test (`testzip`);
2. the entry list equals the expected ordered list exactly — no extras,
   no omissions, no duplicates;
3. every entry has the fixed timestamp, the mode the policy assigns it (`0644`,
   or `0755` for `EXECUTABLE_ENTRIES`), no extra field, deflate compression, and
   a relative name without `..`;
4. the manifest's `root`, `file_count` and `total_bytes` agree with the staged
   set, and each manifest record matches the staged path, size and hash;
5. every stored entry is re-read and its size and SHA256 re-computed.

After publication the archive and sidecar on disk are hashed again. A mismatch
exits `4` and the file is **left in place** for inspection — at that point the
name may no longer be the file this run wrote, so deleting it would be exactly
the ownership mistake the tool avoids elsewhere.

## Publication semantics

Publication is **ordered, not transactional**. The archive is promoted first and
is never rolled back; the sidecar follows. That ordering is what makes a failed
run recoverable instead of destructive.

* **No replace, ever.** If the target archive exists with different bytes, the
  run fails with exit `3`, reports the existing SHA256, and leaves the file
  untouched. The same applies to the sidecar. This check happens before anything
  is written.
* **Idempotent.** If the target already holds byte-identical content, the run
  succeeds with `"status": "already-present"` and writes nothing.
* **Atomic.** Each artifact is staged as a hidden `.<name>.<random>.tmp` file
  in the destination directory, fsynced, then published with `os.link`, which
  fails rather than clobbers if the name appeared in the meantime. Filesystems
  without hard links fall back to `O_CREAT | O_EXCL`.
* **Archive first, and the archive stays.** If the sidecar cannot be published
  after the archive was promoted, the run exits `5` with
  `error: "partial-publication"` and leaves the archive in place. The archive is
  a complete, verified artifact. Once the sidecar problem is resolved and its
  destination is absent, rerunning writes only the sidecar and finishes the release.
* **A pathname is not ownership.** This tool never deletes a published artifact
  because it once used that name: another owner may have replaced it in the
  meantime. The only file it removes on its own failure is the half-written
  destination of the no-hardlink fallback, and only while that file's
  `(device, inode)` still matches the one it created with `O_EXCL`.
* **Pre-existing artifacts always survive.** On a conflict (`exit 3`) nothing is
  written at all: an existing archive or sidecar keeps its exact bytes, and
  `details.preserved` reports its SHA256. A conflicting sidecar does not remove
  a byte-identical archive that was already there.
* **No broad cleanup.** Only this invocation's own staging files are removed;
  unrelated files in the output directory are never touched. The output
  directory is never created, emptied or pruned.
* **Cleanup trouble is reported.** If a staging file cannot be removed (a
  permission denial, a read-only directory), the run exits `6`, still prints the
  receipt, and lists every leftover in `cleanup_failures`. It does not delete the
  published release and does not pretend the run was clean. On an already-failing
  run the same list is attached to `details.cleanup_failures` so the original
  error stays visible.
  If fallback cleanup cannot remove an incomplete destination, its path and
  error also appear in `details.cleanup_failures`. Resolve that leftover before
  retrying; an existing conflicting file is preserved.
* The sidecar is the conventional `sha256sum` form:
  `<sha256>  <archive-basename>\n`.

### Recovering from exit 5

The error payload says exactly what exists:

```json
{"status":"error","error":"partial-publication",
 "message":"archive published but sidecar was not (OSError): ...; resolve the sidecar failure and any cleanup_failures, then rerun",
 "details":{"archive":"/out/mori.zip","archive_sha256":"85ed...","archive_matches":true,
            "sidecar":"/out/mori.zip.sha256","cause":"OSError","cause_message":"..."}}
```

* `archive_matches: true` — the archive on disk is the one this run built. Fix
  the sidecar problem and inspect any `details.cleanup_failures`. Retry after the
  destination is absent or already contains the expected sidecar.
* `archive_matches: false` — something else replaced the archive. The file was
  left alone; inspect it and choose a different `--output` or remove it by hand.
  The tool will not delete it for you.

No lock file or daemon is involved: the recovery path is the ordinary
`identical → skip` rule of the next run.

## Receipt

```json
{
  "format": 1,
  "tool": "mori-source-packager",
  "status": "published",
  "source_root": "/abs/path/to/mori",
  "root": "mori-media-agent-0.1.0",
  "name": "mori-media-agent",
  "version": "0.1.0",
  "archive": "/abs/path/out/mori.zip",
  "archive_sha256": "85ed...",
  "archive_bytes": 4917,
  "sidecar": "/abs/path/out/mori.zip.sha256",
  "sidecar_sha256": "1c3d...",
  "manifest_path": "mori-media-agent-0.1.0/SOURCE-MANIFEST.json",
  "manifest_sha256": "5a57...",
  "entry_count": 29,
  "source_file_count": 28,
  "executable_entries": ["start-mori.command", "start-mori.sh"],
  "total_source_bytes": 306,
  "written": ["/abs/path/out/mori.zip", "/abs/path/out/mori.zip.sha256"],
  "preserved": [],
  "cleanup_failures": [],
  "generated_at": "2026-10-24T01:41:44Z"
}
```

`entry_count` includes the manifest; `source_file_count` does not. `written`
and `preserved` make the publication decision explicit for a release script.
`cleanup_failures` is empty on a clean run and otherwise lists
`{"path": "...", "error": "PermissionError: ..."}`; a non-empty list comes with
exit `6`, and the rest of the receipt is still the truth about the release.
`executable_entries` is the subset that carries mode `0755`, so a release script
can assert the extracted modes without hard-coding the policy.
The receipt says nothing about GitHub or any registry: publishing a release is
someone else's job.

## Tests

```bash
python3 scripts/tests/test_package_source.py
# or, from the repository root
python3 -m unittest discover -s scripts/tests
```

48 standard-library tests, all offline, each against a fabricated tree in a
temporary directory. They cover repeatability, absence of wall-clock data,
fixed ZIP metadata (per-entry mode), the exact allowlist, exclusion of local
state, credentials and `scripts/` caches, missing/invalid required inputs
(including a missing launcher and a missing `scripts` root), symlink and escape
rejection, unreadable directories, output path validation, preservation of an
existing destination, sidecar conflicts, idempotency, temporary-file cleanup on
verification failure, partial publication (archive kept, sidecar reported),
recovery by rerunning, a foreign replacement of the archive surviving a later
sidecar no-hardlink fallback preserving foreign files, fallback cleanup refusal
with a retained sidecar blocking retry, staging cleanup refusal reported with exit
`6`, cleanup failure attached to an already-failing run, manifest/size/hash consistency, sidecar
correctness, non-ASCII and space-containing paths, the release layout (three
launchers plus the `.mjs`/`.py` scripts tree), extracted launcher modes, mode
independence from the checkout, rejection of an archive whose launcher lost its
exec bit, and the real CLI entry point via `subprocess`.

The mode tests do not rely on `zipfile.extractall` (which drops Unix
permissions): they apply `external_attr` the way a Unix extractor does and then
assert `os.access(..., os.X_OK)`. Cleanup tests match staging files by name
rather than by absolute path, so the macOS `/var` → `/private/var` alias cannot
make them pass or fail by accident. No launcher is executed and no dependency is
installed.

## Checking a release by hand

```bash
unzip -q mori-media-agent-0.1.0-source.zip -d /tmp/release
ls -l /tmp/release/mori-media-agent-0.1.0/start-mori.*
# -rwxr-xr-x start-mori.command
# -rwxr-xr-x start-mori.sh
# -rw-r--r-- start-mori.cmd
shasum -a 256 -c mori.zip.sha256    # from the directory holding the archive
```

## Integration notes

* Wire it into a release script as
  `python3 scripts/package_source.py --source-root . --output dist/<name>-<version>-source.zip`;
  treat `0` as done, `5` as "resolve the reported sidecar/cleanup failure before retry",
  `6` as "published, but check `cleanup_failures`", anything else as "do not publish anything".
* Consume `archive_sha256` from the receipt rather than re-hashing, and hand
  the `.sha256` sidecar to whoever uploads the release.
* Keep `SOURCE_ROOTS`, `REQUIRED_SOURCE_ROOTS`, `TOP_LEVEL_FILES`,
  `REQUIRED_TOP_LEVEL` and `EXECUTABLE_ENTRIES` in sync with the repository
  layout; all are plain constants at the top of the module. A new launcher needs
  an entry in both `TOP_LEVEL_FILES` and `EXECUTABLE_ENTRIES` (plus
  `REQUIRED_TOP_LEVEL` if the release cannot start without it).
* The tool deliberately refuses to package a tree missing `LICENSE`,
  `README.md`, a launcher or the `scripts` root, so a mis-pointed
  `--source-root` fails loudly instead of producing a plausible-looking empty
  archive.
