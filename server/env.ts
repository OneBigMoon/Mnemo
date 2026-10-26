/**
 * 部署配置的环境变量读取。
 *
 * 2026-10-25 由 Lucerna 更名为 Mnemo：新名字用 `MNEMO_*`，
 * 旧名 `MORI_*` 在兼容期内仍然生效（新名优先）。
 * 已有 NAS 部署无需立刻改 `.env`；两条都设时以新名为准。
 */
export function readEnv(key: string): string | undefined {
  return process.env[`MNEMO_${key}`] ?? process.env[`MORI_${key}`];
}

/** 该变量的两个名字是否都未设置（用于判断"未配置"而不是"配置为空串"）。 */
export function hasEnv(key: string): boolean {
  return readEnv(key) !== undefined;
}
