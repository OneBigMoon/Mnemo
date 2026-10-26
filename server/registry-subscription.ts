// M7：源配置订阅分发——把源注册表做成可订阅的签名 JSON（对齐 LunaTV
// 的"配置即订阅"思路，自有实现）。
//
// 分发模型：实例用 HMAC-SHA256 密钥对注册表载荷签名，生成可分享的
// 订阅文档 `{ format, issuedAt, sources, signature }`；导入方用同一密钥
// 验签后按普通注册表加载。签名覆盖除 signature 外的规范 JSON（键序
// 无关——序列化前排序键）。
//
// 安全约定：签名密钥只从实例的 master.key 派生（HKDF 风格的域分离），
// 不落新文件；文档自带 issuedAt 供调用方做新鲜度策略。

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { loadRegistry, type SourceRegistry } from "./source-registry.js";

export interface SubscriptionDocument {
  format: 1;
  /** 签发时间（ISO；新鲜度策略由导入方决定）。 */
  issuedAt: string;
  sources: SourceRegistry["sources"];
  /** hex(HMAC-SHA256(canonical({format, issuedAt, sources}), key))。 */
  signature: string;
}

export interface SignedRegistryError {
  error: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 从 master.key 派生订阅签名密钥（域分离，不复用主密钥原文）。 */
export function deriveSubscriptionKey(masterKey: Uint8Array): Uint8Array {
  const mac = createHmac("sha256", Buffer.from([]));
  // HKDF 简化：HMAC(master, info) 作为派生密钥（单轮、无盐，域标签固定）。
  return createHmac("sha256", Buffer.from(masterKey))
    .update("lucerna-registry-subscription-v1")
    .digest();
}

function signPayload(document: Omit<SubscriptionDocument, "signature">, key: Uint8Array): string {
  return createHmac("sha256", Buffer.from(key)).update(canonical(document)).digest("hex");
}

/** 签发订阅文档：registry 必须先通过全量校验。 */
export function signRegistry(
  registry: SourceRegistry,
  masterKey: Uint8Array,
  now = new Date(),
): SubscriptionDocument {
  const { issues } = loadRegistry(JSON.stringify(registry));
  if (issues.length) throw new Error(`注册表无效：${issues[0].field} ${issues[0].message}`);
  const key = deriveSubscriptionKey(masterKey);
  const base = { format: 1 as const, issuedAt: now.toISOString(), sources: registry.sources };
  return { ...base, signature: signPayload(base, key) };
}

/** 验签并加载：签名不符、格式不符或载荷非法都拒绝。 */
export function verifyRegistrySubscription(
  text: string,
  masterKey: Uint8Array,
): { registry?: SourceRegistry; issuedAt?: string; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `订阅文档不是合法 JSON：${error instanceof Error ? error.message : error}` };
  }
  const doc = parsed as Partial<SubscriptionDocument>;
  if (!doc || typeof doc !== "object" || doc.format !== 1 || !Array.isArray(doc.sources) || typeof doc.signature !== "string" || typeof doc.issuedAt !== "string") {
    return { error: "订阅文档结构不符合 format 1" };
  }
  const key = deriveSubscriptionKey(masterKey);
  const expected = signPayload({ format: 1, issuedAt: doc.issuedAt, sources: doc.sources }, key);
  const given = Buffer.from(doc.signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { error: "签名校验失败" };
  }
  const { registry, issues } = loadRegistry(JSON.stringify({ format: 1, sources: doc.sources }));
  if (!registry) return { error: `订阅的注册表无效：${issues[0]?.message ?? "未知问题"}` };
  return { registry, issuedAt: doc.issuedAt };
}

/** 订阅文档的一次性导入标识（用于幂等的轮询缓存键）。 */
export function subscriptionId(document: SubscriptionDocument): string {
  return createHmac("sha256", "lucerna-subscription-id")
    .update(canonical({ f: document.format, s: document.sources }))
    .digest("hex")
    .slice(0, 32) + randomUUID().slice(0, 4);
}
