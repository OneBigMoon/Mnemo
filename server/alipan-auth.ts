import { randomUUID } from "node:crypto";
import { ALIPAN_AUTH_ID, ALIPAN_AUTH_KIND, Store } from "./store.js";

export interface AlipanCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class AlipanError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
    public readonly operationId?: string,
  ) {
    super(message);
    this.name = "AlipanError";
  }
}

type Session = AlipanCredentials & {
  fingerprint: string;
  phase: "pending" | "ready" | "invalid" | "unknown";
  operationId: string;
};
type Waiter = {
  cancelled: boolean;
  resolve: (token: string) => void;
  reject: (error: AlipanError) => void;
  cleanup: () => void;
};
type Flight = {
  session: Session;
  controller: AbortController;
  waiters: Set<Waiter>;
  done: Promise<void>;
  complete: () => void;
  persistenceError?: AlipanError;
};

const flights = new WeakMap<Store, Flight>();
const closings = new WeakMap<Store, Promise<void>>();
const MAX_WAITERS = 16;
const MAX_TOKEN_LENGTH = 16_384;
// Retain the rotated refresh credential after the access credential expires.
const RETAIN_UNTIL = "9999-12-31T23:59:59.999Z";

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH && !/[^\x21-\x7e]/u.test(value);
}

function credentials(value: unknown): value is AlipanCredentials {
  if (!value || typeof value !== "object") return false;
  const item = value as AlipanCredentials;
  return token(item.accessToken) && token(item.refreshToken) &&
    Number.isSafeInteger(item.expiresAt) && item.expiresAt >= 0;
}

function unknown(operationId?: string) {
  return new AlipanError("alipan_auth_unknown",
    "阿里云盘授权轮换结果未确认，请重新取得并保存新的 Web 授权", 409, operationId);
}

function changed(operationId?: string) {
  return new AlipanError("alipan_config_changed",
    "阿里云盘授权配置已变更，旧请求的结果已停止提交", 409, operationId);
}

function cancelled(operationId?: string) {
  return new AlipanError("alipan_cancelled", "阿里云盘授权请求已取消", 409, operationId);
}

export class AlipanAuth {
  constructor(
    private readonly store: Store,
    private readonly refresh: (refreshToken: string, signal: AbortSignal) => Promise<AlipanCredentials>,
  ) {
    if (closings.has(this.store)) return;
    let operationId: string | undefined;
    try {
      this.store.transaction(() => {
        const session = this.read();
        operationId = session?.operationId;
        if (session?.phase === "pending" &&
            flights.get(this.store)?.session.operationId !== session.operationId)
          this.write({ ...session, phase: "unknown" });
      });
    } catch {
      throw unknown(operationId);
    }
  }

  private fingerprint() {
    return this.store.privateId(["alipan-auth-config", this.store.config().sources.alipanRefreshToken]);
  }

  private read(): Session | undefined {
    const session = this.store.privateRecord<Session>(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID);
    if (!session) return undefined;
    if (!/^[a-f0-9]{64}$/u.test(session.fingerprint) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(session.operationId) ||
        !["pending", "ready", "invalid", "unknown"].includes(session.phase) ||
        !token(session.refreshToken) ||
        typeof session.accessToken !== "string" || session.accessToken.length > MAX_TOKEN_LENGTH ||
        /[^\x21-\x7e]/u.test(session.accessToken) ||
        !Number.isSafeInteger(session.expiresAt) || session.expiresAt < 0 ||
        (session.phase === "ready" && !token(session.accessToken)))
      throw unknown();
    return session;
  }

  private write(session: Session) {
    this.store.putPrivate(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID, session, RETAIN_UNTIL);
  }

  private commit(flight: Flight, phase: Session["phase"], result?: AlipanCredentials) {
    this.store.transaction(() => {
      const current = this.read();
      if (this.fingerprint() !== flight.session.fingerprint ||
          current?.fingerprint !== flight.session.fingerprint ||
          current.operationId !== flight.session.operationId)
        throw changed(flight.session.operationId);
      this.write({ ...current, ...result, phase });
    });
  }

  async access(signal?: AbortSignal, force = false): Promise<string> {
    if (closings.has(this.store))
      throw new AlipanError("alipan_closed", "阿里云盘授权服务已关闭", 409);
    if (signal?.aborted) throw cancelled();
    let operationId: string | undefined;
    let decision: string | Session | Flight;
    try {
      decision = this.store.transaction(() => {
        const config = this.store.config().sources;
        if (!config.alipanEnabled || !token(config.alipanRefreshToken))
          throw new AlipanError("alipan_auth_required",
            "请启用阿里云盘并保存有效的 Web 授权", 409);
        const fingerprint = this.fingerprint();
        const session = this.read();
        const running = flights.get(this.store);
        operationId = running?.session.operationId ?? session?.operationId;
        if (running) {
          if (running.controller.signal.aborted || running.session.fingerprint !== fingerprint ||
              session?.fingerprint !== fingerprint ||
              session.operationId !== running.session.operationId)
            throw new AlipanError("alipan_busy", "阿里云盘旧授权请求正在收尾，请稍后重试", 429, operationId);
          return running;
        }
        if (session?.fingerprint === fingerprint) {
          if (session.phase === "invalid")
            throw new AlipanError("alipan_auth_invalid",
              "阿里云盘 Web 授权已失效，请重新取得并保存授权", 409, operationId);
          if (session.phase === "unknown" || session.phase === "pending") throw unknown(operationId);
          if (!force && session.expiresAt > Date.now()) return session.accessToken;
        }
        operationId = randomUUID();
        const pending: Session = {
          fingerprint, operationId, phase: "pending",
          refreshToken: session?.fingerprint === fingerprint ? session.refreshToken : config.alipanRefreshToken,
          accessToken: session?.fingerprint === fingerprint ? session.accessToken : "",
          expiresAt: session?.fingerprint === fingerprint ? session.expiresAt : 0,
        };
        this.write(pending);
        return pending;
      });
    } catch (error) {
      if (error instanceof AlipanError) throw error;
      throw unknown(operationId);
    }
    if (typeof decision === "string") return decision;
    if ("controller" in decision) return this.wait(decision, signal);
    let complete!: () => void;
    const done = new Promise<void>((resolve) => { complete = resolve; });
    const flight: Flight = { session: decision, controller: new AbortController(), waiters: new Set(), done, complete };
    flights.set(this.store, flight);
    const waiting = this.wait(flight, signal);
    void Promise.resolve().then(() => this.rotate(flight)).then(
      (result) => this.finish(flight, result),
      (error: AlipanError) => this.finish(flight, undefined, error),
    );
    return waiting;
  }

  close(): Promise<void> {
    const existing = closings.get(this.store);
    if (existing) return existing;
    const flight = flights.get(this.store);
    const done = flight ? flight.done.then(() => {
      if (flight.persistenceError) throw flight.persistenceError;
    }) : Promise.resolve();
    closings.set(this.store, done);
    if (flight) {
      for (const waiter of flight.waiters) {
        waiter.cancelled = true;
        waiter.cleanup();
      }
      flight.controller.abort();
    }
    return done;
  }

  private wait(flight: Flight, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (flight.waiters.size >= MAX_WAITERS) {
        reject(new AlipanError("alipan_busy", "阿里云盘授权等待人数已达上限，请稍后重试", 429, flight.session.operationId));
        return;
      }
      const waiter: Waiter = {
        cancelled: false, resolve, reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        waiter.cleanup();
        if (flight.waiters.size > 1) {
          flight.waiters.delete(waiter);
          reject(cancelled(flight.session.operationId));
        } else {
          // The last caller drains a late known rotation before its cancellation completes.
          flight.controller.abort();
        }
      };
      flight.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async rotate(flight: Flight): Promise<string> {
    let result: AlipanCredentials | undefined;
    try {
      flight.controller.signal.throwIfAborted();
      const response = await this.refresh(flight.session.refreshToken, flight.controller.signal);
      if (!credentials(response)) throw unknown(flight.session.operationId);
      result = { accessToken: response.accessToken, refreshToken: response.refreshToken, expiresAt: response.expiresAt };
      this.commit(flight, "ready", result);
      return result.accessToken;
    } catch (error) {
      if (error instanceof AlipanError && error.code === "alipan_config_changed") throw error;
      if (result) flight.persistenceError = unknown(flight.session.operationId);
      const invalid = error instanceof AlipanError && error.code === "alipan_auth_invalid";
      try {
        this.commit(flight, invalid ? "invalid" : "unknown", result);
      } catch (persistenceError) {
        if (persistenceError instanceof AlipanError && persistenceError.code === "alipan_config_changed")
          throw persistenceError;
        flight.persistenceError ??= unknown(flight.session.operationId);
        throw flight.persistenceError;
      }
      if (invalid)
        throw new AlipanError("alipan_auth_invalid",
          "阿里云盘 Web 授权已失效，请重新取得并保存授权", 409, flight.session.operationId);
      throw unknown(flight.session.operationId);
    }
  }

  private finish(flight: Flight, result?: string, error?: AlipanError) {
    if (flights.get(this.store) === flight) flights.delete(this.store);
    for (const waiter of flight.waiters) {
      waiter.cleanup();
      if (waiter.cancelled) waiter.reject(flight.persistenceError ?? cancelled(flight.session.operationId));
      else if (error) waiter.reject(error);
      else waiter.resolve(result!);
    }
    flight.waiters.clear();
    flight.complete();
  }
}
