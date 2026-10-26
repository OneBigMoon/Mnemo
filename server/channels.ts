import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Express, Request, Response } from "express";
import type { AgentDeps, ChatReply, NotificationClaim, NotificationDestination } from "../shared/types.ts";
import { runAgent } from "./agent.ts";
import { startTelegramNotifications } from "./telegram-notifications.ts";

const WINDOW_MS = 5 * 60_000;

function guardedDeps(deps: AgentDeps, lifetime: AbortSignal): AgentDeps {
  const combined = (caller?: AbortSignal) =>
    caller ? AbortSignal.any([lifetime, caller]) : lifetime;
  return {
    ...deps,
    subscribe: (value) => {
      lifetime.throwIfAborted();
      return deps.subscribe(value);
    },
    addTask: (value) => {
      lifetime.throwIfAborted();
      return deps.addTask(value);
    },
    request: deps.request
      ? async (value, intent, caller) => {
          const signal = combined(caller);
          signal.throwIfAborted();
          const request = await deps.request!(value, intent, signal);
          signal.throwIfAborted();
          return request;
        }
      : undefined,
    selectRequest: deps.selectRequest
      ? async (id, selection, caller) => {
          const signal = combined(caller);
          signal.throwIfAborted();
          const request = await deps.selectRequest!(id, selection, signal);
          signal.throwIfAborted();
          return request;
        }
      : undefined,
  };
}

async function telegram(
  token: string,
  method: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Telegram 接口请求失败。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Telegram 响应为空。");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        throw new Error("Telegram 响应过大。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    ok?: boolean;
    result?: unknown;
  };
  if (data?.ok !== true) throw new Error("Telegram 接口拒绝请求。");
  return data.result;
}

function telegramText(reply: ChatReply): string {
  if (reply.request) return reply.text.slice(0, 4000);
  const titles = reply.results
    ?.slice(0, 5)
    .map(
      (result, index) =>
        `${index + 1}. ${result.title.slice(0, 150)} · ${result.source.slice(0, 60)}`,
    )
    .join("\n");
  return `${reply.text}${titles ? `\n\n${titles}\n请打开 Mnemo Web 界面选择资源。` : ""}`.slice(
    0,
    4000,
  );
}

export function startChannels(
  deps: AgentDeps,
  onError: (message: string) => void = () => {},
): () => Promise<void> {
  const config = deps.config();
  const settings = config.channels.telegram;
  if (!settings.enabled) return async () => {};
  const token = settings.token.trim();
  const ids = settings.allowedChatIds;
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token) || token.length > 200) {
    onError("Telegram 未启动：请配置有效的 Bot Token。");
    return async () => {};
  }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 100 ||
    ids.some((id) => typeof id !== "string" || !/^-?\d{1,20}$/u.test(id.trim()))
  ) {
    onError(
      "Telegram 未启动：必须配置 1–100 个允许的 Chat ID；空列表默认拒绝所有消息。",
    );
    return async () => {};
  }
  const allowed = new Set(ids.map((id) => id.trim()));
  const controller = new AbortController();
  const stopNotifications = startTelegramNotifications(deps, controller.signal, onError);
  let stopped = false;
  let offset = 0;
  let failures = 0;
  const channelDeps = (owner: string): AgentDeps => {
    if (deps.request && !deps.forOwner)
      throw new Error("渠道缺少选片身份上下文。");
    const scoped = deps.forOwner ? deps.forOwner(owner) : deps;
    return guardedDeps({ ...scoped, config: () => config }, controller.signal);
  };
  const poll = async () => {
    while (!stopped) {
      try {
        const updates = await telegram(
          token,
          "getUpdates",
          { offset, timeout: 20, limit: 20, allowed_updates: ["message"] },
          AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
        );
        if (!Array.isArray(updates) || updates.length > 20)
          throw new Error("Telegram 更新格式无效。");
        failures = 0;
        for (const entry of updates) {
          if (stopped) break;
          const update = entry as {
            update_id?: number;
            message?: {
              chat?: { id?: number };
              from?: { is_bot?: boolean };
              text?: string;
            };
          };
          if (
            !Number.isSafeInteger(update.update_id) ||
            update.update_id! < offset
          )
            continue;
          offset = update.update_id! + 1;
          const message = update.message;
          if (
            !Number.isSafeInteger(message?.chat?.id) ||
            !allowed.has(String(message?.chat?.id)) ||
            message?.from?.is_bot ||
            typeof message?.text !== "string"
          )
            continue;
          const reply = await runAgent(
            message.text,
            channelDeps(
              `telegram:${token.split(":", 1)[0]}:${message.chat!.id}`,
            ),
            settings.model,
          );
          if (!stopped) {
            try {
              await telegram(
                token,
                "sendMessage",
                { chat_id: message.chat!.id, text: telegramText(reply) },
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(10_000),
                ]),
              );
            } catch {
              if (!stopped)
                onError(
                  "Telegram 回复发送失败，结果可能未知；请在 Web 界面核对任务。",
                );
            }
          }
        }
        if (!stopped)
          await delay(updates.length ? 100 : 1000, undefined, {
            signal: controller.signal,
          });
      } catch {
        if (stopped) break;
        onError(
          "Telegram 轮询失败，请检查 Token、网络及是否有其他实例使用该 Bot。",
        );
        failures = Math.min(failures + 1, 5);
        try {
          await delay(
            Math.min(30_000, 1000 * 2 ** failures + Math.random() * 500),
            undefined,
            { signal: controller.signal },
          );
        } catch {
          break;
        }
      }
    }
  };
  const polling = Promise.allSettled([poll()]);
  let draining: Promise<void> | undefined;
  return () => {
    stopped = true;
    controller.abort();
    return draining ??= Promise.all([polling, Promise.allSettled([stopNotifications()])]).then(results => {
      for (const result of results.flat()) if (result.status === "rejected") throw result.reason;
    });
  };
}

export function registerChannelRoutes(
  app: Express,
  deps: AgentDeps,
): () => void {
  const seen = new Map<string, number>();
  const pollNonces = new Map<string, number>();
  const controllers = new Set<AbortController>();
  let active = 0;
  const begin = (req: Request, res: Response) => {
    active++;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    const close = () => { if (!res.writableFinished) abort(); };
    req.once("aborted", abort);
    res.once("close", close);
    if (req.aborted || res.destroyed) abort();
    return { controller, release: () => {
      req.off("aborted", abort);
      res.off("close", close);
      controllers.delete(controller);
      active--;
    } };
  };
  const responseFinished = (res: Response, signal: AbortSignal) => new Promise<void>(resolve => {
    const finish = () => {
      res.off("finish", finish);
      res.off("close", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    res.once("finish", finish);
    res.once("close", finish);
    signal.addEventListener("abort", finish, { once: true });
    if (res.writableFinished || res.destroyed || signal.aborted) finish();
  });
  app.post("/api/channels/bridge/:platform", async (req, res) => {
    const platform = req.params.platform;
    if (!["wechat", "qq", "feishu"].includes(String(platform))) {
      res.status(404).json({ error: "不支持的桥接平台。" });
      return;
    }
    const settings = deps.config().channels.bridge;
    if (!settings.enabled || !settings.secret.trim()) {
      res.status(404).json({ error: "渠道桥接尚未启用。" });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "eventId,peer,text" ||
      typeof body.eventId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(body.eventId) ||
      typeof body.peer !== "string" ||
      !body.peer.trim() ||
      body.peer.length > 200 ||
      /[\u0000-\u001f\u007f]/u.test(body.peer) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.length > 4000
    ) {
      res
        .status(400)
        .json({ error: "需要有效的 eventId、peer 和 1–4000 字的 text。" });
      return;
    }
    const timestamp = req.get("X-Mori-Timestamp") || "";
    const signature = req.get("X-Mori-Signature") || "";
    const now = Date.now();
    if (
      !/^\d{1,12}$/u.test(timestamp) ||
      Math.abs(now - Number(timestamp) * 1000) > WINDOW_MS ||
      !/^[a-f\d]{64}$/iu.test(signature)
    ) {
      res.status(401).json({ error: "桥接签名无效或已过期。" });
      return;
    }
    const expected = createHmac("sha256", settings.secret)
      .update(
        JSON.stringify([
          platform,
          timestamp,
          body.eventId,
          body.peer,
          body.text,
        ]),
        "utf8",
      )
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
      res.status(401).json({ error: "桥接签名无效或已过期。" });
      return;
    }
    for (const [key, expires] of seen) if (expires <= now) seen.delete(key);
    const key = JSON.stringify([platform, body.peer, body.eventId]);
    if (seen.has(key)) {
      res.status(409).json({ error: "该事件已接收，请勿重复执行。" });
      return;
    }
    if (active >= 4 || seen.size >= 2000) {
      res.status(429).json({ error: "桥接处理已达上限，请稍后重试同一事件。" });
      return;
    }
    seen.set(key, Number(timestamp) * 1000 + WINDOW_MS);
    const { controller, release } = begin(req, res);
    try {
      if (deps.request && !deps.forOwner)
        throw new Error("渠道缺少选片身份上下文。");
      const scoped = deps.forOwner
        ? deps.forOwner(`bridge:${platform}:${body.peer}`)
        : deps;
      const reply = await runAgent(
        body.text.trim(),
        guardedDeps(scoped, controller.signal),
        settings.model,
      );
      if (controller.signal.aborted) {
        if (!res.destroyed)
          res
            .status(409)
            .json({ error: "渠道请求已取消，请在 Web 界面核对操作结果。" });
        return;
      }
      res.json(reply);
    } catch {
      res
        .status(500)
        .json({ error: "桥接处理失败，请在 Web 界面核对操作结果。" });
    } finally {
      release();
    }
  });
  const notifications = (route: "poll" | "ack") => async (req: Request, res: Response) => {
    const platform = String(req.params.platform);
    if (!["wechat", "qq", "feishu"].includes(platform)) { res.status(404).json({ error: "不支持的通知平台。" }); return; }
    const settings = deps.config().channels.bridge;
    const service = deps.notifications;
    if (!settings.enabled || !settings.secret.trim() || !service) { res.status(503).json({ disabled: true, error: "通知桥接或通知服务尚未启用。" }); return; }
    const body = req.body as Record<string, unknown> | undefined;
    const keys = body && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
    const peer = body?.peer;
    const validPeer = typeof peer === "string" && peer.trim() && peer.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(peer);
    const validPoll = keys === "nonce,peer" && typeof body?.nonce === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(body.nonce);
    const validAck = (keys === "claimToken,id,outcome,peer" || keys === "claimToken,id,outcome,peer,receipt") && typeof body?.id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(body.id) && typeof body.claimToken === "string" && body.claimToken.length > 0 && body.claimToken.length <= 256 && !/\s|[\u0000-\u001f\u007f]/u.test(body.claimToken) && typeof body.outcome === "string" && ["delivered", "unknown", "rejected"].includes(body.outcome) && (body.receipt === undefined || (typeof body.receipt === "string" && body.receipt.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(body.receipt)));
    if (!validPeer || (route === "poll" ? !validPoll : !validAck)) { res.status(400).json({ error: "通知请求字段无效。" }); return; }
    const timestamp = req.get("X-Mori-Timestamp") || "";
    const signature = req.get("X-Mori-Signature") || "";
    const now = Date.now();
    if (!/^\d{1,12}$/u.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > WINDOW_MS || !/^[a-f\d]{64}$/iu.test(signature)) { res.status(401).json({ error: "通知签名无效或已过期。" }); return; }
    const fields = route === "poll" ? ["notifications.poll", platform, timestamp, peer, body!.nonce] : ["notifications.ack", platform, timestamp, peer, body!.id, body!.claimToken, body!.outcome, body!.receipt || ""];
    const expected = createHmac("sha256", settings.secret).update(JSON.stringify(fields), "utf8").digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) { res.status(401).json({ error: "通知签名无效或已过期。" }); return; }
    let nonce: string | undefined;
    if (route === "poll") {
      for (const [key, expires] of pollNonces) if (expires <= now) pollNonces.delete(key);
      nonce = JSON.stringify([platform, peer, body!.nonce]);
      if (pollNonces.has(nonce)) { res.status(409).json({ error: "该通知轮询已接收，请使用新 nonce。" }); return; }
      if (pollNonces.size >= 2000) { res.status(429).json({ error: "通知轮询已达上限，请稍后再试。" }); return; }
    }
    if (active >= 4) { res.status(429).json({ error: "渠道处理已达上限，请稍后再试。" }); return; }
    if (nonce) pollNonces.set(nonce, Number(timestamp) * 1000 + WINDOW_MS);
    const destination: NotificationDestination = { platform: platform as "wechat" | "qq" | "feishu", peer: peer as string };
    const { controller, release } = begin(req, res);
    const claims: NotificationClaim[] = [];
    let handedOff = false;
    try {
      controller.signal.throwIfAborted();
      if (route === "poll") claims.push(...service.claim(destination, 10));
      else service.acknowledge(destination, body!.id as string, body!.claimToken as string, body!.outcome as "delivered" | "unknown" | "rejected", body!.receipt as string | undefined);
      controller.signal.throwIfAborted();
      const finished = responseFinished(res, controller.signal);
      res.json(route === "poll" ? { notifications: claims, serverTime: new Date().toISOString() } : { ok: true });
      await finished;
      handedOff = res.writableFinished && !controller.signal.aborted;
      if (!handedOff && !res.destroyed) res.destroy();
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(controller.signal.aborted || route === "ack" ? 409 : 500).json({ error: "通知处理未确认，请核对目标和当前 claim。" });
      else if (!res.writableFinished && !res.destroyed) res.destroy();
    } finally {
      if (!handedOff && route === "poll") for (const claim of claims) {
        try { service.acknowledge(destination, claim.id, claim.claimToken, "unknown"); }
        catch { console.warn("Mnemo 通知桥接取消后的回执未保存，请检查通知列表。"); }
      }
      release();
    }
  };
  app.post("/api/channels/bridge/:platform/notifications/poll", notifications("poll"));
  app.post("/api/channels/bridge/:platform/notifications/ack", notifications("ack"));
  return () => {
    for (const controller of controllers) controller.abort();
  };
}
