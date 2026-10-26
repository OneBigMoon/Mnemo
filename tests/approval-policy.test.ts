import test from "node:test";
import assert from "node:assert/strict";
import { channelPlatform, requiresApproval } from "../shared/approval.js";
import { defaults, validateConfig } from "../server/store.js";
import type { AppConfig, ApprovalOverride, ChannelPlatform } from "../shared/types.js";

const INHERIT: Record<ChannelPlatform, ApprovalOverride> = {
  telegram: "inherit",
  wechat: "inherit",
  qq: "inherit",
  feishu: "inherit",
};

function config(
  requireApproval: boolean,
  overrides: Partial<Record<ChannelPlatform, ApprovalOverride>> = {},
): AppConfig {
  const base = defaults("/tmp/mnemo-approval-policy");
  return {
    ...base,
    channels: {
      ...base.channels,
      requireApproval,
      approvalOverrides: { ...INHERIT, ...overrides },
    },
  };
}

test("owner 到渠道平台的映射与通知目标一致", () => {
  assert.equal(channelPlatform("telegram:12345:-10042"), "telegram");
  assert.equal(channelPlatform("bridge:wechat:fixture:GroupMessage:1"), "wechat");
  assert.equal(channelPlatform("bridge:qq:family-a"), "qq");
  assert.equal(channelPlatform("bridge:feishu:oc_123"), "feishu");
  // 网页管理员永远不是渠道。
  assert.equal(channelPlatform("web:admin"), undefined);
  assert.equal(channelPlatform("bridge:telegram:x"), undefined);
  // 判定从宽：畸形渠道地址仍算渠道（宁可多要一次批准，不绕过闸门）。
  assert.equal(channelPlatform("telegram:fixture-user"), "telegram");
  assert.equal(channelPlatform("bridge:qq:"), "qq");
  assert.equal(channelPlatform("bridge:qq:a\u0001b"), "qq");
  assert.equal(channelPlatform(""), undefined);
});

test("单渠道覆盖优先于全局开关，未覆盖时跟随全局", () => {
  // 全局关闭：默认放行。
  assert.equal(requiresApproval(config(false), "telegram:1:-1"), false);
  // 全局开启：渠道需批准，网页管理员不受影响。
  assert.equal(requiresApproval(config(true), "telegram:1:-1"), true);
  assert.equal(requiresApproval(config(true), "web:admin"), false);
  // 全局开启但该渠道 skip：直接下载。
  assert.equal(requiresApproval(config(true, { telegram: "skip" }), "telegram:1:-1"), false);
  // 全局关闭但该渠道 require：仍需批准。
  assert.equal(requiresApproval(config(false, { qq: "require" }), "bridge:qq:family"), true);
  // 覆盖只作用于本平台，不影响其它渠道。
  assert.equal(requiresApproval(config(false, { qq: "require" }), "bridge:wechat:family"), false);
  assert.equal(requiresApproval(config(true, { qq: "skip" }), "bridge:wechat:family"), true);
  // inherit 显式写回时等价于没写。
  assert.equal(requiresApproval(config(true, { feishu: "inherit" }), "bridge:feishu:x"), true);
  assert.equal(requiresApproval(config(false, { feishu: "inherit" }), "bridge:feishu:x"), false);
  // 缺字段的旧配置按跟随全局处理。
  const legacy = config(true);
  delete (legacy.channels as { approvalOverrides?: unknown }).approvalOverrides;
  assert.equal(requiresApproval(legacy, "telegram:1:-1"), true);
  assert.equal(requiresApproval(legacy, "web:admin"), false);
});

test("配置校验接受三态覆盖、拒绝未知取值，并保持旧配置兼容", async () => {
  const base = defaults("/tmp/mnemo-approval-policy");

  // 只提交单渠道：其余渠道补成 inherit，全局开关保持原值。
  const merged = validateConfig(
    { channels: { approvalOverrides: { qq: "require" } } },
    base,
  );
  assert.equal(merged.channels.approvalOverrides?.qq, "require");
  assert.equal(merged.channels.approvalOverrides?.telegram, "inherit");
  assert.equal(merged.channels.requireApproval, false);

  // 未知取值必须报错，不能静默存成无效策略。
  assert.throws(
    () => validateConfig({ channels: { approvalOverrides: { qq: "always" } } }, base),
    /渠道审批策略无效/,
  );

  // 旧配置（完全没有这一层）仍然可用，语义等于全部跟随全局。
  const legacy = validateConfig({ channels: { requireApproval: true } }, base);
  assert.equal(legacy.channels.requireApproval, true);
  for (const platform of ["telegram", "wechat", "qq", "feishu"] as const)
    assert.equal(legacy.channels.approvalOverrides?.[platform], "inherit");
});
