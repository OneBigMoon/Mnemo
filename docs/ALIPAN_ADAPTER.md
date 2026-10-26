# 阿里云盘分享：使用与适配边界

当前可匿名浏览阿里分享；下载与目录自动追更需要用户显式提供Web RefreshToken。文件复用现有选片、加密分享引用和原生下载落盘，无需转存，不删除云端文件。软件行为验证不等于真实账号或会员权益已验收。

## 使用

1. 在「设置中心 → 来源」启用「阿里云盘分享」，默认关闭。仅浏览分享可不填账号凭据，分享提取码仍按来源要求提供。
2. 下载或追更前，在「阿里云盘网页登录授权凭据」中填写自己的Web RefreshToken。它不是官方OpenAPI token；Mnemo不提供扫码或浏览器自动取凭据。
3. 点击「保存并验证网页登录凭据」。留空保存会保留已存值；清除需勾选明确的清除选项并保存。关闭来源不等于清除凭据。「已保存」不代表已验证，验证成功也不保证某个分享可下载或具备会员下载权益。
4. 搜索并确认作品后浏览分享，选择文件下载，或在确认年份、电视剧季数后单独「订阅此目录」。客户端和各文本渠道沿用同一[资源、提取码和目录命令](CHANNELS.md#频道内继续选片)，回复标注相应来源。
5. 如果出现「授权结果未知」，不要反复验证旧凭据；须重新取得并保存新的Web RefreshToken。后台会加密持久保存已知的轮换结果，测试按钮不会重放结果未知的旧凭据。

## 依据与选择

核对日期：2026-10-24。OpenList 快照 `e23600200a354096347303936e7f093a086485e2` 的 AliShare 驱动直接按分享里的 drive_id/file_id 取链；分享驱动最近变更为2025-08-10，仓库整体活跃不能证明当前账号一定可用。协议参考另含 Apache-2.0 的 tickstep/aliyunpan-api v0.2.9，commit `84981629f078042e3d43b78964694eb6b55ce406`。Mnemo独立实现有限HTTP协议，不导入或复制OpenList的AGPL实现。

- [分享驱动](https://github.com/OpenListTeam/OpenList/blob/e23600200a354096347303936e7f093a086485e2/drivers/aliyundrive_share/driver.go)
- [授权与分享请求](https://github.com/OpenListTeam/OpenList/blob/e23600200a354096347303936e7f093a086485e2/drivers/aliyundrive_share/util.go)
- [分享响应字段](https://github.com/OpenListTeam/OpenList/blob/e23600200a354096347303936e7f093a086485e2/drivers/aliyundrive_share/types.go)
- [Web凭据响应](https://github.com/tickstep/aliyunpan-api/blob/84981629f078042e3d43b78964694eb6b55ce406/aliyunpan_web/login.go)

夸克仍仅支持用户既有的OpenList授权挂载路径；独立的分享选文件转存与副作用对账待实现。它不能套用本次阿里无需转存的分享下载路径。

## 已实现的固定协议边界

- 分享token：只发送share_id/share_pwd到固定HTTPS分享token接口；token仅在单次操作内存中存在，不写普通记录。
- 列目录：`https://api.alipan.com/adrive/v3/file/list`，根ID `root`，使用share token，不把账号默认drive ID当分享drive ID。固定请求有界limit；响应最多200条，每次向Shares暴露至多20条。
- 续页：私密 `AlipanPagePosition {marker:string,index:number}`。同provider页未消费完时保留marker并增加index；全部消费后才进入next_marker。可请求limit20，但不能假定provider必然按该值截断。空页若仍有下一marker仍须推进，循环/超大marker必须报错而非静默漏页。
- 下载：`https://api.alipan.com/v2/file/get_share_link_download_url`，发送分享项自己的share_id/drive_id/file_id及expire_sec:600，API请求使用用户Bearer及share token。下载器只增加固定非密钥Referer `https://www.alipan.com/` 和固定UA；账号授权头、Cookie与分享token不得进入CDN请求、普通任务或续传sidecar。
- 分享模型不保证来源SHA1，缺失时不伪造。续传核对已确认的文件大小与HTTP校验器；本地fixture字节一致性验证只证明测试流程，不是来源内容的hash认证。
- API请求拒绝跨域重定向，JSON响应有字节上限，单请求和整次操作均有时限，取消贯穿调用。明确429、失效凭据与文件不存在分别呈现，未知错误不回显provider正文。

## 凭据保存与轮换

初始Web RefreshToken仅由用户在设置中显式输入，不是官方OpenAPI token。`sources.alipanEnabled`默认false，`sources.alipanRefreshToken`默认空并加密、脱敏。留空保存保留旧值，清除须显式提交；浏览不要求账号凭据，下载和目录追更需要网页登录凭据。没有内置扫码或浏览器自动取凭据。

Web刷新地址为 `https://auth.alipan.com/v2/account/token`，请求grant_type=refresh_token。按响应expires_in/expire_time判断access有效期，不猜两小时是服务端保证。新refresh/access凭据必须先加密持久化，再向调用者提供access。

使用Store导出的 `ALIPAN_AUTH_KIND` / `ALIPAN_AUTH_ID` 保存唯一加密会话：配置凭据指纹、当前refresh/access、到期时间、pending/ready/invalid/unknown状态、operationId。请求前原子写pending；同进程singleflight，多消费者取消不应误杀仍有需求的刷新。最后一个消费者取消时向下取消；网络超时、崩溃遗留pending或取消导致的结果未知必须可观察，不自动重发一次可能已轮换的凭据。没有旧refresh token重放安全保证。

收到可验证的新凭据后，即使某个调用者已取消，也先保存轮换结果再结束该调用。提交须核对当前配置指纹与operationId，旧请求不能覆盖新的账号配置。更换或清除配置凭据会在同一Store事务中清除缓存；未知刷新需用户重新取得并保存新的Web授权，不能用测试按钮偷偷重置。

## 并发与关闭

- 分享解析实际并发为2；仅取链（resolve）额外提供FIFO等待，最多4个等候、最长60秒。浏览、扫描、凭据验证仍在满载时即时反馈容量。四路下载的取链可等待空位，不因瞬时占满两路就直接判失败；等待超限仍会明确报错。
- 关闭时先取消并等待Requests、Queue、provider/auth结束，再关闭Store。已知的新轮换凭据先保存；结果未知则保留unknown，不自动重发旧refresh token。

## 复用与兼容

- 保留同一个Shares的扫描、TTL、容量、取消和文件夹父栈。只在私密Share根增加可选provider；缺省仍严格为p115。
- 所有旧115 root/file/folder/navigation ID公式、directory HMAC、cursor version及p115 contentId不变，不批量迁移旧行。
- 阿里根在内部仍归一为 `0`，adapter映射为provider的 `root`。阿里字符串ID有产品长度限制；原115仍只接受其原数字ID规则。
- Folder和父栈可携带私密page position，canonical目录必须清除页位置；marker从不进入公共DTO。File保存来自分享条目的driveId，以及可用的更新时间。
- 公开SearchResult、ShareDirectory、ResolvedShareFile增加可选provider；旧记录缺省115。原生下载只对alipan接受固定Referer，不能放开任意认证头。
- 新搜索可创建阿里supported根。历史access-only引用不改kind、不从去敏URL猜密码；旧结果需要重新搜索。

## 验收与限制

软件适配已实现；行为测试和定向可见源码审查覆盖兼容、分页、取消、关闭与轮换场景，但不代表完整独立源码审查通过。

- Guard对Auth的write/commit/access及HTTP的timed/request/refresh中段输出进行了脱敏或截断，这些部分尚未完成完整独立源码审查；行为测试或局部可见review不能替代全量源码通过。
- 关闭流程fail-fast的P2问题已修复并定向复核，不据此扩大为整套源码审查完成。
- 真实账号、分享权限、会员权益、速度、NAS、Windows与amd64仍未验收。本文不代替最终界面、包装及实机记录，后续证据以[项目验收记录](PLAN.md)为准。
