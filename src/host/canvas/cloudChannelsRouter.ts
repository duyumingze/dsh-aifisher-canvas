/**
 * 「云端 OpenAI 通道」设置接口（host 半，画布设置 → 闭源服务 → 多通道面板用）。
 *
 *   GET  /api/aifisher/canvas/cloud-channels              通道表（**不含密钥**）
 *   POST /api/aifisher/canvas/cloud-channels  {action:'save',   channel}   新增/更新通道
 *   POST /api/aifisher/canvas/cloud-channels  {action:'delete', id}        删除通道
 *   POST /api/aifisher/canvas/cloud-channels  {action:'probe',  baseUrl, apiKey?, id?}
 *                                                        读 `GET {baseUrl}/models`，供界面多选模型
 *
 * v1.13 起没有 `importLegacy`：旧版单端点（`AIFISHER_CLOUD_BASE_URL` 那张设置卡片）已整体移除，
 * 没有可收编的「隐式通道」了。
 *
 * 三条约定：
 *   - 密钥**只进不出**：GET 只回 `apiKeySet: boolean`；save 时 apiKey 缺省 = 保持旧值，空串 = 清除；
 *   - 探测时若请求体没带 apiKey，用通道里已存的（这样「保存后点读模型」不用重新粘贴密钥）；
 *   - 每次写盘后返回**整张表**，界面直接拿它重画，不需要再 GET 一次（避免两份状态打架）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '../http/httpUtil';
import {
  CHANNEL_KINDS,
  DEFAULT_PATHS,
  ChannelRequestError,
  channelIdFromLabel,
  probeChannelModels,
  publicChannel,
  readCloudChannels,
  sanitizeChannel,
  writeCloudChannels,
  type CloudChannel,
} from '../generation/cloudChannels';

export interface CloudChannelsDeps {
  dataDir: string;
  /** 探测时注入 fetcher（测试用）。 */
  fetcher?: typeof fetch;
}

const MAX_BODY_BYTES = 512 * 1024;

function listPayload(channels: readonly CloudChannel[]) {
  return {
    success: true,
    channels: channels.map(publicChannel),
    kinds: [...CHANNEL_KINDS],
    defaults: DEFAULT_PATHS,
  };
}

export async function handleCloudChannelsApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[];
  deps: CloudChannelsDeps;
}): Promise<boolean> {
  const { req, res, parts, deps } = input;
  if (parts[0] !== 'cloud-channels' || parts.length !== 1) return false;
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET') {
    sendJson(res, 200, listPayload(await readCloudChannels(deps.dataDir)));
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const body = (await readJsonBody(req, MAX_BODY_BYTES)) as Record<string, unknown> | null;
  if (!body) {
    sendJson(res, 422, { error: '请求体不是合法 JSON。', code: 'INVALID_BODY' });
    return true;
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const channels = await readCloudChannels(deps.dataDir);

  if (action === 'save') {
    const incoming = (body.channel ?? {}) as Record<string, unknown>;
    const rawId = typeof incoming.id === 'string' ? incoming.id.trim().toLowerCase() : '';
    const existing = rawId ? channels.find((channel) => channel.id === rawId) : undefined;
    const id =
      existing?.id ??
      (rawId || channelIdFromLabel(String(incoming.label ?? incoming.baseUrl ?? ''), channels.map((c) => c.id)));
    const result = sanitizeChannel({ ...incoming, id }, existing);
    if ('error' in result) {
      sendJson(res, 422, { error: result.error, code: result.code });
      return true;
    }
    const others = channels.filter((channel) => channel.id !== result.channel.id);
    const next = [...others, result.channel].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    await writeCloudChannels(deps.dataDir, next);
    sendJson(res, 200, listPayload(next));
    return true;
  }

  if (action === 'delete') {
    const id = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const next = channels.filter((channel) => channel.id !== id);
    if (next.length === channels.length) {
      sendJson(res, 404, { error: `没有这条通道：${id || '(空)'}`, code: 'CHANNEL_NOT_FOUND' });
      return true;
    }
    await writeCloudChannels(deps.dataDir, next);
    sendJson(res, 200, listPayload(next));
    return true;
  }

  if (action === 'probe') {
    const rawId = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
    const stored = rawId ? channels.find((channel) => channel.id === rawId) : undefined;
    const baseUrl =
      (typeof body.baseUrl === 'string' && body.baseUrl.trim()) || stored?.baseUrl || '';
    const apiKey =
      typeof body.apiKey === 'string' && body.apiKey.trim()
        ? body.apiKey.trim()
        : stored?.apiKey ?? '';
    try {
      const result = await probeChannelModels({
        baseUrl,
        apiKey,
        ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
      });
      sendJson(res, 200, { success: true, ...result, apiKeyUsed: Boolean(apiKey) });
    } catch (error) {
      if (error instanceof ChannelRequestError) {
        sendJson(res, error.status, {
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
        });
        return true;
      }
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : '读取模型清单失败。',
        code: 'CHANNEL_MODELS_FAILED',
      });
    }
    return true;
  }

  sendJson(res, 422, {
    error: `未知操作：${action || '(空)'}`,
    code: 'CHANNEL_ACTION_UNKNOWN',
  });
  return true;
}
