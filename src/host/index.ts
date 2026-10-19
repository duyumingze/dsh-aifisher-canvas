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
          try {
            const readResult = (await bridge.request({ action: 'read' }, { sessionId })) as {
              revision?: unknown;
              nodes?: unknown;
            } | null;
            const revision = readResult?.revision;
            if (typeof revision !== 'string' || !revision) {
              return {
                ok: false,
                code: 'NEED_REVISION',
                action: 'recipe',
                message: '画布没有返回 revision，无法展开 recipe。',
              };
            }
            const nodes = Array.isArray(readResult?.nodes) ? readResult.nodes : [];
            const planned = buildShotListRecipe((args as { recipe?: unknown }).recipe, nodes);
            if ('error' in planned) {
              return { ok: false, code: 'INVALID', action: 'recipe', message: planned.error };
            }
            const editResult = (await bridge.request(
              { action: 'edit', revision, operations: planned.operations },
              { sessionId },
            )) as Record<string, ToolJson> | null;
            if (editResult && editResult.ok === false) {
              return {
                ok: false,
                code: typeof editResult.code === 'string' ? editResult.code : 'CANVAS_REJECTED',
                action: 'recipe',
                message: `画布拒绝了这次操作：${String(editResult.code ?? 'CANVAS_REJECTED')}。`,
                result: editResult,
              };
            }
            const response: Record<string, ToolJson> = {
              ...(editResult ?? {}),
              recipe: {
                name: 'shot-list',
                shots: planned.count,
                placed: planned.placed as unknown as ToolJson,
                anchorFound: planned.anchorFound,
              },
            };
            try {
              const snapshot = (await bridge.request({ action: 'read' }, { sessionId })) as unknown;
              if (snapshot && typeof snapshot === 'object') {
                response.snapshot = summarizeCanvasRead(snapshot, { maxTextChars: 160 }) as unknown as ToolJson;
              }
            } catch {
              /* 快照失败不影响 recipe 结果 */
            }
            if (sessionId) {
              chatHub.noteCanvasAction(sessionId, {
                action: 'recipe',
                ok: true,
                ...(typeof editResult?.operationId === 'string'
                  ? { operationId: editResult.operationId }
                  : {}),
              });
            }
            return { ok: true, action: 'recipe', result: response };
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
          return {
            ok: true,
            action: args.action,
            result: summarizeCanvasRead(result, {
              full: detail === 'full',
              digest: view === 'digest',
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
