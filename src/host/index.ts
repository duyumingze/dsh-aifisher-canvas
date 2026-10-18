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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createComfyClient } from './comfyui/comfyClient';
import { attachComfyRoutes, createComfyDelegate } from './comfyui/comfyRouter';
import { createGenerationJournal } from './comfyui/generationJournal';
import { createModelResolver } from './comfyui/modelResolver';
import { attachStaticAssets } from './staticAssets';
import { attachSkillsRoutes, createSkillsCatalog, type DshSkillsService } from './skills/skillsRouter';
import { createCanvasStore } from './canvas/store';
import { createMediaStore } from './canvas/mediaStore';
import { attachCanvasApi } from './canvas/restRouter';
import { applySavedCloudKeys } from './canvas/sourceSettingsRouter';
import { createCanvasBridge } from './canvas/agentBridge';
import { createAgentChatStore } from './canvas/agentChatStore';
import { createCanvasChatHub, type CanvasActionNote } from './canvas/canvasChatHub';
import { buildCanvasCommand, type CanvasToolArgs } from './canvas/commandMapping';
import type { WebServerLike } from './http/httpUtil';
import { dirname, join } from 'node:path';

export const name = 'dsh-aifisher-canvas';
export const inject = ['tools', 'webServer', 'skills'];

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
      chat: { dataDir, store: chatStore, chat: chatHub, mediaStore },
      // 任务队列面板（v1.24）读的生成任务日记：与 ComfyUI 结果回收共用同一份
      tasks: journal,
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

  ctx.tools.register(
    defineTool({
      name: 'canvas_control',
      description:
        'Operate the active AIFISHER infinite canvas. ' +
        'Shortest path is 3 calls: read (get revision + nodes) → edit (same revision + operations) → read (verify). ' +
        'An operation is discriminated by "kind": ' +
        'create{ref,type:"Image"|"Video"|"Audio"|"Text",x,y,title?,prompt?}, ' +
        'update{nodeId,patch{title?,prompt?,x?,y?}}, ' +
        'configure{nodeId,model,parameters}, delete{nodeId}, ' +
        'connect{sourceId,targetId,sourcePort?}, disconnect{sourceId,targetId,targetPort?}, ' +
        'group{ref,nodeIds,label}, ungroup{groupId}, renameGroup{groupId,label}, ' +
        'arrange{nodeIds,columns}, duplicate{nodes[{nodeId,ref}],x,y}. ' +
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
            'skills', 'skillLoad',
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
      async execute(args, exec) {
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
        // 其余动作交给画布：host 把指令长轮询下发，画布内 controlExecutor 执行后回执
        // ----------------------------------------------------------
        const command = buildCanvasCommand(args as unknown as CanvasToolArgs);
        if (typeof command === 'string') {
          return { ok: false, code: 'NEED_COMMAND', message: command };
        }
        try {
          const result = (await bridge.request(command, { sessionId })) as
            | { ok?: unknown; code?: unknown }
            | null;
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
              result,
            };
          }
          return { ok: true, action: args.action, result };
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'CANVAS_BRIDGE_FAILED';
          return {
            ok: false,
            code,
            message: error instanceof Error ? error.message : String(error),
            hint:
              code === 'NO_OPEN_CANVAS'
                ? '请在 DSH 侧边栏点开「无限画布」面板，并在画布里新建或打开一个项目，然后重试。'
                : undefined,
          };
        }
      },
    }),
  );

  ctx.logger?.info?.('[aifisher-canvas] host plugin loaded');
}
