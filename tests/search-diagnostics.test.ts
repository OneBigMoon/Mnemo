import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import test from "node:test";
import type { AppConfig, SearchReport, SearchSource, ShareService } from "../shared/types.ts";
import { createMediaService, MediaError } from "../server/media.ts";
import { defaults } from "../server/store.ts";

const MEDIA_URL = "https://fixture.invalid/Fixture.2024.mp4";
const ENTRY = { url: MEDIA_URL, title: "Fixture 2024" };

function settings(sources: Partial<AppConfig["sources"]> = {}) {
  const config = defaults(os.tmpdir());
  Object.assign(config.sources, sources);
  return config;
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function source(report: SearchReport, kind: SearchSource) {
  const diagnostic = report.diagnostics.sources.find((entry) => entry.source === kind);
  assert(diagnostic, kind);
  return diagnostic;
}

test("unconfigured search returns an explicit report while the legacy array method keeps NOT_CONFIGURED", async () => {
  const config = settings({ p115Enabled: true, alipanEnabled: true });
  const service = createMediaService(() => config);
  const report = await service.searchWithDiagnostics!("Fixture");
  assert.equal(report.diagnostics.status, "not_configured");
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.diagnostics.sources.map((entry) => entry.source), ["pansou", "openlist", "moviepilot", "telegram"]);
  assert(report.diagnostics.sources.every((entry) => entry.status === "not_configured" && entry.resultCount === 0));
  await assert.rejects(service.search("Fixture"), (error) => error instanceof MediaError && error.code === "NOT_CONFIGURED");
});

test("all configured sources can successfully return empty arrays", async () => {
  const local = await fixture((request, response) => {
    if (request.url?.startsWith("/pan/")) json(response, { code: 0, data: { results: [], merged_by_type: {} } });
    else if (request.url?.startsWith("/open/")) json(response, { code: 200, data: { content: [] } });
    else json(response, { success: true, data: [] });
  });
  try {
    const config = settings({ pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/open`, moviePilotUrl: `${local.url}/mp` });
    const service = createMediaService(() => config);
    const report = await service.searchWithDiagnostics!("Fixture");
    assert.equal(report.diagnostics.status, "complete");
    assert.deepEqual(report.results, []);
    for (const kind of ["pansou", "openlist", "moviepilot"] as const)
      assert.equal(source(report, kind).status, "empty");
    assert.deepEqual(await service.search("Fixture"), []);
  } finally {
    await local.close();
  }
});

test("PanSou keeps supported root, data, merged, original-link and explicit empty containers", async () => {
  let payload: unknown;
  const local = await fixture((_request, response) => json(response, payload));
  try {
    const service = createMediaService(() => settings({ pansouUrl: local.url }));
    for (const [value, count] of [
      [{ results: [] }, 0],
      [{ data: { results: [] } }, 0],
      [{ merged_by_type: {} }, 0],
      [{ data: { merged_by_type: { p115: [] } } }, 0],
      [{ data: { results: null, merged_by_type: null } }, 0],
      [{ data: { merged_by_type: { direct: [ENTRY], metadata: "ignored" } } }, 1],
      [{ results: [{ content: MEDIA_URL, title: "Fixture" }] }, 1],
      [{ data: { results: [{ title: "Fixture", links: [{ url: MEDIA_URL }] }] } }, 1],
    ] as const) {
      payload = value;
      const report = await service.searchWithDiagnostics!("Fixture");
      assert.equal(report.diagnostics.status, "complete");
      assert.equal(report.results.length, count);
      assert.equal(source(report, "pansou").status, count ? "success" : "empty");
    }
  } finally {
    await local.close();
  }
});

test("a successful or empty source plus a failed source is partial and legacy search returns available results", async (t) => {
  for (const entries of [[ENTRY], []]) await t.test(entries.length ? "useful results" : "empty success", async () => {
    const local = await fixture((request, response) => {
      if (request.url?.startsWith("/pan/")) json(response, { results: entries });
      else json(response, { message: "fixture upstream private body" }, 503);
    });
    try {
      const service = createMediaService(() => settings({ pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/open` }));
      const report = await service.searchWithDiagnostics!("Fixture");
      assert.equal(report.diagnostics.status, "partial");
      assert.equal(report.results.length, entries.length);
      assert.equal(source(report, "pansou").status, entries.length ? "success" : "empty");
      assert.equal(source(report, "openlist").status, "failed");
      assert.equal(source(report, "openlist").code, "upstream_error");
      assert.equal((await service.search("Fixture")).length, entries.length);
    } finally {
      await local.close();
    }
  });
});

test("all-source failures have bounded codes and safe names while legacy search retains SEARCH_FAILED", async (t) => {
  const secret = "fixture-private-token";
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const local = await fixture((request, response) => {
    const status = request.url?.startsWith("/pan/") ? 401 : request.url?.startsWith("/open/") ? 429 : 503;
    json(response, { message: `${secret} private upstream response` }, status);
  });
  try {
    const service = createMediaService(() => settings({
      pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/open`, moviePilotUrl: `${local.url}/mp`,
      openlistToken: secret, moviePilotToken: secret,
    }));
    const report = await service.searchWithDiagnostics!("Fixture");
    assert.equal(report.diagnostics.status, "failed");
    assert.deepEqual(report.results, []);
    assert.equal(source(report, "pansou").code, "auth_required");
    assert.equal(source(report, "openlist").code, "rate_limited");
    assert.equal(source(report, "moviepilot").code, "upstream_error");
    const publicDiagnostics = JSON.stringify(report.diagnostics);
    assert(!publicDiagnostics.includes(secret));
    assert(!publicDiagnostics.includes(local.url));
    assert(!publicDiagnostics.includes("private upstream"));
    await assert.rejects(service.search("Fixture"), (error) => {
      assert(error instanceof MediaError);
      assert.equal(error.code, "SEARCH_FAILED");
      assert(!error.message.includes(secret));
      assert(!error.message.includes(local.url));
      assert(!error.message.includes("private upstream"));
      return true;
    });
    assert.deepEqual(warnings, []);
  } finally {
    await local.close();
  }
});

test("unrecognized source schemas are failures instead of invented empty results", async (t) => {
  for (const [kind, payload] of [
    ["pansou", {}], ["pansou", { data: {} }],
    ["pansou", { data: { results: {} } }], ["pansou", { merged_by_type: { broken: "value" } }],
    ["openlist", {}], ["openlist", { data: { content: "broken" } }],
    ["moviepilot", {}], ["moviepilot", { data: {} }],
  ] as const) await t.test(kind, async () => {
    const local = await fixture((_request, response) => json(response, payload));
    try {
      const config = settings({ [kind === "pansou" ? "pansouUrl" : kind === "openlist" ? "openlistUrl" : "moviePilotUrl"]: local.url });
      const report = await createMediaService(() => config).searchWithDiagnostics!("Fixture");
      assert.equal(report.diagnostics.status, "failed");
      assert.equal(source(report, kind).code, "invalid_response");
    } finally {
      await local.close();
    }
  });
});

test("a real per-source HTTP deadline is diagnosed without cancelling a healthy source", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => timeout(Math.min(milliseconds, 200)));
  const local = await fixture((request, response) => {
    if (request.url?.startsWith("/pan/")) json(response, { results: [ENTRY] });
  });
  try {
    const service = createMediaService(() => settings({ pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/slow` }));
    const report = await service.searchWithDiagnostics!("Fixture");
    assert.equal(report.diagnostics.status, "partial");
    assert.equal(source(report, "pansou").status, "success");
    assert.equal(source(report, "openlist").code, "timeout");
    assert.equal(report.results.length, 1);
  } finally {
    await local.close();
  }
});

test("caller cancellation propagates rather than returning a partial report", { timeout: 3000 }, async () => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const local = await fixture((request, response) => {
    if (request.url?.startsWith("/pan/")) json(response, { results: [ENTRY] });
    else entered();
  });
  try {
    const service = createMediaService(() => settings({ pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/slow` }));
    const controller = new AbortController();
    const pending = service.searchWithDiagnostics!("Fixture", controller.signal);
    await waiting;
    const reason = new DOMException("fixture caller cancellation", "AbortError");
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    await assert.rejects(service.search("Fixture", controller.signal), (error) => error === reason);
  } finally {
    await local.close();
  }
});

test("concurrent search reports keep their own outcomes and diagnostic objects", async () => {
  const local = await fixture(async (request, response) => {
    const input = await body(request);
    const query = input.kw ?? input.keywords;
    if (request.url?.startsWith("/pan/")) {
      if (query === "first") await new Promise((resolve) => setTimeout(resolve, 25));
      json(response, { results: query === "first" ? [ENTRY] : [] });
    } else if (query === "first") json(response, {}, 503);
    else json(response, { data: { content: [] } });
  });
  try {
    const service = createMediaService(() => settings({ pansouUrl: `${local.url}/pan`, openlistUrl: `${local.url}/open` }));
    const [first, second] = await Promise.all([
      service.searchWithDiagnostics!("first"), service.searchWithDiagnostics!("second"),
    ]);
    assert.equal(first.diagnostics.status, "partial");
    assert.equal(first.results.length, 1);
    assert.equal(second.diagnostics.status, "complete");
    assert.deepEqual(second.results, []);
    assert.equal(source(first, "openlist").status, "failed");
    assert.equal(source(second, "openlist").status, "empty");
    assert.notEqual(first.diagnostics, second.diagnostics);
    assert.notEqual(source(first, "pansou"), source(second, "pansou"));
  } finally {
    await local.close();
  }
});

test("useful results stay deduplicated and private share capture remains before public output", async () => {
  const local = await fixture((_request, response) => json(response, { data: { results: [
    { url: "https://115.com/s/fixture", title: "Fixture", password: "fixture-code" },
    { url: "https://115.com/s/fixture", title: "Fixture", password: "fixture-code" },
  ] } }));
  try {
    let captured = 0;
    const provider: ShareService = {
      capture(resource) {
        captured++;
        assert.equal(resource.extractionCode, "fixture-code");
        return { ...resource, shareRef: `mori-share:${"a".repeat(64)}` };
      },
      browse: async () => [],
      directory() { throw new Error("unused"); },
      scan: async () => { throw new Error("unused"); },
      resolve: async () => { throw new Error("unused"); },
      testConnection: async () => ({ ok: true, message: "unused" }),
    };
    const report = await createMediaService(() => settings({ pansouUrl: local.url }), provider).searchWithDiagnostics!("Fixture");
    assert.equal(report.diagnostics.status, "complete");
    assert.equal(captured, 1);
    assert.equal(report.results.length, 1);
    assert(report.results[0].shareRef);
    assert.equal("extractionCode" in report.results[0], false);
  } finally {
    await local.close();
  }
});

test("Telegram channel diagnostics use stable independent ids and static numbered names", async (t) => {
  const config = settings({ telegramChannels: ["fixture_alpha", "fixture_beta"] });
  t.mock.method(globalThis, "fetch", async (input: URL | string | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "t.me");
    if (url.pathname.endsWith("fixture_beta")) throw new TypeError("fixture private upstream error");
    return new Response(`<div data-post="fixture_alpha/1"><div class="tgme_widget_message_text"><a href="${MEDIA_URL}">Fixture</a></div></div>`);
  });
  const service = createMediaService(() => config);
  const first = await service.searchWithDiagnostics!("first");
  const second = await service.searchWithDiagnostics!("second");
  const channels = first.diagnostics.sources.filter((entry) => entry.source === "telegram");
  assert.equal(first.diagnostics.status, "partial");
  assert.deepEqual(channels.map((entry) => entry.name), ["Telegram 频道 1", "Telegram 频道 2"]);
  assert.notEqual(channels[0].id, channels[1].id);
  assert(channels.every((entry) => /^telegram:[a-f0-9]{24}$/u.test(entry.id)));
  assert.equal(channels[0].status, "success");
  assert.equal(channels[1].code, "unreachable");
  assert.deepEqual(channels.map((entry) => entry.id), second.diagnostics.sources.filter((entry) => entry.source === "telegram").map((entry) => entry.id));
  const serialized = JSON.stringify(first.diagnostics);
  for (const privateText of ["fixture_alpha", "fixture_beta", "https:", "private upstream"])
    assert(!serialized.includes(privateText));
  config.sources.telegramChannels.push("fixture_alpha");
  const repeated = (await service.searchWithDiagnostics!("third")).diagnostics.sources.filter((entry) => entry.source === "telegram");
  assert.equal(new Set(repeated.map((entry) => entry.id)).size, 3);
  assert.deepEqual(repeated.slice(0, 2).map((entry) => entry.id), channels.map((entry) => entry.id));
});

test("Telegram empty channel markup is recognized while unrelated response text is invalid", async (t) => {
  let html = '<div class="tgme_channel_info">Fixture</div>';
  t.mock.method(globalThis, "fetch", async () => new Response(html));
  const service = createMediaService(() => settings({ telegramChannels: ["fixture_alpha"] }));
  const empty = await service.searchWithDiagnostics!("Fixture");
  assert.equal(empty.diagnostics.status, "complete");
  assert.equal(source(empty, "telegram").status, "empty");
  html = "{}";
  const invalid = await service.searchWithDiagnostics!("Fixture");
  assert.equal(invalid.diagnostics.status, "failed");
  assert.equal(source(invalid, "telegram").code, "invalid_response");
});
