import type { MediaService, SearchDiagnostics, SearchFailureCode, SearchReport } from "./types.js";

export async function searchWithDiagnostics(
 service: Pick<MediaService, "search" | "searchWithDiagnostics">,
 query: string,
 signal?: AbortSignal,
): Promise<SearchReport> {
 if (service.searchWithDiagnostics) return service.searchWithDiagnostics(query, signal);
 return { results: await service.search(query, signal), diagnostics: { status: "complete", sources: [] } };
}

export function searchFailureMessage(code?: SearchFailureCode): string {
 switch (code) {
  case "timeout": return "连接超时，请稍后重试";
  case "unreachable": return "无法连接，请检查来源地址和服务是否启动";
  case "auth_required": return "授权未通过，请检查来源凭据";
  case "rate_limited": return "请求过于频繁，请稍后重试";
  case "invalid_response": return "返回格式无法识别，请检查服务地址和版本";
  case "core_unavailable": return "Rust 解析核心不可用，请重新构建或检查安装包";
  case "busy": return "解析任务已满，请稍后重试";
  default: return "来源暂时不可用，请稍后重试";
 }
}

export function searchDiagnosticSummary(diagnostics?: SearchDiagnostics): string {
 if (!diagnostics || diagnostics.status === "complete") return "";
 if (diagnostics.status === "not_configured") return "尚未配置片名搜索源，请到设置中心配置 PanSou、OpenList、MoviePilot 或 Telegram 频道。分享解析账号不能代替搜索源。";
 const failed = diagnostics.sources.filter((source) => source.status === "failed");
 const details = failed.map((source) => `${source.name}：${searchFailureMessage(source.code)}`).join("；");
 const summary = diagnostics.status === "partial" ? "部分来源未能完成搜索，本次结果不完整。" : "本次搜索未完成，暂时无法判断是否有资源。";
 return details ? `${summary}${details}` : summary;
}
