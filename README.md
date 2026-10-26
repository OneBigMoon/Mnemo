# Mnemo · 影视管家

一个本地优先、可自行部署的影视 Agent 客户端。通过模型或关键词查找内容、保存订阅、下载到电脑/NAS，并输出媒体库元数据。所有账号和资源由使用者自行授权。

> 当前是可运行的 0.1 开发版。连接器通过本地模拟服务验证，不等于已经验证所有网盘账号、聊天平台或 NAS 固件。实际兼容边界见下表，不把分享页、转存或 STRM 当作实体文件下载完成。

**命名沿革**：项目原名 Mori，2026-10-25 起叫 Lucerna，现更名为 **Mnemo**（希腊神话记忆女神 Mnemosyne 的简称：记忆＝媒体库与元数据，缪斯之母＝影视与音乐）。用户可见处一律用 Mnemo；为避免已有部署失效，下列技术标识符保持原样或双名兼容：`.env` 里的 `MORI_*` 仍被读取（新名 `MNEMO_*` 优先）、数据卷 `mori-data`、数据库 `mori.sqlite`、`.mori-*` 临时/续传前缀、`mori-share:` 协议、`X-Mori-*` 桥接签名头、`start-mori.*` 启动器文件名、`astrbot_mori` 插件包，以及全部历史回执与发布包。详见 `docs/evidence/mnemo-brand-20261025.json`。

## 运行

本机安装可先查看[安装与自检说明](docs/LOCAL_INSTALL.md)：提供 macOS、Linux、Windows 启动入口，以及 `npm run local -- doctor` 环境检查。发布源码包的方法见[源码打包说明](docs/SOURCE_PACKAGE.md)。启动入口已通过 macOS 隔离测试；Windows 实机仍待验证。

源码构建需要 Node.js 22.13 及以上（使用内置 SQLite）和 Rust/Cargo。Windows、macOS、Linux 使用同一套 Web 客户端；已经打好的便携包不需要另装 Rust：

```sh
npm ci
npm run build
npm start
```

若要使用115分享下载：本项目Docker镜像已内置Python 3.12和固定版本的p115client。本机Node.js启动时，请在`npm start`前按[115 helper安装说明](integrations/p115_resolver/README.md#依赖安装)准备独立venv，依次完成构建依赖锁、运行依赖锁和固定SDK三个安装步骤，并将`MORI_PYTHON`设为该环境的Python可执行文件。仅安装npm依赖不会安装115 SDK。阿里分享使用内置HTTP适配，不依赖这个SDK。

打开 `http://127.0.0.1:4180`，设置至少 12 字符的管理员密码，再完成引导。默认仅监听本机；未配置模型服务时仍可使用规则与关键词模式，地址和模型名齐全的本地模型允许免 Key。模型调用由用户保存配置并主动使用时发生，未内置任何共享或付费 Key。

开发前端：一个终端执行 `npm run dev`，另一终端执行 `npm run dev:web`。Vite 会把 `/api` 代理到本地后台。

## 桌面与移动端

### Rust 核心迁移（2026-10-26）

默认搜索路径已使用 `rust-core/` 的原生程序解析 CMS 列表、分集详情和 RSS/Atom 正文，程序随构建复制到 `bin/mnemo-core`（Windows 为 `.exe`）。RSS/Atom 来源使用固定订阅 URL，按查询词筛选标题；可选 `{query}` 占位会被编码替换。CMS 继续使用 `wd` 查询参数。来源注册表最多 32 项，搜索同时处理 4 个来源；原生解析最多 2 个子进程和 16 个等待任务，正文最多 4 MiB，超时或取消会结束对应子进程。

原生核心现为 `0.1.1`，还负责兼容旧 scrypt 记录的登录密码校验，以及下载响应的 200/206 续传范围、长度和校验标识判定。密码校验使用有界异步子进程，输入只经 stdin；初始化密码、会话、配置加密和 SQLite 格式保持原样。下载判定在打开、追加或截断临时文件前完成，网络、流式写入、文件发布和任务落库继续由 TypeScript 管理。

HTTP/API、队列和网盘连接器仍由 TypeScript 主程序管理。`output/zcode-work/rust-core` 是历史候选，不会作为独立服务启动，也不会接管已有数据库。原生核心故障会明确显示；不会静默切换实现。必要时可设置 `MNEMO_CORE=typescript` 回退原有 CMS 解析、密码校验和续传判定（此模式不提供新增 RSS/Atom 解析）。此迁移不改变已保存的任务、凭据或媒体文件。

便携客户端现在要求在目标操作系统上执行原生程序的协议校验后打包；Windows 包必须在 Windows 上构建/验证。历史客户端包不包含本轮变更。

除了 Docker 与源码运行，还提供**便携客户端包**：macOS（Apple Silicon）解压双击即用、Windows（x64）解压后首次联网装依赖，均内置官方 Node.js 运行时，机器无需安装 Node；安卓/桌面浏览器在 HTTPS 入口下可「安装到主屏幕」作为独立应用使用。打包方式、验收状态与限制见[便携客户端说明](docs/CLIENT_PACKAGES.md)。

## NAS / Docker

复制 `environment.example` 为 `.env`，填写自己的初始化口令和下载目录。Docker Compose 会同时启动受限资源的 PanSou 搜索服务，新建 Mnemo 配置自动连接它，无需再部署第二套PanSou。然后：

```sh
docker compose up --build -d
```

直接用 Node.js 运行时，可设置 `MORI_PANSOU_URL` 指向已有 PanSou，否则需在设置页连接自己的来源。模型 Key、作品识别服务和资源搜索源是独立配置；未连接来源时不会制造搜索结果。

初始化页面需要 `.env` 中的 `MORI_SETUP_TOKEN`。默认端口只绑定本机。需要局域网访问时明确设置 `MORI_BIND_ADDRESS=0.0.0.0`，使用自己的防火墙/HTTPS入口，不默认暴露公网。下载目录必须可由容器 UID 1000 写入；容器内设置页填写 `/downloads`。不通过 `chmod 777` 解决权限。Mnemo 把媒体和 NFO 发布为 `0644`，把由它新建的下载根目录和分季目录设为 `0755`，便于以其他 UID 运行的 Emby/Jellyfin 读取；数据库、续传元数据和凭据仍保存在私有的 `/data`。若下载根目录由你预先创建，它必须对媒体服务器用户可遍历；旧版本已经生成的 `0600` 文件不会自动迁移。Mnemo 优先用硬链接原子发布媒体；下载目录所在文件系统不支持硬链接（如 exFAT/FAT32）时自动改用拷贝回退，仍不覆盖既有文件，但发布较慢且期间需要约两倍空闲空间，doctor 会注明。

使用 NAS 主机名或反向代理时设置完整 `MORI_PUBLIC_ORIGIN`，HTTPS 下另设 `MORI_COOKIE_SECURE=1`；通过局域网 IP 直接访问无需填写主机名。`/data` 存储数据库与加密密钥，必须一起备份；丢失 `master.key` 将无法解密凭据。此应用不提供账号多租户隔离；当前是一个管理员管理自己的媒体库。

电脑运行时关闭浏览器不会停止后台，关闭后台/关机会中断任务；NAS 常驻运行才可持续订阅。中断任务恢复后显示暂停，可手动继续；不把中断宣告完成。

## 配置中心

首次向导和设置页共用持久配置：

- 模型：兼容 Chat Completions 的 API 基址、模型名和用户自己的 Key。Key 加密存储，读取接口不返回明文；空白保存保留已有 Key。
- 片名检索来源：PanSou、OpenList、MoviePilot和已配置的公开TG频道。配置存在不代表服务连通或本次检索成功。
- 作品识别与分享解析：TMDB用于作品元数据，115/阿里分享账号用于分享浏览与下载，不能代替片名检索源。两项分享功能均默认关闭，凭据须由用户自行提供；不让模型索取密码或凭空创建登录态。
- 下载：目录、1–4 个并行任务、可选 aria2 RPC。aria2 和 Mnemo 必须能访问同一个文件系统路径，否则不能验证真实落盘。
- 媒体库：Emby、Jellyfin、飞牛、绿联、Kodi 的通用 NFO/命名预设、元数据语言和图片开关。
- 渠道：原生 Telegram Bot；微信、QQ、飞书通过签名桥接接入。设置页提供可安装的 AstrBot 插件 ZIP，源码与操作说明位于 `integrations/astrbot_mori`；仍需要 AstrBot 对应渠道的账号授权。每个渠道默认沿用全局模型，可选模型名覆盖；不是为每个渠道复制一套下载服务。「渠道下载审批」默认关闭，开启后渠道发起的下载先停在待批准，由你在网页端批准或拒绝。

文件存在哪台 NAS，与由哪个媒体软件播放，是两项独立配置。Emby/Jellyfin 可配置服务器、播放账户和目录映射，下载后会请求刷新并检查准确文件、作品身份与播放来源；文件完成与入库确认分别显示。电影与电视剧使用各自的规范目录布局；电视剧为`剧名 (年份)/Season NN/剧名 (年份) - S01E02.ext`，并写入单集 NFO 与剧集级`tvshow.nfo`。隔离 Emby 4.10.2.0 与 Jellyfin 10.10.7 已分别通过电影和电视剧的实际流读取与解码验证；电视剧均识别为 Episode 并关联 SeriesId。另以非 root UID 1001 的全新 Jellyfin 10.10.7 验证：Mnemo 以 UID 1000 发布的 `0644` 媒体与 NFO 可被跨 UID 扫描、识别并直接流播放，回执为 `docs/evidence/jellyfin-nonroot-real-source-20261025.json`。飞牛/绿联仍使用通用 NFO，尚未在实际设备上验收；不能承诺厂商私有格式完全兼容。

已完成下载的任务可在 Mnemo 的 Web 客户端直接播放并拖动进度，服务端只读取任务记录中位于下载目录内的实体文件，支持单区间 HTTP Range。本版本新下载的任务会记录落盘时的目录，更换配置后仍可播放；没有该记录的历史任务只按当前下载目录查找。这里播放的是已完整落盘的文件，不是网盘边下边播或云盘直链流；也不做转码。浏览器通常能直接播放 MP4/WebM/MOV，MKV、AVI、TS 等取决于内置解码器，失败时请改用 Emby/Jellyfin 或本地播放器。除本机 macOS 验收外，已在 Linux amd64 容器中以非 root 用户重复下载与播放（完整 200、区间/后缀 206、多区间 416、HEAD），并通过仓库 Compose 默认 `127.0.0.1:4180` 与 `./downloads` 绑定挂载验证宿主机落盘；回执为 `docs/evidence/playback-container-amd64-20261025.json` 与 `docs/evidence/compose-bind-amd64-20261025.json`。详见[本地播放说明](docs/PLAYBACK.md)。

在首次向导或「设置中心 → 模型」选择「只说片名时」的默认动作：先搜索、找到后下载、持续追更。新安装和旧配置默认先搜索；主动选择并保存后，客户端与已授权消息渠道共用该行为。作品、年份、季集或资源不明确时仍会让你选择。明确发送「搜索 / 下载 / 订阅」优先于默认设置；资源搜索框始终只搜索。问句或控制字样的真实片名可完整写成《片名》，例如《你想活出怎样的人生？》。

## 能力边界

| 能力 | 当前实现 |
|---|---|
| 直链实际下载 | 流式写入、进度、暂停/取消、来源允许时续传、已有文件不覆盖 |
| 本地播放 | 已完成下载的实体文件可在 Web 客户端播放和拖动；单区间 HTTP Range、登录校验及下载目录路径约束；不含云盘在线流、边下边播或转码 |
| aria2 | 可选 JSON-RPC；是否分段提速取决于服务器、账号、网络和资源能力 |
| 网盘 | OpenList 已挂载/授权文件路径解析，不内置所有网盘扫码和分享转存流程 |
| 搜索 | 聚合已配置的片名检索源，标明资源类型及本次来源诊断；Compose已带PanSou |
| TG 来源 | 已配置公开频道的可访问内容；不是任意私有频道全文索引 |
| 分享链接 | 115与阿里可分页浏览、选文件下载及目录追更，均原生下载且不转存；夸克仅走既有OpenList挂载路径，分享选文件转存与对账待实现 |
| 订阅 | 保留按剧名聚合订阅；另可独立订阅115或阿里目录及下级目录，仅对匹配已确认作品的新文件自动入队 |
| 刮削 | TMDB 识别、NFO和图片；同名片/季集仍需确认，元数据来源需自己的授权 |
| 多渠道 | 原生 Telegram + 微信/QQ/飞书签名桥接；后者需要额外运行现成适配器 |
| 模型安全边界 | 固定意图和参数校验，无任意 shell、任意系统设置工具 |

### 搜索来源诊断

- 未配置片名检索源：先在设置中连接来源；不是已经查过但没有资源。
- 全部来源失败：本次检索没有成功，不能据此判断没有资源。
- 部分来源成功：会说明失败的来源，已取得的资源仍可继续选择。
- 已查来源全部成功但0结果：本次暂未找到匹配，不代表所有地方都没有这部作品。

来源返回格式错误会按失败提示，不当作真实空结果。请求和订阅会保存最近一次检索诊断，并在聊天回复中展示。检查来源设置后可由你明确重试；软件不会自动重复提交结果未知的操作。

### 115与阿里分享下载

在「设置中心 → 来源」分别启用115或阿里（默认关闭）。115的Cookie可选，匿名访问由来源决定；115「测试」只检查SDK就绪。阿里可匿名浏览，下载及目录追更需手动保存Web RefreshToken（不是官方OpenAPI token），不提供扫码或浏览器自动取凭据。

阿里凭据留空保存会保留原值，清除需显式操作。验证不保证分享权限或会员权益；结果未知时须取得并保存新的Web凭据，不能重复验证旧值。详见[阿里授权、续传与验收边界](docs/ALIPAN_ADAPTER.md)。

选择115或阿里分享后，可浏览文件夹和分页；目录导航不会启动下载。选中文件经作品匹配或必要的确认后，才会加入下载任务。两者均无需转存，文件使用原生下载器，不走aria2。文本渠道的提取码命令见[渠道说明](docs/CHANNELS.md#频道内继续选片)。

持续追更需先确认作品、年份和电视剧季数，再成功浏览目标目录，单独点击「订阅此目录」或发送`订阅目录 <requestId>`。阿里追更需先保存Web登录凭据。原有「订阅 剧名」仍是按作品聚合订阅。扫描范围、暂停和轮询限制见[目录追更说明](docs/SHARE_RESOLVER.md#目录追更与限制)。

电视剧季集匹配覆盖`S01E02`、`1x02`、`Season/Episode`、`第2季 第3集`、中文数字及全角写法，并识别多集区间、整季包、多季范围和目录中的纯数字集号。只有完整片名、唯一年份和唯一季集证据全部一致的单个资源才会自动下载；多集或整季包、错季、错集及类型冲突按不匹配阻止下载，缺失唯一年份或季集证据的资源必须由你明确确认。片名中一次写出多季或多集会被要求拆成一次一季或一集；电视剧下载需先指定季号和集号，订阅需先指定季号（开始集可选）。电视剧下载落到`剧名 (年份)/Season NN/`，文件名统一为`剧名 (年份) - S01E02.ext`，并在单集旁写入 NFO、在剧集根目录写入稳定的`tvshow.nfo`；隔离 Emby 与 Jellyfin 已据此识别 Episode、季集号和 SeriesId。不同来源的命名变体、合集/多视频拆分及真实来源覆盖仍需继续验收，详见[电视剧季集匹配](docs/SEASON_MATCHING.md)。应用内多用户隔离（当前为单管理员）、真实 NAS/SMB ACL、原生安装包、网盘一键扫码、各平台端到端认证及飞牛/绿联专用刷新仍属于后续验收项，不以界面存在代替已实现。

任务完成或失败后，通知中心会保留结果。原生 Telegram 可向已授权会话发送；微信、QQ、飞书通过 AstrBot 0.2 插件领取并投递，须在插件中开启主动通知和会话白名单。发送结果未知时不会自动重发；重新发送需明确确认，已发送不代表对方已阅读。详细协议与限制见 `docs/NOTIFICATIONS.md` 和 `integrations/astrbot_mori/README.md`。

## 连接器与研究依据

官方项目入口（调研时间 2026-10-23）：

- PanSou: https://github.com/fish2018/pansou
- OpenList: https://github.com/OpenListTeam/OpenList
- aria2: https://github.com/aria2/aria2
- MoviePilot: https://github.com/jxxghp/MoviePilot
- AstrBot: https://github.com/AstrBotDevs/AstrBot
- Gopeed: https://github.com/GopeedLab/gopeed
- AB Download Manager: https://github.com/amir1376/ab-download-manager

默认优先稳定协议 OpenList + aria2。Gopeed 可作为未来替换引擎；不为“加速”同时运行多套默认队列。Motrix Turbo/Gopeed 的新 beta 能力与稳定发布分开评估。CloudDrive2 未确认主程序开源，不作为本项目源码依赖。

本仓库自编代码使用 MIT。外部服务独立运行并遵循各自许可证；未复制 MoviePilot/OpenList/aria2 源码。商业使用、镜像捆绑和再分发前应核验对应依赖的许可文件。

## 验证

本机运行回执、截图和内部执行计划不纳入公开 Git 仓库；文档中的历史证据路径保留在本地交付包中，可通过下列命令重新验证当前源码。

```sh
npm run check
npm test
npm run build
```

自动化测试使用临时目录和本地服务，不连接真实网盘、模型或聊天账号。[隔离播放验收](docs/ISOLATED_PLAYBACK.md)提供可复跑脚本，分别覆盖电影和电视剧：从HTTP片名请求开始，验证原生搜索、下载、NFO和真实Emby媒体流；作品身份和搜索源仍是受控样例，不能对生产媒体库运行。电影最新回执为 `docs/evidence/fullchain-emby-20261024.json`，当前镜像回归回执为 `docs/evidence/fullchain-emby-regression-20261024.json`，电视剧全链路回执为 `docs/evidence/fullchain-tv-emby-20261024.json`，历史直接下载验收为 `docs/evidence/emby-isolated-20261023.json`。[本地播放](docs/PLAYBACK.md)使用受控 MP4 验证认证、Range 拖动、路径约束和独立浏览器播放，最新全套 454 项 Node 测试、类型检查、构建与截图见 `docs/evidence/local-playback-20261025.json`；同一能力已在 `linux/amd64` 容器镜像中重复验收（非 root、健康检查、静态资源、完整/区间/后缀/HEAD 流与浏览器播放），见 `docs/evidence/playback-container-amd64-20261025.json` 和 `scripts/verify_container_playback.mjs`；仓库 Compose 的默认端口与 `./downloads` 绑定挂载也已验收（字节夹具，非真实视频），见 `docs/evidence/compose-bind-amd64-20261025.json`。媒体服务器跨 UID 读取另以全新非 root Jellyfin 验收，回执 `docs/evidence/jellyfin-nonroot-real-source-20261025.json`。容器验收运行于 arm64 宿主模拟，未使用真实网盘、NAS 或移动端实机。当前能力及剩余平台验证项见 `docs/ACCEPTANCE.md`；旧源码包不会被静默覆盖。

渠道签名协议见 `docs/CHANNELS.md`。任何返回的来源页面、文件名和搜索描述都属于不可信内容，不作为系统指令。

`tests/selection-preview.manual.ts` 是明确标记的隔离演示，不是真实搜索服务。它只接受“回声”固定样例，并在所有页面显示橙色测试警示；普通片名不能使用这些样例作为搜索证据。正式实例默认不启用 `testMode`。
