/**
 * 数据目录设置接口（v1.43，host 半）。
 *
 *    GET    /api/aifisher/canvas/data-dir                      → 现状读数
 *    POST   /api/aifisher/canvas/data-dir  {directory, migrate} → 写入指针（重启 DSH 生效）
 *    DELETE /api/aifisher/canvas/data-dir                      → 回默认目录（同样要重启）
 *
 * 语义全在 `canvas/dataDir.ts` 的文件头里（指针文件放默认目录、重启生效、只复制不删旧目录）。
 * 这里只做「校验 → 复制 → 写指针 → 回读数」，**不**假装已经切过去了：`restartRequired`
 * 为 true 时前端必须照原样说「重启 DSH 生效」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../http/httpUtil';
import {
  clearDataDirPointer,
  copyDataDir,
  dataDirStatus,
  validateDataDirTarget,
  writeDataDirPointer,
} from './dataDir';

export interface DataDirApiInput {
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[];
  /** 这个进程现在实际在用的目录（index.ts 构造 store 时定下的那个）。 */
  activeDir: string;
}

/** 处理 `/data-dir`；已处理返回 true。 */
export async function handleDataDirApi(input: DataDirApiInput): Promise<boolean> {
  const { req, res, parts, activeDir } = input;
  if (parts[0] !== 'data-dir') return false;
  const method = (req.method ?? 'GET').toUpperCase();

  if (parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, dataDirStatus(activeDir));
      return true;
    }
    if (method === 'POST') {
      const body = (await readJsonBody(req, 16 * 1024)) as
        | { directory?: unknown; migrate?: unknown }
        | null;
      if (!body) {
        sendJson(res, 422, { error: '请求体无效。', code: 'DATA_DIR_BODY_INVALID' });
        return true;
      }
      const target = validateDataDirTarget(body.directory, activeDir);
      if (!target.ok) {
        sendJson(res, 422, { error: target.error, code: target.code });
        return true;
      }
      const migrate = body.migrate !== false; // 默认复制
      let migration: { copiedFiles: number; copiedBytes: number; skipped: number } | null = null;
      if (migrate) {
        try {
          const result = copyDataDir(activeDir, target.directory);
          migration = {
            copiedFiles: result.copiedFiles,
            copiedBytes: result.copiedBytes,
            skipped: result.skipped.length,
          };
        } catch (error) {
          sendJson(res, 500, {
            error: `把数据复制到新目录失败：${error instanceof Error ? error.message : String(error)}`,
            code: 'DATA_DIR_COPY_FAILED',
          });
          return true;
        }
      }
      writeDataDirPointer(target.directory);
      sendJson(res, 200, {
        status: 'pending-restart',
        restartRequired: true,
        migration,
        ...dataDirStatus(activeDir),
      });
      return true;
    }
    if (method === 'DELETE') {
      const removed = clearDataDirPointer();
      sendJson(res, 200, {
        status: 'pending-restart',
        restartRequired: true,
        removed,
        ...dataDirStatus(activeDir),
      });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  sendJson(res, 404, { error: '没有这个数据目录接口。', code: 'NOT_FOUND' });
  return true;
}
