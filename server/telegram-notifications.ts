import timers from "node:timers/promises";
import type {
  AgentDeps,
  NotificationDestination,
} from "../shared/types.ts";

const REJECTED_CODES = new Set([400, 401, 403, 429]);
const RESPONSE_LIMIT = 64 * 1024;
const LOOP_ERROR = "Telegram 通知处理失败，请在 Web 界面核对通知状态。";

function settings(deps: AgentDeps) {
  const current = deps.config().channels.telegram;
  const token = current.token.trim();
  const ids = current.allowedChatIds;
  if (
    !current.enabled ||
    token.length > 200 ||
    !/^[1-9]\d{0,19}:[A-Za-z0-9_-]+$/u.test(token) ||
    !Array.isArray(ids) ||
    ids.length > 100
  )
    return undefined;
  const peers = [...new Set(ids
    .filter((id) => typeof id === "string" && /^-?[1-9]\d{0,19}$/u.test(id.trim()))
    .map((id) => id.trim()))];
  if (peers.length === 0) return undefined;
  return {
    token,
    botId: token.split(":", 1)[0],
    peers,
  };
}

async function send(
  token: string,
  peer: string,
  text: string,
  lifetime: AbortSignal,
): Promise<{ outcome: "delivered" | "unknown" | "rejected"; receipt?: string }> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]);
  try {
    signal.throwIfAborted();
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: peer, text: text.slice(0, 4000) }),
    });
    if (REJECTED_CODES.has(response.status) || response.status >= 500) {
      await response.body?.cancel();
      signal.throwIfAborted();
      return { outcome: REJECTED_CODES.has(response.status) ? "rejected" : "unknown" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { outcome: "unknown" };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT) {
          await reader.cancel();
          return { outcome: "unknown" };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    signal.throwIfAborted();
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      ok?: unknown;
      error_code?: unknown;
      result?: { message_id?: unknown };
    } | null;
    if (typeof data?.error_code === "number" && REJECTED_CODES.has(data.error_code))
      return { outcome: "rejected" };
    const messageId = data?.result?.message_id;
    if (
      response.status === 200 &&
      data?.ok === true &&
      typeof messageId === "number" &&
      Number.isSafeInteger(messageId) &&
      messageId > 0
    )
      return { outcome: "delivered", receipt: String(messageId) };
  } catch {
    // A failed request may already have reached Telegram; never retry it here.
  }
  return { outcome: "unknown" };
}

export async function sendTelegramNotificationsBatch(
  deps: AgentDeps,
  signal: AbortSignal,
  cursor = 0,
): Promise<number> {
  const service = deps.notifications;
  if (!service || signal.aborted) return cursor;
  const initial = settings(deps);
  if (!initial) return cursor;
  const start = cursor % initial.peers.length;
  let scanned = 0;
  let claimed = 0;
  while (scanned < initial.peers.length && claimed < 4 && !signal.aborted) {
    const peer = initial.peers[(start + scanned) % initial.peers.length];
    scanned++;
    const current = settings(deps);
    if (
      signal.aborted ||
      !current ||
      current.botId !== initial.botId ||
      !current.peers.includes(peer)
    )
      continue;
    const destination: NotificationDestination = {
      platform: "telegram",
      botId: current.botId,
      peer,
    };
    const [claim] = service.claim(destination, 1);
    if (!claim) continue;
    claimed++;
    let result: Awaited<ReturnType<typeof send>> = { outcome: "unknown" };
    try {
      const beforeSend = settings(deps);
      if (
        !signal.aborted &&
        beforeSend &&
        beforeSend.botId === destination.botId &&
        beforeSend.peers.includes(peer)
      )
        result = await send(beforeSend.token, peer, claim.text, signal);
    } finally {
      service.acknowledge(
        destination,
        claim.id,
        claim.claimToken,
        signal.aborted ? "unknown" : result.outcome,
        signal.aborted ? undefined : result.receipt,
      );
    }
  }
  return (start + scanned) % initial.peers.length;
}

export function startTelegramNotifications(
  deps: AgentDeps,
  lifetime: AbortSignal,
  onError: (message: string) => void = () => {},
): () => Promise<void> {
  if (!deps.notifications || lifetime.aborted || !settings(deps)) return async () => {};
  const controller = new AbortController();
  const signal = AbortSignal.any([lifetime, controller.signal]);
  const run = async () => {
    let cursor = 0;
    while (!signal.aborted) {
      try {
        cursor = await sendTelegramNotificationsBatch(deps, signal, cursor);
      } catch {
        onError(LOOP_ERROR);
      }
      if (signal.aborted) break;
      try {
        await timers.setTimeout(5000, undefined, { signal });
      } catch {
        break;
      }
    }
  };
  const settled = Promise.allSettled([run()]);
  let draining: Promise<void> | undefined;
  return () => {
    controller.abort();
    return (draining ??= settled.then(([result]) => {
      if (result.status === "rejected") throw result.reason;
    }));
  };
}
