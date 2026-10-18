/**
 * 画布 host 端诊断日志（内存环形缓冲）。
 *
 * 用途：画布应用跑在浏览器里，我（agent）看不到控制台。所以 client 半把
 * window.onerror / unhandledrejection / React 错误边界的报错 POST 到
 * /api/aifisher/canvas/diagnostics，这里存最后 N 条，GET 同一个端点就能读出来。
 * 纯排查设施，不落盘。
 */
export interface DiagnosticEntry {
  at: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  detail?: unknown;
}

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];

export function pushDiagnostic(
  entry: Omit<DiagnosticEntry, 'at'> & { at?: string },
): DiagnosticEntry {
  const record: DiagnosticEntry = {
    at: entry.at ?? new Date().toISOString(),
    level: entry.level ?? 'error',
    message: String(entry.message ?? '').slice(0, 4000),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  };
  entries.push(record);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return record;
}

export function readDiagnostics(limit = 50): DiagnosticEntry[] {
  return entries.slice(-limit);
}

export function clearDiagnostics(): void {
  entries.length = 0;
}
