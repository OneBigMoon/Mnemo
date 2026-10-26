# 便携客户端包（Windows / macOS）

便携客户端把官方 Node.js 运行时、宿主源码与对应平台的 `mnemo-core` 打进一个 ZIP（macOS 包还含全部依赖与构建好的前端），机器上**不需要安装 Node.js 或 Rust**。包内的启动器会优先使用 `runtime/` 里的内置运行时。

## 包的内容

| 平台 | 包 | 启动 | 依赖 |
|---|---|---|---|
| macOS（Apple Silicon） | `mnemo-client-0.1.0-darwin-arm64-*.zip` | 双击 `start-mori.command` | 已内置（离线可用） |
| Windows（x64） | `mnemo-client-0.1.0-windows-x64-*.zip` | 双击 `start-mori.cmd` | 首次联网安装 |

- macOS 包：`runtime/bin/node` + `bin/mnemo-core`（Mach-O arm64）+ 全部 `node_modules` + 构建好的 `dist/`，解压即用；Gatekeeper 拦截时右键启动器 →「打开」。
- Windows 包：`runtime/node.exe` + npm + 宿主源码 + `bin/mnemo-core.exe`（PE x64）。首次使用先双击 `install-mori.cmd`（联网安装依赖，按锁文件安装并构建前端），之后双击 `start-mori.cmd` 日常启动。
- 便携包不带 `rust-core/` 源码；安装/构建只验证随包 native core 的 `--version`，因此不要求 Cargo。缺少或不兼容的 binary（包括旧 `0.1.0`）会明确报错；修复时应恢复相应平台的 `0.1.1` executable，或改用包含 Rust 源码的源码包。
- 两个包都有 `install-mori.*`（修复/重装依赖用）与 `CLIENT-README.txt`；每个包内有 `PACKAGE-MANIFEST.json`（逐文件 SHA-256）。
- 数据默认保存在包目录的 `data/` 与 `downloads/` 下；用 `MORI_DATA_DIR` / `MORI_DOWNLOAD_DIR` 可指向别处。exFAT/FAT32 下载盘可用（拷贝回退发布）。

## 打包方式（开发者）

```sh
python3 scripts/package_client.py \
  --source-root <项目目录> \
  --platform darwin-arm64 \
  --output <输出目录>/mnemo-client-0.1.0-darwin-arm64-<日期>.zip
```

- `--platform`：`darwin-arm64` 或 `windows-x64`。
- 先在目标平台构建 `mnemo-core`，或通过 `--native-binary <文件>` 指定目标 executable；默认读取源码根目录下的 `bin/mnemo-core` / `bin/mnemo-core.exe`。默认源构建命令为 `node scripts/build_rust.mjs`，使用 `cargo build --release --locked`。
- 缺少目标 binary 时，打包在下载 Node 运行时之前失败。macOS 只接受 Mach-O arm64 executable，Windows 只接受 PE x64 executable；不能把 macOS 文件改名为 `.exe`。必须在目标平台和架构上真实执行 `--version`，得到 `mnemo-core 0.1.1 protocol=1` 后才能打包；跨平台宿主无法验证时会明确拒绝，即使传入 `--native-binary` 也不能跳过。Windows 包需在 Windows x64 上生成，macOS 包需在 macOS arm64 上生成；成功 receipt 的 `native_binary.protocol_verified` 为 `true`。
- Node 运行时从 nodejs.org 官方 dist 下载，**逐字节核对 SHASUMS256.txt** 后缓存（`--cache-dir`，默认 `~/.cache/mori-node-runtime`）；缓存命中后离线可打包（macOS 包的 `npm ci`/`npm run build` 仍需 npm 缓存或网络）。
- macOS 包在暂存目录真实执行 `npm ci --include=dev` 与 `npm run build`，依赖与前端构建产物随包分发；Windows 包不预装依赖（跨平台原生二进制不可移植），首次联网安装。
- 发布走无覆盖路径并生成 `.sha256` sidecar；打包 receipt 输出到 stdout。

## 验收状态（2026-10-25）

以下为 Rust native core 迁移前已有客户端包的历史验收；不能作为新增 native binary 路径的运行证据。当前打包器要求每个新包都携带对应平台 binary。

- macOS 包已在本机完成端到端验收（回执 `docs/evidence/client-bundles-20261025.json`）：解包后**在不含任何系统 Node 的干净 PATH 下**真实启动——服务进程确认使用包内 `runtime/bin/node`；`/api/health` 200；PWA 资产（`manifest.webmanifest`、`sw.js`、图标）正常下发；8,975 个包内条目逐项与 `PACKAGE-MANIFEST.json` 的 SHA-256 一致；符号链接（npm、tsx）在 ZIP 内正确保留。
- Windows 包只做了结构验收：`node.exe` PE 头、逐项清单哈希、启动器/安装器/README 齐全。**真 Windows 双击冒烟（含首次联网安装）仍未做**，需要在真实 Windows 机器上验收。
- PWA（安卓/桌面浏览器「安装到主屏幕」）：已提供 manifest、图标与不缓存任何请求的最小 Service Worker。**安卓 Chrome 只在 HTTPS 上下文允许安装 PWA**——局域网 HTTP 直连仍可正常使用网页，但要获得可安装的独立应用，需要把实例放到 HTTPS 入口之后（`MORI_PUBLIC_ORIGIN` + 反向代理 + `MORI_COOKIE_SECURE=1`）。

## 边界与限制

- 包不做代码签名/公证，也不做自动更新；升级 = 下载新包 + 迁移 `data/`（或用环境变量指向既有数据目录）。
- 未打包 Linux 客户端（已有 Docker 与源码运行两条路径）；未做 iOS/Android 原生应用。
- 包内运行时版本以打包时 nodejs.org 官方 v22 最新版为准（当前 v22.23.4），与项目要求的 Node ≥22.13.0 一致。
