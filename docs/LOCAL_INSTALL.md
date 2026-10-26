# Mnemo 本地安装与启动指南（Windows / macOS / Linux）

本指南面向普通用户，介绍如何在本机安装、自检并启动 Mnemo。Mnemo 是开源自托管媒体代理：Node.js `>=22.13.0`，默认端口 `4180`，凭据与管理员一律在网页界面中配置，**任何脚本都不会读取或写入你的账号凭据、数据库或私密状态**。

---

## 1. 环境要求

| 组件 | 要求 | 用途 | 缺失时的影响 |
|---|---|---|---|
| Node.js | `>= 22.13.0`（自带 npm） | 运行 Mnemo 与本工具 | 无法启动（必需） |
| Rust / Cargo（源码安装） | 能构建随包 `rust-core/Cargo.lock` 的 Rust toolchain | 构建 native core | 默认源码构建失败；已构建便携客户端不需要 Rust |
| Python（可选，仅 macOS/Linux） | `>= 3.12, < 4` | 仅「115 分享文件解析」功能 | 其他功能全部正常 |

下载边界，如实说明：

- 本工具与启动器**不会自动下载或安装** Node.js、Python 或任何远程脚本；需要时只会给出官方网址，由你手动安装。
- 联网步骤为包管理器按锁文件获取依赖：`install` 通过 `npm ci` 从 npm registry 下载锁定版本的依赖（含构建工具）；源码构建通过 Cargo 获取 `rust-core/Cargo.lock` 锁定的 Rust 依赖；可选的 115 组件通过 `pip` 安装 SHA256 锁定的 wheel 与固定 commit 的 SDK。

默认核心为 Rust native core。源码目录的 `npm run build` 会执行 `cargo build --release --locked --manifest-path rust-core/Cargo.toml`，并复制宿主 executable 到 `bin/mnemo-core`（Windows 为 `bin/mnemo-core.exe`）。`npm start` 验证已有 executable 的 `--version`（`mnemo-core 0.1.1 protocol=1`），缺失或不兼容时尝试构建。旧 `0.1.0` executable 不支持新增的认证与下载响应操作，不能复用。便携客户端已携带匹配平台 binary 且不带 Rust 源码，其安装/构建只验证 binary，因此无需终端用户安装 Cargo；源码包本身不携带 binary。若已有匹配的预构建 binary，可将其放入 `bin/`，依次运行 `npm ci --include=dev`、`node scripts/build_rust.mjs --if-missing`、`npm run check`、`npx vite build`，再运行 `npm start`；这条安装路径无需 Cargo，默认源码 `npm run build` 仍会重建 Rust。

native core 承担 CMS / RSS / Atom 正文解析、纯 `password_verify` 和纯 `download_response`。密码 setup 的写入及既有存储格式、数据库仍由 TypeScript 负责；宿主调用 native core 时，密码只经 stdin 传递，不进入 argv、环境变量或日志。`download_response` 只校验下载响应，不接收 URL 或凭据，也不发起网络请求、不操作文件。

保留已有 CMS 路径时，可在构建和运行环境中显式设置 `MNEMO_CORE=typescript`（兼容 `MORI_CORE=typescript`）来跳过 native 构建；RSS/Atom 解析需要 Rust。`doctor` 当前检查宿主环境，native executable 的协议校验在 build / start 阶段执行。

---

## 2. 快速开始

```sh
# 1) 进入 Mnemo 安装目录（路径含空格或中文完全支持）
cd /path/to/mori

# 2) 一键安装：按 package-lock.json 锁定依赖（npm ci --include=dev，
#    即使环境预设了 NODE_ENV=production 也会安装构建工具）并构建 native core 与前端
node scripts/local.mjs install

# 3) 环境自检（必需项全部「正常」即就绪）
node scripts/local.mjs doctor

# 4) 前台启动（Ctrl+C 停止），随后访问 http://127.0.0.1:4180
node scripts/local.mjs start
```

也可以使用 npm 脚本：`npm run local -- doctor`、`npm run local:test`（本工具的离线测试）。

### 双击启动（推荐给非命令行用户）

| 系统 | 双击文件 | 说明 |
|---|---|---|
| Windows | `start-mori.cmd` | 自动切换 UTF-8 代码页；结束时按键再关窗，便于阅读信息；不转发命令行参数 |
| macOS | `start-mori.command` | 在「终端」中打开运行 |
| Linux | `start-mori.sh` | 文件管理器双击或终端运行 |

双击启动器会：

- 自动定位自己所在的 Mnemo 安装目录（与双击时的工作目录无关，路径含空格/中文亦可）；
- 未找到 Node.js 时用中文提示安装地址（`https://nodejs.org/zh-cn`），不会自动下载；
- 依赖未安装时给出三步中文安装指引，而不是打印一屏报错；
- 前台运行 Mnemo。停止时（Ctrl+C 或关闭窗口）：macOS/Linux 上本工具把信号向整个子进程组转发一次并等待退出，超过 12 秒强制终止；Windows 上 Ctrl+C 由控制台广播给共享控制台的进程树，工具在 12 秒后终止直接子进程兜底。若 Windows 下仍有残留 node 进程，请用任务管理器结束。

---

## 3. 命令详解

### `node scripts/local.mjs doctor [--json] [--root <目录>]`

逐项检查并给出结论与修复建议：

| 检查项 | 说明 |
|---|---|
| Node.js 运行时 | 版本是否 `>= 22.13.0` |
| npm 包管理器 | 真实执行一次 `npm --version` 并以其退出状态为准（优先经 `npm_execpath` 或 Node 自带 npm-cli.js 直调，不经 shell） |
| 项目文件 | `package.json`、`server/index.ts`、`package-lock.json` 是否齐全 |
| 依赖安装 | `node_modules` 中关键依赖（express、react、tsx、vite 等）能否真实解析入口；占位或损坏的包会被识别 |
| 前端构建 | `dist/index.html` 存在且非空，且其引用的本地静态资源存在 |
| 监听地址与端口 | `HOST`/`PORT` 是否合法（`PORT` 为 0–65535 的十进制整数；`HOST` 为合法主机名或 IP） |
| 数据 / 下载目录 | 默认 `安装目录/data`、`安装目录/downloads`；相对路径按安装目录解析（与启动后的服务一致）；不支持以 `~` 开头的路径；悬空符号链接会被识别；存在时做写探针；下载目录另做硬链接探针（exFAT/FAT32 等不支持硬链接的文件系统仍为正常，结果中会注明将以拷贝回退发布） |
| 115 组件（可选，仅 macOS/Linux） | `MORI_PYTHON` 指定的解释器（或默认探测位置）为 Python 3.12–3.x，并通过 helper 固定 `health` 协议真实导入 `p115client 0.0.9.7.2` |

三种状态：

- `[正常]` 就绪；
- `[未配置]` 尚未安装/构建，按「修复建议」操作即可（通常是运行 `install`）;
- `[不可用]` 当前环境不满足（如 Node 版本过低、目录无写权限、HOST/PORT 非法）。

退出码：`0` 就绪；`1` 存在问题；`2` 参数错误。**可选的 115 组件未就绪不会导致非零退出码。**

`--json` 输出结构化结果（`ok`、`summary`、逐项 `checks`、`nextSteps`、生效 `config`），供后续界面集成；此时标准输出只有 JSON。`config` 中的路径为解析后的绝对路径。

写探针机制：目录可写检测只在目标目录内创建一个**独占随机临时文件**（`.mori-doctor-*.tmp`，`wx` 独占创建，绝不覆盖既有文件），检测后**仅删除该文件**。下载目录另有硬链接探针：同样以 `wx` 创建独占随机文件，在同目录 `link` 出第二个名字，验证后**仅删除这两个探针文件**。Mnemo 下载完成后优先通过硬链接原子发布媒体；文件系统不支持硬链接（exFAT/FAT32 等）时自动改用拷贝回退：先把完成的临时文件拷贝为发布目录内的隐藏临时副本（`.mori-publish-*.tmp`）、fsync 后原子改名，全程不覆盖既有文件、崩溃不会留下半发布的媒体，但发布较慢且期间需要约两倍空闲空间。

### `node scripts/local.mjs start [--root <目录>]`

- 先做快速预检：HOST/PORT 与数据/下载目录配置、目录完整、Node 版本、npm（真实探测）、依赖可解析；不满足时给出中文错误与安装步骤并退出码 1，不会反复拉起进程。启动前若端口已被占用会提示「可能已有实例在运行」（多实例请用 `PORT` 换端口）。
- 复用项目的 `npm start` 脚本，**前台运行**，原样转发输出。
- 按 `Ctrl+C`（或收到 SIGTERM/SIGHUP）时：macOS/Linux 上把同一信号向整个子进程组转发**一次**（孙进程一并收到，不会重复投递），等待整个进程组退出，直接子进程先退出也继续监督；超过 12 秒按组强制终止，再用最多 1 秒确认退出。需要按组 SIGKILL 时退出码为 `137`，无法确认清理完成时输出错误并退出码 `1`。Windows 上控制台 Ctrl+C 会广播给整棵进程树，工具不再重复终止，仅保留 12 秒兜底终止直接子进程。正常清理后的退出码与子进程一致（被信号终止时按惯例 `128+信号值`）。
- 前端未构建或产物为空时仅提示警告，不阻止启动（接口仍可用）。

### `node scripts/local.mjs install [--root <目录>]`

依次执行 `npm ci --include=dev`（严格按 `package-lock.json` 安装，并显式包含开发依赖，保证 `tsx`/`vite`/`typescript` 等构建与运行工具就位，不受 `NODE_ENV=production` 影响）与 `npm run build`（源码目录构建 native core 与前端；便携包验证预构建 binary 并构建前端），前台显示全部输出，任一步失败即停止并保留其退出码。缺少 `package-lock.json` 时会拒绝浮动版本安装并要求从完整发布包恢复锁文件。

---

## 4. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MORI_DATA_DIR` | `安装目录/data` | 数据目录；相对路径按安装目录解析（与启动后的服务一致）；不支持以 `~` 开头 |
| `MORI_DOWNLOAD_DIR` | `安装目录/downloads` | 下载目录；规则同上 |
| `HOST` | `127.0.0.1` | 监听地址（合法主机名或 IP） |
| `PORT` | `4180` | 监听端口（0–65535 的十进制整数） |
| `MORI_PYTHON` | 自动探测 | 115 组件使用的 Python 解释器，与应用读取的设置一致；未设置时按 `/opt/mori-p115/bin/python`、`~/.local/share/mori-p115/bin/python`、PATH 中 `python3.12/3.13/3` 的顺序探测 |

以上均为路径/端口类配置；本工具不读取任何凭据类环境变量。

---

## 5. 可选：115 分享解析组件（仅 macOS/Linux）

仅当需要「115 分享文件解析」功能时才需要配置，**不影响其余功能**；整个过程不登录、不访问任何云端账号。helper 依赖 POSIX 的 `SIGALRM/ITIMER_REAL` 定时机制，**Windows 暂不支持 115 组件**，doctor 在 Windows 上会如实标注本项不可用。

1. 安装 Python 3.12+（手动从 https://www.python.org 下载，本工具不会代下载）与 Git。
2. 创建独立虚拟环境并按锁定文件安装（命令来自 `integrations/p115_resolver/README.md`，依赖以 SHA256 锁定）。普通用户建议放在自己的主目录下，避免 `/opt` 权限问题：

   ```sh
   python3.12 -m venv "$HOME/.local/share/mori-p115"
   "$HOME/.local/share/mori-p115/bin/python" -m pip install --require-hashes --only-binary=:all: -r integrations/p115_resolver/requirements-build.lock
   "$HOME/.local/share/mori-p115/bin/python" -m pip install --require-hashes --only-binary=:all: -r integrations/p115_resolver/requirements.lock
   "$HOME/.local/share/mori-p115/bin/python" -m pip install --no-deps --no-build-isolation -r integrations/p115_resolver/requirements.in
   ```

   管理员也可按 `integrations/p115_resolver/README.md` 的示例安装到 `/opt/mori-p115`（需要 root；doctor 会自动探测该默认位置）。
3. 让 doctor 与应用使用同一解释器：`export MORI_PYTHON="$HOME/.local/share/mori-p115/bin/python"`。
4. 运行 `node scripts/local.mjs doctor`。115 项的判定不是查包元数据，而是用该解释器运行 `integrations/p115_resolver/main.py` 的固定 `health` 协议（真实导入 SDK 与 normalizer，并核对 `p115client 0.0.9.7.2`）。

未配置时 doctor 会显示 `[未配置]` 或 `[不可用]` 并说明只影响 115 解析；整体退出码不受影响。

---

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| 提示端口 4180 被占用 | 可能已有一个 Mnemo 实例在运行；如需多实例，设置 `PORT` 换端口 |
| `PORT`/`HOST` 报「不可用」 | `PORT` 必须是 0–65535 的十进制整数；`HOST` 必须是合法主机名或 IP（如 `127.0.0.1`、`0.0.0.0`、`localhost`） |
| 数据/下载目录「不可写」或提示 `~`/符号链接 | 改用绝对路径或相对安装目录的路径；修正目录权限（macOS/Linux `chmod`/`chown`；Windows 右键属性或以管理员运行）；悬空符号链接需移除或修复 |
| 下载目录注明「不支持硬链接」 | 功能不受影响，发布将改用拷贝回退（较慢、发布期间需约两倍空闲空间）；追求性能请改用支持硬链接的文件系统（APFS/HFS+、ext4、btrfs、XFS、NTFS 或支持硬链接的 SMB/NFS 共享） |
| 依赖缺失 / 构建缺失 | 运行 `node scripts/local.mjs install` |
| `npm ci` 失败 | 检查网络、Node 版本（需 22.13.0+）与磁盘空间后重试 |
| Windows 下配置 115 组件 | 暂不支持：helper 仅支持 macOS/Linux，doctor 会如实标注；其余功能不受影响 |
| Windows 下中文乱码 | 启动器已自动 `chcp 65001`；手动运行命令时请先执行同一命令 |
| 双击后窗口一闪而过 | 用 `start-mori.cmd` / `start-mori.command` 启动（结束时会等待按键），或在终端中运行以查看完整输出 |
| 想看机器可读结果 | `node scripts/local.mjs doctor --json` |

---

## 7. 安全与隐私说明

- 本工具只读取上述路径/端口类环境变量，**不读取账号凭据、Cookie、数据库或私密账号状态**；管理员与凭据只能在 Mnemo 网页界面配置。
- 工具自身不下载 Node.js、Python 或远程脚本；依赖获取仅通过 npm/pip 按锁文件进行（见第 1 节）。
- 目录检测的写探针只创建并删除自己的独占随机临时文件，不动其他任何文件。
- 所有子进程均以**固定命令 + 参数数组**直呼，不经 shell 拼接：Windows 上通过 npm 的 JS 入口（`npm_execpath` 或 Node 自带 npm-cli.js）直调；Windows 的 PATH 回退不做 shell 拼接，无法安全直调时如实报告不可用。
- `start-mori.cmd` 不转发命令行参数（cmd 无法安全转义任意参数）；POSIX 启动器以加引号方式转发参数。

---

## 8. 测试与已知限制

- 离线测试：`npm run local:test`（即 `node --test scripts/tests/local.test.mjs`）。全部使用自建临时 fixture 与替身脚本，不联网、不触碰真实数据；覆盖版本比较、空格/中文路径、HOST/PORT 校验、相对路径与 `~` 拒绝、悬空符号链接、占位依赖识别、npm 探测次数与失败传播、115 helper health 协议、信号转发与进程组清理（含孙进程与重复投递）、退出码与 JSON 输出、凭据不泄露。
- 已知限制（如实说明）：
  - 信号与进程组语义在 macOS/Linux 上验证；Windows 上 Ctrl+C 依赖控制台广播，工具只做 12 秒直接子进程兜底终止，**不保证整棵进程树清理**，且未在真实 Windows 上冒烟。`start-mori.cmd` 为 Windows 编写并做静态校验（UTF-8 代码页、带引号路径、CRLF 行尾），集成后请在真实 Windows 上做一次双击冒烟；同理 Linux 下 `.sh` 仅在 macOS 上验证。
  - npm 在 Windows 上仅支持经 `npm_execpath` 或 Node 自带 npm-cli.js 直调（不经 shell）；非标准 npm 布局且两者都不可用时，doctor/start/install 会如实报告不可用，而不是退回 shell 拼接。
  - 115 组件仅支持 macOS/Linux（helper 依赖 POSIX 定时器）；Windows 上不做探测、文档不提供安装步骤。
  - 依赖检查按 `require.resolve` 验证关键包入口可解析；构建检查验证 `dist/index.html` 非空及其引用的本地静态资源存在，不等于运行时完全无错。
  - 前端构建产物按 Vite 默认输出目录 `dist/index.html` 检测；若项目自定义了 `outDir`，请以实际构建配置为准。
