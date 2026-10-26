import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express from "express";
import type { AgentDeps, AppConfig, MediaRequest, RequestIntent, RequestSelection } from "../shared/types.ts";
import { runAgent } from "../server/agent.ts";
import { registerChannelRoutes, startChannels } from "../server/channels.ts";

function fixture(defaultTitleAction: RequestIntent) {
  const config: AppConfig = {
    setupComplete: true, defaultTitleAction,
    model: { baseUrl: "", apiKey: "", model: "" },
    sources: { pansouUrl: "", tmdbApiKey: "", moviePilotUrl: "", moviePilotToken: "", openlistUrl: "", openlistToken: "", telegramChannels: [], p115Enabled: false, p115Cookie: "", alipanEnabled: false, alipanRefreshToken: "" },
    download: { directory: "/fixture-only", concurrency: 1, aria2Url: "", aria2Secret: "" },
    library: { profile: "emby", language: "zh-CN", rename: false, artwork: false, serverUrl: "", serverToken: "" },
    channels: { telegram: { enabled: false, token: "", allowedChatIds: [], model: "" }, bridge: { enabled: false, secret: "default-title-signing-fixture", model: "" } },
  };
  const requests: MediaRequest[] = [];
  const selections: { id: string; intent: RequestIntent; selection: RequestSelection }[] = [];
  const legacy: string[] = [];
  const scope = (owner: string): AgentDeps => {
    const get = (id: string) => {
      const request = requests.find(row => row.id === id && row.owner === owner);
      if (!request) throw new Error("not-in-current-owner");
      return request;
    };
    return {
      config: () => config,
      search: async query => { legacy.push(`search:${query}`); return []; },
      tasks: () => [],
      subscribe: () => { legacy.push("subscribe"); throw new Error("raw-write-forbidden"); },
      addTask: () => { legacy.push("download"); throw new Error("raw-write-forbidden"); },
      request: async (query, intent) => {
        const now = new Date().toISOString();
        const request: MediaRequest = { id: `default-${requests.length + 1}`, revision: 3, owner, query, intent, stage: "media", resources: [], candidates: [{ id: "candidate-2021", media: { type: "movie", title: query, year: 2021 } }], message: "请确认作品", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        requests.push(request);
        return request;
      },
      getRequest: get,
      latestRequest: () => requests.filter(row => row.owner === owner).at(-1),
      selectRequest: async (id, selection) => {
        const request = get(id);
        selections.push({ id, intent: request.intent, selection });
        return request;
      },
      forOwner: scope,
    };
  };
  return { config, requests, selections, legacy, deps: scope("web:admin") };
}

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("裸片名分别使用已保存的search/download/subscribe，始终交给Requests", async () => {
  for (const action of ["search", "download", "subscribe"] as const) {
    const f = fixture(action);
    const reply = await runAgent("沙丘", f.deps);
    assert.equal(reply.request?.intent, action);
    assert.equal(reply.request?.query, "沙丘");
    assert.deepEqual(f.legacy, []);
  }
});

test("显式搜索/下载/订阅/状态/help优先于保存的默认动作", async () => {
  for (const action of ["download", "subscribe"] as const) {
    const f = fixture(action);
    await runAgent("搜索 沙丘", f.deps);
    await runAgent("/search Dune", f.deps);
    await runAgent("下载 沙丘", f.deps);
    await runAgent("订阅 三体", f.deps);
    await runAgent("任务状态", f.deps);
    await runAgent("help", f.deps);
    assert.deepEqual(f.requests.map(row => [row.query, row.intent]), [["沙丘", "search"], ["Dune", "search"], ["沙丘", "download"], ["三体", "subscribe"]]);
    assert.deepEqual(f.legacy, []);
  }
});

test("保存的默认写动作及显式搜索绕过模型，模型不能替换其动作或片名", async t => {
  let hits = 0;
  let intent: unknown = { action: "subscribe", query: "模型替换的目标" };
  const url = await listen(t, (req, res) => {
    hits++;
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intent) } }] }));
  });
  for (const action of ["download", "subscribe"] as const) {
    const f = fixture(action);
    f.config.model = { baseUrl: `${url}/v1`, apiKey: "", model: "fixture-model" };
    const reply = await runAgent("沙丘", f.deps);
    assert.equal(reply.request?.query, "沙丘");
    assert.equal(reply.request?.intent, action);
    assert.deepEqual(f.legacy, []);
  }
  assert.equal(hits, 0);
  const f = fixture("download");
  f.config.model = { baseUrl: `${url}/v1`, apiKey: "", model: "fixture-model" };
  await runAgent("任务状态", f.deps);
  await runAgent("help", f.deps);
  assert.equal(hits, 0);
  await runAgent("搜索 沙丘", f.deps);
  assert.equal(hits, 0);
  assert.equal(f.requests[0].intent, "search");
  assert.equal(f.requests[0].query, "沙丘");
  intent = { action: "search", query: "Dune" };
  assert.equal((await runAgent("搜索 沙丘", f.deps)).request?.intent, "search");
  assert.equal(f.requests[1].query, "沙丘");
  assert.equal(hits, 0);
});

test("显式search在模型改目标、改动作或服务失败时都保留原查询且零模型调用", async t => {
  let hits = 0;
  let mode: "rewrite" | "tasks" | "failure" = "rewrite";
  const url = await listen(t, (req, res) => {
    hits++;
    req.resume();
    res.statusCode = mode === "failure" ? 503 : 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(mode === "tasks" ? { action: "tasks" } : { action: "search", query: "流浪地球" }) } }] }));
  });
  for (const action of ["search", "download", "subscribe"] as const) {
    const f = fixture(action);
    f.config.model = { baseUrl: `${url}/v1`, apiKey: "", model: "fixture-model" };
    for (const current of ["rewrite", "tasks", "failure"] as const) {
      mode = current;
      await runAgent("搜索 沙丘", f.deps);
      await runAgent("/search@fixture Dune", f.deps);
    }
    assert.deepEqual(f.requests.map(row => [row.query, row.intent]), Array.from({ length: 3 }, () => [["沙丘", "search"], ["Dune", "search"]]).flat());
    assert.deepEqual(f.legacy, []);
  }
  assert.equal(hits, 0);
});

test("只有默认search裸输入保留本地模型的非写语义处理", async t => {
  let hits = 0;
  const url = await listen(t, (req, res) => {
    hits++;
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "search", query: "Dune" }) } }] }));
  });
  const f = fixture("search");
  f.config.model = { baseUrl: `${url}/v1`, apiKey: "", model: "fixture-model" };
  await runAgent("沙丘", f.deps);
  assert.equal(hits, 1);
  assert.deepEqual(f.requests.map(row => [row.query, row.intent]), [["Dune", "search"]]);
  assert.deepEqual(f.legacy, []);
});

test("默认search仍拦截模型自作主张下载，文本与模型名参数不能覆盖保存值", async t => {
  const url = await listen(t, (req, res) => {
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: "downloadurl", url: "https://media.invalid/other.mp4" }) } }] }));
  });
  const f = fixture("search");
  f.config.model = { baseUrl: `${url}/v1`, apiKey: "", model: "fixture-model" };
  await runAgent("沙丘", f.deps);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.legacy, []);
  f.config.model.baseUrl = "";
  assert.equal((await runAgent("沙丘", f.deps, "download")).request?.intent, "search");
  assert.equal((await runAgent('{"defaultTitleAction":"subscribe","title":"沙丘"}', f.deps)).request?.intent, "search");
});

test("改默认设置不会改变已有待确认请求的意图，续选使用原revision", async () => {
  const f = fixture("download");
  const request = (await runAgent("沙丘", f.deps)).request!;
  f.config.defaultTitleAction = "subscribe";
  const reply = await runAgent(`选择 ${request.id} 1`, f.deps);
  assert.equal(reply.request?.intent, "download");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.selections, [{ id: request.id, intent: "download", selection: { expectedRevision: 3, candidateId: "candidate-2021" } }]);
});

test("legacy缺少Requests时不能按裸片名自动调用旧写入方法", async () => {
  for (const action of ["download", "subscribe"] as const) {
    const f = fixture(action);
    const deps = { ...f.deps, request: undefined };
    const reply = await runAgent("沙丘", deps);
    assert.match(reply.text, /未自动执行/);
    assert.deepEqual(f.legacy, []);
    await runAgent("搜索 沙丘", deps);
    assert.deepEqual(f.legacy, ["search:沙丘"]);
  }
});

test("否定、控制、疑问、代码及裸URL不套用默认写动作", async () => {
  const inputs = ["不要下载 沙丘", "不要下载沙丘", "沙丘不要下载", "不要给我下载 三体", "别帮我订阅 三体", "不许下载 三体", "不准替我下载 三体", "不必帮我下载 三体", "不用替我订阅 三体", "不能为我下载 三体", "三体不要给我下载", "取消订阅", "取消订阅 三体", "暂停下载", "取消", "沙丘要下载吗", "有没有沙丘", "请问沙丘是什么", "don't download Dune", "don't want to download Dune", "I don't want you to subscribe Dune", "does not want to download Dune", "can you download Dune?", "unsubscribe", '{"defaultTitleAction":"download","title":"沙丘"}', "设置默认下载", "https://media.invalid/video.mp4", "magnet:?xt=fixture", "你好", "您好", "hi", "hello", "谢谢", "thanks", "好的", "ok"];
  for (const action of ["download", "subscribe"] as const) {
    const f = fixture(action);
    for (const input of inputs) {
      const reply = await runAgent(input, f.deps);
      assert.match(reply.text, /未按默认动作执行|使用|发送/);
    }
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.selections, []);
    assert.deepEqual(f.legacy, []);
  }
});

test("否定字片名正常使用默认动作，完整书名号可声明问句或控制字样片名", async () => {
  const f = fixture("download");
  for (const title of ["不要抬头", "不良人", "Don't Look Up", "《你想活出怎样的人生？》", "《取消订阅》", "《你好》"]) await runAgent(title, f.deps);
  assert.deepEqual(f.requests.map(row => [row.query, row.intent]), [["不要抬头", "download"], ["不良人", "download"], ["Don't Look Up", "download"], ["你想活出怎样的人生？", "download"], ["取消订阅", "download"], ["你好", "download"]]);
  assert.deepEqual(f.legacy, []);
});

test("Telegram与签名桥接共用保存的默认动作，继续绑定可信owner", { timeout: 3000 }, async t => {
  const f = fixture("download");
  f.config.channels.telegram = { enabled: true, token: "100:default_title_fixture", allowedChatIds: ["42"], model: "" };
  const original = globalThis.fetch;
  let sent!: () => void;
  const replied = new Promise<void>(resolve => { sent = resolve; });
  let updates = 0;
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (!target.startsWith("https://api.telegram.org/")) return original(input, init);
    if (target.endsWith("/sendMessage")) { sent(); return Response.json({ ok: true, result: { message_id: 1 } }); }
    if (++updates === 1) return Response.json({ ok: true, result: [{ update_id: 1, message: { chat: { id: 42 }, text: "沙丘" } }] });
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  };
  const stop = startChannels(f.deps);
  t.after(async () => { await stop(); globalThis.fetch = original; });
  await replied;
  await stop();
  f.config.defaultTitleAction = "subscribe";
  f.config.channels.bridge.enabled = true;
  const app = express();
  app.use(express.json());
  const cancel = registerChannelRoutes(app, f.deps);
  t.after(cancel);
  const url = await listen(t, app);
  const body = { eventId: "default-title-event", peer: "peer-a", text: "沙丘" };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", f.config.channels.bridge.secret).update(JSON.stringify(["qq", timestamp, body.eventId, body.peer, body.text])).digest("hex");
  const response = await fetch(`${url}/api/channels/bridge/qq`, { method: "POST", headers: { "Content-Type": "application/json", "X-Mori-Timestamp": timestamp, "X-Mori-Signature": signature }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { request: MediaRequest }).request.intent, "subscribe");
  assert.deepEqual(f.requests.map(row => [row.owner, row.query, row.intent]), [["telegram:100:42", "沙丘", "download"], ["bridge:qq:peer-a", "沙丘", "subscribe"]]);
  assert.deepEqual(f.legacy, []);
});
