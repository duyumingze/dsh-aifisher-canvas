/**
 * 工作流配图路由（v1.28）：`/api/aifisher/canvas/workflow-covers`
 *
 *   GET    /workflow-covers                        → { ok, dir, covers: { <工作流id>: {url, updatedAt, bytes, mime} } }
 *   POST   /workflow-covers/<工作流id>              → body `{ "dataUrl": "data:image/png;base64,..." }`
 *                                                   （也接受裸 data URL 字符串）→ { ok, id, cover }
 *   DELETE /workflow-covers/<工作流id>              → { ok, removed: boolean }
 *   GET    /workflow-covers/file/<文件名>           → 图片字节（带 cache-control，换图靠 ?v= 破缓存）
 *
 * 为什么是「上传一张图」而不是让用户填一个外部 URL：
 *   画布是本地单机工具，工作流面板里的配图要跟着本机数据走（删了工作流也不该留一堆
 *   指向外网随时会挂的链接）。落盘位置与索引见 host/comfyui/workflowCovers.ts。
 *
 * body 用 JSON + dataUrl（不是裸二进制）：这样前端一行 FileReader 就够，
 * 回归脚本也能用与浏览器完全相同的请求形状（jsdom 的 fetch 桩只认 JSON body）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../http/httpUtil';
import {
  WORKFLOW_COVER_MAX_BYTES,
  WorkflowCoverError,
  deleteWorkflowCover,
  listWorkflowCovers,
  readWorkflowCoverFile,
  saveWorkflowCover,
  workflowCoverUrl,
  workflowCoversDir,
} from '../comfyui/workflowCovers';

export interface WorkflowCoverRouteDeps {
  /** 画布数据目录（仅用于诊断输出：配图实际落点由 workflowCovers 自己按 DSH_HOME 解析） */
  dataDir?: string;
}

/** base64 之后大约膨胀 4/3，再留一点 JSON 包装的余量。 */
const COVER_BODY_LIMIT = Math.ceil((WORKFLOW_COVER_MAX_BYTES * 4) / 3) + 64 * 1024;

function coverJson(id: string) {
  const covers = listWorkflowCovers();
  const entry = covers[id];
  if (!entry) return null;
  return {
    id,
    url: workflowCoverUrl(id) ?? '',
    file: entry.file,
    mime: entry.mime,
    bytes: entry.bytes,
    updatedAt: entry.updatedAt,
  };
}

/** 处理 `/workflow-covers*`；不归它管的路径返回 false（调用方继续往下走）。 */
export async function handleWorkflowCoversApi(args: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
  deps?: WorkflowCoverRouteDeps;
}): Promise<boolean> {
  const { req, res, parts } = args;
  if (parts[0] !== 'workflow-covers') return false;
  const method = (req.method ?? 'GET').toUpperCase();

  // GET /workflow-covers/file/<文件名> —— 图片字节
  if (parts[1] === 'file' && parts.length >= 3) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    // 文件名可能被编码过（中文/空格），parts 已经是 decode 后的结果
    const name = parts.slice(2).join('/');
    const file = readWorkflowCoverFile(name);
    if (!file) {
      sendJson(res, 404, { error: '配图不存在（或已被删除）。', code: 'COVER_MISSING' });
      return true;
    }
    res.writeHead(200, {
      'content-type': file.mime,
      'content-length': file.bytes.length,
      // 文件名由工作流 id 决定（稳定），换图靠 URL 上的 ?v=<updatedAt> 破缓存
      'cache-control': 'private, max-age=31536000, immutable',
    });
    if (method === 'HEAD') res.end();
    else res.end(file.bytes);
    return true;
  }

  // GET /workflow-covers —— 全部配图
  if (parts.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const covers: Record<string, ReturnType<typeof coverJson>> = {};
    for (const id of Object.keys(listWorkflowCovers())) covers[id] = coverJson(id);
    sendJson(res, 200, {
      ok: true,
      dir: workflowCoversDir(),
      count: Object.keys(covers).length,
      covers,
    });
    return true;
  }

  // POST / DELETE /workflow-covers/<工作流id>
  if (parts.length === 2) {
    // parts 已经在 restRouter 的 segment() 里 decode 过，这里不能再解一次（id 里可能有 %）
    const id = parts[1];
    if (method === 'DELETE') {
      const removed = deleteWorkflowCover(id);
      sendJson(res, 200, { ok: true, id, removed });
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    const body = await readJsonBody(req, COVER_BODY_LIMIT);
    if (body === null) {
      sendJson(res, 413, {
        error: `配图请求体过大（上限 ${WORKFLOW_COVER_MAX_BYTES / 1024 / 1024} MB 的图片）。`,
        code: 'COVER_TOO_LARGE',
      });
      return true;
    }
    try {
      saveWorkflowCover(id, body);
      sendJson(res, 200, { ok: true, cover: coverJson(id) });
    } catch (error) {
      if (error instanceof WorkflowCoverError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return true;
      }
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '保存配图失败',
        code: 'COVER_SAVE_FAILED',
      });
    }
    return true;
  }

  sendJson(res, 404, { error: '未知的配图路径。', code: 'NOT_FOUND' });
  return true;
}
