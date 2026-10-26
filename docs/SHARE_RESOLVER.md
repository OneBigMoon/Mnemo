# 分享下载与目录追更

当前支持115与阿里分享的文件夹与分页浏览、匹配确认后下载选中文件，也可明确订阅已确认目录及下级目录追更。两者均使用原生下载器，无需转存。夸克仅支持既有OpenList挂载路径，分享选文件转存与对账仍待实现。

## 使用

1. 使用115时：Docker镜像已内置Python 3.12与固定SDK。本机Node.js启动前，按[helper依赖安装说明](../integrations/p115_resolver/README.md#依赖安装)准备venv，依次安装构建依赖锁、运行依赖锁和固定SDK，再设置`MORI_PYTHON`。仅安装npm依赖不会让115解析可用。阿里使用内置HTTP适配，无需新增Python SDK。
2. 在「设置中心 → 来源」启用对应来源，两者默认关闭。115的Cookie可选，测试只检查SDK就绪；阿里可匿名浏览，但下载和目录追更需显式保存Web RefreshToken。凭据验证不保证分享权限或会员权益。
3. 搜索并选择115或阿里分享。需要提取码时提供访问码；文本渠道使用`资源 <requestId> <编号> 提取码 <4位字母数字>`，例如`资源 requestId 2 提取码 a1b2`。
4. 按需进入文件夹、上一级或下一页，再选择具体文件。导航不创建下载；文件经匹配或必要的确认后由原生下载器保存到目标目录，不走aria2。下载入队不等于下载完成。
5. 如需持续追更，先在选片流程确认作品、年份和电视剧季数；成功浏览目标目录后，独立点击「订阅此目录」，或发送`订阅目录 <requestId>`。浏览目录或发送原有「订阅 剧名」不会自动绑定目录。阿里目录追更还需先保存Web登录凭据。

## 目录追更与限制

- 追更包含目标目录的下级目录。每次扫描一页20项，最多将10个匹配文件入队；未处理文件和扫描游标跨重启保留。约15秒后续扫，一轮完成后约30分钟重扫；繁忙时会排队，不保证准点。
- 电视剧在已确认的目录上下文中，可识别`S01E03`、`第3集`、`03.mp4`等简短名称，并要求季集匹配。显式其他作品或季数、未知命名、花絮、字幕和多集包不会自动下载；电影文件仍需完整片名与年份。
- 扫描硬上限为256个目录、1024页、10000项和64层。达到上限会暂停并提示缩小范围；可选择更小目录重新订阅，不是无限全量扫描。
- 暂停会停止在途检查和后续新发现；已经入队的下载仍在下载中心单独管理，不会随订阅暂停自动取消。删除订阅会释放其目录绑定。
- 轮询不提供来源快照：115使用offset分页，阿里使用marker/index游标。只能发现持续存在且轮询时可访问的新文件，不能保证捕捉瞬间出现又删除的文件；实际访问仍取决于分享状态、权限和来源限制。

## 阿里凭据与续传

阿里下载和追更需要用户显式提供Web RefreshToken，不是官方OpenAPI token；Mnemo不提供扫码，也不会自动读取浏览器凭据。留空保存保留原值，清除需显式操作；授权结果未知时只能重新取得并保存新的Web凭据，不能重复测试旧值。

阿里没有来源SHA1保证，续传使用已确认大小和HTTP校验器；不能把本地fixture字节验证称为来源hash认证。凭据轮换、并发及审查限制见[阿里适配说明](ALIPAN_ADAPTER.md)。

## 115 helper边界

- 固定使用`p115client` commit `856e4f8f09ce034534bd458f06d3dee4474a1698`（MIT，包版本0.0.9.7.2，Python >=3.12,<4）。构建依赖、运行依赖和SDK分别按helper安装说明准备；单独固定SDK commit不等于锁定全部依赖。
- Invoke a fixed bundled Python helper with JSON over stdin/stdout. No shell, user-selected executable/script, remote RPC daemon, credentials in argv, or generic SDK method invocation. `MORI_PYTHON` is operator-only process configuration; default is python3.
- Anonymous construction must explicitly pass `cookies=''`; `None` invokes login/QR and is prohibited. This pinned constructor accepts cookies/app/app_id/console_qrcode, not check_for_relogin/ensure_cookies. Never print client repr.
- With no configured Cookie, use the provider's public share permission check and anonymous share URL path. With an explicitly configured Cookie, use the authenticated share-file API. Honor denial/login requirements. Never transfer/save/delete cloud files or invoke share_receive. Account-drive pickcode is not a share file_id.
- 本阶段支持Web和文本渠道中的分页浏览、文件选择与匹配确认后下载，以及成功浏览后的显式115目录订阅。原有按作品聚合订阅入口保留，不将此阶段描述为全部网盘能力完成。

## 115 helper协议

One JSON input, one JSON output; no logs on stdout. Input `{op:'health'|'list'|'link',shareCode?,receiveCode?,cookie?,parentId?,offset?,fileId?}`. Success is `{ok:true,data:...}`; failure is `{ok:false,error:{code,message}}`. SDK internals and URLs are never selected by the caller.

- health reports availability and package version without any provider request or implicit login.
- list returns at most 100 entries: id, name, directory, size, optional SHA1; total and optional nextOffset. One provider page per call; no unbounded recursion. Directory and pagination navigation are explicit.
- link returns URL, name, size, optional SHA1, and only a documented fixed User-Agent if needed. It must not return account cookies or arbitrary authentication headers. File data stays with Mnemo's native downloader.
- Errors use a small static code/message set: unavailable, invalid_input, access_denied, expired, not_found, rate_limited, upstream_error. Never serialize provider response bodies, Cookie, passcodes, signed URLs or exception repr.
- Bound input/output bytes, SDK HTTP time, process lifetime and concurrency. Cancel/timeout kills and waits for the owned child. There is no automatic cloud-write retry because there are no cloud writes.

## Private references and app contract

- 来源设置提供`p115Enabled`（默认false）和`p115Cookie`（默认空，加密存储）。旧配置沿用这些默认值；设置页「测试」只检查固定SDK是否就绪，不认证账号、Cookie或具体分享权限。
- 阿里来源通过内置HTTP适配运行，默认关闭；Web凭据加密保存和轮换。原有缺省provider仍为115，115引用、ID规则与续传保持兼容。
- PanSou extraction codes must survive parsing. Source results may carry a transient extractionCode; Requests must capture that access context in encrypted storage and omit it from persisted/public resource DTOs. Public share URLs are canonicalized without the passcode.
- Store gains encrypted record read/write using the same envelope format/key as configuration; do not store plaintext provider access data in normal task/request records. Recognized 115 access context is captured locally even while disabled, allowing a later enabled retry without losing the code; the switch gates all SDK/provider execution.
- A ShareService captures supported source shares, browses trusted references, resolves file references, and checks local readiness. IDs are opaque, server-issued and bounded. Capture/listing may create only local encrypted metadata. Prune expired unreferenced records; retain references used by tasks; hard capacity rejects new admission rather than dropping active state.
- Files use ResourceKind `cloud` and `mori-share:<opaque-id>`; URL is stable and contains no short-lived link or credential. Public resource options may mark a directory or next-page navigation. Folder navigation cannot create a task. Unsupported shares retain the existing explicit unsupported state.
- Requests keeps owner/revision/CAS and rechecks after asynchronous browsing. Directory/page choices only replace the resource view. File choices use existing matchResource and uncertainty confirmation before Queue admission. Optional user-supplied extractionCode is accepted only for share browsing and stored encrypted, never in a completed-selection receipt.
- MediaService receives an optional ShareService through bootstrap. It exposes share browsing to Requests and resolves cloud references only when executing a task. Native cloud downloads use a stable content identity (provider/share/file/size/SHA1), refresh the URL per attempt, and preserve verified range/validator behavior. Temporary URLs/headers remain in memory.
- 本阶段115与阿里分享文件由Mnemo原生下载器处理，不走aria2；短期直链仅在下载时使用，不作为持久资源地址。

## Acceptance and ownership

Required evidence: SDK pinned-interface tests without network; helper no-login/no-transfer checks; encrypted-reference/expiry/capacity checks; passcode preservation and DTO redaction; owner/revision/cancel-safe browsing; identity/uncertainty checks; native refresh/resume and real temporary-byte receipt; UI/text channel folder selection; configuration migration and build/packaging. 真实115/阿里账号、分享权限、会员权益、速度、NAS、Windows与amd64仍待验收；软件行为测试不代替这些实机验证。

Root owns shared types, Store/configuration, bootstrap, Queue, integration and final gates. Assign helper, ShareService, media download and Requests/UI slices only after their exact interfaces are agreed. No competing writers or real-account/provider calls during automated development validation.

Agreed TypeScript interfaces are in shared/types.ts. Store provides `putPrivate(kind,id,value,expiresAt)` and `privateRecord<T>(kind,id)`; `list<{id,expiresAt,sealed}>(kind)` exposes only envelope metadata, and existing transaction/remove methods handle admission/pruning. ShareService.capture returns a captured SearchResult; its shareRef is a `mori-share:<opaque-id>` reference. Browse returns trusted results: file kind cloud with a stable opaque URL, directory/page kind share with shareRef and navigation folder/parent/next. A plain source share has shareRef but no navigation. Resource DTOs must omit extractionCode. MediaService.browseShare is optional so existing injected media fixtures remain compatible.

Primary sources inspected 2026-10-24: p115client pinned repository and pyproject; OpenList drivers/all.go, 115 Open, 115 Share documentation, AliyundriveShare and 123PanShare driver sources. OpenList's legacy 115 Share driver is marked unmaintained in its documentation, so it is not the selected route. 夸克选文件转存与对账仍待实现；阿里已通过无需转存的分享下载路径实现本阶段能力，详见[阿里适配说明](ALIPAN_ADAPTER.md)。
