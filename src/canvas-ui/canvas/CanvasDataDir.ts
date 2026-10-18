/**
 * 「项目数据目录」的数据面（v1.43）。
 *
 * 用户 2026-10-18 原话：「设置里添加项目自定义缓存目录」。
 *
 * 这里只做「跟 host 说话 + 把人话拼出来」：
 *   GET    /api/aifisher/canvas/data-dir                现状（当前在用 / 重启后会用的 / 是否等重启）
 *   POST   /api/aifisher/canvas/data-dir  {directory, migrate}
 *   DELETE /api/aifisher/canvas/data-dir                回默认目录
 *
 * ⚠️ host 的语义是「写指针 + 重启生效」（见 src/host/canvas/dataDir.ts 的文件头）：
 *    接口一定回 `restartRequired: true`，所以界面文案里**不许**出现「已切换」这种说法。
 */
export const DATA_DIR_API = '/api/aifisher/canvas/data-dir';

export interface DataDirStatus {
  active: string;
  pending: string;
  default: string;
  overridden: boolean;
  restartRequired: boolean;
  pointerFile: string;
  activeExists: boolean;
  pendingExists: boolean;
  canvasFile: string;
  mediaDir: string;
}

export interface DataDirApplyResult {
  status: DataDirStatus;
  message: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 当前状态 → 一行人话（面板读者一栏）。 */
export function dataDirStatusText(status: DataDirStatus | null): string {
  if (!status) return '正在读取…';
  if (status.restartRequired) {
    return `已改到新目录，但还没生效：重启一次 DSH 之后才会用 ${status.pending}。`;
  }
  if (status.overridden) {
    return '正在使用自定义目录（重启后会继续用它）。';
  }
  return '正在使用默认目录（DSH 数据目录下的 storages/dsh-aifisher-canvas）。';
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asStatus(data: Record<string, unknown>): DataDirStatus {
  return data as unknown as DataDirStatus;
}

function errorText(response: Response, data: Record<string, unknown>, fallback: string): string {
  if (response.status === 501 || data.code === 'NOT_PORTED') {
    return '当前 DSH 里跑的插件还是旧版 host：重启一次 DSH 之后这个设置才可用。';
  }
  if (typeof data.error === 'string' && data.error) return data.error;
  return fallback;
}

function readable(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

/** 读现状。 */
export async function fetchDataDirStatus(): Promise<DataDirStatus> {
  const response = await fetch(DATA_DIR_API, { headers: { Accept: 'application/json' } });
  const data = await readJson(response);
  if (!response.ok) throw new Error(errorText(response, data, `读取数据目录失败（HTTP ${response.status}）`));
  return asStatus(data);
}

/**
 * 应用新目录。
 *
 * `migrate` = 先把现有数据**复制**过去（纯复制、不删旧目录）。host 默认也复制，
 * 这里显式传，免得界面上那个勾选框变成摆设。
 */
export async function applyDataDir(
  directory: string,
  migrate: boolean,
): Promise<DataDirApplyResult> {
  const value = String(directory ?? '').trim();
  if (!value) throw new Error('请填一个目录的绝对路径。');
  let response: Response;
  try {
    response = await fetch(DATA_DIR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: value, migrate: migrate !== false }),
    });
  } catch (error) {
    throw readable(error, '请求没发出去（DSH 没在跑？）。');
  }
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(errorText(response, data, `应用数据目录失败（HTTP ${response.status}）`));
  }
  const status = asStatus(data);
  const migration = data.migration as
    | { copiedFiles?: number; copiedBytes?: number; skipped?: number }
    | null
    | undefined;
  const copied = migration
    ? `已复制 ${migration.copiedFiles ?? 0} 个文件（${formatBytes(Number(migration.copiedBytes ?? 0))}）到新目录` +
      (Number(migration.skipped ?? 0) > 0 ? `，${migration.skipped} 个同名文件已存在、跳过` : '')
    : '没有复制旧数据（新目录会是空的）';
  return {
    status,
    message: `${copied}。重启一次 DSH 之后才会在新目录读写。`,
  };
}

/** 回默认目录。 */
export async function resetDataDir(): Promise<DataDirApplyResult> {
  const response = await fetch(DATA_DIR_API, { method: 'DELETE' });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(errorText(response, data, `恢复默认目录失败（HTTP ${response.status}）`));
  }
  const status = asStatus(data);
  return {
    status,
    message: '已恢复默认目录。重启一次 DSH 之后生效（旧的自定义目录不会被删）。',
  };
}
