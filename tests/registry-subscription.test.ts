import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSubscriptionKey,
  signRegistry,
  verifyRegistrySubscription,
} from "../server/registry-subscription.js";
import { loadRegistry, type SourceRegistry } from "../server/source-registry.js";

const REGISTRY: SourceRegistry = {
  format: 1,
  sources: [
    {
      id: "cms-a",
      name: "采集 A",
      kind: "cms_v10",
      endpoint: "https://a.example.org/api.php/provide/vod",
      detailRoot: "https://a.example.org/",
    },
  ],
};

test("subscription round trip: sign with the derived key, verify and load", () => {
  const master = new Uint8Array(32).fill(7);
  const document = signRegistry(REGISTRY, master, new Date("2026-10-25T00:00:00Z"));
  assert.equal(document.format, 1);
  assert.match(document.signature, /^[0-9a-f]{64}$/);
  const verified = verifyRegistrySubscription(JSON.stringify(document), master);
  assert.equal(verified.error, undefined);
  assert.equal(verified.issuedAt, "2026-10-25T00:00:00.000Z");
  assert.deepEqual(verified.registry, loadRegistry(JSON.stringify(REGISTRY)).registry);
});

test("tampered payloads and wrong keys are rejected with constant-time compare", () => {
  const masterA = new Uint8Array(32).fill(1);
  const masterB = new Uint8Array(32).fill(2);
  const document = signRegistry(REGISTRY, masterA);
  // 换密钥验签失败。
  assert.match(verifyRegistrySubscription(JSON.stringify(document), masterB).error ?? "", /签名校验失败/);
  // 篡改任一字段失败。
  const tampered = { ...document, sources: [{ ...REGISTRY.sources[0], name: "篡改名" }] };
  assert.match(verifyRegistrySubscription(JSON.stringify(tampered), masterA).error ?? "", /签名校验失败/);
  const tamperedDate = { ...document, issuedAt: "2027-01-01T00:00:00.000Z" };
  assert.match(verifyRegistrySubscription(JSON.stringify(tamperedDate), masterA).error ?? "", /签名校验失败/);
  // 长度不同的伪签名安全拒绝。
  const short = { ...document, signature: "abcd" };
  assert.match(verifyRegistrySubscription(JSON.stringify(short), masterA).error ?? "", /签名校验失败/);
  // 结构不符。
  assert.match(verifyRegistrySubscription("{bad", masterA).error ?? "", /不是合法 JSON/);
  assert.match(verifyRegistrySubscription("{}", masterA).error ?? "", /结构不符合/);
});

test("signing an invalid registry is refused; key derivation is domain-separated", () => {
  const master = new Uint8Array(32).fill(3);
  const bad: SourceRegistry = {
    format: 1,
    sources: [{ id: "x", name: "X", kind: "cms_v10", endpoint: "ftp://x/y" }],
  };
  assert.throws(() => signRegistry(bad, master), /注册表无效/);
  const derived = deriveSubscriptionKey(master);
  assert.equal(derived.length, 32);
  assert.notDeepEqual(Buffer.from(derived), Buffer.from(master), "派生密钥不得等于主密钥原文");
});
