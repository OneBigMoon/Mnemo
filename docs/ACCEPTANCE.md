# 用户需求与验收边界

日期：2026-10-25（初版 2026-10-24）。已交付本地可运行开发版，不以源码/模拟服务测试替代真实账号与设备验收。

| 用户需求 | 当前交付 | 仍需完成的验收 |
|---|---|---|
| 首次使用询问配置 | 管理员初始化 + 五步向导，复用设置页选择裸片名默认搜索/下载/追更；旧配置仍搜索 | 更多新用户可用性测试和真实账号授权 |
| OpenClaw 类常驻配置页 | 模型、来源、目录、媒体库、渠道分组；保存刷新恢复 | 产品配置帮助可继续完善 |
| 用户自行填写一个模型 Key | 兼容模型服务；默认共享模型，渠道可覆盖名称；支持本地免 Key | 用户所选真实服务的兼容性和费用验证 |
| 输入影视名称自动搜索 | 按保存偏好处理裸片名；明确命令优先；持久作品/年份/季集选择与确定性资源匹配；有歧义需确认 | 真实元数据与来源覆盖仍需扩大验证；不可将固定样例作为真实来源证据 |
| 网盘搜索、源订阅、自动下载 | 聚合订阅周期搜索；115和阿里可显式绑定已浏览目录，递归分页追更、去重及跨重启续扫；阿里分享只读解析，无需转存 | 夸克分享解析/必要转存、真实账号可用性和瞬时新增删除文件捕获未验收 |
| 下载到电脑/NAS目录 | 实际字节落盘、队列、续传、暂停、取消、幂等、重启恢复 | 真实超大文件、各NAS路径权限和磁盘故障 |
| 本地在线播放 | 已完成任务的本地实体文件可在 Web 客户端播放、暂停、拖动；单区间 HTTP Range、认证、非符号链接与真实路径校验，限制在任务下载目录或当前下载目录；新任务记录下载目录，更换配置后仍可播放，未记录目录的历史任务按当前目录查找；同一能力已在 linux/amd64 容器（非 root）中重复下载与播放验收，并通过仓库 Compose 默认 `./downloads` 绑定挂载验证宿主机落盘（字节夹具） | 云盘直链在线流、边下边播、转码、真实超大文件、真实 x86_64 主机、Windows 与移动端实机未验收；MKV/AVI/TS 取决于浏览器解码器 |
| 加速与体验项目 | 原生流式续传、可选aria2 JSON-RPC、OpenList取链接；115刷新直链并核验大小/SHA1；阿里按分享文件获取直链并核验大小及HTTP续传身份 | 115/阿里分享当前仅内置下载器；阿里来源未保证SHA1，真实网盘速度与会员能力未验证 |
| 电影、电视剧、网剧 | movie/tv 类型、年份、季号/集号、TMDB候选选择；单集、多集区间、整季包、多季范围、中文及全角季集、目录数字文件均有匹配与确认测试；仅证据一致的单个资源自动下载；电视剧按`剧名 (年份)/Season NN/`布局并写入单集 NFO 与`tvshow.nfo` | 未知命名变体、合集/多视频拆分、真实元数据与来源覆盖仍需扩大验证 |
| 刮削与整理 | NFO、受控TMDB图片请求、规范命名，无覆盖发布 | 同名片、特典、动漫等复杂命名需更多样例 |
| 飞牛、绿联、Emby等类别 | 通用NFO预设；Emby/Jellyfin刷新和身份/路径/播放来源核验；隔离 Emby 4.10.2.0 与 Jellyfin 10.10.7 的电影和电视剧均通过实际流读取及解码，电视剧识别为 Episode 并关联 SeriesId；Jellyfin 以非 root UID 1001 跨 UID 读取 Mnemo 发布的 0644 媒体/NFO | 飞牛/绿联专用刷新与实机格式未认证；媒体库均为隔离测试服务器，未连接用户生产媒体库或物理NAS |
| TG聊天入口 | 原生 Bot 轮询、会话白名单、持久选择与任务结果通知；关机等待在途回执收尾 | 真实 Bot 的平台连通性、限流和投递验收 |
| 微信、QQ、飞书 | 签名桥接与 AstrBot 0.2 插件；持久投递日志、poll/ack、过期回执处理和主动通知白名单 | 真实宿主与平台账号投递；不是原生平台登录 |
| 家庭共用渠道时的下载确认 | 可选「渠道下载审批」（默认关闭）：开启后渠道请求停在待批准，网页端批准或拒绝，直链命令不再绕过；关闭时保持单管理员直接下载。决定后经通知桥接 `poll` 回传申请人一条消息（批准＝已开始下载，拒绝＝未创建任务），同一决定重复提交只排一条。可按渠道三态覆盖（跟随全局／需批准／免批准），单渠道优先于全局，缺字段旧配置等价全部跟随全局 | 仍为单管理员，没有多账户/多角色；消息依赖桥接已启用，队列已满时决定仍生效但不补发；操作记录覆盖任务创建与审批决定（各留 500/200 条），但不含暂停/取消/删除、配置变更与登录；操作人是归属标识而非具体人；真实家庭使用习惯未验证 |
| 简单易用客户端 | 桌面/手机响应式界面、空状态、错误与真实进度；辅助文字对比度≥4.5:1 | 尚无原生Windows/macOS安装包 |
| 兼顾不同用户 | 本地Node运行、Docker部署、LAN访问；Docker内置Python3.12与固定115 SDK，Linux ARM64隔离验收；linux/amd64 播放镜像在 arm64 宿主模拟下通过非 root 下载/播放验收与 Compose 默认绑定挂载落盘验收；Mnemo UID 1000 发布的 0644 媒体/NFO 已由非 root UID 1001 Jellyfin 跨 UID 扫描、识别与流播放（Linux bind mount） | Windows/真实 x86_64 主机执行、应用内多用户隔离、真实 NAS/SMB ACL 与物理 NAS 未验收 |
| 开源供他人安装 | 自编源码MIT、锁文件、Dockerfile/Compose、安装和渠道文档、源码ZIP；源码仓库 [OneBigMoon/Mnemo](https://github.com/OneBigMoon/Mnemo) | 镜像仓库发布和外部用户公测尚未完成 |

## 当前证据

- 全量操作审计阶段：499 项 Node 测试通过（0 失败、取消或跳过），TypeScript 与 Vite 构建通过。任务创建（网页/渠道/订阅）与审批决定合并为一条时间线，任务审计与任务创建同事务写入，超出上限按时间裁剪；新增仅管理员可读的 `GET /api/audit`（`/api/approvals` 保留）。无会话访问 401；渠道批准建的任务与网页手动任务都出现在审计里。界面「操作记录」用无头 Chrome 验收 14/14：显示「渠道创建 · 沙丘.2021.1080p」与「已批准 · 沙丘」两行，390px 无溢出、控制台零错误，截图 `docs/evidence/approval-history-20261025.png`，回执 `docs/evidence/audit-trail-20261026.json`。

- 审批历史阶段：496 项 Node 测试通过（0 失败、取消或跳过），TypeScript 与 Vite 构建通过。决定与任务创建在同一事务内写入，请求上记录 outcome/at/by，独立历史按 requestId 去重并保留最近 200 条；新增仅管理员可读的 `GET /api/approvals`。无会话访问返回 401，拒绝与批准各留一条且 owner→outcome 映射正确。界面「审批记录」区块用无头 Chrome 验收：真实签名桥接发起→管理员批准后，区块显示「已批准 · 沙丘 · bridge:qq:qa-family · 时间」，12/12 项通过，截图 `docs/evidence/approval-history-20261025.png`，回执 `docs/evidence/approval-history-20261025.json`。该轮还修掉一个体验缺口：审批后历史不会自动刷新（首屏与决定后各补一次拉取）。

- 按渠道审批策略阶段：496 项 Node 测试全部通过（0 失败、取消或跳过），TypeScript 与 Vite 构建通过。新增覆盖 owner→平台映射（含畸形标识与 web 域）、三态覆盖优先级、旧配置补齐为跟随全局、配置校验拒绝未知取值，以及「全局关闭 + Telegram 需批准仍停待批准」「全局开启 + Telegram 免批准直接建任务」两条闸门用例。回执 `docs/evidence/approval-per-channel-20261025.json`。界面四个下拉已用无头 Chrome 做浏览器渲染验收：四个下拉与三态选项齐全、默认跟随全局、改成需批准后刷新保持、390×844 无横向溢出、控制台零错误；截图 `docs/evidence/approval-ui-desktop-20261025.png`、`approval-ui-mobile-20261025.png`，回执 `docs/evidence/approval-ui-verify-20261025.json`。该轮同时发现并修掉了纯字符串改名漏掉的 8 处界面旧词标（小写 `lucerna.`、页脚 `LUCERNA` 等）与打包产物名 `lucerna-client-*`。

- 渠道下载审批（M8）阶段：490 项 Node 测试全部通过（0 失败、取消或跳过），TypeScript 与 Vite 构建通过。新增回归覆盖：开关默认关闭时渠道请求直接建任务、开启后停在待批准且渠道侧不能自批、管理员跨域读取与批准/拒绝、网页管理员不受闸门影响、直链命令不再绕过审批。回执 `docs/evidence/m8-approval-20261025.json`。全套测试需在未注入本机文件系统 shim 的 Node 环境运行：该 shim 会把预期的 `EEXIST`/`link` 结果改写成拒绝错误，媒体与阿里用例在 shim 下必然失败，与产品缺陷无关。

- 电视剧季集匹配阶段 43 项定向测试和 451 项全套 Node 测试通过（0 失败、取消或跳过），TypeScript 和 Vite 构建通过；覆盖单集、多集区间、整季包、多季范围、中文数字/全角写法、目录数字文件与分辨率文件名，以及请求层自动下载、人工确认和冲突阻断。回执：`docs/evidence/season-matching-20261024.json`。
- 上一阶段搜索诊断验收的 443 项 Node 测试通过（0 失败、取消或跳过；最新全套为452项，见下条播放验收），包含115兼容、阿里授权状态/分享分页/下载/目录追更、持久恢复及关闭等待。项目TypeScript和Vite通过；新Linux ARM64搜索镜像另通过7项断外网就绪检查和10项实际HTTP测试，见 `docs/evidence/search-container-20261024.json`。
- 24项 AstrBot桥接插件测试通过（上一阶段记录，本轮插件未改），使用本地服务/假宿主，无真实平台消息。
- 当前Docker镜像在断外网环境通过11项安装检查及8项实际本地HTTP集成测试；运行源码/前端摘要与工作区一致。插件ZIP获取为上一阶段验证，本阶段插件未修改。
- 真实HTTP链路：搜索本地测试源 → 写入测试媒体字节 → NFO生成 → 重启读取完成状态。
- 隔离Emby 4.10.2.0真实服务：上一阶段从直接创建下载任务开始，回执为 `docs/evidence/emby-isolated-20261023.json`。本轮补齐HTTP裸片名入口 → 实际PanSou协议搜索 → 原生下载与NFO → Emby识别 → 完整媒体流SHA一致 → ffmpeg解码，见 `docs/evidence/fullchain-emby-20261024.json`。作品身份和搜索源为受控样例，没有真实模型、TMDB、公开分享、聊天账号或物理NAS参与。
- 电视剧全链路：在同一隔离 Emby 4.10.2.0 中，从 HTTP 裸片名开始，详情步骤要求显式季集；选择季1集2后创建聚合订阅，并以 `Mnemo TV Fixture 2026 S01` 检查。本地 PanSou 协议同时返回正确的 S01E02 与错误的 S02E02，只有 S01E02 入队，错误季资源 0 次读取。原生下载落到 `Mnemo TV Fixture (2026)/Season 01/Mnemo TV Fixture (2026) - S01E02.mp4`，写入单集 NFO 与 `tvshow.nfo`；Emby 识别 `Episode`、季1集2、`SeriesId`、`SeriesName` 和准确路径，完整媒体流 SHA-256 与源文件一致并通过 ffmpeg 解码。镜像 `mori-media-agent:tv-fullchain-20261024`，runId `60f4ed67883b`；回执：`docs/evidence/fullchain-tv-emby-20261024.json`。作品身份和搜索源为受控样例，没有真实模型、TMDB、公开分享、聊天账号或物理NAS参与。
- 当前镜像 Emby 电影回归：使用 `mori-media-agent:jellyfin-fullchain-20261024`（镜像 ID `sha256:fef451c032836c7f9ed51b49487c036ca1bc547abbff176ecac4f646e668d7c1`）重跑电影全链路，runId `a333a03d4e97`，完整媒体流 53,540 字节、SHA-256 与源文件一致并通过 ffmpeg 解码，回执 `docs/evidence/fullchain-emby-regression-20261024.json`；上一镜像的电影回执 `docs/evidence/fullchain-emby-20261024.json` 保留。
- 隔离 Jellyfin 10.10.7 电影全链路：固定摘要镜像全新实例，经真实启动向导创建临时账户和 movies 媒体库；HTTP 裸片名 → 实际 PanSou 协议搜索 → 原生下载与 NFO → Jellyfin 识别 `Movie` 和准确路径 → 完整媒体流 53,542 字节、SHA-256 与源一致 → ffmpeg 解码。Mnemo 镜像 `mori-media-agent:jellyfin-fullchain-20261024`（镜像 ID `sha256:fef451c032836c7f9ed51b49487c036ca1bc547abbff176ecac4f646e668d7c1`），runId `9b63af34c511`，itemId `224637f893eab83ab458c88c1a83db25`；回执：`docs/evidence/fullchain-jellyfin-20261024.json`。作品身份和搜索源为受控样例，没有真实模型、TMDB、公开分享、聊天账号或物理NAS参与。
- 隔离 Jellyfin 电视剧全链路：固定摘要镜像全新实例和 tvshows 媒体库；HTTP 裸剧名停在详情步骤，选择季1集2后创建聚合订阅。本地 PanSou 同时返回 S01E02 与 S02E02，只有 S01E02 入队，错误季资源 0 次读取。原生下载落到 `Mnemo TV Fixture (2026)/Season 01/Mnemo TV Fixture (2026) - S01E02.mp4` 并写入单集 NFO 与 `tvshow.nfo`；Jellyfin 识别 `Episode`、季1集2、非空 `SeriesId`、`SeriesName` 和准确路径，完整媒体流 53,542 字节、SHA-256 与源一致并通过 ffmpeg 解码。Mnemo 镜像 `mori-media-agent:jellyfin-tv-fullchain-20261024`（镜像 ID `sha256:9ab15606f223f1a02e67b2fad19a8e72dde4f8b84184eb3ab18101b564a3720c`），runId `9edbb0d9cd8d`；回执：`docs/evidence/fullchain-tv-jellyfin-20261024.json`。
- 当前镜像 Emby 电视剧回归：使用同一 `mori-media-agent:jellyfin-tv-fullchain-20261024` 镜像重跑 Emby 电视剧全链路，runId `5ba78debd1da`，同样识别 `Episode`、季1集2、`SeriesId` 和准确路径，完整流 SHA-256 与源一致并解码通过，错误季资源 0 次读取；回执 `docs/evidence/fullchain-tv-emby-regression-20261024.json`，原 Emby 电视剧回执 `docs/evidence/fullchain-tv-emby-20261024.json` 保留。
- Chromium：初始化、五步向导、配置保存后刷新恢复、手机390×844无横向溢出、电视剧任务表单与无效URL拒绝。
- 本地播放阶段1项定向测试和452项全套 Node 测试通过（0失败、取消或跳过），TypeScript和Vite构建通过。定向测试覆盖未登录拒绝、完整200、`bytes=3-7`/开放区间/后缀区间、越界与多区间416及`bytes */size`、HEAD、未知任务404、未完成409、目录外路径与指向目录外的符号链接404、文件删除后404，并检查任务记录下载目录。浏览器实测：受控3秒MP4（81,833字节，SHA-256与下载文件一致）经Mnemo下载后，播放器`readyState=4`，手动播放后时间前进，拖动到2.2秒后继续播放，媒体请求返回`206`和`video/mp4`，控制台无错误；截图`docs/evidence/local-playback-ui-20261025.png`，回执`docs/evidence/local-playback-20261025.json`。该能力仅播放已完成任务的本地文件，不做云盘在线流、边下边播或转码；MKV/AVI/TS等取决于浏览器解码器，临时服务与目录已清理。真实网盘、NAS、Windows和移动端实机仍未验收。
- Linux amd64 容器播放验收：镜像 `mori-media-agent:playback-amd64-20261025`（`sha256:739ca3a0e06a9b8ad06ddb5dce315e586120533f6cc834ecc3460605f09c7fe4`）在 arm64 OrbStack 宿主以 QEMU 模拟运行，非 root UID 1000、Node v22.23.4 linux x64、健康检查 healthy、固定 p115 SDK 0.0.9.7.2。新建实例经 `/api/setup` 后下载52,646字节受控MP4并写入NFO，任务记录 `downloadRoot=/downloads`；完整流200与源文件SHA-256一致，`bytes=100-199`与后缀请求返回206，多区间返回416及`bytes */52646`，HEAD 200空体；静态前端与工作区构建摘要一致。宿主 Chromium 从容器实例播放：`readyState=4`、无媒体错误、拖动到1.4秒后暂停，媒体响应206 `video/mp4`。回执`docs/evidence/playback-container-amd64-20261025.json`，截图`docs/evidence/amd64-container-playback-20261025.png`，复跑脚本`scripts/verify_container_playback.mjs`。限制：amd64 为模拟执行而非真实 x86_64 主机；未覆盖搜索、模型、TMDB、媒体库或真实115；宿主 `/tmp` 绑定挂载在本次 Docker 环境不可用，验收使用命名卷；容器与临时卷已清理，镜像保留。
- Compose 默认部署路径验收：使用仓库 `compose.yaml`（SHA-256 `d2da67a5...`）的默认 `127.0.0.1:4180` 与 `./downloads` 绑定挂载，在 `linux/amd64` 镜像上启动非 root 容器，下载 52,646 字节确定性字节夹具（扩展名 `.mp4`，非可解码视频），296ms 完成；宿主机上的 MP4 与 NFO 摘要与服务端、源文件一致，流式 200/206/后缀 206/多区间 416/HEAD 通过，容器健康且零重启。首次尝试因夹具服务仅绑定 `127.0.0.1` 出现一次 undici `Parser.finish` 断言退出，任务在重启后标记暂停；改用 `0.0.0.0` 绑定并重置实例后通过，根因未定位，不宣称已修复。该轮未启动 pansou，未覆盖搜索、真实网盘、真实 x86_64 或浏览器播放。回执`docs/evidence/compose-bind-amd64-20261025.json`。
- 非 root 媒体库跨 UID 权限验收：Mnemo 镜像 `mori-media-agent:jellyfin-nonroot-20261025`（`sha256:a33495e3893a7db43e7457b91b18dde50d3bcbce4537487e5b13ba73f6b0ed83`，linux/amd64 模拟）以 UID 1000 下载真实公网 HTTPS 源（4,372,373 字节，SHA-256 `b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254`），发布媒体与 108 字节 NFO 均为 `0644`；全新 Jellyfin 10.10.7 以非 root UID/GID 1001 经 Linux bind mount 扫描并识别为 `Movie`/2010，Mnemo 首次库校验即为 `verified`、`playable`，Jellyfin 完整直连流与源文件 SHA-256 一致，区间请求返回 206，ffmpeg 解码 exit 0。产品侧将新建下载根目录和分季目录设为 `0755`，并新增跨用户读取回归；同时修复并发剧集刮削共享 `tvshow.nfo` 时偶发把发布中的临时硬链接判为不安全文件、导致任务失败的问题，并新增 12 路并发刮削回归。媒体定向 19 项与全套 454 项 Node 测试通过（0 失败、取消或跳过），连续运行 3 次全套无失败，TypeScript 与 Vite 构建通过。回执 `docs/evidence/jellyfin-nonroot-real-source-20261025.json`（11,984 字节，SHA-256 `ab148660fb5787dafddd3c8b79e4af2dec94ecaaffa73ad8d82d1a288bef1dfe`），帧 `docs/evidence/jellyfin-nonroot-real-source-frame-20261025.png`。限制：任务经 `POST /api/tasks` 创建，身份确认与资源搜索未在本轮复验；未使用 TMDB、Jellyfin Web 客户端、真实网盘、NAS/SMB ACL、Windows、移动端或物理 x86_64；Jellyfin 为原生 arm64、Mnemo 为模拟 amd64。旧版本已生成的 `0600` 文件不自动迁移。
- 独立源码审查确认Host校验、取消传播、数据库关闭顺序、刮削中断后恢复的修复。
- 源码与发布包不含真实模型Key、网盘凭据、管理员数据库或浏览器状态。
- 真实PanSou本地实例搜索“宝宝巴士”成功，Mnemo适配器规范化返回100条记录，其中96条标题包含查询词；来源记录可用不等于分享有效或已经下载。正式预览已连接该服务；TMDB和模型尚待用户配置。具体回执见 `docs/evidence/pansou-live-probe.json`。

没有任何一项真实账号、真实NAS或平台互操作性被模拟测试替代宣称完成。

搜索诊断新增验收：未配置、全部失败、部分失败、部分来源无结果、全部无结果和完整结果六种客户端状态均通过。部分失败保留可用结果；隔离客户端手动创建的下载实际落盘47字节，390px无横向溢出、页面零异常，自有服务、浏览器和临时状态已清理。请求与订阅持久化诊断，成功进入具体分享后移除旧聚合警告；未生成新报告的异常不会沿用旧成功状态。独立审查后补强目录订阅清理回归，30项定向测试和443项全套测试通过。证据索引：`docs/evidence/search-isolated-20261024.json`。

新的匿名PanSou探测返回100条规范化结果，其中99条标题含“宝宝巴士”，耗时10290ms；仅证明当次公开搜索可用，不证明分享有效、账号权益或实际下载速度。回执：`docs/evidence/search-pansou-live-20261024.json`。

本轮新增：通知中心的已读、忽略、未知结果重发确认及刷新恢复通过独立无头 Chromium 验证；390×844 无横向溢出。Linux ARM64 新镜像通过 7 项安装烟测并清理临时容器，回执见 `docs/evidence/notifications-container-20261024.json`。通知交付状态不等于实际观看或平台阅读回执。

默认片名动作验收：旧加密配置迁移为搜索、旧客户端编辑保留现值、已保存动作跨重启保持、未保存草稿不改助手提示、资源搜索页只搜索、键盘与390px布局通过。隔离 HTTP 覆盖裸片名下载实际临时字节文件及 Web/QQ 合并追更；Linux ARM64 的11项烟测含重启后偏好/会话保留和否定输入无写。回执见 `docs/evidence/title-actions-isolated-20261024.json`。

115分享文件基础验收见 `docs/evidence/p115-isolated-20261024.json`；其“目录订阅未实现”仅是上一阶段边界。Python helper/SDK本阶段未改，不重复该基础测试。

115目录追更新增验收：纯HTTP流程在macOS和断外网Linux ARM64容器均通过5项，覆盖17个模拟剧集文件字节/SHA/NFO、先接纳10个后跨重启处理pending、子目录/下一页/后续新增、重复媒体去重、错季/错作品/附加文件排除、暂停和删除取消，以及从搜索起的签名QQ入口复用Web订阅并继承通知。目录范围和检查次数有硬上限，未知命名不会自动下载。容器回执 `docs/evidence/directory-container-20261024.json`；模拟视频字节和签名桥接不等于真实115或QQ平台验收。

目录追更客户端验收：独立无头浏览器确认10+2待处理文件及刷新恢复、先消费积压再续页、取消后迟到结果不入队、390px无溢出和页面零错误。所有自有句柄/临时状态已清理。最终本轮证据索引见 `docs/evidence/directory-isolated-20261024.json`。

阿里分享新增验收：使用模拟Web授权/分享服务，真实本地HTTP串联搜索、匿名目录浏览、手动下载、跨重启目录追更及签名QQ入口复用。24个符合条件的模拟剧集文件落盘并生成NFO，6个错季/附加候选被排除；模拟字节比对不代表来源提供SHA1或真实下载权益。授权轮换先加密持久化再使用；结果未知不会自动重放。关闭等待请求、下载和授权处理完成后才关闭数据库。读取链接同时最多2个，另有最多4个有时限等待，已覆盖默认4路下载场景。

阿里客户端通过16项隔离检查，包括匿名浏览/下载授权提示、保存与独立清除、两种未知授权错误及重新配置恢复、目录分页和旧115兼容；实际队列生成2个共78字节的模拟文件，390px无溢出。自有浏览器、临时服务/凭据与文件、容器及其匿名卷均清理。证据：`docs/evidence/alipan-isolated-20261024.json`、`alipan-container-20261024.json`、`alipan-ui-20261024.json`。

审查边界：独立审查发现的关闭提前返回问题已修复并验证；Agent Guard屏蔽了部分授权写入/提交/访问与HTTP计时/请求/刷新源码，完整独立源码审查仍未证实。行为测试不替代这项缺失证据。本轮未使用真实网盘账号、真实NAS、付费模型或真实平台消息；Windows/真实 x86_64 主机、物理飞牛/绿联与真实下载权益仍待验收。
