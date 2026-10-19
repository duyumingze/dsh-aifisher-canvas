/**
 * 画布节点 @ 引用（client 半，v1.51）。
 *
 * 用户原话（2026-10-19）：「能不能加一个我能在对话去@画布内的素材，文本、图像等」。
 *
 * DSH 的 composer 本身就有 `@` 触发流水线（`@deepseek-ai/dsh-client-ui-input-trigger`）：
 * 光标处键入 @ 会打开分组候选菜单，pick 之后由输入机插入一个**原子行内引用**；
 * 发送时输入机调 `inputTriggers.serializeReference(source, ref)`，把引用换成模型可见文本
 * （文件/会话那条链就是这么工作的，见 `@deepseek-ai/dsh-client-ui-reference`）。
 *
 * 这里注册第三个 `@` source（trigger `@`、name `aifisher-node`）：
 *   - 候选 = 当前打开的画布项目里的节点（标题 / 类型 / 正文预览），数据从本地后端
 *     `GET /api/aifisher/canvas/workflows/:id` 取（画布自动保存，读到的就是画布上那一份）；
 *   - pick 插入的引用序列化成 `@[标题](aifisher-node:节点id)`；
 *   - 宿主半（src/host/canvas/nodeReferences.ts）在 `agent/pre-step` 里把 mention 展开成
 *     一条只读的节点快照，模型不用先 read 一轮就知道用户指的是哪个节点、里面写了什么。
 *
 * 三条刻意选择：
 *   1. **项目 id 从画布自己的 resume 状态读**（`window.__FISHERAI_CANVAS_SESSION__.load()`），
 *      不另存一份；再用 `#canvas-background` 判断「画布视图真的开着」——项目库视图里
 *      resume 状态还是上一个项目，照它列候选会列错。
 *   2. **appearance 不给**：芯片会渲染成「@ + 标题」的中性 chip。DSH 的 appearance 枚举
 *      只有 session/file/folder 三种，画布节点不属于任何一种，硬塞一个会给错图标。
 *   3. **userText 规则 order=5**（比 session 的 10、file 的 30 小）：`@[标题](aifisher-node:…)`
 *      里也含 `@...`，不改顺序的话会被 file 规则的 `@path` 语法抢先匹配成文件引用。
 *
 * 全部 fail-open：拿不到 inputTriggers / uiConversation / 画布没开 / 接口失败 → 安静地
 * 少一组候选，画布与对话照常工作。
 */
import * as React from 'react';

/** 本 source 的名字；同时是 insert.source 与 userText 规则的 id。 */
export const CANVAS_NODE_SOURCE = 'aifisher-node';

/** 模型可见的 mention 语法（host 半按同一语法解析）。 */
export function formatNodeMention(label: string, id: string): string {
  return `@[${label}](aifisher-node:${id})`;
}

/** 标题进 mention 前的清洗：方括号/换行会把语法打断，长度也有上限。 */
export function mentionLabel(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const flat = raw.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length === 0 ? '画布节点' : flat.slice(0, 80);
}

const NODE_TYPE_LABEL: Record<string, string> = {
  Text: '文本',
  Image: '图像',
  Video: '视频',
  Audio: '音频',
  'Upload Image': '图像',
  ComfyUI: '工作流',
};

interface CanvasReferenceNode {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  textContent?: unknown;
  prompt?: unknown;
  resultUrl?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface CanvasReferenceDocument {
  id?: unknown;
  title?: unknown;
  nodes?: unknown;
}

/** 一行候选（input-trigger 的 MenuView 读 name/description/section/value）。 */
export interface CanvasNodeCandidate {
  name: string;
  description?: string;
  section?: string;
  value: string;
}

function nodeTypeLabel(type: string): string {
  return NODE_TYPE_LABEL[type] ?? (type || '节点');
}

function plainPreview(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 把一份项目文档投影成候选行。
 *
 * 纯函数（不碰 DOM/网络），排序与过滤都写死在这里：
 *   文本节点优先（@ 一个文本节点是最常见的用法），其余按画布上的 y/x 顺序。
 */
export function buildCanvasNodeCandidates(
  document: CanvasReferenceDocument | null | undefined,
  query: string,
): CanvasNodeCandidate[] {
  const nodes = Array.isArray(document?.nodes)
    ? (document!.nodes as CanvasReferenceNode[]).filter(
        (node): node is CanvasReferenceNode & { id: string } =>
          Boolean(node) && typeof node.id === 'string' && node.id.length > 0,
      )
    : [];
  const needle = query.trim().toLowerCase();
  const rows: Array<{ candidate: CanvasNodeCandidate; text: boolean; y: number; x: number }> = [];
  for (const node of nodes) {
    const type = typeof node.type === 'string' ? node.type : 'Node';
    const label = mentionLabel(node.title);
    const body = type === 'Text' ? (node.textContent ?? node.prompt) : undefined;
    if (needle) {
      const haystack = [String(node.title ?? ''), type, nodeTypeLabel(type), String(body ?? '')]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    const preview =
      type === 'Text'
        ? plainPreview(body, 36)
        : typeof node.resultUrl === 'string' && node.resultUrl
          ? '已有结果'
          : '空节点';
    rows.push({
      text: type === 'Text',
      y: Number(node.y) || 0,
      x: Number(node.x) || 0,
      candidate: {
        name: label,
        description: `${nodeTypeLabel(type)}${preview ? ` · ${preview}` : ''}`,
        section: '画布节点',
        value: JSON.stringify({ id: node.id, label }),
      },
    });
  }
  rows.sort(
    (left, right) =>
      Number(right.text) - Number(left.text) || left.y - right.y || left.x - right.x,
  );
  return rows.slice(0, 50).map((row) => row.candidate);
}

/** 画布当前打开的项目 id（画布自己把 resume 状态存进 sessionStorage）。 */
function currentCanvasProjectId(): string | undefined {
  try {
    const holder = window as unknown as {
      __FISHERAI_CANVAS_SESSION__?: { load?: () => { workflowId?: unknown } | null };
    };
    const state = holder.__FISHERAI_CANVAS_SESSION__?.load?.();
    return typeof state?.workflowId === 'string' && state.workflowId ? state.workflowId : undefined;
  } catch {
    return undefined;
  }
}

/** 画布视图是否真的开着（项目库视图里没有 #canvas-background）。 */
function canvasViewOpen(): boolean {
  try {
    return Boolean(document.getElementById('canvas-background'));
  } catch {
    return false;
  }
}

async function fetchCanvasDocument(
  projectId: string,
  signal?: AbortSignal,
): Promise<CanvasReferenceDocument | null> {
  try {
    const response = await fetch(
      `/api/aifisher/canvas/workflows/${encodeURIComponent(projectId)}`,
      {
        signal,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as CanvasReferenceDocument) : null;
  } catch {
    return null;
  }
}

/** 把画布节点聚焦到视口中心（画布应用挂了这个桥；没挂就当没点）。 */
function focusCanvasNode(id: string): void {
  try {
    const holder = window as unknown as { __FISHERAI_FOCUS_NODES__?: (ids: string[]) => void };
    holder.__FISHERAI_FOCUS_NODES__?.([id]);
  } catch {
    /* 聚焦只是贴心，失败不影响引用 */
  }
}

function parseCandidateValue(value: unknown): { id: string; label: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as { id?: unknown; label?: unknown };
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    return { id: parsed.id, label: mentionLabel(parsed.label) };
  } catch {
    return null;
  }
}

function parseMentionId(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const match = /\(aifisher-node:([0-9A-Za-z-]{1,64})\)$/.exec(ref);
  return match ? match[1] : null;
}

/**
 * 列出当前画布项目里的候选（`@` 菜单与排查入口共用）。
 */
async function listCanvasNodeCandidates(
  query: string,
  signal?: AbortSignal,
): Promise<CanvasNodeCandidate[]> {
  if (!canvasViewOpen()) return [];
  const projectId = currentCanvasProjectId();
  if (!projectId) return [];
  const document = await fetchCanvasDocument(projectId, signal);
  return buildCanvasNodeCandidates(document, query);
}

/**
 * `@` source 本体。
 *
 * 只依赖标准 DOM/fetch：不在 DSH 的模块表里要任何额外包（client 半的产物只能要 `react`）。
 */
export function createCanvasNodeTriggerSource() {
  return {
    trigger: '@',
    name: CANVAS_NODE_SOURCE,
    order: 20,
    showGroupTitle: false,
    async candidates(
      _session: unknown,
      request: { query?: unknown; signal?: AbortSignal } | undefined,
    ): Promise<CanvasNodeCandidate[]> {
      return listCanvasNodeCandidates(String(request?.query ?? ''), request?.signal);
    },
    onPick({ candidate }: { candidate?: { value?: unknown } }) {
      const parsed = parseCandidateValue(candidate?.value);
      if (!parsed) return undefined;
      const mention = formatNodeMention(parsed.label, parsed.id);
      return {
        insert: {
          source: CANVAS_NODE_SOURCE,
          ref: mention,
          label: parsed.label,
          // appearance 刻意不给：见文件头的第 2 条。
          clipboardText: mention,
        },
      };
    },
    /** 点输入框里的引用 = 把那个节点聚焦到画布中央。 */
    openReference(_session: unknown, reference: { ref?: unknown }): boolean {
      const id = parseMentionId(reference?.ref);
      if (!id) return false;
      focusCanvasNode(id);
      return true;
    },
    codec: {
      clipboardText: (ref: string) => ref,
      serialize: (ref: string) => Promise.resolve(ref),
    },
  };
}

/**
 * 已发送消息里的引用渲染（`conversation.user.text.node` 槽位，key = aifisher-node）。
 *
 * 不引 ui-primitives 的 ReferenceChip（client 半没有那个依赖），自己画一个同尺寸的
 * 中性 chip：`@ 标题`。可交互时点一下 = 聚焦回画布上的节点。
 */
export function CanvasNodeReferenceChip(props: {
  node?: { data?: { id?: unknown; label?: unknown } };
  raw?: string;
  interactive?: boolean;
}) {
  const id = typeof props.node?.data?.id === 'string' ? props.node.data.id : '';
  const label = mentionLabel(props.node?.data?.label);
  return React.createElement(
    'span',
    {
      'data-aifisher-node-ref': id,
      title: typeof props.raw === 'string' ? props.raw : label,
      onClick: props.interactive && id ? () => focusCanvasNode(id) : undefined,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        maxWidth: 260,
        margin: '0 2px',
        padding: '0 6px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14))',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.06))',
        color: 'var(--dsw-alias-label-primary, #e7e9ee)',
        font: 'inherit',
        lineHeight: '1.5',
        verticalAlign: 'baseline',
        cursor: props.interactive && id ? 'pointer' : 'default',
      },
    },
    React.createElement('span', { 'aria-hidden': true, style: { opacity: 0.7 } }, '@'),
    React.createElement(
      'span',
      { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      label,
    ),
  );
}

/** 已发送文本里的 mention → chip（order 5，压过 file 的 @path 规则，见文件头第 3 条）。 */
export const CANVAS_NODE_USER_TEXT_RULE = {
  id: CANVAS_NODE_SOURCE,
  order: 5,
  match(text: string, from: number) {
    const pattern = /@\[([^\]\n]{1,200})\]\(aifisher-node:([0-9A-Za-z-]{1,64})\)/uy;
    for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
      pattern.lastIndex = start;
      const match = pattern.exec(text);
      if (!match) continue;
      return {
        id: CANVAS_NODE_SOURCE,
        start,
        end: start + match[0].length,
        data: { id: match[2], label: mentionLabel(match[1]) },
      };
    }
    return undefined;
  },
};

interface TriggerService {
  registerSource?: (source: unknown) => unknown;
}

interface UserTextService {
  userText?: { register?: (rule: unknown) => unknown };
}

function readService(holder: unknown, name: string): unknown {
  const target = holder as { get?: (service: string) => unknown } | undefined;
  if (typeof target?.get === 'function') {
    try {
      const value = target.get(name);
      if (value !== undefined) return value;
    } catch {
      /* 未注入的服务读不到：按没有处理 */
    }
  }
  try {
    return (target as Record<string, unknown> | undefined)?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 把 source / userText 规则挂到宿主（在 client apply 里调用）。
 *
 * 用 `ctx.inject` 等这两个服务就绪再挂，而不是写进本插件的 inject 数组：
 * 那两个服务缺失时应该只少一组 @ 候选，不该让整个 client 半启动失败（画布面板消失）。
 */
export function installCanvasNodeReferences(ctx: unknown): void {
  const context = ctx as {
    inject?: (deps: string[], callback: (sub: unknown) => unknown) => unknown;
  };
  if (typeof context.inject !== 'function') return;
  const holder = window as unknown as {
    __DSH_CANVAS_NODE_REFS__?: {
      installed: boolean;
      at: number;
      triggerRegistered: boolean;
      userTextRegistered: boolean;
      probe: () => { canvasOpen: boolean; projectId: string | null };
      candidates: (query?: string) => Promise<CanvasNodeCandidate[]>;
    };
  };
  // 排查入口（与 __FISHERAI_* 那套同一习惯）：真机上「@ 里没有画布节点」时先看这里。
  const diagnostics = {
    installed: true,
    at: Date.now(),
    triggerRegistered: false,
    userTextRegistered: false,
    probe: () => ({
      canvasOpen: canvasViewOpen(),
      projectId: currentCanvasProjectId() ?? null,
    }),
    candidates: (query = '') => listCanvasNodeCandidates(query),
  };
  holder.__DSH_CANVAS_NODE_REFS__ = diagnostics;
  try {
    context.inject(['inputTriggers'], (sub) => {
      const service = readService(sub, 'inputTriggers') as TriggerService | undefined;
      if (!service || typeof service.registerSource !== 'function') return undefined;
      const disposer = service.registerSource(createCanvasNodeTriggerSource());
      diagnostics.triggerRegistered = true;
      return disposer;
    });
  } catch (error) {
    console.warn('[aifisher-canvas] 注册 @画布节点 候选来源失败：', error);
  }
  try {
    context.inject(['uiConversation'], (sub) => {
      const service = readService(sub, 'uiConversation') as UserTextService | undefined;
      const disposer = service?.userText?.register?.(CANVAS_NODE_USER_TEXT_RULE);
      if (typeof disposer === 'function' || disposer !== undefined) {
        diagnostics.userTextRegistered = true;
      }
      return disposer;
    });
  } catch (error) {
    console.warn('[aifisher-canvas] 注册 @画布节点 消息渲染规则失败：', error);
  }
}
