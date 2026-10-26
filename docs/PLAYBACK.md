# 本地播放

Mnemo 可在 Web 客户端直接播放**已经下载完成的本地文件**。播放框使用浏览器原生控件，可暂停和拖动进度。

这不是云盘在线流、边下边播或转码服务：播放前文件必须已经完整落到任务记录的下载目录；服务端按 HTTP Range 读取实体文件，不把分享页或直链直接交给浏览器。

## 使用

1. 在「下载任务」中等待任务状态变为已完成。只有带服务端记录路径的完成任务才显示播放按钮。
2. 点击任务行的播放按钮。若浏览器拦截自动播放，点击原生播放控件即可开始，这是浏览器自动播放策略，不是下载或文件损坏。
3. 拖动进度条时浏览器会发送单区间 `Range` 请求，服务端返回 `206 Partial Content`。不支持 `Range` 的客户端会收到完整 `200`。

文件在任务完成后被移动、删除或替换成符号链接时，播放会提示媒体文件不可用，不会回退到任意路径。本版本新下载的任务会记录落盘时的下载目录，更换配置后仍从此目录播放；更早的完成任务若没有该记录，只按当前下载目录查找。

格式支持取决于浏览器内置解码器：

- MP4/H.264、WebM、MOV、OGV 通常可直接播放；
- MKV、AVI、TS/M2TS 等常见于下载资源的容器通常无法由浏览器直接解码，界面会提前提示；
- 播放失败时使用已配置的 Emby/Jellyfin（Mnemo 会继续负责下载与 NFO）或本地播放器。

当前不做转码、转封装、多码率或字幕轨选择。

## 接口与安全边界

`GET|HEAD /api/tasks/:id/stream`，需要已登录会话：

- 只接受任务 ID，不接受客户端传入文件路径；
- 任务必须为 `completed` 且已有服务端记录的 `path`，否则 `409`；
- 依次检查 `lstat` 为普通文件、非符号链接、大小大于 0；
- 对文件和可信目录做 `realpath`，文件必须位于任务记录的 `downloadRoot` 或当前配置的下载目录内，否则 `404`；
- 单区间解析：`bytes=3-7`、`bytes=3-`、`bytes=-5` 均支持；越界或 `bytes=0-1,3-4` 这类多区间请求返回 `416` 与 `Content-Range: bytes */size`；
- 响应带 `Accept-Ranges: bytes`、准确的 `Content-Length`、`Content-Range` 和 `Content-Disposition: inline`；
- 客户端断开时销毁文件流。

认证、Host 校验、CSRF 来源检查和 CSP 沿用全局中间件；播放响应与 `/api` 其他接口一样不缓存。

## 限制与验收边界

- 不验证视频内部编码、分辨率、字幕或音轨是否适合浏览器，只按文件扩展名给出提示。
- 不提供云盘直链播放；阿里/115 分享仍需完成下载后才能播放。
- 已用本地受控 MP4 验证播放与拖动，并在 Linux amd64 容器中重复下载与播放验收；未在真实超大文件、真实网盘、真实 x86_64 主机、物理 NAS、Windows 或移动端实机验收。
- 本机播放通过不等于 Emby/Jellyfin 入库识别或转码能力；媒体库链路另有隔离全链路回执。

## 复现

```sh
npx tsx --test tests/playback.test.ts
npm test
npm run check
npm run build
```

完整结果、浏览器观测和文件摘要见 `docs/evidence/local-playback-20261025.json`，截图 `docs/evidence/local-playback-ui-20261025.png`。浏览器验证使用临时 Mnemo 实例和本地测试源，完成后已删除临时目录并停止自有服务。

## 容器部署验证

2026-10-25 在 linux/amd64 容器中验收了同一构建产物：首次设置、直接下载、NFO、播放与拖动。3 秒 MP4 的全量请求为 `200`，单区间与后缀为 `206`，多区间为 `416`，`HEAD` 为 `200` 且无响应体；流字节 SHA-256 与源文件一致。容器以 UID 1000 非 root 运行，健康检查通过，p115 SDK 0.0.9.7.2 可加载，前端静态文件哈希与工作区构建一致。

镜像为 `mori-media-agent:playback-amd64-20261025`（`sha256:739ca3a0e06a9b8ad06ddb5dce315e586120533f6cc834ecc3460605f09c7fe4`），在 arm64 OrbStack 上以 buildx 模拟 amd64。宿主 Qoder Desktop 内置 Chromium 从容器流播放时 `readyState=4`、时长 3 秒、无媒体错误。

仓库自带的 [compose.yaml](compose.yaml) 默认部署路径也单独验收：保留镜像按 Compose 默认镜像名启动，使用默认 `127.0.0.1:4180` 和 `./downloads` 绑定挂载，容器 UID 1000 写入宿主机目录；下载任务 296ms 完成，宿主机上的 MP4 与 NFO 摘要与服务端及源文件一致，流式 200/206/416/HEAD 与前述一致。该轮使用字节模式夹具（扩展名 `.mp4`，非可解码视频）验证落盘与 Range，不重复浏览器播放。首次尝试用仅绑定 `127.0.0.1` 的夹具服务时，容器进程曾以 undici `Parser.finish` 断言退出，任务在重启后标记为暂停；改为 `0.0.0.0` 绑定并重置实例后同一流程通过、零重启。该异常未定位根因，不作为已修复缺陷。回执见 `docs/evidence/compose-bind-amd64-20261025.json`。

对已运行的实例复现（`FIXTURE` 为可读的本地 MP4，`SOURCE_URL` 为容器可访问的同一文件）：

```sh
BASE=http://127.0.0.1:41901 FIXTURE="$FIXTURE" SOURCE_URL="$SOURCE_URL" \
SETUP_TOKEN="$SETUP_TOKEN" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
TITLE="AMD64 Playback Fixture" node scripts/verify_container_playback.mjs
```

实例已经完成首次设置时省略 `SETUP_TOKEN`，脚本改用 `ADMIN_PASSWORD` 登录。结果与边界见 `docs/evidence/playback-container-amd64-20261025.json`，截图 `docs/evidence/amd64-container-playback-20261025.png`。Compose 默认绑定挂载回执为 `docs/evidence/compose-bind-amd64-20261025.json`。Windows、真实 x86_64 主机、物理 NAS、媒体库链路与超大文件仍未覆盖。

## 落盘权限与跨用户读取

Mnemo 把下载完成的媒体、NFO、图片和续传发布的文件设置为 `0644`，把由它新建的下载根目录和分季目录设置为 `0755`；数据库、凭据和内部暂存仍保留在私有的 `/data` 或临时目录中。这样以另一 UID 运行的 Emby/Jellyfin 才能直接读取同一挂载目录。

- 若下载根目录由部署者预先创建，其自身和各级父目录必须对媒体服务器用户可遍历；Mnemo 不会改写已存在目录的权限。
- 旧版本已经生成的 `0600` 文件与 `0700` 目录不会自动迁移，需要部署者自行确认媒体服务器可读，或重新下载。
- 浏览器播放由 Mnemo 服务读取文件，不受媒体服务器 UID 影响；媒体库扫描则由媒体服务器直接读文件，因此受上述权限约束。

跨 UID 验收使用 `mori-media-agent:jellyfin-nonroot-20261025`（`sha256:a33495e3893a7db43e7457b91b18dde50d3bcbce4537487e5b13ba73f6b0ed83`）：Mnemo 以 UID 1000 发布 `0644` 媒体与 NFO，全新 Jellyfin 10.10.7 以非 root UID 1001 经 Linux bind mount 扫描、识别为 `Movie`/2010、首次库校验 `verified`/`playable`，完整直连流 SHA-256 与源一致，ffmpeg 解码 exit 0。回执 `docs/evidence/jellyfin-nonroot-real-source-20261025.json`。该轮使用真实公网 HTTPS 源，但任务经 `POST /api/tasks` 创建，未复验身份确认与资源搜索；未覆盖 NAS/SMB ACL、Windows、移动端、物理 x86_64 或 Jellyfin Web 客户端。
