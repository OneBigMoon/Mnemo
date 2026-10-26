/**
 * 渠道下载审批策略（服务端与前端共用同一份判定，避免两处各写一遍正则）。
 *
 * owner 是请求归属标识，与 server/index.ts 的 destinationFor 同源：
 * - `telegram:<botId>:<peer>`
 * - `bridge:(wechat|qq|feishu):<peer>`
 * - `web:admin`（网页管理员自己，永不走渠道审批）
 */
import type { AppConfig, ApprovalOverride, ChannelPlatform } from "./types.js";

export const CHANNEL_PLATFORMS: readonly ChannelPlatform[] = [
  "telegram",
  "wechat",
  "qq",
  "feishu",
];

export const APPROVAL_OVERRIDES: readonly ApprovalOverride[] = [
  "inherit",
  "require",
  "skip",
];

/** 渠道 owner → 平台；网页域或无法识别返回 undefined。 */
export function channelPlatform(owner: string): ChannelPlatform | undefined {
  // 判定从宽：只要前缀像渠道就算渠道。地址是否合法由 destinationFor 严格校验，
  // 这里宁可多要一次批准，也不能让畸形 owner 绕过闸门。
  if (owner.startsWith("telegram:")) return "telegram";
  const bridge = /^bridge:(wechat|qq|feishu):/u.exec(owner);
  if (bridge) return bridge[1] as ChannelPlatform;
  return undefined;
}

/**
 * 该归属的下载是否需要管理员批准。
 * 单渠道覆盖优先于全局开关；没有覆盖（或 inherit）时跟随全局。
 */
export function requiresApproval(config: AppConfig, owner: string): boolean {
  const platform = channelPlatform(owner);
  if (!platform) return false;
  const override = config.channels.approvalOverrides?.[platform];
  if (override === "require") return true;
  if (override === "skip") return false;
  return config.channels.requireApproval === true;
}
