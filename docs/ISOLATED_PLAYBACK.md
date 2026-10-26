# 从片名到 Emby/Jellyfin 播放的隔离验收

该文档覆盖 Emby 与 Jellyfin 各两条（电影、电视剧）隔离全链路，共四条。它们都使用自生成视频、本地 PanSou HTTP 样例和固定作品身份；Mnemo 的请求处理、搜索适配、下载、NFO 写入和媒体库入库/播放验证均使用实际实现。它们不调用模型，也不证明真实 TMDB、网盘账号、公开分享、聊天平台或物理 NAS 可用。

需要 macOS、Linux 或 WSL 上的 Python 3.9+ 和 Docker。当前实际验收环境为
macOS 主机及 Linux ARM64 容器；其他平台和架构仍需分别验证。

在项目根目录执行：

```sh
docker build \
  -t mori-media-agent:fullchain-test \
  -t mori-media-agent:tv-fullchain-20261024 \
  -t mori-media-agent:jellyfin-fullchain-20261024 \
  -t mori-media-agent:jellyfin-tv-fullchain-20261024 \
  .
python3 scripts/verify_emby_fullchain.py
python3 scripts/verify_emby_tv_fullchain.py
python3 scripts/verify_jellyfin_fullchain.py
python3 scripts/verify_jellyfin_tv_fullchain.py
```

四个标签来自同一工作区构建，分别用于对应回执的可追溯性；测试文件由验证器从
宿主机只读挂载，避免镜像内旧副本掩盖当前改动。已有待测镜像时，可通过
`MORI_FULLCHAIN_IMAGE` 指定电影镜像，通过 `MORI_TV_FULLCHAIN_IMAGE` 指定电视剧镜像，
避免重复构建。Emby 与 Jellyfin 使用脚本内固定摘要的官方镜像；首次运行可能需要下载镜像。

验证器生成三秒 H.264/AAC 视频，在全新的 Emby 或 Jellyfin 实例中创建本轮临时账号与
媒体库，再把必要连接信息经 stdin 交给对应的 `tests/fullchain-*.manual.ts`，不把凭据写入
回执。媒体服务器与 Mnemo 共用隔离网络命名空间，API 只走该命名空间的回环地址；不向主机
发布端口，内部网络阻断外部连接。

电影验收覆盖：

- 经 HTTP 完成 Mnemo 初始化、登录和默认动作配置，再提交带年份的裸片名。
- 真实 PanSou 协议请求、确定性匹配、唯一下载任务及文件 SHA256。
- 实际读取 NFO，核对标题、年份与简介。
- 媒体服务器识别媒体与播放来源，读取完整媒体流并核对 SHA256。
- 使用对应服务器的 ffmpeg 解码返回的媒体流。
- Emby 与 Jellyfin 各自使用全新媒体库；回执记录实际服务器版本、条目 ID 和服务器路径。

电视剧验收覆盖：

- 经 HTTP 提交带年份的裸剧名，必须停在详情步骤；未指定季集时不会创建任务或订阅。
- 显式选择季1集2后创建聚合订阅（开始集2），检查关键词为 `Mnemo TV Fixture 2026 S01`。
- 本地 PanSou 同时返回正确的 S01E02 和错误的 S02E02；只有 S01E02 入队，错误季资源 0 次读取。
- 原生下载到 `Mnemo TV Fixture (2026)/Season 01/Mnemo TV Fixture (2026) - S01E02.mp4`，写入单集 NFO 和 `tvshow.nfo`。
- Emby/Jellyfin 识别 `Episode`、季1集2、`SeriesId`、`SeriesName` 和准确路径；完整媒体流 SHA256 一致并通过 ffmpeg 解码。
- 回执副本分别为 `docs/evidence/fullchain-tv-emby-20261024.json`、
  `docs/evidence/fullchain-tv-jellyfin-20261024.json`，以及同镜像回归的
  `docs/evidence/fullchain-tv-emby-regression-20261024.json`。

日志与不含凭据的回执分别保存在
`output/verification/fullchain-runs/<runId>/`、
`output/verification/fullchain-tv-runs/<runId>/`、
`output/verification/fullchain-jellyfin-runs/<runId>/` 和
`output/verification/fullchain-jellyfin-tv-runs/<runId>/`。
成功要求外层退出码为 0、`status=passed`、解码成功、清理错误为空且临时目录已移除。
每轮容器与网络都有独立名称和所有权标签；仅清理本轮资源，不修改已有媒体库。
若清理失败会保留临时目录并在回执中列明，不能将该轮视为完整通过。

启动协议存在版本差异。Emby 4.10.2.0 的初始化接口需要 `Password`，脚本依据该版本内置
向导和实际响应设置随机临时密码。Jellyfin 10.10.7 必须先在全新实例上
`GET /Startup/User` 初始化默认管理员，再 `POST /Startup/User` 设置名称和密码；否则
`POST /Startup/User` 会因没有用户而返回 HTTP 500。Jellyfin 的媒体库通过查询参数创建，
并使用 `GET /Library/VirtualFolders` 列出；Emby 使用 JSON 创建和 `/Library/VirtualFolders/Query`
列出。四个验证器各自固定目标服务器摘要，并各自创建全新临时账号和媒体库。
旧代码或历史源码省略这些步骤，不能直接作为当前协议。
当前固定作品身份和本地搜索源仅用于可重复验证，不应配置为普通用户的真实来源。
