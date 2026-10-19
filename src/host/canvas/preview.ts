/**
 * preview：把节点上的生成结果解析成本机文件路径，供 agent 用 read_image 看图自评（v1.56）。
 *
 * 背景（2026-10-20「更智能的画布助手」P0 第三项）：
 *   生成完成后 agent 只能看到节点状态（status/参数），看不到画面 —— 无法判断手崩了、
 *   脸不像、构图空，只能等用户反馈。视觉回读要解决的就是「让它看见」。
 *
 * 怎么拿图：生成结果写在节点的 `resultUrl` / `resultUrls`（vendor canvasLocalWorkflows
 * 的 localWorkflowOutputNode 写这两个字段），值是媒体库 URL：
 *   /api/aifisher/canvas/media/<projectId>/<images|videos|audios>/<file>
 * host 的 mediaStore.localPathForUrl() 已经能把这种 URL（含 ?t= 缓存戳）解析成磁盘绝对路径。
 * 于是 preview 只负责：挑字段 → 去重 → 分类（file/remote/data/missing）→ 回给模型。
 *
 * 注意：图片用 read_image 打开；视频/音频没有等价的只读工具，只能给出路径，
 * 需要画面时走 media 动作截帧。preview 本身**不改画布**。
 */

export interface PreviewMedia {
  url: string;
  kind: 'file' | 'remote' | 'data' | 'missing';
  /** kind === 'file' 时的本机绝对路径。 */
  path?: string;
  /** file 时的媒体类型（images/videos/audios）。 */
  type?: string;
}

export interface PreviewNode {
  nodeId?: unknown;
  title?: unknown;
  type?: unknown;
  status?: unknown;
  media: PreviewMedia[];
}

export interface LocalMedia {
  path: string;
  type?: string;
}

/** 生成结果 URL 的来源字段（按优先级）。 */
const RESULT_URL_KEYS = ['resultUrl', 'resultUrls'] as const;

function urlList(node: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of RESULT_URL_KEYS) {
    const value = node[key];
    if (typeof value === 'string' && value) values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item) values.push(item);
    }
  }
  return [...new Set(values)];
}

export function collectPreviewFiles(
  nodes: readonly unknown[],
  resolveLocal: (url: string) => LocalMedia | null,
): PreviewNode[] {
  const out: PreviewNode[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const node = raw as Record<string, unknown>;
    const urls = urlList(node);
    if (urls.length === 0) continue;
    const media: PreviewMedia[] = urls.map((url) => {
      if (url.startsWith('data:')) {
        return { url: `${url.slice(0, 48)}…`, kind: 'data' };
      }
      const local = resolveLocal(url);
      if (local) {
        return {
          url,
          kind: 'file',
          path: local.path,
          ...(local.type ? { type: local.type } : {}),
        };
      }
      // 本插件媒体 URL 但文件不在 → missing；其余 http(s) 是远程结果（无法 read_image）。
      return /^https?:/i.test(url)
        ? { url, kind: 'remote' }
        : { url, kind: 'missing' };
    });
    out.push({
      nodeId: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      media,
    });
  }
  return out;
}
