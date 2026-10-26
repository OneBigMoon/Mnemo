import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { readEnv } from "./env.js";
import { coreEngine, runRustCore } from "./rust-core.js";
import type { AppConfig, ApprovalOverride, ChannelPlatform } from "../shared/types.js";

export const ALIPAN_AUTH_KIND = "alipan-auth";
export const ALIPAN_AUTH_ID = "current";

export const SECRET_PATHS = [
  "model.apiKey",
  "sources.tmdbApiKey",
  "sources.moviePilotToken",
  "sources.openlistToken",
  "sources.p115Cookie",
  "sources.alipanRefreshToken",
  "download.aria2Secret",
  "library.serverToken",
  "channels.telegram.token",
  "channels.bridge.secret",
];
export function defaults(directory: string): AppConfig {
  return {
    setupComplete: false,
    defaultTitleAction: "search",
    model: { baseUrl: "", apiKey: "", model: "" },
    sources: {
      pansouUrl: readEnv("PANSOU_URL") || "",
      tmdbApiKey: "",
      moviePilotUrl: "",
      moviePilotToken: "",
      openlistUrl: "",
      openlistToken: "",
      p115Enabled: false,
      p115Cookie: "",
      alipanEnabled: false,
      alipanRefreshToken: "",
      telegramChannels: [],
      registryJson: "",
    },
    download: { directory, concurrency: 2, aria2Url: "", aria2Secret: "" },
    library: {
      profile: "emby",
      language: "zh-CN",
      rename: true,
      artwork: true,
      serverUrl: "",
      serverToken: "",
      pathFrom: "",
      pathTo: "",
      userId: "",
    },
    channels: {
      requireApproval: false,
      // 旧配置没有这一层：全部 inherit 等价于原来的全局开关。
      approvalOverrides: { telegram: "inherit", wechat: "inherit", qq: "inherit", feishu: "inherit" },
      telegram: { enabled: false, token: "", allowedChatIds: [], model: "" },
      bridge: { enabled: false, secret: "", model: "" },
    },
  };
}
function field(obj: any, key: string): { object: any; key: string } {
  const parts = key.split(".");
  const last = parts.pop()!;
  return { object: parts.reduce((v, p) => v[p], obj), key: last };
}
export function publicConfig(config: AppConfig) {
  const copy = structuredClone(config);
  const secretStatus: Record<string, boolean> = {};
  for (const key of SECRET_PATHS) {
    const f = field(copy, key);
    secretStatus[key] = Boolean(f.object[f.key]);
    f.object[f.key] = "";
  }
  return { ...copy, secretStatus };
}
export function validateConfig(input: unknown, old: AppConfig): AppConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("配置必须是对象");
  const value = input as Record<string, any>;
  function merge(shape: any, candidate: any, prefix = ""): any {
    if (candidate === undefined) return structuredClone(shape);
    if (Array.isArray(shape)) {
      if (
        !Array.isArray(candidate) ||
        candidate.length > 100 ||
        candidate.some((x) => typeof x !== "string" || x.length > 500)
      )
        throw new Error(`${prefix} 格式不正确`);
      return [
        ...new Set(candidate.map((x: string) => x.trim()).filter(Boolean)),
      ];
    }
    if (shape && typeof shape === "object") {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      )
        throw new Error(`${prefix} 格式不正确`);
      return Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [
          k,
          merge(v, candidate[k], prefix ? `${prefix}.${k}` : k),
        ]),
      );
    }
    if (
      typeof candidate !== typeof shape ||
      (typeof candidate === "string" && candidate.length > 4096)
    )
      throw new Error(`${prefix} 格式不正确`);
    if (SECRET_PATHS.includes(prefix) && candidate === "") return shape;
    return typeof candidate === "string" ? candidate.trim() : candidate;
  }
  const config: AppConfig = merge({
    ...old,
    defaultTitleAction: old.defaultTitleAction ?? "search",
    sources: {
      ...old.sources,
      p115Enabled: old.sources.p115Enabled ?? false,
      registryJson: old.sources.registryJson ?? "",
      p115Cookie: old.sources.p115Cookie ?? "",
      alipanEnabled: old.sources.alipanEnabled ?? false,
      alipanRefreshToken: old.sources.alipanRefreshToken ?? "",
    },
  }, value);
  if (!["search", "download", "subscribe"].includes(config.defaultTitleAction))
    throw new Error("片名默认动作必须是搜索、下载或追更");
  for (const [platform, value] of Object.entries(config.channels.approvalOverrides ?? {}))
    if (!["inherit", "require", "skip"].includes(value as string))
      throw new Error(`渠道审批策略无效：${platform}`);
  if (/[\u0000-\u001f\u007f]/u.test(config.sources.p115Cookie))
    throw new Error("115 Cookie 不能包含换行或控制字符");
  if (/[^\x21-\x7e]/u.test(config.sources.alipanRefreshToken))
    throw new Error("阿里云盘授权凭据不能包含空白或非 ASCII 字符");
  if (value.clearSecrets !== undefined) {
    if (
      !Array.isArray(value.clearSecrets) ||
      value.clearSecrets.some(
        (x: unknown) => typeof x !== "string" || !SECRET_PATHS.includes(x),
      )
    )
      throw new Error("无效的密钥清除选项");
    for (const key of value.clearSecrets) {
      const f = field(config, key);
      f.object[f.key] = "";
    }
  }
  for (const key of [
    "model.baseUrl",
    "sources.pansouUrl",
    "sources.moviePilotUrl",
    "sources.openlistUrl",
    "download.aria2Url",
    "library.serverUrl",
  ]) {
    const f = field(config, key);
    const v = f.object[f.key];
    if (!v) continue;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      throw new Error(`${key} 必须是完整网址`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(`${key} 仅支持不含账号、查询参数的 HTTP(S) 地址`);
  }
  if (
    !Number.isInteger(config.download.concurrency) ||
    config.download.concurrency < 1 ||
    config.download.concurrency > 4
  )
    throw new Error("同时下载数必须是 1–4");
  if (
    !path.isAbsolute(config.download.directory) ||
    path.parse(config.download.directory).root ===
      path.resolve(config.download.directory)
  )
    throw new Error("请选择绝对路径的专用下载文件夹，不能使用磁盘根目录");
  if (
    !["emby", "jellyfin", "fnos", "ugreen", "kodi"].includes(
      config.library.profile,
    )
  )
    throw new Error("未知媒体库类型");
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(config.library.language))
    throw new Error("元数据语言格式应为 zh-CN 或 en");
  if (Boolean(config.library.pathFrom) !== Boolean(config.library.pathTo))
    throw new Error("路径映射的本机目录和媒体服务器目录需要同时填写");
  if (config.library.pathFrom && !path.isAbsolute(config.library.pathFrom))
    throw new Error("本机映射目录必须使用绝对路径");
  if (
    config.library.pathTo &&
    !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(config.library.pathTo)
  )
    throw new Error("媒体服务器映射目录必须使用绝对路径");
  if (
    config.channels.telegram.allowedChatIds.some((x) => !/^-?\d{1,20}$/.test(x))
  )
    throw new Error("Telegram 授权聊天 ID 必须为数字");
  if (
    config.channels.telegram.enabled &&
    (!config.channels.telegram.token ||
      !config.channels.telegram.allowedChatIds.length)
  )
    throw new Error("启用 Telegram 前请填写 Bot Token 和允许的聊天 ID");
  if (
    config.channels.bridge.enabled &&
    config.channels.bridge.secret.length < 32
  )
    throw new Error("渠道桥接密钥至少 32 个字符");
  return config;
}

export class Store {
  private transactionDepth = 0;
  db: DatabaseSync;
  private key: Buffer;
  constructor(
    public readonly directory: string,
    downloadDirectory = path.resolve("downloads"),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = path.join(directory, "master.key");
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32)
      throw new Error("本地加密密钥损坏，不能读取配置");
    this.db = new DatabaseSync(path.join(directory, "mori.sqlite"));
    chmodSync(path.join(directory, "mori.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);",
    );
    if (!this.get("config")) this.setConfig(defaults(downloadDirectory));
  }
  get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as any)
      ?.value;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  private unseal<T>(sealed: string): T {
    const raw = JSON.parse(sealed);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(raw.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(raw.tag, "hex"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(raw.value, "hex")),
        decipher.final(),
      ]).toString(),
    );
  }
  /** 主密钥（注册表订阅签名派生用；不写入日志）。 */
  get masterKey(): Uint8Array {
    return this.key;
  }
  config(): AppConfig {
    const config = this.unseal<AppConfig>(this.get("config")!);
    config.library.pathFrom ??= "";
    config.library.pathTo ??= "";
    config.library.userId ??= "";
    config.defaultTitleAction ??= "search";
    config.sources.p115Enabled ??= false;
    config.sources.p115Cookie ??= "";
    config.sources.alipanEnabled ??= false;
    config.sources.alipanRefreshToken ??= "";
    config.channels.requireApproval ??= false;
    // 旧配置没有单渠道覆盖：补齐为 inherit，行为与原来的全局开关一致。
    const stored = (config.channels.approvalOverrides ?? {}) as Partial<
      Record<ChannelPlatform, ApprovalOverride>
    >;
    config.channels.approvalOverrides = {
      telegram: stored.telegram ?? "inherit",
      wechat: stored.wechat ?? "inherit",
      qq: stored.qq ?? "inherit",
      feishu: stored.feishu ?? "inherit",
    };
    return config;
  }
  private seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        value: data.toString("hex"),
    });
  }
  setConfig(config: AppConfig) {
    this.transaction(() => {
      const old = this.get("config") ? this.config() : undefined;
      if (old?.sources.alipanRefreshToken !== config.sources.alipanRefreshToken)
        this.remove(ALIPAN_AUTH_KIND, ALIPAN_AUTH_ID);
      this.set("config", this.seal(config));
    });
  }
  putPrivate(kind: string, id: string, value: unknown, expiresAt: string) {
    this.put(kind, { id, expiresAt, sealed: this.seal(value) });
  }
  privateId(value: unknown): string {
    return createHmac("sha256", this.key)
      .update("mori-private-id-v1\0")
      .update(JSON.stringify(value))
      .digest("hex");
  }
  privateRecord<T>(kind: string, id: string): T | undefined {
    const record = this.record<{ id: string; sealed: string }>(kind, id);
    return record ? this.unseal<T>(record.sealed) : undefined;
  }
  initialized() {
    return Boolean(this.get("password"));
  }
  setup(password: string) {
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 256
    )
      throw new Error("管理员密码需要 12–256 个字符");
    if (this.initialized()) throw new Error("已完成管理员初始化");
    const salt = randomBytes(16);
    this.db
      .prepare("INSERT INTO kv VALUES (?,?)")
      .run(
        "password",
        `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`,
      );
  }
  async checkPassword(password: unknown, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (typeof password !== "string" || password.length > 256) return false;
    const value = this.get("password");
    if (!value) return false;
    if (coreEngine() === "rust") {
      const result = await runRustCore("password_verify", JSON.stringify({
        passwordHex: Buffer.from(password, "utf8").toString("hex"), stored: value,
      }), signal);
      return result.matches;
    }
    const [salt, hash] = value.split(":");
    return timingSafeEqual(
      scryptSync(password, Buffer.from(salt, "hex"), 32),
      Buffer.from(hash, "hex"),
    );
  }
  session() {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?)")
      .run(this.hash(token), Date.now() + 7 * 86400000);
    return token;
  }
  authenticated(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const record = this.db
      .prepare("SELECT expires FROM sessions WHERE token=?")
      .get(this.hash(token)) as any;
    return Boolean(record && record.expires > Date.now());
  }
  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token=?").run(this.hash(token));
  }
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT payload FROM records WHERE kind=? ORDER BY rowid DESC")
        .all(kind) as any[]
    ).map((x) => JSON.parse(x.payload));
  }
  record<T>(kind: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return r ? JSON.parse(r.payload) : undefined;
  }
  put<T extends { id: string }>(kind: string, record: T) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(kind, record.id, JSON.stringify(record));
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `mori_tx_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = operation();
      if (result && typeof (result as any).then === 'function') throw new Error('数据库事务只能执行同步操作');
      this.db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      if (depth) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); }
      else this.db.exec("ROLLBACK");
      throw error;
    } finally { this.transactionDepth--; }
  }
  close() {
    this.db.close();
  }
}
