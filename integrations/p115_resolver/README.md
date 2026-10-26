# 115 分享文件只读 resolver

独立的一次性 JSON stdin/stdout helper，使用 Python `>=3.12,<4`。固定调用 `p115client` `0.0.9.7.2`，源码 commit `856e4f8f09ce034534bd458f06d3dee4474a1698`。不启动服务，不接收脚本、可执行文件、SDK 方法名或上游地址。

## 依赖安装

`requirements.in` 固定 SDK 的 Git commit；`requirements.lock` 锁定从该 commit 完整解析的56个 registry 运行依赖及 SHA256。两份文件共同覆盖跨平台依赖集合的57个包，具体环境按 marker 选择；SDK 源码以 commit 固定，不能把单独的顶层 commit 说成锁定了全部依赖。`requirements-build.lock` 锁定 SDK 构建使用的 `poetry-core==2.2.1` 及 SHA256；生成器为 `uv 0.11.16`。

在独立环境安装，需要 Git 和可用 TLS。registry 依赖只装 wheel；缺少目标平台 wheel 时安装失败，不临时拉取未锁定的构建依赖：

```sh
python3.12 -m venv /opt/mori-p115
/opt/mori-p115/bin/python -m pip install --require-hashes --only-binary=:all: -r integrations/p115_resolver/requirements-build.lock
/opt/mori-p115/bin/python -m pip install --require-hashes --only-binary=:all: -r integrations/p115_resolver/requirements.lock
/opt/mori-p115/bin/python -m pip install --no-deps --no-build-isolation -r integrations/p115_resolver/requirements.in
```

不把带 VCS 条目的要求文件直接交给 `pip --require-hashes`：pip 不支持为 Git 工作树提供同一种分发包 hash。SDK 单独以完整 commit 安装，运行依赖和构建依赖分别按上述锁验证；helper 本身从不安装或升级依赖。root 负责 Docker、固定 Python 路径及外层子进程管理。

重新生成锁使用文件头记录的命令；同时保留 `build-constraints.txt`。不要只更新 SDK commit 而继续把旧依赖锁称为完整锁。

## 固定协议

每个进程只读取一个 UTF-8 JSON 对象，并输出一行 JSON。返回码为0时仍须检查 `ok`；业务错误也是固定 JSON，不通过 traceback 或 stderr 传递。

输入：

```json
{"op":"health"}
{"op":"list","shareCode":"share123","receiveCode":"abcd","cookie":"","parentId":"0","offset":0}
{"op":"link","shareCode":"share123","receiveCode":"abcd","cookie":"","fileId":"9007199254740993"}
```

`health` 只接受 `op`。`list/link` 的 `shareCode` 必填，为1–64位 ASCII 字母数字；`receiveCode` 可省略，默认空串，最多32位字母数字。`cookie` 可省略，默认空串；显式值必须是非 `None` 字符串，最多8192个 ASCII 可打印字符，非空不能全为空白。拒绝所有未知字段，Cookie、提取码只经 stdin 传递。

`list` 的 `parentId` 默认字符串 `"0"`；`fileId` 必填且不能为 `"0"`。ID 都是无前导零的十进制字符串，最多32位；不能使用 JSON 数字代替。`offset` 默认0，是 `0..2^31-1` 内的非布尔整数。`limit` 不接受输入，内部固定100，每次只调用一次 SDK 页接口，不递归目录。

成功：

```json
{"ok":true,"data":{"available":true,"version":"0.0.9.7.2"}}
{"ok":true,"data":{"entries":[{"id":"9007199254740993","name":"影片.mkv","directory":false,"size":1234,"sha1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}],"total":101,"nextOffset":1}}
{"ok":true,"data":{"url":"https://example.invalid/file","name":"影片.mkv","size":1234,"headers":{"User-Agent":"Mozilla/5.0"}}}
```

`health` 真实导入 SDK 与 normalizer 并检查精确包版本；缺依赖、版本不符或导入失败返回 `{"ok":true,"data":{"available":false,"version":null}}`。它不构造账号、不联网，不能说明某账号或分享可访问。

`entries` 最多100项。`total/nextOffset/sha1` 可省略；`nextOffset` 仅表示 provider 下一页，不等于 Mori 客户端显示页大小。名称为1–512字符，不能包含斜杠、反斜杠或 ASCII 控制字符；size 是非负 safe integer；SHA1 为40位大写 hex。目录 size 为0表示此接口未提供聚合大小。全部 SDK ID 在返回前转字符串，避免 JavaScript 的数字精度损失。

`link` 只返回一个经校验的非目录 HTTP(S) URL、文件元数据，以及固定 `User-Agent`；不复制 Cookie jar、任意 SDK headers 或对象属性。该 URL 属于内部短期取链结果，不应写入普通日志或公共 DTO。文件字节由 Mori 原有下载器处理。

错误为 `{"ok":false,"error":{"code":"access_denied","message":"The share requires permission or valid access data."}}`。code 仅为 `unavailable`、`invalid_input`、`access_denied`、`expired`、`not_found`、`rate_limited`、`upstream_error`，message 全部固定。未知 provider errno 不按动态文案猜测，归为 `upstream_error`；不输出响应正文、Cookie、提取码、签名 URL 或 exception repr。

## SDK 调用与边界

- 构造固定为 `P115Client(cookies=<显式字符串>, app='web', console_qrcode=False)`。空 Cookie 也明确传 `''`；禁止 `None` 触发隐式登录。此 pin 没有 `check_for_relogin/ensure_cookies` 构造参数。
- 列目录使用 `share_snap({share_code,receive_code,cid,offset,limit:100}, timeout=8)`；使用官方 `p115client.tool.attr.normalize_attr_simple` 识别文件与目录。
- 匿名取链先 `share_skip_login_check({share_code,receive_code,file_id}, timeout=8)`，再 `share_skip_login_download_url(..., strict=True, timeout=8)`。前置 `state=True` 不能独立证明可下载，仍须最终有效非目录 URL。
- 显式账号 Cookie 取链使用 `share_download_url({share_code,receive_code,file_id}, strict=True, timeout=8)`，使用分享的 file_id，不能换成账号盘 pickcode 路线。
- 不调用登录、扫码、`share_receive`、转存、删除或下载器 SDK 方法；账号或公开分享权限不足时直接返回静态错误，不追加云端写操作。

输入上限64 KiB，输出上限256 KiB；SDK每请求 timeout 为8秒，POSIX helper 总期限20秒。底层 HTTP adapter 可能有自己的连接策略，8秒不能替代外层硬期限。父进程仍须限制并发、独立执行硬超时，并在取消/超时后 kill 且 wait 该子进程。helper 仅支持具有 `SIGALRM/ITIMER_REAL` 的 POSIX 环境。SDK stdout/stderr 和 native fd 输出均被隔离，只有保留的协议描述符可输出 JSON；单次调用结束后直接退出，避免 SDK 退出清理钩子污染协议。

## 验证与依据

运行 `python3.12 tests/p115-resolver.test.py`。自动测试使用 fake SDK、fake HTTP 错误和专属临时包；覆盖严格 schema、禁登录/禁云写、分页、精确 ID、匿名与账号路线、静态错误、凭据输出隔离和总期限。隔离环境还核验了真实 pinned SDK 的导入及目标签名，未访问账号或分享。

尚未验证真实115账号/分享、provider拒绝细节、实际下载或 NAS 落盘；这些不属于 helper ready 的证明。

官方源码：

- [pinned pyproject](https://github.com/ChenyangGao/p115client/blob/856e4f8f09ce034534bd458f06d3dee4474a1698/pyproject.toml)
- [pinned client](https://github.com/ChenyangGao/p115client/blob/856e4f8f09ce034534bd458f06d3dee4474a1698/p115client/client.py)
- [normalizer](https://github.com/ChenyangGao/p115client/blob/856e4f8f09ce034534bd458f06d3dee4474a1698/p115client/tool/attr.py)
- [exception types](https://github.com/ChenyangGao/p115client/blob/856e4f8f09ce034534bd458f06d3dee4474a1698/p115client/exception.py)
