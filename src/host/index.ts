/**
 * Host 半（Node 端）
 *
 * 装配：
 *  1. ComfyUI 客户端 + 工作流路由
 *  2. 插件 public/ 静态资源托管（/creative-presets, /mj-styles）
 *  3. canvas_control 工具（DSH agent 操控画布）
 *
 * 历史上还有一块「AIFISHER 账号会话（identity session）+ /api/aifisher/account/* 路由」，
 * 2026-10-16 全量移除：它连的是 identity.work-fisher.com（官方客户端那套身份账号），
 * 与用户实际持有的 api.work-fisher.com（FisherAI 接口站）账号是两套体系，登不进去只添乱，
 * 而插件里没有任何功能依赖它（余额/中继都没移植）。云端模型调用只认 API Key。
 *
 * DSH webServer 是 node:http 原生路由（不是 Express）：
 *   ctx.webServer.register({ kind: 'prefix'|'exact', path, handler })
 * handler 直接吃 IncomingMessage / ServerResponse。
 */
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { createComfyClient } from './comfyui/comfyClient';
import { attachComfyRoutes, createComfyDelegate } from './comfyui/comfyRouter';
import { createGenerationJournal } from './comfyui/generationJournal';
import { createModelResolver } from './comfyui/modelResolver';
import { createGenerationEvents } from './canvas/generationEvents';
import { createGenerationPlans } from './canvas/generationPlans';
import { createGenerationPush } from './canvas/generationPush';
import { attachStaticAssets } from './staticAssets';
import { attachSkillsRoutes, createSkillsCatalog, type DshSkillsService } from './skills/skillsRouter';
import { createCanvasStore } from './canvas/store';
import { createMediaStore } from './canvas/mediaStore';
import { attachCanvasApi } from './canvas/restRouter';
import { applySavedCloudKeys } from './canvas/sourceSettingsRouter';
import { createCanvasBridge } from './canvas/agentBridge';
import { createAgentChatStore } from './canvas/agentChatStore';
import { createCanvasChatHub, type CanvasActionNote } from './canvas/canvasChatHub';
import { buildCanvasNodeSnapshot, messageText, parseCanvasNodeMentions } from './canvas/nodeReferences';
import { buildCanvasCommand, type CanvasToolArgs } from './canvas/commandMapping';
import { placeCreateOperations, type CanvasPlacementNode } from './canvas/nodePlacement';
import { buildShotListRecipe } from './canvas/recipe';
import { collectPreviewFiles } from './canvas/preview';
import { summarizeCanvasRead } from './canvas/readSummary';
import { createProjectMemory, type ProjectMemoryBlock } from './canvas/projectMemory';
import { createAssetLibrary } from './canvas/assetLibrary';
import { compileIntent } from './canvas/intent';
import { planPromptFixes, reviewCanvas } from './canvas/review';
import { planCrew, receiveCrew } from './canvas/crew';
import { createCanvasJobs } from './canvas/canvasJob';
import { createCanvasNoticeQueue } from './canvas/noticeQueue';
import {
  buildCopilotSuggestions,
  copilotSummary,
  type CopilotSuggestion,
} from './canvas/copilot';
import {
  coverageReport,
  planLockOperations,
  planUnlockOperations,
  type AnchorInput,
} from './canvas/consistency';
import type { WebServerLike } from './http/httpUtil';
import { dirname, join } from 'node:path';

export const name = 'dsh-aifisher-canvas';
export const inject = ['tools', 'webServer', 'skills'];

/**
 * 工具输出的 JSON 值类型。直接从 dsh-tools 的 `ToolDefinition.output.render`
 * 第二参取，别手写一份 JsonValue（会跟上游漂移）。
 */
type ToolJson = Parameters<ToolDefinition['output']['render']>[1];

interface PreStepMessage {
  id?: string;
  role?: string;
  source?: { kind?: string; form?: string; summary?: string };
  content?: unknown;
}

interface PreStepDecision {
  kind?: string;
  messages?: PreStepMessage[];
}

/**
 * 画布助手会话的「上下文提示」注入（只在会话第一回合插一条）。
 *
 * 为什么不用「把提示拼进用户消息」：那样每条消息都会带着一段脚手架，用户在自己会话里
 * 翻历史也看得见。DSH 的 `agent/pre-step` 瀑布给了插件在提交前改消息列表的位置，
 * 形状与 meow-memory 的记忆注入一致（消息对象 = {id, role, content:[{type:'text',text}], source}），
 * 那边是生产在跑的写法。这里全程 fail-open：任何异常都原样返回宿主给的决定。
 */
function installCanvasChatInstructions(ctx: Context, hub: ReturnType<typeof createCanvasChatHub>): void {
  try {
    const on = (ctx as unknown as {
      on(
        name: string,
        listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): unknown;
    }).on;
    if (typeof on !== 'function') return;
    on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as PreStepDecision | undefined;
      try {
        const sessionId = (payload as { agent?: { session?: { header?: { id?: unknown } } } })?.agent
          ?.session?.header?.id;
        if (typeof sessionId !== 'string' || !hub.isCanvasSession(sessionId)) return decision;
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
        const text = hub.takeInstructions(sessionId);
        if (!text || decision.messages.length === 0) return decision;
        const messages = [...decision.messages];
        let index = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.source?.kind === 'user') {
            index = i;
            break;
          }
        }
        messages.splice(index < 0 ? messages.length : index, 0, {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-aifisher-canvas', form: 'notice', summary: '画布助手上下文' },
        });
        return { ...decision, messages };
      } catch (error) {
        ctx.logger?.warn?.(
          `[aifisher-canvas] 画布助手上下文注入失败（已放行原始消息）：${error instanceof Error ? error.message : String(error)}`,
        );
        return decision;
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[aifisher-canvas] agent/pre-step 事件不可用，画布对话不注入上下文提示：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 画布节点 @ 引用（v1.51）：把本次提交里的 `@[标题](aifisher-node:<id>)` 展开成只读快照。
 *
 * 与上面「画布助手上下文」同一个挂点，但不限会话：任何会话里 @ 了画布节点都会展开
 * （用户在主区域聊天里 @ 也一样）。快照插在提到它的那条用户消息**后面**，原始消息不动。
 * 全程 fail-open：拿不到 store 里的节点（被删了）就原样放行。
 */
function installCanvasNodeReferences(
  ctx: Context,
  store: ReturnType<typeof createCanvasStore>,
): void {
  try {
    const on = (ctx as unknown as {
      on(
        name: string,
        listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): unknown;
    }).on;
    if (typeof on !== 'function') return;
    /**
     * 已经展开过的用户消息 id。
     *
     * 为什么需要：pre-step 可能对同一条消息进入多次（宿主重试/后续步骤），而快照是**追加**
     * 一条消息 —— 不做去重的话同一份节点上下文会重复进历史。只记 id，不记内容，200 条封顶。
     */
    const injectedMessages = new Set<string>();
    on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as PreStepDecision | undefined;
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision;
        }
        let index = -1;
        const mentions: Array<{ id: string; label: string }> = [];
        for (let i = decision.messages.length - 1; i >= 0; i -= 1) {
          const message = decision.messages[i];
          if (message?.source?.kind !== 'user') continue;
          const found = parseCanvasNodeMentions(messageText(message));
          if (found.length === 0) continue;
          index = i;
          mentions.push(...found);
          break;
        }
        if (index < 0 || mentions.length === 0) return decision;
        const sessionId = (payload as { agent?: { session?: { header?: { id?: unknown } } } })
          ?.agent?.session?.header?.id;
        const messageId = decision.messages[index]?.id;
        const dedupeKey =
          typeof sessionId === 'string' && typeof messageId === 'string'
            ? `${sessionId}:${messageId}`
            : '';
        if (dedupeKey && injectedMessages.has(dedupeKey)) return decision;
        const snapshot = buildCanvasNodeSnapshot(store, mentions);
        if (!snapshot) return decision;
        const messages = [...decision.messages];
        messages.splice(index + 1, 0, {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: snapshot }],
          source: {
            kind: 'plugin:dsh-aifisher-canvas',
            form: 'notice',
            summary: '画布节点引用',
          },
        });
        if (dedupeKey) {
          injectedMessages.add(dedupeKey);
          if (injectedMessages.size > 200) {
            injectedMessages.delete(injectedMessages.values().next().value as string);
          }
        }
        return { ...decision, messages };
      } catch (error) {
        ctx.logger?.warn?.(
          `[aifisher-canvas] @画布节点 快照注入失败（已放行原始消息）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return decision;
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[aifisher-canvas] agent/pre-step 事件不可用，@画布节点 不会展开成上下文：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 生成事件推送的**兜底入口**（v1.57）。
 *
 * 正常路径是 generationPush 直接往会话投一条消息（用户当场就能在面板里看到）。
 * 但有些时候投不出去：宿主没有 sessionController、会话已归档、prompt 抛错 —— 那时事件
 * 会留在推送层的队列里。这里在会话**下一次真正开始一回合**时把它们补给它，
 * 于是最坏情况也只是「晚一轮知道」，而不是静默吞掉。
 *
 * 只消费一次（takePendingText 取走即删），不会和主动推送重复。
 */
function installGenerationEventNotices(
  ctx: Context,
  push: ReturnType<typeof createGenerationPush>,
): void {
  try {
    const on = (ctx as unknown as {
      on(
        name: string,
        listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): unknown;
    }).on;
    if (typeof on !== 'function') return;
    on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as PreStepDecision | undefined;
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision;
        }
        const agent = (payload as {
          agent?: { session?: { header?: { id?: unknown }; id?: unknown } };
        })?.agent;
        const sessionId = agent?.session?.header?.id ?? agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId) return decision;
        const text = push.takePendingText(sessionId);
        if (!text) return decision;
        const messages = [...decision.messages];
        // 追加在最后：这是「本轮开始前宿主补的一条系统事件」，与用户最后那句话不冲突
        messages.push({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin:dsh-aifisher-canvas',
            form: 'notice',
            summary: '画布生成事件',
          },
        });
        return { ...decision, messages };
      } catch (error) {
        ctx.logger?.warn?.(
          `[aifisher-canvas] 生成事件注入失败（已放行原始消息）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return decision;
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[aifisher-canvas] agent/pre-step 事件不可用，生成事件只能靠主动推送：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 项目记忆注入（v1.59，P1 第一项）：画布对话每回合带上前缀。
 *
 * 用户原话（提议路线图时）：「画布助手记忆：项目风格/角色/参数沉淀，跨会话注入」——
 * 目标就是「新开一个会话不用重新交代画风」。所以注入点选在 `agent/pre-step`，
 * 只对**画布对话面板的会话**生效（主区域会话仍然靠 digest/工具读，不硬塞）。
 *
 * 两条防重复：
 *   1. 同一会话、同一份记忆文本只插一次（记忆变了才重新插）；
 *   2. 插在最后一条用户消息**前面**，与「画布助手上下文」同一个位置，
 *      不影响用户原话与 @ 节点快照的相对顺序。
 */
function installCanvasProjectMemory(
  ctx: Context,
  deps: {
    memory: ReturnType<typeof createProjectMemory>;
    hub: ReturnType<typeof createCanvasChatHub>;
    store: ReturnType<typeof createCanvasStore>;
  },
): void {
  try {
    const on = (ctx as unknown as {
      on(
        name: string,
        listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): unknown;
    }).on;
    if (typeof on !== 'function') return;
    /** sessionId → 上次注入的文本（文本变了才重新注入）。 */
    const injected = new Map<string, string>();
    on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as PreStepDecision | undefined;
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision;
        }
        const sessionId = (payload as { agent?: { session?: { header?: { id?: unknown } } } })?.agent
          ?.session?.header?.id;
        if (typeof sessionId !== 'string' || !sessionId) return decision;
        if (!deps.hub.isCanvasSession(sessionId)) return decision;
        const projectId = deps.hub.projectForSession(sessionId);
        if (!projectId) return decision;
        const title = deps.store.getDocument(projectId)?.title;
        const text = deps.memory.formatForPrompt(projectId, {
          ...(typeof title === 'string' && title ? { title } : {}),
        });
        if (!text || injected.get(sessionId) === text) return decision;
        injected.set(sessionId, text);
        if (injected.size > 200) injected.delete(injected.keys().next().value as string);
        const messages = [...decision.messages];
        let index = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i]?.source?.kind === 'user') {
            index = i;
            break;
          }
        }
        messages.splice(index < 0 ? messages.length : index, 0, {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-aifisher-canvas', form: 'notice', summary: '画布项目记忆' },
        });
        return { ...decision, messages };
      } catch (error) {
        ctx.logger?.warn?.(
          `[aifisher-canvas] 项目记忆注入失败（已放行原始消息）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return decision;
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[aifisher-canvas] agent/pre-step 事件不可用，项目记忆不会自动注入：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 长任务通知的兜底入口（v1.59）：通知推送失败时，在会话下一回合补进去。
 *
 * 与 installGenerationEventNotices 同形；分离是因为载荷不同（任意一段话 vs 批次事件）。
 */
function installCanvasNoticeNotices(
  ctx: Context,
  notices: ReturnType<typeof createCanvasNoticeQueue>,
): void {
  try {
    const on = (ctx as unknown as {
      on(
        name: string,
        listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): unknown;
    }).on;
    if (typeof on !== 'function') return;
    on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
      const decision = (await next()) as PreStepDecision | undefined;
      try {
        if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
          return decision;
        }
        const agent = (payload as { agent?: { session?: { header?: { id?: unknown }; id?: unknown } } })
          ?.agent;
        const sessionId = agent?.session?.header?.id ?? agent?.session?.id;
        if (typeof sessionId !== 'string' || !sessionId) return decision;
        const text = notices.takePendingText(sessionId);
        if (!text) return decision;
        const messages = [...decision.messages];
        messages.push({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:dsh-aifisher-canvas', form: 'notice', summary: '画布长任务' },
        });
        return { ...decision, messages };
      } catch (error) {
        ctx.logger?.warn?.(
          `[aifisher-canvas] 长任务通知注入失败（已放行原始消息）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return decision;
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[aifisher-canvas] agent/pre-step 事件不可用，长任务通知只能靠主动推送：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function apply(ctx: Context) {
  // ============================================================
  // 0) webServer
  // ============================================================
  const webServer = ctx.get('webServer') as unknown as WebServerLike;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.error?.(
      '[aifisher-canvas] webServer 服务不可用，HTTP 路由与静态资源全部跳过',
    );
  }

  // ============================================================
  // 1) 数据目录（项目/素材库等本地后端都落在这里）
  // ============================================================
  const canvasStore = createCanvasStore();
  const dataDir = dirname(canvasStore.filePath);

  // ============================================================
  // 2) ComfyUI
  // ============================================================
  const comfy = createComfyClient();
  comfy.ping().then((online) => {
    ctx.logger?.info?.(
      `[aifisher-canvas] ComfyUI ${online ? '在线' : '未连上'} @ ${process.env.COMFYUI_URL ?? 'http://127.0.0.1:8188'}`,
    );
  });

  // ============================================================
  // 3) DSH 技能目录（画布侧：路由 + canvas_control 的 skills/skillLoad）
  // ============================================================
  // ⚠️ 只问 ctx.skills 是不够的：文件系统技能 provider 挂在 **agent 作用域**，
  // 插件 host 上下文只看得见 global（bundled）层 —— 用户自己的技能一条都列不出来
  // （2026-10-18 真机取证：只回 4 条 bundled、skillLoad 404）。所以走 createSkillsCatalog：
  // 它按官方 provider 的四个根自己扫（项目 .dsh/skills > 项目 .agents/skills >
  // 用户 $DSH_HOME/skills > 用户 $DSH_AGENTS_HOME/skills），再与 ctx.skills 合并。
  const skills = ctx.get('skills') as unknown as DshSkillsService | undefined;
  if (!skills || typeof skills.list !== 'function' || typeof skills.get !== 'function') {
    ctx.logger?.warn?.(
      '[aifisher-canvas] ctx.skills 不可用：画布技能目录仍会扫文件系统，只是少了 bundled 层',
    );
  }
  // 项目层默认扫画布数据目录（= 画布自己创建的会话用的 cwd，见下面 chatHub）；
  // canvas_control 调用时会优先用**发起调用的那个会话**的 cwd（?cwd= 同义）。
  const skillsCatalog = createSkillsCatalog({ skills, cwd: () => dataDir });

  // ============================================================
  // 4) 挂路由 + 静态资源
  // ============================================================
  const bridge = createCanvasBridge();
  const mediaStore = createMediaStore();
  // 画布右侧对话面板（v1.9）：一条画布对话 = 一个 DSH 会话。
  // 会话存档落 <数据目录>/agent-chat.json；工作目录就用画布数据目录
  // （DSH 创建会话时要求每次给同一个 cwd）。
  const chatStore = createAgentChatStore({ filePath: join(dataDir, 'agent-chat.json') });
  const chatHub = createCanvasChatHub({ ctx, store: chatStore, cwd: dataDir });
  // 生成任务日记（内存）：画布的结果回收与 agent 的 tasks/cancelTask 都查它
  const journal = createGenerationJournal();
  /**
   * 生成事件（v1.57）：journal 事件 → 按「准备批次」成组 → 画布对话面板。
   *
   * 绑定信息来自下面 plans 的 onPrepare：画布准备批次时带 `sessionId`（= 发起
   * canvas_control 的 DSH 会话）与 `items[].nodeId`，所以这批跑完知道该推给谁。
   */
  const generationEvents = createGenerationEvents({ journal });
  /**
   * 生成批次记录（v1.57）：`/agent/plans*`。
   *
   * 这不是「额外功能」而是主链路的前置条件 —— 画布 prepareGeneration 的最后一步要 POST
   * /agent/plans 落库拿 revision，缺了它整条「Agent 准备 → 用户确认」都会 UNAVAILABLE
   * （v1.57 之前就是这个状态）。
   */
  const generationPlans = createGenerationPlans({
    onPrepare(record) {
      // 画布 bridge 在拿不到会话 id 时会填 'dsh' 占位：那种批次没有可推送的会话
      if (!record.sessionId || record.sessionId === 'dsh') return;
      generationEvents.bindNodes(
        record.sessionId,
        record.items.map((item) => item.nodeId),
        record.id,
      );
    },
  });
  // 推送层：把收口的批次投进 DSH 会话（推不出去就留到该会话下一回合，见 pre-step 注入）
  const generationPush = createGenerationPush({ ctx, events: generationEvents });
  // ------------------------------------------------------------
  // v1.59（P1）：项目记忆 / 长任务 / 主动副驾
  // ------------------------------------------------------------
  // 项目记忆：<数据目录>/canvas-memory.json（文本条目 + 参考锚点）
  const projectMemory = createProjectMemory({ filePath: join(dataDir, 'canvas-memory.json') });
  // 资产库（v1.63）：<数据目录>/canvas-assets.json（角色/场景/道具/画风的锁定串 + 定妆节点）
  const assetLibrary = createAssetLibrary({ filePath: join(dataDir, 'canvas-assets.json') });
  // 长任务通知：推不进会话就留着，下一回合由 pre-step 补给（与生成事件同一套护栏）
  const canvasNotices = createCanvasNoticeQueue({ ctx });
  /**
   * 后台长任务编排：read → shots → lock → prepare → await → retry → report。
   *
   * 只调用 prepareGeneration（产出 awaiting-approval），从不 approve —— 审批仍只在画布 UI。
   */
  const canvasJobs = createCanvasJobs({
    bridge,
    events: generationEvents,
    plans: generationPlans,
    memory: projectMemory,
    notify: (sessionId, text) => canvasNotices.push(sessionId, text),
  });
  // 提交前对账：本机 ComfyUI 的节点/模型清单（模板里的文件名可能与本机不一致）
  // 缓存时长可用 AIFISHER_COMFY_OBJECT_INFO_TTL_MS 覆盖（回归测试用 0 = 每次都重新拉）
  const objectInfoTtl = Number(process.env.AIFISHER_COMFY_OBJECT_INFO_TTL_MS);
  const modelResolver = createModelResolver(
    comfy,
    Number.isFinite(objectInfoTtl) ? { ttlMs: objectInfoTtl } : {},
  );
  const comfyDeps = { mediaStore, journal, modelResolver };
  ctx.logger?.info?.(`[aifisher-canvas] 画布本地后端数据文件：${canvasStore.filePath}`);
  ctx.logger?.info?.(`[aifisher-canvas] 素材库目录：${mediaStore.rootDir}`);

  if (webServer) {
    attachComfyRoutes(webServer, comfy, comfyDeps);
    attachStaticAssets(webServer);
    // 画布本地后端（项目/文件夹/偏好）+ 素材库 + 媒体加工 + agent 控制通道（长轮询下发指令）
    // + v1.1 补的设置页各分区（画布外观 / 本机运行环境 / 闭源服务 / 提示词 / 媒体下载）
    const comfyBaseUrl = process.env.COMFYUI_URL?.trim() || 'http://127.0.0.1:8188';
    // 界面上保存过的云端端点配置（设置 → 闭源服务）：环境变量优先，这里只补空缺
    void applySavedCloudKeys(dirname(canvasStore.filePath)).then((applied) => {
      if (applied.length) {
        ctx.logger?.info?.(`[aifisher-canvas] 已载入界面保存的云端配置：${applied.join(', ')}`);
      }
    });
    attachCanvasApi(webServer, canvasStore, bridge, {
      mediaStore,
      comfy: createComfyDelegate(comfy, comfyDeps),
      comfyClient: comfy,
      comfyBaseUrl,
      chat: { dataDir, store: chatStore, chat: chatHub, mediaStore, plans: generationPlans },
      // 任务队列面板（v1.24）读的生成任务日记：与 ComfyUI 结果回收共用同一份
      tasks: journal,
      // 生成事件（v1.57）：`/events` 只读回看（推送本身走 DSH 会话，不经过这条路由）
      events: generationEvents,
      // 生成批次记录（v1.57）：`/status` 里报计数（对话面板的 plans 走 chat deps）
      plans: generationPlans,
      // 画布助手 P1（v1.59）：项目记忆 / 参考锚点 / 副驾建议 / 长任务
      copilot: {
        memory: projectMemory,
        jobs: canvasJobs,
        plans: generationPlans,
        assets: assetLibrary,
        /**
         * 副驾/锚点优先读**活画布**的节点（刚建、刚连的节点也在），拿不到再退回磁盘文档。
         *
         * 两条硬约束（2026-10-20 真机检查踩到）：
         *   ① 只有**最近还在轮询**的页面才值得问：上一个页面的 client 会留在桥里，
         *      向一个已经消失的页面下发指令只能等超时（表现是界面/页面卡住）；
         *   ② 超时给 1.5s 而不是 5s：这是「锦上添花」的读数，磁盘文档才是兜底答案。
         */
        liveNodes: async () => {
          try {
            const status = bridge.status() as { clients?: Array<{ idleMs?: unknown }> };
            const clients = Array.isArray(status.clients) ? status.clients : [];
            const polling = clients.some(
              (client) => typeof client.idleMs === 'number' && client.idleMs < 5_000,
            );
            if (!polling) return null;
            const result = await bridge.request({ action: 'read' }, { timeoutMs: 1_500 });
            return Array.isArray(result.nodes) ? result.nodes : null;
          } catch {
            return null;
          }
        },
      },
    });
    // 技能路由**无条件挂**：文件系统那一层不依赖 ctx.skills（见 createSkillsCatalog）。
    attachSkillsRoutes(webServer, skillsCatalog);
    ctx.logger?.info?.('[aifisher-canvas] routes mounted: /api/comfy/*, /api/aifisher/canvas/*, /api/aifisher/canvas-app/*, /creative-presets/*, /mj-styles/*');
  }

  // ============================================================
  // 5) canvas_control 工具
  // ============================================================
  // 画布对话面板的会话，第一回合先注入一段上下文提示（告诉它「你在画布面板里、
  // 用 canvas_control 操作画布」）。宿主没有这个事件时只是不注入，画布照常可用。
  installCanvasChatInstructions(ctx, chatHub);
  // v1.51：@ 画布节点 → 紧随用户消息的只读快照（任何会话都生效）
  installCanvasNodeReferences(ctx, canvasStore);
  // v1.57：生成事件推送的兜底入口（主动推送失败的批次在这里补给会话）
  installGenerationEventNotices(ctx, generationPush);
  // v1.59：画布对话每回合带上项目记忆（风格/角色/参数，跨会话不再重新交代）
  installCanvasProjectMemory(ctx, { memory: projectMemory, hub: chatHub, store: canvasStore });
  // v1.59：长任务通知的兜底入口（收口/自动重试没推出去时，下一回合补给会话）
  installCanvasNoticeNotices(ctx, canvasNotices);

  ctx.tools.register(
    defineTool({
      name: 'canvas_control',
      description:
        'Operate the active AIFISHER infinite canvas. ' +
        'Fast path is ONE call: edit with operations — revision is optional (the host reads it for you), ' +
        'and a successful edit returns a compact "snapshot", so no follow-up read is needed. ' +
        'Use read only when you must inspect state first; it returns a trimmed node list by default ' +
        '(long prompt/textContent is clipped to ~240 chars with textTruncated) — pass detail:"full" for full text. ' +
        'For multi-step planning start with view:"digest": a compact project overview (counts by type/status, edges, groups, selected nodes, and hints such as missing prompts or failed generations) without node text. ' +
        'An operation is discriminated by "kind": ' +
        'create{ref,type:"Image"|"Video"|"Audio"|"Text",x,y,title?,prompt?,text?}, ' +
        'create positions are auto-guarded: a create without x/y, or whose position would overlap an existing node, is moved to free space right of existing content (explicit non-overlapping positions are kept) — agent-created nodes never cover existing ones. ' +
        'update{nodeId,patch{title?,prompt?,x?,y?,text?}}, ' +
        'configure{nodeId,model,parameters}, delete{nodeId}, ' +
        'connect{sourceId,targetId,sourcePort?}, disconnect{sourceId,targetId,targetPort?}, ' +
        'group{ref,nodeIds,label}, ungroup{groupId}, renameGroup{groupId,label}, ' +
        'arrange{nodeIds,columns}, duplicate{nodes[{nodeId,ref}],x,y}. ' +
        'For storyboard/shot lists use action:"recipe" with recipe:{name:"shot-list", shots:[{title?,prompt,type?:"Image"|"Video",model?,parameters?}], anchorId?, columns?} — the host expands the whole list into ONE edit (grid below the anchor, or right of existing content; never covering existing nodes). Shots are NOT connected to the script node: connecting would concatenate the whole script into every prompt. ' +
        'preview: action:"preview" with optional nodeIds returns the local file paths of generated results (resultUrl/resultUrls mapped into the media store) — open images with read_image to judge them; preview never mutates the canvas. ' +
        'Generation push (v1.57): when a batch you prepared with prepareGeneration reaches its end (success/failed/cancelled), the host posts a 【画布生成事件】 notice into this conversation — treat it as a system event, not a user request: review successful nodes with preview, then fix the cause and prepareGeneration again for failures; the user still approves every batch. ' +
        'Text nodes have two fields: "text" is the body shown in the node, "prompt" is the transform template — pass "text" for the script/content itself; a lone "prompt" on a Text node is also written to the body (never into the prompt box). ' +
        'configure rules: "model" must exactly match the canvas catalog display name — create a node then read it back to learn the exact string (never guess); ' +
        'every "parameters" key must be declared by that model or the whole edit fails with INVALID; ' +
        'switching model resets any advanced parameter you omit (e.g. generateCount falls back to 1), so always pass model+parameters in the same call. ' +
        'Generation is human-authorized by design: prepareGeneration only yields an awaiting-approval plan and the approve step is intentionally UI-only. ' +
        'Your job is to prepare nodes/params/prompt and hand it over — never try to submit or bypass it. ' +
        'Persistence (v1.58): every mutating edit is followed by a forced save, and the result carries "saved": "saved" | "failed" | "unknown". ' +
        'saved:"failed" means the canvas applied your change but could NOT write it to disk — tell the user to press Save and verify; never resubmit the same edit (it would duplicate nodes). ' +
        'saved:"unknown" means the canvas was busy or switched away, so persistence could not be confirmed. ' +
        'Project memory (v1.59): action:"memory" list|set|remove|anchor-set|anchor-add|anchor-remove keeps the project’s look/characters/model prefs in canvas-memory.json; entries with the same kind+key update in place. ' +
        'Consistency (v1.59): action:"consistency" op:"status"|"lock"|"unlock" wires the project’s reference anchors (character sheet / style refs) into shot nodes as upstream inputs — the canvas then uses them as reference images; no new protocol. ' +
        'Copilot (v1.59): action:"copilot" returns actionable suggestions (failed nodes, missing prompts, unlocked shots, empty memory). ' +
        'Long task (v1.59): action:"job" op:"create" runs a deterministic pipeline (read → shot-list → lock anchors → prepareGeneration → await approval/result → auto-retry failed nodes → summary) and returns immediately with a job snapshot; the user still confirms every batch. ' +
        'Intent compiler (v1.63): action:"intent" {op:"compile"|"apply", brief, shots?, type?, aspectRatio?, duration?, model?, style?} turns a natural-language brief into a deterministic shot list (style + asset lock strings woven into every prompt, fixed quality/limit clauses appended); op:"apply" expands it into nodes in ONE call; human approval still gates generation. Prefer it over hand-writing shots when the user says 「一句话做短片」. ' +
        'Quality review (v1.63): action:"review" {op:"scan"} checks prompts (missing light/quality/limits, length), anchor coverage, and result files (format/pixel size/bytes via file header) and returns summary.retry — it does NOT score aesthetics; use preview + read_image for that. {op:"fix", apply:true} appends the missing fixed clauses (never rewrites the original text). ' +
        'Assets (v1.63): action:"assetlibrary" list/add/update/remove/link/import/use keeps per-project character/scene/prop/style cards with a verbatim lock string; op:"use" registers a card’s node as a reference anchor and locks it onto shots. intent weaves these lock strings automatically. ' +
        'Multi-agent (v1.63): action:"crew" {op:"plan", brief, shots?} returns assignments (role, task, deliverable JSON schema, boundary, compact context) that you can hand to DSH subagents; {op:"receive", role, deliverable, apply?} validates and normalizes their shots/locks — subagents never get canvas approve rights. ' +
        'job also accepts brief (v1.63): {op:"create", brief:"…", shotsCount?} runs the intent compiler first, so 「一句话做完整短片」 is one call; explicit shots still win. ' +
        'Full contract and error codes: docs/canvas-agent-contract.md.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: [
            'read', 'edit', 'undo', 'focus',
            'assets', 'projects', 'models', 'tasks',
            'prepareGeneration', 'runGeneration', 'cancelTask',
            'media', 'workflow', 'product',
            'skills', 'skillLoad', 'recipe', 'preview',
            'memory', 'consistency', 'copilot', 'job',
            'intent', 'review', 'assetlibrary', 'crew',
          ],
        },
        /** edit/undo 必须带上一轮 read 返回的 revision（乐观并发令牌）。 */
        revision: { type: 'string' },
        /** edit 的动作列表（create/update/configure/delete/connect/disconnect/group/…）；字段契约见 docs/canvas-agent-contract.md。 */
        operations: { type: 'array' },
        /** focus / tasks 的目标节点。 */
        nodeIds: { type: 'array' },
        /** 技能名（skillLoad）、项目/素材搜索词（projects/assets）。 */
        name: { type: 'string' },
        /** undo 的操作号（edit 的返回里有）。 */
        operationId: { type: 'string' },
        /** models 动作要查询的节点类型。 */
        type: { type: 'string' },
        /** 分页游标（projects/assets）。 */
        offset: { type: 'number' },
        /**
         * read 的详细程度：默认 summary（节点正文截到约 240 字，省上下文）；
         * full 原样返回全文（要改长文/剧本时才用）。
         */
        detail: { type: 'string', enum: ['summary', 'full'] },
        /** read 的视图：nodes=节点列表（默认，detail 控制截断）；digest=项目摘要（统计/连线/分组/hints，不含正文）。 */
        view: { type: 'string', enum: ['nodes', 'digest'] },
        /**
         * recipe 参数（action:"recipe"）：{ name:"shot-list", shots:[{title?,prompt,type?,model?,parameters?}], anchorId?, columns? }。
         * 一次 expand 成节点 + 可选 configure，画布侧只收到一条普通 edit。
         */
        recipe: { type: 'object', additionalProperties: true },
        /**
         * 项目记忆参数（action:"memory"）：
         *   { op:"list" } | { op:"set", kind, text, key?, importance? } | { op:"remove", id }
         *   | { op:"anchor-add", nodeIds:[id], role?, title? } | { op:"anchor-set", anchors:[{nodeId,title?,role?}] }
         *   | { op:"anchor-remove", nodeIds:[id] }
         */
        memory: { type: 'object', additionalProperties: true },
        /**
         * 一致性参数（action:"consistency"）：{ op:"status" } | { op:"lock"|"unlock", nodeIds?: [镜头] }
         */
        consistency: { type: 'object', additionalProperties: true },
        /**
         * 长任务参数（action:"job"）：
         *   { op:"create", name, shots:[{title?,prompt,type?,model?,parameters?}], columns?, anchorId?,
         *     lockAnchors?, prepare?, retry?:{enabled?,maxAttempts?} }
         *   | { op:"list" } | { op:"status", id } | { op:"cancel", id }
         */
        job: { type: 'object', additionalProperties: true },
        /**
         * 意图编译器（action:"intent"，v1.63）：
         *   { op:"compile"|"apply", brief, shots?, type?, aspectRatio?, duration?, model?,
         *     style?, includeLocks?, qualityAnchor?, limitClause?, columns?, anchorId? }
         * 确定性把一句话意图编译成 shots（风格/锁定串来自项目记忆与资产库），
         * op:"apply" 会直接展开成节点。
         */
        intent: { type: 'object', additionalProperties: true },
        /**
         * 质量评估（action:"review"，v1.63）：
         *   { op:"scan"|"fix", apply? }
         * scan 只读：提示词结构、锚点覆盖、结果文件（格式/尺寸/大小）、失败归因；
         * fix 给追加式修补计划，apply:true 才写回画布。不做主观画质打分。
         */
        review: { type: 'object', additionalProperties: true },
        /**
         * 资产库（action:"assetlibrary"，v1.63）：
         *   { op:"list" } | { op:"add"|"update", kind:"character"|"scene"|"prop"|"style", name, prompt, tags?, nodeId? }
         *   | { op:"remove", id } | { op:"link", id, nodeId } | { op:"import", locks:[…] }
         *   | { op:"use", id }（把已挂节点的资产登记为锚点并锁到镜头，nodeIds 可限定）
         */
        assetlibrary: { type: 'object', additionalProperties: true },
        /**
         * 多 agent 协作（action:"crew"，v1.63）：
         *   { op:"plan", brief, shots?, roles? } → 可直接派给 DSH 子代理的任务包
         *   { op:"receive", role, deliverable:{shots?/locks?/verdicts?}, apply?, importLocks? }
         */
        crew: { type: 'object', additionalProperties: true },
        /**
         * 逃生舱：直接给一条完整画布指令（canvasControlProtocol 的 CanvasControl），
         * 用于那些参数较多、暂时没有单独暴露的动作（prepareGeneration/media/workflow…）。
         * 注意：DSH 的 schema DSL 要求 object 节点显式声明开放度，漏了会直接拒绝注册。
         */
        command: { type: 'object', additionalProperties: true },
      },
      output: {
        // DSH 的 schema DSL 要求 object 节点显式声明开放度，不写会被直接拒绝：
        //   "schema.additionalProperties must be explicitly true or false"
        // 这个工具的成功返回不止一种形状（skills / skill / UNCONFIRMED …），
        // 所以开放为 true，只把恒定存在的 ok 标成 required。
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec): Promise<{ ok: boolean } & Record<string, ToolJson>> {
        ctx.logger?.info?.('[aifisher-canvas] canvas_control called', args);
        // 工具调用来自哪个会话（用于多会话时定位画布页面；取不到就回退最近活跃的画布）
        const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent
          ?.session?.id;
        /**
         * 技能目录的项目层要扫哪个目录：**发起调用的那个会话的工作目录**。
         *
         * 不传会话 cwd 就会退到画布数据目录（createSkillsCatalog 的默认值），
         * 于是「项目级 `.dsh/skills`」会被漏掉 —— 这正是 dsh-skill-picker 0.5.x 踩过的坑
         * （它当年不带 `?cwd=`，项目级技能在面板里静默消失）。
         */
        const sessionCwd = (exec as { agent?: { session?: { cwd?: unknown } } } | undefined)?.agent
          ?.session?.cwd;
        const skillsCwd = typeof sessionCwd === 'string' ? sessionCwd : undefined;

        /**
         * 让画布**立刻**把当前内容落盘，并把结果如实带回去（2026-10-20，修「保存不上」）。
         *
         * 为什么要多这一步：画布上游是「编辑 → 1.2s 防抖 → 自动保存」，而 canvas_control
         * 的 edit 在「画布内部已执行、回执已拿到」时就返回成功了 —— 落盘还在后面排队。
         * 于是出现用户报障的那种体验：助手改完画布看着都对，一旦自动保存失败（冲突/网络/
         * 超时）就整个丢失，而工具这边一路 ok:true，谁也不知道没存上。
         *
         * 现在每次改完文档的动作（edit / undo / recipe / 插图类）都由 host 追加一条
         * `project.save`：画布侧走它自己的保存链路（含冲突合并重试），host 等回执。
         * 返回值三态：
         *   saved   —— 画布确认已落盘；
         *   failed  —— 画布明确说这次没存成（UNCONFIRMED），工具会把它报到顶层；
         *   unknown —— 画布当时忙/被切走/超时，无法确认（不是失败，不回退成错误）。
         */
        const flushCanvasSave = async (
          targetSessionId: string | undefined,
          revision: unknown,
        ): Promise<'saved' | 'failed' | 'unknown'> => {
          if (typeof revision !== 'string' || !revision) return 'unknown';
          try {
            const receipt = (await bridge.request(
              { action: 'project', operation: 'save', revision },
              { sessionId: targetSessionId, timeoutMs: 20_000 },
            )) as { ok?: unknown; code?: unknown } | null;
            if (!receipt || typeof receipt !== 'object') return 'unknown';
            if (receipt.ok !== false) return 'saved';
            // 只有「画布明确说没存成」才算失败；CONFLICT/UNAVAILABLE 属于当时状态不对。
            return receipt.code === 'UNCONFIRMED' ? 'failed' : 'unknown';
          } catch {
            return 'unknown';
          }
        };
        /** 改完画布内容后要追加落盘的动作（这些动作会改 nodes/groups）。 */
        const SAVE_AFTER_ACTIONS = new Set(['edit', 'undo', 'recipe', 'media', 'workflow', 'importAsset']);

        /**
         * shot-list 展开（v1.55；v1.63 抽成可复用）：
         * 读 revision → recipe 纯函数 → 一条普通 edit → 落盘 → 带回快照。
         * 被 action:"recipe"、intent 的 op:"apply"、crew receive 的 apply 共用。
         */
        const expandShotList = async (
          recipeInput: unknown,
          targetSessionId: string | undefined,
        ): Promise<
          | { ok: true; response: Record<string, unknown> }
          | { ok: false; code: string; message: string; response?: Record<string, unknown> }
        > => {
          try {
            const readResult = (await bridge.request({ action: 'read' }, { sessionId: targetSessionId })) as {
              revision?: unknown;
              nodes?: unknown;
            } | null;
            const revision = readResult?.revision;
            if (typeof revision !== 'string' || !revision) {
              return {
                ok: false,
                code: 'NEED_REVISION',
                message: '画布没有返回 revision，无法展开 recipe。',
              };
            }
            const nodes = Array.isArray(readResult?.nodes) ? readResult.nodes : [];
            const planned = buildShotListRecipe(recipeInput, nodes);
            if ('error' in planned) {
              return { ok: false, code: 'INVALID', message: planned.error };
            }
            const editResult = (await bridge.request(
              { action: 'edit', revision, operations: planned.operations },
              { sessionId: targetSessionId },
            )) as Record<string, ToolJson> | null;
            if (editResult && editResult.ok === false) {
              return {
                ok: false,
                code: typeof editResult.code === 'string' ? editResult.code : 'CANVAS_REJECTED',
                message: `画布拒绝了这次操作：${String(editResult.code ?? 'CANVAS_REJECTED')}。`,
                response: editResult as Record<string, unknown>,
              };
            }
            const response: Record<string, unknown> = {
              ...(editResult ?? {}),
              recipe: {
                name: 'shot-list',
                shots: planned.count,
                placed: planned.placed as unknown as ToolJson,
                anchorFound: planned.anchorFound,
              },
            };
            // 与 edit 分支同一条纪律：展开完立刻落盘，别等画布那 1.2s 防抖。
            const savePromise = flushCanvasSave(targetSessionId, editResult?.revision);
            try {
              const snapshot = (await bridge.request({ action: 'read' }, { sessionId: targetSessionId })) as unknown;
              if (snapshot && typeof snapshot === 'object') {
                response.snapshot = summarizeCanvasRead(snapshot, { maxTextChars: 160 }) as unknown as ToolJson;
              }
            } catch {
              /* 快照失败不影响 recipe 结果 */
            }
            const saved = await savePromise;
            if (saved) response.saved = saved;
            return { ok: true, response };
          } catch (error) {
            const code = (error as { code?: string }).code ?? 'CANVAS_BRIDGE_FAILED';
            return {
              ok: false,
              code,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        };

        // skills: 列出 DSH 当前已装技能（与画布 UI 调 /api/aifisher/skills 同源）
        if (args.action === 'skills') {
          try {
            const list = await skillsCatalog.list(skillsCwd);
            return {
              ok: true,
              cwd: skillsCwd ?? null,
              skills: list.map((s) => ({
                name: s.name,
                description: s.description,
                whenToUse: s.whenToUse,
                source: s.source,
                provider: s.provider,
              })),
            };
          } catch (e) {
            return {
              ok: false,
              code: 'SKILLS_LIST_FAILED',
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }

        // skillLoad: 取某个技能的完整 SKILL.md 正文（name 必填）
        if (args.action === 'skillLoad') {
          const name = typeof args.name === 'string' ? args.name : '';
          if (!name) {
            return { ok: false, code: 'MISSING_NAME', message: 'skillLoad 需要 name 参数。' };
          }
          try {
            const def = await skillsCatalog.get(name, skillsCwd);
            if (!def) {
              return { ok: false, code: 'NOT_FOUND', message: `技能 "${name}" 不存在。` };
            }
            return {
              ok: true,
              skill: {
                name: def.name,
                description: def.description,
                whenToUse: def.whenToUse,
                source: def.source,
                provider: def.provider,
                path: def.path,
                content: def.content ?? '',
              },
            };
          } catch (e) {
            return {
              ok: false,
              code: 'SKILL_GET_FAILED',
              error: e instanceof Error ? e.message : String(e),
            };
          }
        }

        // ----------------------------------------------------------
        // recipe：一次调用把结构化镜头列表展开成节点（host 端确定性排布）
        // ----------------------------------------------------------
        if (args.action === 'recipe') {
          const expansion = await expandShotList((args as { recipe?: unknown }).recipe, sessionId);
          if (!expansion.ok) {
            return {
              ok: false,
              code: expansion.code,
              action: 'recipe',
              message: expansion.message,
              ...(expansion.response ? { result: expansion.response as unknown as ToolJson } : {}),
            };
          }
          const response = expansion.response;
          if (sessionId) {
            chatHub.noteCanvasAction(sessionId, {
              action: 'recipe',
              ok: true,
              ...(typeof response.operationId === 'string' ? { operationId: response.operationId } : {}),
            });
          }
          return { ok: true, action: 'recipe', result: response as unknown as ToolJson };
        }

        // ----------------------------------------------------------
        // preview：生成结果 → 本机文件路径（视觉回读，不改画布）
        // ----------------------------------------------------------
        if (args.action === 'preview') {
          try {
            const readResult = (await bridge.request({ action: 'read' }, { sessionId })) as {
              nodes?: unknown;
            } | null;
            const rawNodes = Array.isArray(readResult?.nodes) ? readResult.nodes : [];
            const wantedIds = Array.isArray((args as { nodeIds?: unknown }).nodeIds)
              ? (args as { nodeIds: unknown[] }).nodeIds.filter(
                  (item): item is string => typeof item === 'string' && item.length > 0,
                )
              : [];
            const wanted = wantedIds.length ? new Set(wantedIds) : null;
            const selected = wanted
              ? rawNodes.filter((raw) => {
                  if (!raw || typeof raw !== 'object') return false;
                  const id = (raw as { id?: unknown }).id;
                  return typeof id === 'string' && wanted.has(id);
                })
              : rawNodes;
            /**
             * 画布把项目加载进内存时会重新规范化节点（实测/测试都观察到 resultUrl 被剥离，
             * 只剩 id/type/x/y/title/prompt/status），所以内存节点缺结果 URL 时，
             * 回退到该项目最近一次持久化文档里的同名节点补上。
             */
            let projectId = '';
            try {
              const status = bridge.status() as { clients?: Array<{ projectId?: unknown }> };
              const client = Array.isArray(status.clients) ? status.clients[0] : undefined;
              if (client && typeof client.projectId === 'string') projectId = client.projectId;
            } catch {
              /* 取不到 projectId 就只读内存节点 */
            }
            const savedDocument = projectId ? canvasStore.getDocument(projectId) : null;
            const savedNodes = savedDocument && Array.isArray(savedDocument.nodes) ? savedDocument.nodes : [];
            const savedById = new Map<string, Record<string, unknown>>();
            for (const node of savedNodes) {
              if (node && typeof node === 'object' && !Array.isArray(node)) {
                const record = node as Record<string, unknown>;
                if (typeof record.id === 'string') savedById.set(record.id, record);
              }
            }
            const merged = selected.map((raw) => {
              if (!raw || typeof raw !== 'object') return raw;
              const node = raw as Record<string, unknown>;
              const hasResult =
                typeof node.resultUrl === 'string' ||
                (Array.isArray(node.resultUrls) && node.resultUrls.length > 0);
              if (hasResult) return node;
              const stored = typeof node.id === 'string' ? savedById.get(node.id) : undefined;
              if (!stored) return node;
              return {
                ...node,
                ...(typeof stored.resultUrl === 'string' ? { resultUrl: stored.resultUrl } : {}),
                ...(Array.isArray(stored.resultUrls) ? { resultUrls: stored.resultUrls } : {}),
              };
            });
            const files = collectPreviewFiles(merged, (url) => mediaStore.localPathForUrl(url));
            return {
              ok: true,
              action: 'preview',
              result: {
                nodes: files,
                hint: '图片用 read_image 打开 media[].path 自评；视频/音频先看 path，需要画面时用 media 动作截帧。preview 不改画布。',
              } as unknown as ToolJson,
            };
          } catch (error) {
            const code = (error as { code?: string }).code ?? 'CANVAS_BRIDGE_FAILED';
            return {
              ok: false,
              code,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        // ----------------------------------------------------------
        // v1.59（P1）：项目记忆 / 视觉一致性 / 主动副驾 / 长任务
        //
        // 这四个动作都在 host 侧完成（不经过画布协议）：记忆是文件、锚点是纯计算、
        // 副驾是建议、长任务是一条 host 流水线。只有「改画布」时才用 bridge 下发普通 edit。
        // ----------------------------------------------------------
        const activeProjectId = (): string => {
          try {
            const status = bridge.status() as { clients?: Array<{ projectId?: unknown }> };
            const client = Array.isArray(status.clients) ? status.clients[0] : undefined;
            return client && typeof client.projectId === 'string' ? client.projectId : '';
          } catch {
            return '';
          }
        };
        const anchorList = (projectId: string): AnchorInput[] =>
          projectMemory.get(projectId).anchors.map((anchor) => ({
            nodeId: anchor.nodeId,
            title: anchor.title,
            role: anchor.role,
          }));
        /** 读当前打开的画布节点（副驾/锚点/一致性都要「活」的节点，不是磁盘快照）。 */
        const readLiveNodes = async (): Promise<unknown[]> => {
          const read = (await bridge.request({ action: 'read' }, { sessionId })) as {
            nodes?: unknown;
          } | null;
          return read && Array.isArray(read.nodes) ? read.nodes : [];
        };

        if (args.action === 'memory') {
          const projectId = activeProjectId();
          if (!projectId) {
            return { ok: false, code: 'NO_PROJECT', message: '画布没有打开项目，无法读写项目记忆。' };
          }
          const input = ((args as { memory?: unknown }).memory ?? {}) as Record<string, unknown>;
          const op = typeof input.op === 'string' ? input.op : 'list';
          try {
            if (op === 'list') {
              const block = projectMemory.get(projectId);
              const title = canvasStore.getDocument(projectId)?.title;
              return {
                ok: true,
                action: 'memory',
                result: { ...block, prompt: projectMemory.formatForPrompt(projectId, { ...(title ? { title } : {}) }) } as unknown as ToolJson,
              };
            }
            if (op === 'set') {
              const entry = await projectMemory.upsert(projectId, input);
              if (!entry) {
                return {
                  ok: false,
                  code: 'INVALID',
                  message: '记忆需要非空 text；kind 取 style/character/model/param/rule/note，key 用于同类原地更新。',
                };
              }
              return { ok: true, action: 'memory', result: { entry } as unknown as ToolJson };
            }
            if (op === 'remove') {
              const id = typeof input.id === 'string' ? input.id : '';
              const removed = await projectMemory.remove(projectId, id);
              return removed
                ? { ok: true, action: 'memory', result: { removed: id } as unknown as ToolJson }
                : { ok: false, code: 'NOT_FOUND', message: '没有这条记忆。' };
            }
            if (op === 'anchor-add' || op === 'anchor-set' || op === 'anchor-remove') {
              const nodeIds = Array.isArray((args as { nodeIds?: unknown }).nodeIds)
                ? ((args as { nodeIds: unknown[] }).nodeIds.filter(
                    (value): value is string => typeof value === 'string' && value.length > 0,
                  ))
                : [];
              const nodes = await readLiveNodes();
              const titleOf = (id: string): string => {
                const found = nodes.find(
                  (raw) => raw && typeof raw === 'object' && (raw as { id?: unknown }).id === id,
                );
                const title = found ? (found as { title?: unknown }).title : undefined;
                return typeof title === 'string' && title ? title : id;
              };
              const known = new Set(
                nodes.flatMap((raw) => {
                  if (!raw || typeof raw !== 'object') return [];
                  const id = (raw as { id?: unknown }).id;
                  return typeof id === 'string' ? [id] : [];
                }),
              );
              let anchors;
              if (op === 'anchor-remove') {
                anchors = await projectMemory.removeAnchor(projectId, nodeIds[0] ?? '');
              } else if (op === 'anchor-add') {
                if (!nodeIds[0]) {
                  return { ok: false, code: 'INVALID', message: 'anchor-add 需要 nodeIds:[节点 id]。' };
                }
                anchors = await projectMemory.addAnchor(projectId, {
                  nodeId: nodeIds[0],
                  title: typeof input.title === 'string' ? input.title : titleOf(nodeIds[0]),
                  role: input.role,
                });
              } else {
                const raw = Array.isArray(input.anchors)
                  ? (input.anchors as Array<Record<string, unknown>>).map((anchor) => ({
                      nodeId: anchor?.nodeId,
                      title: typeof anchor?.title === 'string' ? anchor.title : titleOf(String(anchor?.nodeId ?? '')),
                      role: anchor?.role,
                    }))
                  : nodeIds.map((id) => ({ nodeId: id, title: titleOf(id), role: input.role }));
                anchors = await projectMemory.setAnchors(projectId, raw, known.size > 0 ? known : undefined);
              }
              if (!anchors) {
                return { ok: false, code: 'INVALID', message: '锚点需要 nodeId，且节点必须在当前画布上。' };
              }
              return {
                ok: true,
                action: 'memory',
                result: {
                  anchors,
                  consistency: coverageReport(nodes, anchors),
                } as unknown as ToolJson,
              };
            }
            return { ok: false, code: 'INVALID', message: `未知 op：${op}（list/set/remove/anchor-add/anchor-set/anchor-remove）。` };
          } catch (error) {
            return {
              ok: false,
              code: 'MEMORY_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (args.action === 'consistency') {
          const projectId = activeProjectId();
          if (!projectId) {
            return { ok: false, code: 'NO_PROJECT', message: '画布没有打开项目，无法核对参考一致性。' };
          }
          const input = ((args as { consistency?: unknown }).consistency ?? {}) as Record<string, unknown>;
          const op = typeof input.op === 'string' ? input.op : 'status';
          try {
            let nodes = await readLiveNodes();
            let operations = 0;
            if (op === 'lock' || op === 'unlock') {
              const anchors = anchorList(projectId);
              if (anchors.length === 0) {
                return {
                  ok: false,
                  code: 'NO_ANCHORS',
                  message: '项目还没有参考锚点：先用 action:"memory" op:"anchor-add" 把角色定妆/画风参考节点设为锚点。',
                };
              }
              const wanted = Array.isArray((args as { nodeIds?: unknown }).nodeIds)
                ? ((args as { nodeIds: unknown[] }).nodeIds.filter(
                    (value): value is string => typeof value === 'string' && value.length > 0,
                  ))
                : undefined;
              const read = (await bridge.request({ action: 'read' }, { sessionId })) as {
                revision?: unknown;
                nodes?: unknown;
              };
              const revision = typeof read?.revision === 'string' ? read.revision : '';
              if (!revision) {
                return { ok: false, code: 'NEED_REVISION', message: '画布没有返回 revision。' };
              }
              const plan =
                op === 'lock'
                  ? planLockOperations(nodes, anchors, wanted)
                  : planUnlockOperations(nodes, anchors, wanted);
              operations = plan.operations.length;
              if (operations > 0) {
                const editResult = (await bridge.request(
                  { action: 'edit', revision, operations: plan.operations },
                  { sessionId },
                )) as Record<string, unknown> | null;
                if (editResult && editResult.ok === false) {
                  return {
                    ok: false,
                    code: typeof editResult.code === 'string' ? editResult.code : 'CANVAS_REJECTED',
                    message: '画布拒绝了参考连线操作。',
                  };
                }
              }
              nodes = await readLiveNodes();
              return {
                ok: true,
                action: 'consistency',
                result: {
                  op,
                  operations,
                  coverage: coverageReport(nodes, anchors),
                } as unknown as ToolJson,
              };
            }
            const anchors = anchorList(projectId);
            return {
              ok: true,
              action: 'consistency',
              result: {
                op: 'status',
                anchors,
                coverage: coverageReport(nodes, anchors),
              } as unknown as ToolJson,
            };
          } catch (error) {
            return {
              ok: false,
              code: 'CONSISTENCY_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (args.action === 'copilot') {
          const projectId = activeProjectId();
          if (!projectId) {
            return { ok: false, code: 'NO_PROJECT', message: '画布没有打开项目。' };
          }
          try {
            const nodes = await readLiveNodes();
            const memory = projectMemory.get(projectId);
            const anchors = anchorList(projectId);
            const openBatches = generationPlans
              .list(projectId)
              .filter((plan) => plan.state === 'pending' || plan.state === 'running').length;
            const openJobs = canvasJobs
              .list(projectId)
              .filter((job) => ['running', 'awaiting-approval', 'waiting'].includes(job.state))
              .map((job) => ({ id: job.id, name: job.name, state: job.state }));
            const suggestions: CopilotSuggestion[] = buildCopilotSuggestions({
              nodes,
              memory,
              openBatches,
              openJobs,
            });
            return {
              ok: true,
              action: 'copilot',
              result: {
                summary: copilotSummary(suggestions),
                suggestions,
                consistency: coverageReport(nodes, anchors),
                memory: {
                  entries: memory.entries.length,
                  anchors: memory.anchors.map((anchor) => anchor.title),
                },
              } as unknown as ToolJson,
            };
          } catch (error) {
            return {
              ok: false,
              code: 'COPILOT_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (args.action === 'job') {
          const input = ((args as { job?: unknown }).job ?? {}) as Record<string, unknown>;
          const op = typeof input.op === 'string' ? input.op : 'create';
          if (op === 'create') {
            /**
             * v1.63：job 也可以直接吃 brief —— 用意图编译器把「一句话做完整短片」
             * 变成 shots，模型不必先自己编一遍镜头清单（硬指标：6 镜 ≤3 轮）。
             * 显式给 shots 时优先用 shots，编译只作为缺省。
             */
            let jobInput = input;
            if (!Array.isArray(input.shots) && typeof input.brief === 'string' && input.brief.trim()) {
              const projectId = activeProjectId();
              const memory = projectId ? projectMemory.get(projectId) : null;
              const compiled = compileIntent(
                {
                  brief: input.brief,
                  ...(input.shotsCount !== undefined ? { shots: input.shotsCount } : {}),
                  ...(input.type !== undefined ? { type: input.type } : {}),
                  ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
                  ...(input.duration !== undefined ? { duration: input.duration } : {}),
                  ...(input.model !== undefined ? { model: input.model } : {}),
                  ...(input.style !== undefined ? { style: input.style } : {}),
                },
                {
                  style: memory?.entries.filter((entry) => entry.kind === 'style').map((entry) => entry.text),
                  characters: memory?.entries
                    .filter((entry) => entry.kind === 'character')
                    .map((entry) => entry.text),
                  rules: memory?.entries.filter((entry) => entry.kind === 'rule').map((entry) => entry.text),
                  locks: projectId ? assetLibrary.locksFor(projectId) : [],
                },
              );
              if ('error' in compiled) {
                return { ok: false, code: 'INVALID', action: 'job', message: compiled.error };
              }
              jobInput = { ...input, shots: compiled.plan.shots };
            }

            const created = canvasJobs.create(jobInput, {
              sessionId: sessionId ?? 'dsh',
              projectId: activeProjectId(),
            });
            if (created.error) {
              return { ok: false, code: 'INVALID', action: 'job', message: created.error };
            }
            return {
              ok: true,
              action: 'job',
              result: {
                job: created.job,
                hint:
                  '任务在后台跑：建节点 → 锁参考 → 准备批次，然后等你在画布右下角点「确认本批生成与费用」。' +
                  '失败会自动准备重试批次（仍需你确认）；用 action:"job" op:"status" 查进度。',
              } as unknown as ToolJson,
            };
          }
          const projectId = activeProjectId();
          if (op === 'list') {
            return {
              ok: true,
              action: 'job',
              result: { jobs: canvasJobs.list(projectId || undefined) } as unknown as ToolJson,
            };
          }
          const id = typeof input.id === 'string' ? input.id : '';
          if (!id) return { ok: false, code: 'INVALID', message: 'job 需要 id（status/cancel）。' };
          if (op === 'status') {
            const job = canvasJobs.get(id);
            return job
              ? { ok: true, action: 'job', result: { job } as unknown as ToolJson }
              : { ok: false, code: 'NOT_FOUND', message: '没有这个长任务。' };
          }
          if (op === 'cancel') {
            const job = canvasJobs.cancel(id);
            return job
              ? { ok: true, action: 'job', result: { job } as unknown as ToolJson }
              : { ok: false, code: 'NOT_FOUND', message: '没有这个长任务。' };
          }
          return { ok: false, code: 'INVALID', message: `未知 op：${op}（create/list/status/cancel）。` };
        }

        // ----------------------------------------------------------
        // v1.63（P2）：意图编译器 / 质量评估 / 多 agent / 资产库
        //
        // 四项都尽量在 host 侧做确定性计算：编译器不调模型、评估只读文件头、
        // 任务包是纯模板、资产库是 JSON 文件。需要改画布时才走普通 edit。
        // ----------------------------------------------------------
        if (args.action === 'intent') {
          const projectId = activeProjectId();
          const memory = projectId ? projectMemory.get(projectId) : null;
          const input = (args as { intent?: unknown }).intent;
          const compiled = compileIntent(input, {
            style: memory?.entries.filter((entry) => entry.kind === 'style').map((entry) => entry.text),
            characters: memory?.entries.filter((entry) => entry.kind === 'character').map((entry) => entry.text),
            rules: memory?.entries.filter((entry) => entry.kind === 'rule').map((entry) => entry.text),
            locks: projectId ? assetLibrary.locksFor(projectId) : [],
          });
          if ('error' in compiled) {
            return { ok: false, code: 'INVALID', action: 'intent', message: compiled.error };
          }
          const plan = compiled.plan;
          const planJson = plan as unknown as ToolJson;
          const op = (() => {
            const value = (input as { op?: unknown } | null)?.op;
            return typeof value === 'string' ? value : 'compile';
          })();
          if (op !== 'apply') {
            return {
              ok: true,
              action: 'intent',
              result: {
                plan: planJson,
                hint:
                  'op:"compile" 只返回计划，不改画布；确认后用 op:"apply" 一次展开成节点。' +
                  '生成仍需在画布右下角点「确认本批生成与费用」。',
              } as unknown as ToolJson,
            };
          }
          const anchorId =
            typeof (input as { anchorId?: unknown } | null)?.anchorId === 'string'
              ? String((input as { anchorId: string }).anchorId)
              : '';
          const expansion = await expandShotList(
            {
              name: 'shot-list',
              shots: plan.shots,
              columns: plan.columns,
              ...(anchorId ? { anchorId } : {}),
            },
            sessionId,
          );
          if (!expansion.ok) {
            return {
              ok: false,
              code: expansion.code,
              action: 'intent',
              message: expansion.message,
              ...(expansion.response ? { result: expansion.response as unknown as ToolJson } : {}),
            };
          }
          if (sessionId && typeof expansion.response.operationId === 'string') {
            chatHub.noteCanvasAction(sessionId, {
              action: 'recipe',
              ok: true,
              operationId: expansion.response.operationId,
            });
          }
          return {
            ok: true,
            action: 'intent',
            result: { plan: planJson, ...expansion.response } as unknown as ToolJson,
          };
        }

        if (args.action === 'review') {
          const projectId = activeProjectId();
          if (!projectId) {
            return { ok: false, code: 'NO_PROJECT', message: '画布没有打开项目，无法评估。' };
          }
          try {
            const input = ((args as { review?: unknown }).review ?? {}) as Record<string, unknown>;
            const op = typeof input.op === 'string' ? input.op : 'scan';
            const nodes = await readLiveNodes();
            const anchors = anchorList(projectId);
            const coverage = coverageReport(nodes, anchors);
            const report = reviewCanvas({
              nodes,
              uncovered: coverage.uncovered,
              resolvePath: (url) => mediaStore.localPathForUrl(url)?.path ?? null,
            });
            const reportJson = { ...report, coverage } as unknown as ToolJson;
            if (op !== 'fix' && input.apply !== true) {
              return {
                ok: true,
                action: 'review',
                result: { report: reportJson } as unknown as ToolJson,
              };
            }
            const prompts = new Map<string, string>();
            for (const raw of nodes) {
              if (!raw || typeof raw !== 'object') continue;
              const node = raw as Record<string, unknown>;
              if (typeof node.id === 'string' && typeof node.prompt === 'string') {
                prompts.set(node.id, node.prompt);
              }
            }
            const fixes = planPromptFixes(report, prompts);
            let applied = 0;
            let receipt: Record<string, unknown> = {};
            if (input.apply === true && fixes.operations.length > 0) {
              const read = (await bridge.request({ action: 'read' }, { sessionId })) as {
                revision?: unknown;
              } | null;
              const revision = typeof read?.revision === 'string' ? read.revision : '';
              if (!revision) {
                return { ok: false, code: 'NEED_REVISION', message: '画布没有返回 revision。' };
              }
              const editResult = (await bridge.request(
                { action: 'edit', revision, operations: fixes.operations },
                { sessionId },
              )) as Record<string, unknown> | null;
              if (editResult && editResult.ok === false) {
                return {
                  ok: false,
                  code: typeof editResult.code === 'string' ? editResult.code : 'CANVAS_REJECTED',
                  action: 'review',
                  message: '画布拒绝了提示词修补操作（update 只接受 title/prompt/text/x/y）。',
                };
              }
              applied = fixes.operations.length;
              receipt = (editResult ?? {}) as Record<string, unknown>;
              await flushCanvasSave(sessionId, editResult?.revision);
            }
            return {
              ok: true,
              action: 'review',
              result: {
                ...receipt,
                report: reportJson,
                fixes: { applied, patches: fixes.patches as unknown as ToolJson },
                hint:
                  input.apply === true
                    ? '已把缺失的固定串追加到提示词末尾（只追加，不重写原文）。'
                    : 'op:"fix" 只给修补计划；带 apply:true 才会写进画布。',
              } as unknown as ToolJson,
            };
          } catch (error) {
            return {
              ok: false,
              code: 'REVIEW_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (args.action === 'assetlibrary') {
          const projectId = activeProjectId();
          if (!projectId) {
            return { ok: false, code: 'NO_PROJECT', message: '画布没有打开项目，无法读写资产库。' };
          }
          const input = ((args as { assetlibrary?: unknown }).assetlibrary ?? {}) as Record<string, unknown>;
          const op = typeof input.op === 'string' ? input.op : 'list';
          try {
            if (op === 'list') {
              return {
                ok: true,
                action: 'assetlibrary',
                result: {
                  entries: assetLibrary.list(projectId) as unknown as ToolJson,
                  summary: assetLibrary.summary(projectId) as unknown as ToolJson,
                  anchors: assetLibrary.anchorsFor(projectId) as unknown as ToolJson,
                  locks: assetLibrary.locksFor(projectId) as unknown as ToolJson,
                  hint: '资产卡片要能被 intent 自动织进每镜提示词；use 会把已挂定妆节点的资产登记成参考锚点并锁到镜头上。',
                } as unknown as ToolJson,
              };
            }
            if (op === 'add' || op === 'update') {
              const entry = await assetLibrary.upsert(projectId, input);
              return entry
                ? { ok: true, action: 'assetlibrary', result: { entry: entry as unknown as ToolJson } as unknown as ToolJson }
                : {
                    ok: false,
                    code: 'INVALID',
                    message: '资产需要 name（kind 取 character/scene/prop/style）；同名同类型原地更新，满了要删旧条目。',
                  };
            }
            if (op === 'remove') {
              const id = typeof input.id === 'string' ? input.id : '';
              const removed = await assetLibrary.remove(projectId, id);
              return removed
                ? { ok: true, action: 'assetlibrary', result: { removed: id } as unknown as ToolJson }
                : { ok: false, code: 'NOT_FOUND', message: '没有这条资产。' };
            }
            if (op === 'link') {
              const id = typeof input.id === 'string' ? input.id : '';
              const nodeId = typeof input.nodeId === 'string' && input.nodeId ? input.nodeId : null;
              const entry = await assetLibrary.setNode(projectId, id, nodeId);
              return entry
                ? { ok: true, action: 'assetlibrary', result: { entry: entry as unknown as ToolJson } as unknown as ToolJson }
                : { ok: false, code: 'NOT_FOUND', message: '没有这条资产。' };
            }
            if (op === 'import') {
              const locks = Array.isArray(input.locks) ? input.locks : [];
              const saved: unknown[] = [];
              const rejected: Array<{ index: number; reason: string }> = [];
              for (let index = 0; index < locks.length; index += 1) {
                const entry = await assetLibrary.upsert(projectId, locks[index]);
                if (entry) saved.push(entry);
                else rejected.push({ index, reason: '缺 name 或超过每项目上限' });
              }
              return {
                ok: true,
                action: 'assetlibrary',
                result: { entries: saved, rejected } as unknown as ToolJson,
              };
            }
            if (op === 'use') {
              const id = typeof input.id === 'string' ? input.id : '';
              const entry = assetLibrary.get(projectId, id);
              if (!entry) return { ok: false, code: 'NOT_FOUND', message: '没有这条资产。' };
              if (!entry.nodeId) {
                return {
                  ok: false,
                  code: 'NEED_NODE',
                  message:
                    '这条资产没有挂画布节点：先 op:"link" 把定妆/定版节点绑上，或把锁定串写进提示词（intent 会自动织入）。',
                };
              }
              let nodes = await readLiveNodes();
              const known = new Set(
                nodes.flatMap((raw) => {
                  if (!raw || typeof raw !== 'object') return [];
                  const value = (raw as { id?: unknown }).id;
                  return typeof value === 'string' ? [value] : [];
                }),
              );
              if (known.size > 0 && !known.has(entry.nodeId)) {
                return {
                  ok: false,
                  code: 'NODE_GONE',
                  message: `资产「${entry.name}」绑的节点 ${entry.nodeId} 不在当前画布上，重新 link 一个定妆节点。`,
                };
              }
              const anchors = await projectMemory.addAnchor(projectId, {
                nodeId: entry.nodeId,
                title: entry.name,
                role: entry.kind === 'character' ? 'character' : entry.kind === 'style' ? 'style' : 'prop',
              });
              if (!anchors) {
                return { ok: false, code: 'INVALID', message: '锚点需要有效 nodeId。' };
              }
              const anchorInputs = anchorList(projectId);
              const read = (await bridge.request({ action: 'read' }, { sessionId })) as {
                revision?: unknown;
                nodes?: unknown;
              } | null;
              const revision = typeof read?.revision === 'string' ? read.revision : '';
              if (!revision) return { ok: false, code: 'NEED_REVISION', message: '画布没有返回 revision。' };
              const wanted = Array.isArray((args as { nodeIds?: unknown }).nodeIds)
                ? (args as { nodeIds: unknown[] }).nodeIds.filter(
                    (value): value is string => typeof value === 'string' && value.length > 0,
                  )
                : undefined;
              const plan = planLockOperations(nodes, anchorInputs, wanted);
              if (plan.operations.length > 0) {
                const editResult = (await bridge.request(
                  { action: 'edit', revision, operations: plan.operations },
                  { sessionId },
                )) as Record<string, unknown> | null;
                if (editResult && editResult.ok === false) {
                  return {
                    ok: false,
                    code: typeof editResult.code === 'string' ? editResult.code : 'CANVAS_REJECTED',
                    message: '画布拒绝了参考连线操作。',
                  };
                }
                await flushCanvasSave(sessionId, editResult?.revision);
                nodes = await readLiveNodes();
              }
              return {
                ok: true,
                action: 'assetlibrary',
                result: {
                  op,
                  entry: entry as unknown as ToolJson,
                  operations: plan.operations.length,
                  coverage: coverageReport(nodes, anchorInputs) as unknown as ToolJson,
                } as unknown as ToolJson,
              };
            }
            return {
              ok: false,
              code: 'INVALID',
              message: `未知 op：${op}（list/add/update/remove/link/import/use）。`,
            };
          } catch (error) {
            return {
              ok: false,
              code: 'ASSET_LIBRARY_FAILED',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }

        if (args.action === 'crew') {
          const input = ((args as { crew?: unknown }).crew ?? {}) as Record<string, unknown>;
          const op = typeof input.op === 'string' ? input.op : 'plan';
          const projectId = activeProjectId();
          if (op === 'plan') {
            let nodes: unknown[] = [];
            try {
              nodes = await readLiveNodes();
            } catch {
              nodes = [];
            }
            const memory = projectId ? projectMemory.get(projectId) : null;
            const byType: Record<string, number> = {};
            for (const raw of nodes) {
              if (!raw || typeof raw !== 'object') continue;
              const type = String((raw as { type?: unknown }).type ?? 'unknown');
              byType[type] = (byType[type] ?? 0) + 1;
            }
            const planned = planCrew(input, {
              ...(projectId && canvasStore.getDocument(projectId)?.title
                ? { projectTitle: canvasStore.getDocument(projectId)?.title }
                : {}),
              style: (memory?.entries ?? [])
                .filter((entry) => entry.kind === 'style')
                .map((entry) => entry.text)
                .join('；'),
              assets: projectId
                ? assetLibrary.list(projectId).map((entry) => ({ name: entry.name, kind: entry.kind }))
                : [],
              ...(typeof input.shots === 'number' ? { shotCount: input.shots } : {}),
              digest: { nodes: nodes.length, byType },
            });
            if ('error' in planned) {
              return { ok: false, code: 'INVALID', action: 'crew', message: planned.error };
            }
            return {
              ok: true,
              action: 'crew',
              result: {
                plan: planned.plan as unknown as ToolJson,
                hint:
                  '每个 assignment 都是一条可直接派给 DSH 子代理的任务（角色/交付 JSON/边界/压过的上下文）。' +
                  '子代理只能回 JSON，不能提交生成；收回来后用 op:"receive" 校验，再 apply 展开。',
              } as unknown as ToolJson,
            };
          }
          if (op === 'receive') {
            const received = receiveCrew(input);
            if ('error' in received) {
              return { ok: false, code: 'INVALID', action: 'crew', message: received.error };
            }
            const { result } = received;
            const response: Record<string, unknown> = { ...result };
            if (result.acceptedLocks.length > 0 && input.importLocks !== false && projectId) {
              const imported: unknown[] = [];
              for (const lock of result.acceptedLocks) {
                const entry = await assetLibrary.upsert(projectId, lock);
                if (entry) imported.push(entry);
              }
              if (imported.length > 0) response.imported = imported;
            }
            if (result.acceptedShots.length > 0 && input.apply === true) {
              const columns = Number(input.columns);
              const expansion = await expandShotList(
                {
                  name: 'shot-list',
                  shots: result.acceptedShots,
                  ...(Number.isFinite(columns) ? { columns: Math.max(1, Math.min(6, Math.trunc(columns))) } : {}),
                  ...(typeof input.anchorId === 'string' && input.anchorId ? { anchorId: input.anchorId } : {}),
                },
                sessionId,
              );
              if (!expansion.ok) {
                return {
                  ok: false,
                  code: expansion.code,
                  action: 'crew',
                  message: expansion.message,
                  ...(expansion.response ? { result: expansion.response as unknown as ToolJson } : {}),
                };
              }
              Object.assign(response, expansion.response);
            }
            return { ok: true, action: 'crew', result: response as unknown as ToolJson };
          }
          return { ok: false, code: 'INVALID', message: `未知 op：${op}（plan/receive）。` };
        }

        // ----------------------------------------------------------
        // 其余动作交给画布：host 把指令长轮询下发，画布内 controlExecutor 执行后回执
        // ----------------------------------------------------------
        const command = buildCanvasCommand(args as unknown as CanvasToolArgs);
        if (typeof command === 'string') {
          return { ok: false, code: 'NEED_COMMAND', message: command };
        }
        try {
          /**
           * v1.52：edit 允许不带 revision —— host 先自己读一次补上。
           *
           * 「先 read 拿 revision、再 edit」原本是两次模型往返；现在补 revision 这一步
           * 只在 host ↔ 画布之间发生（毫秒级、不经过模型），模型一次调用就能完成「读+改」。
           * 两次下发之间画布若被改，照旧返回 CONFLICT，模型重试一次即可 —— 语义没变。
           *
           * v1.53：edit 里含 create 时，这一次 read 顺便用于**落位避让**
           * （见 canvas/nodePlacement.ts）—— 新节点不会盖在已有节点上面。
           */
          if (command.action === 'edit') {
            const operations = Array.isArray(command.operations)
              ? (command.operations as unknown[])
              : [];
            const needsPlacement = operations.some(
              (operation) =>
                operation !== null &&
                typeof operation === 'object' &&
                (operation as { kind?: unknown }).kind === 'create',
            );
            if (typeof command.revision !== 'string' || needsPlacement) {
              let readResult: { revision?: unknown; nodes?: unknown } | null = null;
              try {
                readResult = (await bridge.request({ action: 'read' }, { sessionId })) as {
                  revision?: unknown;
                  nodes?: unknown;
                } | null;
              } catch (error) {
                // 已带 revision 时，落位读失败不该阻塞编辑本身（画布仍会校验 revision）。
                if (typeof command.revision !== 'string') throw error;
              }
              if (typeof command.revision !== 'string') {
                const revision = readResult?.revision;
                if (typeof revision === 'string' && revision) command.revision = revision;
                else
                  return {
                    ok: false,
                    code: 'NEED_REVISION',
                    message: '画布没有返回 revision，无法补全 edit；请先 action:"read" 再重试。',
                  };
              }
              if (needsPlacement && readResult) {
                const nodes = Array.isArray(readResult.nodes) ? readResult.nodes : [];
                command.operations = placeCreateOperations(
                  operations,
                  nodes as CanvasPlacementNode[],
                );
              }
            }
          }

          const result = (await bridge.request(command, { sessionId })) as
            | { ok?: unknown; code?: unknown }
            | null;

          /**
           * 落盘（v1.58）：改动文档的动作执行成功之后，立刻让画布保存一次。
           * 与下面的快照读取**并行**发下去 —— 快照是纯读、保存只认 revision 令牌，
           * 两者互不影响，所以不会多花一次往返的时间。
           */
          const savePromise =
            result &&
            typeof result === 'object' &&
            result.ok !== false &&
            SAVE_AFTER_ACTIONS.has(String(args.action))
              ? flushCanvasSave(sessionId, (result as { revision?: unknown }).revision)
              : null;

          /**
           * v1.52：edit 成功回带精简快照 —— 模型不用再 read 验证（再省一次往返）。
           *
           * 快照只是「省一次工具调用」的便利：读失败（画布恰好在忙/超时）不能让已经
           * 成功的 edit 变成失败，所以整段吞掉异常。
           */
          if (
            args.action === 'edit' &&
            result &&
            typeof result === 'object' &&
            result.ok !== false
          ) {
            try {
              const snapshot = (await bridge.request({ action: 'read' }, { sessionId })) as unknown;
              if (snapshot && typeof snapshot === 'object') {
                (result as Record<string, unknown>).snapshot = summarizeCanvasRead(snapshot, {
                  maxTextChars: 160,
                });
              }
            } catch {
              /* 快照失败不影响 edit 结果 */
            }
          }

          // 画布对话面板里跑的工具调用：把动作回执转给面板，让它在消息下面画「画布动作」卡片
          if (sessionId && (args.action === 'edit' || args.action === 'undo')) {
            const receipt = (result ?? {}) as Record<string, unknown>;
            const note: CanvasActionNote = {
              action: String(args.action),
              ok: receipt.ok !== false,
              ...(typeof receipt.operationId === 'string' ? { operationId: receipt.operationId } : {}),
              ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
            };
            chatHub.noteCanvasAction(sessionId, note);
          }
          // 画布明确拒绝（revision 冲突 / NOT_FOUND / 指令无效…）时，把失败提到工具顶层，
          // 让模型一眼看到 ok:false，而不是埋在 result 里被忽略。
          if (result && typeof result === 'object' && result.ok === false) {
            return {
              ok: false,
              code: typeof result.code === 'string' ? result.code : 'CANVAS_REJECTED',
              action: args.action,
              message: `画布拒绝了这次操作：${String(result.code ?? 'CANVAS_REJECTED')}。`,
              result: result as unknown as ToolJson,
            };
          }
          // read 默认减重（正文截断 + 提示 detail:"full"）；detail:"full" 原样返回；
          // view:"digest" 走项目摘要（不含正文，带统计与 hints）。
          const detail = (args as { detail?: unknown }).detail;
          const view = (args as { view?: unknown }).view;
          const saved = savePromise ? await savePromise : null;
          /**
           * digest 的补充段（v1.59）：记忆条数、一致性覆盖率、可执行建议。
           *
           * 放在 digest 里而不是另开一个工具：模型做规划时本来就要先读摘要，
           * 顺手拿到「这个项目记着什么、哪些镜头没锁、当前最该做什么」，省一次往返。
           */
          let digestExtra: Record<string, unknown> | undefined;
          if (view === 'digest' && result && typeof result === 'object') {
            try {
              const rawNodes = (result as { nodes?: unknown }).nodes;
              const nodes = Array.isArray(rawNodes) ? rawNodes : [];
              const projectId = activeProjectId();
              const memory: ProjectMemoryBlock = projectId
                ? projectMemory.get(projectId)
                : { projectId: '', entries: [], anchors: [], updatedAt: '' };
              const anchors: AnchorInput[] = projectId ? anchorList(projectId) : [];
              const coverage = coverageReport(nodes, anchors);
              const suggestions = buildCopilotSuggestions({ nodes, memory });
              digestExtra = {
                projectId: projectId || null,
                memory: {
                  entries: memory.entries.length,
                  anchors: memory.anchors.map((anchor) => anchor.title),
                  hint: '风格/角色/参数用 action:"memory" 写入，下次会话自动注入。',
                },
                assets: projectId ? assetLibrary.summary(projectId) : { entries: 0, byKind: {}, linked: 0 },
                consistency: {
                  shots: coverage.shots,
                  covered: coverage.covered,
                  uncovered: coverage.uncovered.length,
                  summary: coverage.summary,
                },
                copilot: {
                  summary: copilotSummary(suggestions),
                  suggestions: suggestions.map((item) => `${item.level}: ${item.title}`),
                },
              };
            } catch {
              /* 摘要补充失败不影响 digest 本身 */
            }
          }
          return {
            ok: true,
            action: args.action,
            // 落盘结果：saved / failed / unknown（见 flushCanvasSave 的注释）。
            // 画布已经改好了才走到这里，所以 ok 仍是 true；`saved:false` 是在告诉模型
            // 「看着改成功了，但盘上没有」——这句话以前没人说得出来。
            ...(saved ? { saved } : {}),
            ...(saved === 'failed'
              ? {
                  message:
                    '画布已经按这次操作改好了，但**保存到磁盘失败**（画布报告 UNCONFIRMED）。' +
                    '请提醒用户在画布里点一次「保存」并核对；不要重复提交同样的编辑。',
                }
              : {}),
            result: summarizeCanvasRead(result, {
              full: detail === 'full',
              digest: view === 'digest',
              ...(digestExtra ? { digestExtra } : {}),
            }) as unknown as ToolJson,
          };
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'CANVAS_BRIDGE_FAILED';
          return {
            ok: false,
            code,
            message: error instanceof Error ? error.message : String(error),
            ...(code === 'NO_OPEN_CANVAS'
              ? { hint: '请在 DSH 侧边栏点开「无限画布」面板，并在画布里新建或打开一个项目，然后重试。' }
              : {}),
          };
        }
      },
    }),
  );

  ctx.logger?.info?.('[aifisher-canvas] host plugin loaded');
}

// ---------------------------------------------------------------- 纯函数出口（v1.59）
// 回归脚本直接 import lib/index.js 拿这些函数做单测：它们没有 I/O，
// 从产物里 import 可以避免测试去跑 TS（node 的类型剥离不支持无扩展名 import）。
export {
  coverageReport,
  orderShots,
  planLockOperations,
  planUnlockOperations,
  shotNumberFromTitle,
} from './canvas/consistency';
export { buildCopilotSuggestions, copilotSummary } from './canvas/copilot';
export type { CopilotSuggestion } from './canvas/copilot';
export { compileIntent, splitBrief, distributeBeats } from './canvas/intent';
export { planPromptFixes, probeImageFile, reviewCanvas } from './canvas/review';
export { planCrew, receiveCrew } from './canvas/crew';
