/**
 * 合成器 → 主画布的接缝。
 *
 * 三条约束决定了这里怎么做：
 *   1. **不新增 host 接口**：`POST /media/images/annotation` 本来就是「dataURL 落盘」，
 *      合成结果用的就是它（返回 asset.url，和标注功能同一条路）；
 *   2. **写回走节点卡片自己的 `onUpdate`**：vendor 的 `updateCanvasNode` 是
 *      `{...original, ...patch}`，任意字段都能落盘，所以 `resultUrl` / `compositorGraph`
 *      不需要新桥；
 *   3. **vendor 侧只认 window 桥**：节点卡片调 `__FISHERAI_COMPOSITOR__.open(...)`，
 *      不 import src 的模块 —— 上游 vendor 若哪天被单独打包也不会断。
 */

import type { CompositorGraph, CompositorInputImage } from './graph';
import { closeCompositorEditor, compositorReport, isCompositorOpen, openCompositorEditor } from './editor';

export interface CompositorNodeSavePayload {
  resultUrl: string;
  graph: CompositorGraph;
}

export interface OpenCompositorNodeOptions {
  nodeId: string;
  projectId?: string;
  title?: string;
  images: CompositorInputImage[];
  graph?: unknown;
  onSave: (payload: CompositorNodeSavePayload) => void | Promise<void>;
}

interface CompositorBridge {
  open(options: OpenCompositorNodeOptions): void;
  close(): void;
  isOpen(): boolean;
  report(): Record<string, unknown>;
}

/** 画布当前项目 id：节点上都带 projectId，这里是兜底（桥被直接调时用）。 */
function currentProjectId(): string | null {
  try {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_SESSION__?: { load?: () => { workflowId?: unknown } };
    };
    const loaded = holder.__FISHERAI_CANVAS_SESSION__?.load?.();
    return typeof loaded?.workflowId === 'string' && loaded.workflowId ? loaded.workflowId : null;
  } catch {
    return null;
  }
}

/**
 * dataURL 落进项目媒体库，返回可直接给画布用的素材 URL。
 *
 * 为什么走 annotation 而不是新开一个 upload 路由：上游那条「标注」在服务端就是
 * 「base64 解码 → 写 images/<file> → 记 asset」，跟我们需要的语义完全一样；
 * 多开一个路由只会让 host 的媒体接口面再宽一寸。
 */
export async function uploadCompositorDataUrl(projectId: string, dataUrl: string): Promise<string> {
  const response = await fetch('/api/aifisher/canvas/media/images/annotation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, dataUrl, mode: 'draw' }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? String((body as { error: string }).error)
        : `保存合成结果失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  const url =
    body && typeof body === 'object'
      ? (body as { asset?: { url?: unknown } }).asset?.url
      : undefined;
  if (typeof url !== 'string' || !url) throw new Error('保存合成结果失败：服务端没有返回素材地址。');
  return url;
}

/**
 * 打开某个调色节点的合成器。
 * 「应用」= 导出 PNG → 落媒体库 → 通过节点的 onUpdate 写回 resultUrl + compositorGraph。
 */
export function openCompositorForNode(options: OpenCompositorNodeOptions): void {
  const projectId = options.projectId || currentProjectId() || 'default';
  const images = options.images.filter((image) => typeof image.url === 'string' && image.url.length > 0);
  openCompositorEditor({
    nodeId: options.nodeId,
    title: options.title,
    images,
    graph: options.graph,
    onApply: async ({ graph, dataUrl }) => {
      const resultUrl = await uploadCompositorDataUrl(projectId, dataUrl);
      await options.onSave({ resultUrl, graph });
    },
  });
}

/** 挂到 window 上的桥；vendor 节点卡片只认这个入口。 */
export function installCompositorBridge(): { dispose: () => void } {
  const holder = window as unknown as { __FISHERAI_COMPOSITOR__?: CompositorBridge };
  const previous = holder.__FISHERAI_COMPOSITOR__;
  const bridge: CompositorBridge = {
    open: openCompositorForNode,
    close: closeCompositorEditor,
    isOpen: isCompositorOpen,
    report: compositorReport,
  };
  holder.__FISHERAI_COMPOSITOR__ = bridge;
  // 版本戳：排查「刷了没生效」时先看控制台这一行（画布产物是浏览器内存里的旧模块，
  // Ctrl+F5 才会重新 import）。有它就不必再猜是缓存还是没构建。
  try {
    console.info(
      '[dsh-aifisher-canvas] v1.79 · 调色合成器已就绪（顶栏已让出系统标题栏；Shift+A 可打字搜节点；混合节点三输入 A/B/系数）',
    );
  } catch {
    // 控制台不可用不影响功能
  }
  return {
    dispose() {
      if (holder.__FISHERAI_COMPOSITOR__ !== bridge) return;
      if (previous) holder.__FISHERAI_COMPOSITOR__ = previous;
      else delete holder.__FISHERAI_COMPOSITOR__;
    },
  };
}
