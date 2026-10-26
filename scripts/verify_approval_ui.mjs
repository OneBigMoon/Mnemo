#!/usr/bin/env node
// 浏览器渲染验收：设置 → 消息渠道 的「按渠道审批」四个下拉。
//
// 依赖 playwright-core（不进项目依赖）。二选一：
//   npm i -D playwright-core
//   PLAYWRIGHT_CORE=/abs/path/node_modules/playwright-core/index.js node scripts/verify_approval_ui.mjs
//
// 用法：
//   BASE=http://127.0.0.1:4199 OUT=docs/evidence node scripts/verify_approval_ui.mjs
//
// 断言：四个下拉存在且选项正确、改动能保存并在刷新后保持、390px 无横向溢出、
// 控制台无错误。截图落到 OUT（默认 docs/evidence）。
//
// QA_SEED=1 时额外造一条真实审批（签名桥接发起 → 管理员批准），
// 用于验收「审批记录」区块；需要目标实例带夹具 media（见 output 说明）。
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ESM 不认 NODE_PATH：允许用 PLAYWRIGHT_CORE 指向绝对路径（项目外安装时用）。
// CJS 包经 ESM 动态导入后可能挂在 default 上，两种形状都接受。
const playwright = await import(
  process.env.PLAYWRIGHT_CORE || "playwright-core"
);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("playwright-core 未能加载，请检查 PLAYWRIGHT_CORE");

const BASE = process.env.BASE || "http://127.0.0.1:4199";
const OUT = path.resolve(process.env.OUT || "docs/evidence");
const CHROME =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = process.env.QA_PASSWORD || "qa-approval-20261025-pass";
const EXPECTED = ["Telegram下载审批", "微信下载审批", "QQ下载审批", "飞书下载审批"];
const OPTIONS = ["跟随全局", "需批准", "免批准"];
const SEED = process.env.QA_SEED === "1";
const SECRET = randomUUID();

const failures = [];
const check = (ok, label, detail = "") => {
  if (!ok) failures.push(detail ? `${label}（${detail}）` : label);
  process.stderr.write(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}\n`);
};

async function session() {
  const body = JSON.stringify({ password: PASSWORD });
  const headers = { "content-type": "application/json" };
  let response = await fetch(`${BASE}/api/setup`, { method: "POST", headers, body });
  if (response.status === 409) {
    response = await fetch(`${BASE}/api/login`, { method: "POST", headers, body });
  }
  if (!response.ok)
    throw new Error(`无法建立管理员会话：HTTP ${response.status}`);
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie");
  const [pair] = String(raw || "").split(";");
  const index = pair.indexOf("=");
  if (index < 0) throw new Error("响应没有会话 Cookie");
  return { name: pair.slice(0, index), value: pair.slice(index + 1) };
}

const cookie = await session();
// 首次向导不在这条验收路径上：直接把 setupComplete 置位，进入常规设置页。
const skipWizard = await fetch(`${BASE}/api/config`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie: `${cookie.name}=${cookie.value}` },
  body: JSON.stringify({ setupComplete: true }),
});
if (!skipWizard.ok) throw new Error(`无法跳过向导：HTTP ${skipWizard.status}`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 960 },
  locale: "zh-CN",
});
await context.addCookies([
  { name: cookie.name, value: cookie.value, domain: "127.0.0.1", path: "/" },
]);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const signed = (fields) =>
  createHmac("sha256", SECRET).update(JSON.stringify(fields), "utf8").digest("hex");
const apiJson = async (route, method, body, headers = {}) => {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${cookie.name}=${cookie.value}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};
const seedApproval = async () => {
  const config = await apiJson("/api/config", "PUT", {
    setupComplete: true,
    channels: {
      requireApproval: true,
      bridge: { enabled: true, secret: SECRET, model: "" },
      telegram: { enabled: false, token: "", allowedChatIds: [], model: "" },
    },
  });
  if (config.status !== 200) throw new Error(`配置写入失败：HTTP ${config.status}`);
  const eventId = randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const peer = "qa-family";
  const text = "下载 沙丘";
  const sent = await fetch(`${BASE}/api/channels/bridge/qq`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Mori-Timestamp": timestamp,
      "X-Mori-Signature": signed(["qq", timestamp, eventId, peer, text]),
    },
    body: JSON.stringify({ eventId, peer, text }),
  });
  if (!sent.ok) throw new Error(`桥接请求失败：HTTP ${sent.status}`);
  const listed = await apiJson("/api/requests", "GET");
  const parked = (listed.body?.requests ?? []).find(
    (request) => request.owner === `bridge:qq:${peer}` && request.stage === "approval",
  );
  if (!parked) throw new Error("渠道请求没有停在待批准");
  const approved = await apiJson(`/api/requests/${parked.id}/select`, "POST", {
    expectedRevision: parked.revision,
    approve: true,
  });
  if (approved.status !== 200) throw new Error(`批准失败：HTTP ${approved.status}`);
};

const openChannels = async () => {
  await page.goto(`${BASE}/#settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "消息渠道" }).click();
  await page.getByText("渠道下载审批").waitFor({ timeout: 10_000 });
};

try {
  await openChannels();

  const selects = page.getByRole("combobox", { name: /下载审批$/ });
  check((await selects.count()) === 4, "四个渠道各有一个审批下拉", `实际 ${await selects.count()}`);

  const labels = await page
    .locator(".approval-override > span")
    .allTextContents();
  check(
    EXPECTED.every((name) => labels.some((label) => `${label}下载审批` === name)),
    "下拉标签覆盖 Telegram/微信/QQ/飞书",
    labels.join("、"),
  );

  const options = await selects.first().locator("option").allTextContents();
  check(
    OPTIONS.every((option) => options.includes(option)) && options.length === OPTIONS.length,
    "三态选项齐全",
    options.join("/"),
  );
  check(
    (await selects.first().inputValue()) === "inherit",
    "默认值为跟随全局",
    await selects.first().inputValue(),
  );

  // 改动 → 保存 → 刷新后保持。
  await page.getByRole("combobox", { name: "QQ下载审批" }).selectOption("require");
  const save = page.getByRole("button", { name: /保存更改/ });
  await save.click();
  await page.getByRole("button", { name: "设置已保存" }).waitFor({ timeout: 15_000 });

  await openChannels();
  const persisted = await page.getByRole("combobox", { name: "QQ下载审批" }).inputValue();
  check(persisted === "require", "刷新后 QQ 覆盖仍为需批准", persisted);
  const others = await page
    .locator(".approval-override select")
    .evaluateAll((nodes) => nodes.map((node) => node.value));
  check(
    others.filter((value) => value === "require").length === 1,
    "只有 QQ 被改动，其它渠道保持跟随全局",
    others.join(","),
  );

  mkdirSync(OUT, { recursive: true });
  await page.screenshot({
    path: path.join(OUT, "approval-ui-desktop-20261025.png"),
    fullPage: true,
  });

  // 390px：不重新加载，保留当前分组，量横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(overflow <= 1, "390px 无横向溢出", `溢出 ${overflow}px`);
  await page.screenshot({
    path: path.join(OUT, "approval-ui-mobile-20261025.png"),
    fullPage: true,
  });

  check(consoleErrors.length === 0, "控制台无错误", consoleErrors.slice(0, 3).join(" | "));

  if (SEED) {
    await page.setViewportSize({ width: 1280, height: 960 });
    await seedApproval();
    // 造数据走的是 API 而非界面点击，因此整页重载一次再断言。
    await page.goto(`${BASE}/#assistant`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    const history = page.locator(".approval-history");
    await history.waitFor({ timeout: 10_000 });
    await history.locator("summary").click();
    const historyText = await history.innerText();
    check(historyText.includes("已批准"), "审批记录显示已批准", historyText.slice(0, 80));
    check(historyText.includes("沙丘"), "审批记录带片名");
    check(historyText.includes("bridge:qq:qa-family"), "审批记录带申请人");
    check(/\d{4}\/\d{1,2}\/\d{1,2}/.test(historyText), "审批记录带时间", historyText.slice(0, 120));
    check(historyText.includes("操作记录"), "区块标题为操作记录");
    check(historyText.includes("渠道创建"), "任务创建也进入同一条时间线");
    await page.screenshot({
      path: path.join(OUT, "approval-history-20261025.png"),
      fullPage: true,
    });
  }
} catch (error) {
  failures.push(`流程异常：${error instanceof Error ? error.message : error}`);
} finally {
  await browser.close();
}

const summary = {
  base: BASE,
  failures,
  seeded: SEED,
  screenshots: [
    path.relative(process.cwd(), path.join(OUT, "approval-ui-desktop-20261025.png")),
    path.relative(process.cwd(), path.join(OUT, "approval-ui-mobile-20261025.png")),
    ...(SEED
      ? [path.relative(process.cwd(), path.join(OUT, "approval-history-20261025.png"))]
      : []),
  ],
  checkedAt: new Date().toISOString(),
};
writeFileSync(
  path.join(OUT, "approval-ui-20261025.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(failures.length ? 1 : 0);
