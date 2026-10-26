# AstrBot × Mori v0.2.0

可直接安装的 AstrBot 插件，通过 Mori 的 HMAC 桥接收发 QQ、微信、飞书命令与任务结果通知。只处理 `/mori` 命令；主动通知需要另行开启。不接管普通聊天，不调用 AstrBot 模型，不读取模型密钥。Python 3.9+，仅使用标准库及宿主提供的 AstrBot API。

## 安装与配置

1. 将本目录内 `main.py`、`metadata.yaml`、`_conf_schema.json`、`README.md` 放在 ZIP 根目录，通过 AstrBot 插件管理的本地插件上传入口安装；也可把目录复制为 AstrBot `data/plugins/astrbot_plugin_mori` 并重启。无需安装额外 Python 包。
2. 先在 AstrBot 配置好对应平台 Bot。此插件负责 Mori 转发，不代替平台账号、Bot 审核或适配器登录。
3. Mori 设置中启用渠道桥接，填写随机签名密钥。AstrBot 插件配置填写相同 `bridge_secret` 与可访问的 `mori_url`。容器里的 `127.0.0.1` 指容器自身，应按部署网络填写服务地址。
4. 同时填写用户与会话白名单。用户为 `qq:用户ID`、`wechat:用户ID` 或 `feishu:用户ID`；会话填写 AstrBot `/sid` 得到的完整 UMO。两项都必须匹配，任一空列表默认拒绝，不会向未授权用户回消息。管理员需从平台管理界面确认发送者用户 ID。
5. 自动映射 `aiocqhttp`、`qq_official`、`qq_official_webhook` 至 QQ，`wecom`、`wecom_ai_bot`、`weixin_official_account`、`weixin_oc` 至微信，`lark` 至飞书。未识别的平台默认拒绝；Satori 等通用适配器须由管理员明确设置 `platform` 并配置精确白名单。
6. 配置变更后重新加载插件，避免继续使用旧配置。
7. 如需下载完成、失败等任务结果主动通知，在 Mori 开启渠道桥接，并在本插件开启 `notifications_enabled`（默认关闭）。`allowed_sessions` 的完整 UMO 同时是主动通知的授权目标，最多128项。UMO 的平台实例必须在 AstrBot 中存在；自动模式使用实际适配器名称映射 QQ、微信、飞书。消息命令仍须同时命中发送者和 UMO 白名单。

命令示例：`/mori 搜索 沙丘`、`/mori 订阅 三体`、`/mori 任务状态`、`/mori 下载 https://example.com/movie.mp4`。文本与最多五个资源标题、链接通过 `event.plain_result` 回复原渠道；每条最多 2500 字，总共最多四条。平台可能限制单条长度或链接发布，具体以平台权限为准。

搜索结果不会自动下载，插件不支持“下载第二个”或自动确认。用户应在 Mori 页面选择资源，或明确发送 HTTP(S) 下载直链，由 Mori 再次校验。不会绕过 Mori 的任务及意图限制，也不将模型输出当成签名密钥或平台凭据。

## 传输与故障

请求为 `/api/channels/bridge/{wechat|qq|feishu}`，仅发送 `eventId`、`peer`、`text`；事件 ID 由平台、UMO、平台原消息 ID 稳定派生。签名原文与 Mori 一致：UTF-8 `JSON.stringify([platform,timestamp,eventId,peer,text])`，HMAC-SHA256，时间戳秒数。没有稳定平台消息 ID 的请求不提交。

最多两条网络请求、八条处理中或等待的命令；满载明确拒绝，队列不落盘。HTTP 总期限约 18 秒，异步等待最多 20 秒，响应最多 256 KiB，无重试、无重定向；网络超时或 HTTP 409 时先在 Mori 核对，避免换消息重复提交写操作。禁用/卸载会取消等待，取消后不产生新回复；已发出的 HTTP 写操作不能撤销，需在 Mori 对账。底层已发出线程在自身超时内退出，两个线程槽位不会因取消而放大。

插件不记录 URL、密钥、用户消息或上游错误正文。远程部署请使用 HTTPS。`secret: true` 只遮罩 AstrBot 配置面板；宿主配置文件仍需管理员妥善保护。Mori 的进程内重放缓存重启会清空，因此不能保证跨重启 exactly-once；不要手动反复转发旧的写入指令。

## 任务结果通知

插件在 `initialize` 中启动一个轮询任务，串行轮转授权 UMO；每次最多领取10条，正常间隔5–6秒，HTTP/ACK失败退避至最多61秒。通知与命令共用两个网络线程槽位，沿用18秒 HTTP 总期限、20秒异步等待和256 KiB响应上限。只请求当前目标的 `/api/channels/bridge/{platform}/notifications/poll` 和 `/ack`；两者按 [通知协议](../../docs/NOTIFICATIONS.md) 分别签名。响应中的其他目标字段不能改变发送目标。停止或移除授权后，不开始新的发送。

发送前将 `(notification id, claim token, platform, UMO)` 持久化为 `dispatching`，再调用官方 `Context.send_message(UMO, MessageChain)`。只有返回 `True` 才记为 `delivered` 并 ACK；官方实现仅确认匹配到平台且 `send_by_session` 正常返回，不提供平台消息回执。部分适配器内部可能跳过发送，插件无法从该布尔值判断，不代表平台最终收到或用户已读。返回 `False` 或适配器明确不支持发送记为 `rejected`；发送期间超时、异常、取消或进程重启记为 `unknown`。`unknown` 不自动重发。收到同一 attempt 的重复结果只补 ACK；管理员在 Mori 明确重试后产生的新 claim token 才是另一次发送尝试。claim 的期限从服务器时间保守换算，过期后不开始发送。

journal 使用官方 `StarTools.get_data_dir()` 下的 `notifications.sqlite3`，即 AstrBot 的 `data/plugin_data/{插件名}`；只存身份、目标和状态，不存通知正文。最多5500条 attempt，保留最近500条已 ACK 或 obsolete 回执；旧记录须已 ACK 或已标记 obsolete，且 claim 过期至少5分钟才可剪除。仍待重放 ACK 的记录不会因容量而删除；容量满则暂停领取并继续对账。ACK 返回404/409时，持久标记 obsolete 并记录状态码，保留原发送结果、告警待人工核对，随后继续领取新通知；重启也不会重发该旧消息或反复提交旧 ACK。网络及其他 HTTP 错误仍重放 ACK，不重发消息。

请保留插件数据目录及其 SQLite 文件，不要在存在待对账结果时删除或复制给另一个同时运行的实例。一个实例拥有该 journal；插件卸载/禁用会等待轮询取消。已经交给平台的调用不能撤销，取消时仍可能已经发出，因此保留 `unknown` 供人工核对。QQ 官方、微信、飞书等主动发送能力取决于实际适配器版本、平台权限和会话规则，不会绕过平台限制。

## 验证范围与官方依据

依据 2026-10-24 官方文档与源码：

- [最小插件示例](https://docs.astrbot.app/en/dev/star/guides/simple.html)：`Star`、`filter.command`、`event.plain_result`、`terminate`。
- [事件接口](https://docs.astrbot.app/en/dev/star/guides/listen-message-event.html)：事件内容、发送者和会话入口。
- [插件配置](https://docs.astrbot.app/en/dev/star/guides/plugin-config.html)：`AstrBotConfig`、`_conf_schema.json` 和敏感字段遮罩。
- [发送消息](https://docs.astrbot.app/dev/star/guides/send-message.html)：主动发送使用原 UMO 与 `MessageChain`。
- [Context 源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/star/context.py)：`send_message` 的布尔返回契约及 `get_platform_inst`。
- [StarTools 源码](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/star/star_tools.py)：插件持久数据目录 `get_data_dir`。

本仓库自测使用 Python 3.9 语法检查、模拟 AstrBot 导入、临时 SQLite 与本地 HTTP 假服务，覆盖命令入口、通知签名与路由、发送前持久化、崩溃恢复、ACK回放、过期、跨目标拒绝、白名单移除、停机和轮转退避。未实际安装 AstrBot，未验证真实微信、QQ、飞书账号，未发送真实平台消息；宿主和各平台互操作性仍需安装后验收。
