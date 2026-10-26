import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  return value;
}

const base = need("BASE");
const fixture = readFileSync(need("FIXTURE"));
const sourceUrl = need("SOURCE_URL");
const password = need("ADMIN_PASSWORD");
const setupToken = process.env.SETUP_TOKEN || "";
const downloadRoot = process.env.DOWNLOAD_ROOT || "/downloads";
const title = process.env.TITLE || "Container Playback Fixture";
const year = Number(process.env.YEAR || 2026);
const out = process.env.OUT || "";
const fixtureSha = createHash("sha256").update(fixture).digest("hex");
let cookie = "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(route, method = "GET", body, headers = {}) {
  return fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

async function expect(response, status, label) {
  if (response.status !== status) {
    throw new Error(`${label} ${response.status}: ${await response.text()}`);
  }
}

const started = Date.now();
try {
  const health = await request("/api/health");
  await expect(health, 200, "health");
  const healthBody = await health.json();
  assert(healthBody.ok === true, "health body not ok");

  const anonymous = await request("/api/tasks/unknown/stream");
  await expect(anonymous, 401, "anonymous stream");

  const authRoute = setupToken ? "/api/setup" : "/api/login";
  const authBody = setupToken ? { password, setupToken } : { password };
  const session = await request(authRoute, "POST", authBody);
  await expect(session, 200, setupToken ? "setup" : "login");
  const setCookie = session.headers.getSetCookie?.()[0] || session.headers.get("set-cookie");
  assert(setCookie, "auth did not set a cookie");
  cookie = setCookie.split(";")[0];

  const created = await request("/api/tasks", "POST", {
    title,
    url: sourceUrl,
    kind: "direct",
    media: { title, year, type: "movie" },
  });
  await expect(created, 201, "create");
  const createdTask = (await created.json()).task;

  let task;
  for (let attempt = 0; attempt < 600; attempt++) {
    const listing = await request("/api/tasks");
    await expect(listing, 200, "list");
    const listingBody = await listing.json();
    task = listingBody.tasks.find((item) => item.id === createdTask.id);
    if (task && ["completed", "failed"].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(task, "task disappeared");
  assert(task.status === "completed", `task ${task.status}: ${task.error || ""}`);
  assert(task.downloadRoot === downloadRoot, `downloadRoot ${task.downloadRoot}`);
  assert(task.path.startsWith(`${downloadRoot}/`), `path ${task.path}`);

  const full = await request(`/api/tasks/${task.id}/stream`);
  await expect(full, 200, "full");
  assert(full.headers.get("accept-ranges") === "bytes", "accept-ranges missing");
  assert(full.headers.get("content-type") === "video/mp4", `content-type ${full.headers.get("content-type")}`);
  assert(full.headers.get("content-length") === String(fixture.length), "full length mismatch");
  const fullBytes = Buffer.from(await full.arrayBuffer());
  const fullSha = createHash("sha256").update(fullBytes).digest("hex");
  assert(fullSha === fixtureSha, `stream sha ${fullSha} != ${fixtureSha}`);

  const partial = await request(`/api/tasks/${task.id}/stream`, "GET", undefined, {
    range: "bytes=100-199",
  });
  await expect(partial, 206, "partial");
  assert(partial.headers.get("content-range") === `bytes 100-199/${fixture.length}`, "content-range mismatch");
  const partialBytes = Buffer.from(await partial.arrayBuffer());
  assert(partialBytes.equals(fixture.subarray(100, 200)), "partial bytes mismatch");

  const suffix = await request(`/api/tasks/${task.id}/stream`, "GET", undefined, {
    range: "bytes=-64",
  });
  await expect(suffix, 206, "suffix");
  assert(Buffer.from(await suffix.arrayBuffer()).equals(fixture.subarray(-64)), "suffix bytes mismatch");

  const invalid = await request(`/api/tasks/${task.id}/stream`, "GET", undefined, {
    range: "bytes=0-1,3-4",
  });
  await expect(invalid, 416, "invalid range");
  assert(invalid.headers.get("content-range") === `bytes */${fixture.length}`, "invalid content-range mismatch");

  const head = await request(`/api/tasks/${task.id}/stream`, "HEAD");
  await expect(head, 200, "head");
  assert(head.headers.get("content-length") === String(fixture.length), "head length mismatch");
  assert((await head.arrayBuffer()).byteLength === 0, "head returned a body");

  const result = {
    health: healthBody,
    anonymousStreamStatus: anonymous.status,
    task: { id: task.id, status: task.status, path: task.path, downloadRoot: task.downloadRoot },
    fixture: { bytes: fixture.length, sha256: fixtureSha },
    full: {
      status: full.status,
      contentType: full.headers.get("content-type"),
      bytes: fullBytes.length,
      sha256: fullSha,
    },
    range: { status: partial.status, contentRange: partial.headers.get("content-range"), bytes: partialBytes.length },
    suffixStatus: suffix.status,
    invalidRange: { status: invalid.status, contentRange: invalid.headers.get("content-range") },
    head: { status: head.status, contentLength: head.headers.get("content-length") },
    elapsedMs: Date.now() - started,
  };
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
