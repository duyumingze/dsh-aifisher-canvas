/**
 * 画布对话面板的「大脑」（host 半）：把面板的消息接到 **DSH 自己的会话**上。
 *
 * 为什么用 DSH 会话而不是另起一套模型调用：
 *   ① 不用多配任何东西 —— 画布助手用的就是 DSH 当前的模型与渠道；
 *   ② 画布控制能力本来就在 DSH 这边 —— `canvas_control` 工具 + agentBridge 长轮询
 *      已经把 read/edit/undo/focus 这一整套打通了，agent 直接调它即可；
 *   ③ 上下文连续 —— 面板里的一条对话 = 一个 DSH 会话，历史、记忆注入、技能都跟着走。
 *
 * 与 DSH 内核的接口（都是**可选服务**，用 ctx.get 惰取，绝不写进 inject —— 见
 * dsh-wechat-plugin 的写法：老宿主没有这些服务时插件仍要能加载）：
 *   ctx.get('sessionController')
 *     .create({sessionId, cwd})                建会话 / 认领已有会话（幂等）
 *     .prompt({requestId, sessionId, mode, content}, signal)   投递一条用户消息
 *     .cancel({sessionId})                     打断当前回合
 *     .modelCatalog() / .selectModel({...})    模型清单与切换
 *   ctx.on('agent/assistant-stream', payload, {global:true})
 *     **一次模型尝试**的流式帧：payload.agent.session.id 指明会话，payload.frame 是
 *     {type:'start'|'chunk'|'end'}；正文在 frame.chunk.type === 'text-delta' 的 text 上。
 *   ctx.on('agent/inbox/claimed', {agent, message, turn}, {global:true})
 *     某条用户消息被领进某个 turn —— 我们用 message.source.rpcId === requestId 反查 turn 号。
 *   ctx.on('session/event', (session, event), {global:true})
 *     **持久事件**（回合级终局只能看它）：event.type === 'turn/end' 带 data.turn/data.reason，
 *     'assistant/message' 带 data.message.content 的完整正文。
 *
 * ⚠️ v1.13 的关键教训：`agent/assistant-stream` 的 end 帧是**一次 attempt** 结束，不是回合结束 ——
 * 一次带工具调用的回合会有多个 attempt（每个 step 一次）。早先拿它当回合收尾，会导致
 * 「工具调用的回合只回一句空话」；而模型没密钥这类失败更是连正文都没有，面板什么都收不到。
 * DSH 自己的插件规范写得很清楚：**正文用 assistant-stream 打字机，收尾等 durable 事件**
 * （turn/end、assistant/message），并且「不要轮询 agent/status、whenIdle 不等于一次投递结束」。
 */
import { randomUUID } from 'node:crypto';
import type { AgentChatStore } from './agentChatStore';

/** 只取我们用到的字段，避免对 DSH 内部类型包产生构建期依赖。 */
interface DshSessionControllerLike {
  create(request: {
    sessionId?: string;
    cwd?: string;
    workspaceId?: string;
    agentPreset?: string;
  }): Promise<{ sessionId?: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue' | 'steer';
      content: readonly { type: 'text'; text: string }[];
    },
    signal: AbortSignal,
  ): Promise<{ accepted?: boolean }>;
  cancel?(request: { sessionId: string }): Promise<unknown>;
  modelCatalog?(): Promise<ModelCatalogLike>;
  selectModel?(request: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }): Promise<unknown>;
}

interface ModelCatalogLike {
  default?: { provider?: string; model?: string };
  groups?: Array<{
    id?: string;
    name?: string;
    models?: Array<{ id?: string; name?: string; description?: string }>;
  }>;
  failures?: Array<{ id?: string; name?: string; message?: string }>;
}

/** `ctx.llm`：只取「可配置来源」这张表（拿 apiKeyEnv 用）。 */
interface LlmLike {
  listConfigurableProviders?(): Array<{
    provider?: string;
    displayName?: string;
    settingsNs?: string;
    settingsPath?: string[];
  }>;
}

/** `ctx.get('settings').describe({redactSecrets})`：读来源配置（含 apiKeyEnv 引用名）。 */
interface SettingsLike {
  describe?(options: { redactSecrets: boolean }): Array<{ ns?: string; value?: unknown }>;
}

/** `ctx.get('credentials').describe(ref)`：只关心「配没配」。
 *  host 侧服务是单参（回 `{configured}`），Remote 那层是数组参（回 `{ref: {configured}}`）——
 *  两种形状都认，认不出来就当可用（宁多勿少）。 */
interface CredentialsLike {
  describe?(
    ref: string,
  ):
    | Promise<{ configured?: boolean } | Record<string, { configured?: boolean }>>
    | { configured?: boolean }
    | Record<string, { configured?: boolean }>;
}

/** canvas_control 跑完之后要回给面板的动作卡片（vendor 的 CanvasActionLog 精简版）。 */
export interface CanvasActionNote {
  action: string;
  ok: boolean;
  operationId?: string;
  code?: string;
}

interface CordisLike {
  get?(name: string): unknown;
  on?(
    name: string,
    listener: (...args: unknown[]) => void,
    options?: Record<string, unknown>,
  ): unknown;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
}

export interface CanvasChatModel {
  /** 面板里选择的模型 id，形状 `<provider>/<model>`（切模型时按它拆回两半）。 */
  id: string;
  label: string;
  vision: 'supported' | 'unsupported' | 'unknown';
}

export interface CanvasChatTurnInput {
  chatId: string;
  text: string;
  /** 面板选的模型（`<provider>/<model>`，来自本模块的 models()）。 */
  model?: string;
  /** 当前画布项目 id（写进上下文提示，也让诊断可查）。 */
  projectId?: string;
  onDelta?(token: string): void;
  /** canvas_control 真跑过之后回调（面板据此画「画布动作」卡片）。 */
  onCanvasResult?(action: CanvasActionNote): void;
  signal?: AbortSignal;
}

export interface CanvasChatTurnResult {
  text: string;
  dshSessionId: string;
}

interface ActiveTurn {
  chatId: string;
  dshSessionId: string;
  text: string;
  /** 一次投递的 requestId：用它把 agent/inbox/claimed 里的消息认成自己的 turn。 */
  requestId: string;
  /** 本回合的 turn 号（由 agent/inbox/claimed 反查；查不到时为 null）。 */
  turnNumber: number | null;
  /** 最后一次 assistant/message 的完整正文（比增量拼接权威）。 */
  finalText: string | null;
  /** agent/error 报上来的失败（turn/end 缺席时兜底）。 */
  errorText: string | null;
  /** 面板选的模型（`provider/model`），失败文案里要带上它。 */
  model?: string;
  failure: Error | null;
  onDelta?: (token: string) => void;
  onCanvasResult?: (action: CanvasActionNote) => void;
  settle(): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CanvasChatHubOptions {
  ctx: CordisLike;
  store: AgentChatStore;
  /** 会话的工作目录（DSH 会把会话挂在它下面；同一会话每次必须给同一个）。 */
  cwd: string;
  /** 回合最长等待（默认 20 分钟，`DSH_AIFISHER_CHAT_TIMEOUT_MS` 可覆盖）。 */
  timeoutMs?: number;
}

export class CanvasChatUnavailableError extends Error {
  readonly code = 'CHAT_UNAVAILABLE';
  constructor(message = 'DSH 会话服务不可用，画布对话无法接入。') {
    super(message);
  }
}

export class CanvasChatBusyError extends Error {
  readonly code = 'CHAT_BUSY';
  constructor(message = '这条画布对话正在回答，请等它结束或点停止。') {
    super(message);
  }
}

/** 回合以失败收尾（模型没密钥 / 会话被拦 / 被中止…）：code 会随 SSE error 事件发给面板。 */
export class CanvasChatTurnError extends Error {
  readonly code: string;
  constructor(message: string, code = 'CHAT_FAILED') {
    super(message);
    this.name = 'CanvasChatTurnError';
    this.code = code;
  }
}

/** `session/event` 的第一个参数（Session）：header.id 与 id 都取，兼容两种形状。 */
function sessionIdOf(session: unknown): string | null {
  const value = session as { header?: { id?: unknown }; id?: unknown } | null | undefined;
  const id = value?.header?.id ?? value?.id;
  return typeof id === 'string' && id ? id : null;
}

/** 持久事件的形状：`{type, seq, time, data}`。 */
interface DurableEventLike {
  type?: unknown;
  seq?: unknown;
  data?: Record<string, unknown>;
}

/** assistant/message 的正文（content 里 type === 'text' 的块）。 */
function assistantMessageText(message: unknown): string {
  const blocks = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => {
      const item = block as { type?: unknown; text?: unknown } | null;
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

/**
 * turn/end 的 reason → 面板该看到的失败；null 表示这一轮正常收尾。
 *
 * 形状来自 DSH：`{kind:'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | …}`，
 * 其中 error 带 `{message, code}`（例如 MISSING_CREDENTIAL = 这个模型在 DSH 里没配密钥）。
 */
function failureFromTurnEnd(reason: unknown, model: string | undefined): Error | null {
  const value = reason as { kind?: unknown; error?: unknown } | null | undefined;
  const kind = typeof value?.kind === 'string' ? value.kind : '';
  if (kind === 'completed' || kind === 'max-tokens' || kind === '') return null;
  if (kind === 'aborted') return new CanvasChatTurnError('已请求停止。', 'CHAT_ABORTED');
  if (kind === 'blocked') {
    return new CanvasChatTurnError('这一轮被 DSH 拦下了（会话可能已归档）。', 'CHAT_BLOCKED');
  }
  if (kind === 'interrupted' || kind === 'forked') return null;
  const failure = value?.error as { message?: unknown; code?: unknown } | null | undefined;
  const code = typeof failure?.code === 'string' ? failure.code : 'CHAT_FAILED';
  const raw =
    typeof failure?.message === 'string' && failure.message
      ? failure.message
      : `模型调用失败（${kind}）。`;
  if (code === 'MISSING_CREDENTIAL') {
    // 真机上最常见的一条：面板下拉里那条模型在 DSH 里没有密钥。把「怎么修」写清楚，
    // 否则用户只会看到「点击发送没有回应」。
    return new CanvasChatTurnError(
      `这个模型在 DSH 里还没有配密钥（${model ? `${model} · ` : ''}${raw}）。` +
        '请在面板左下角换一个模型，或在 DSH 的「模型」页给这个来源填上 Key。',
      code,
    );
  }
  return new CanvasChatTurnError(raw, code);
}

/** 画布助手会话的上下文提示：只在会话的第一回合注入一次。 */
export function canvasChatInstructions(projectId: string | undefined): string {
  const lines = [
    '【画布助手模式】你正在「无限画布」右侧的对话面板里回答用户，用户就是画布的主人。',
  ];
  if (projectId) lines.push(`当前画布项目 id：${projectId}。`);
  lines.push(
    '要看画布或改画布，用 canvas_control 工具：先 action:"read" 拿 revision 与节点清单，',
    '再用 action:"edit" 带同一个 revision 和 operations 增删改连节点；生成图片/视频优先走画布节点',
    '（edit 建节点 → prepareGeneration/runGeneration 跑），不要自己直接调云端接口。',
    '回答简短、用中文，不要贴大段 JSON 或工具原始输出。',
    '（这是插件注入的上下文提示，不是用户消息。）',
  );
  return lines.join('');
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createCanvasChatHub(options: CanvasChatHubOptions) {
  const { ctx, store } = options;
  const cwd = options.cwd;
  const envTimeout = Number(process.env.DSH_AIFISHER_CHAT_TIMEOUT_MS);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 20 * 60_000);

  /** dshSessionId → 正在进行的回合（assistant-stream 按它分发）。 */
  const turns = new Map<string, ActiveTurn>();
  /** 已经注入过上下文提示的会话。 */
  const instructed = new Set<string>();
  /** dshSessionId → 当前画布项目（上下文提示与诊断用）。 */
  const projects = new Map<string, string>();
  let streamHookBound = false;
  let streamFrames = 0;
  /** durable session/event 是否绑上了 —— 绑不上就退回「attempt end 收尾」的老行为。 */
  let durableBound = false;
  let durableEvents = 0;
  let turnEndEvents = 0;

  function log(message: string, detail?: unknown): void {
    try {
      ctx.logger?.info?.(`[aifisher-canvas] ${message}`, detail ?? '');
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  function controller(): DshSessionControllerLike | null {
    try {
      const service = ctx.get?.('sessionController') as DshSessionControllerLike | undefined;
      return service && typeof service.create === 'function' && typeof service.prompt === 'function'
        ? service
        : null;
    } catch {
      return null;
    }
  }

  function finishTurn(turn: ActiveTurn, failure: Error | null): void {
    if (turns.get(turn.dshSessionId) !== turn) return;
    turns.delete(turn.dshSessionId);
    clearTimeout(turn.timer);
    turn.failure = failure;
    turn.settle();
  }

  /**
   * 绑定宿主事件：只在真的用到画布对话时才绑，且只绑一次。
   *
   * 三件事：
   *   ① `agent/assistant-stream` —— 打字机（正文增量），**不**拿它判定回合结束；
   *   ② `agent/inbox/claimed`  —— 用 requestId 把「本回合的 turn 号」查出来，收尾时对号入座；
   *   ③ `session/event`        —— durable 事件，`turn/end` 才是这一轮的终局，
   *                              `assistant/message` 是权威正文（比拼接增量可靠）。
   */
  function bindStream(): void {
    if (streamHookBound) return;
    streamHookBound = true;
    try {
      ctx.on?.(
        'agent/assistant-stream',
        (payload: unknown) => {
          const frame = (payload as { frame?: unknown })?.frame as
            | { type?: unknown; chunk?: { type?: unknown; text?: unknown } }
            | undefined;
          const sessionId = (payload as { agent?: { session?: { id?: unknown } } })?.agent?.session
            ?.id;
          if (typeof sessionId !== 'string') return;
          const turn = turns.get(sessionId);
          if (!turn) return; // 别的会话（用户自己的对话）的帧，不碰
          streamFrames += 1;
          if (frame?.type === 'end') {
            // attempt 收尾（可能还有下一步/工具调用）。只有拿不到 durable 事件的老宿主
            // 才在这里收尾，否则一律等 turn/end —— 否则工具调用的回合会只回一句空话。
            if (!durableBound) finishTurn(turn, turn.errorText ? new CanvasChatTurnError(turn.errorText) : null);
            return;
          }
          const chunk = frame?.chunk;
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
            turn.text += chunk.text;
            try {
              turn.onDelta?.(chunk.text);
            } catch {
              /* 下游（SSE 写失败）出错不该影响回合本身 */
            }
          }
        },
        { global: true },
      );
      ctx.on?.(
        'agent/inbox/claimed',
        (payload: unknown) => {
          const message = (payload as { message?: { source?: { rpcId?: unknown } } })?.message;
          const requestId = message?.source?.rpcId;
          if (typeof requestId !== 'string' || !requestId) return;
          const sessionId = (payload as { agent?: { session?: { id?: unknown } } })?.agent?.session?.id;
          const turnNumber = (payload as { turn?: unknown })?.turn;
          for (const turn of turns.values()) {
            if (turn.requestId !== requestId) continue;
            if (typeof sessionId === 'string' && sessionId && turn.dshSessionId !== sessionId) continue;
            if (typeof turnNumber === 'number' && Number.isFinite(turnNumber)) {
              turn.turnNumber = turnNumber;
            }
            return;
          }
        },
        { global: true },
      );
      ctx.on?.(
        'agent/error',
        (payload: unknown) => {
          const sessionId = (payload as { agent?: { session?: { id?: unknown } } })?.agent?.session
            ?.id;
          if (typeof sessionId !== 'string') return;
          const turn = turns.get(sessionId);
          if (!turn) return;
          const error = (payload as { error?: unknown })?.error;
          const text =
            error instanceof Error
              ? error.message
              : typeof (error as { message?: unknown } | null)?.message === 'string'
                ? String((error as { message: string }).message)
                : String(error ?? '');
          // 只记下来：真正的收尾还是等 turn/end（它带着同一条 failure 与 code）。
          if (text) turn.errorText = text;
        },
        { global: true },
      );
      ctx.on?.(
        'session/event',
        (session: unknown, event: unknown) => {
          const sessionId = sessionIdOf(session);
          if (!sessionId) return;
          const turn = turns.get(sessionId);
          const durable = event as DurableEventLike | null;
          const type = typeof durable?.type === 'string' ? durable.type : '';
          if (type !== 'assistant/message' && type !== 'turn/end') return;
          durableEvents += 1;
          if (!turn) return; // 这个会话此刻没有我们的回合（用户自己在 DSH 里聊的）
          const data = durable?.data ?? {};
          const turnNumber = typeof data.turn === 'number' ? data.turn : null;
          if (turn.turnNumber !== null && turnNumber !== null && turn.turnNumber !== turnNumber) {
            return; // 不是本回合（会话被别处也聊过）
          }
          if (type === 'assistant/message') {
            const text = assistantMessageText(data.message);
            if (text) turn.finalText = text;
            return;
          }
          turnEndEvents += 1;
          if (turn.turnNumber === null && turnNumber !== null) turn.turnNumber = turnNumber;
          // agent/error 只在「这一轮什么都没产出」时才当失败用：DSH 内部可能重试过某个请求、
          // 最终仍然给出答复，那种情况不能被记成失败。
          const reasonFailure = failureFromTurnEnd(data.reason, turn.model);
          const produced = Boolean((turn.finalText ?? '').trim() || turn.text.trim());
          const failure =
            reasonFailure ??
            (produced || !turn.errorText ? null : new CanvasChatTurnError(turn.errorText));
          finishTurn(turn, failure);
        },
        { global: true },
      );
      durableBound = true;
    } catch (error) {
      // 宿主没有这些事件（老版本）时不能让插件起不来：回合会退回 attempt 收尾 / 超时兜底
      log('宿主事件订阅失败，画布对话只能靠 attempt 收尾或超时', error);
    }
  }

  async function ensureSession(chatId: string, fresh = false): Promise<string> {
    const service = controller();
    if (!service) throw new CanvasChatUnavailableError();
    const record = store.ensureSession(chatId, () => `session-${randomUUID()}`);
    if (!fresh && record.messages.length > 0) {
      // 已经跑过：DSH 侧一定存在，直接复用（省一次 create）
      return record.dshSessionId;
    }
    const target = fresh ? `session-${randomUUID()}` : record.dshSessionId;
    try {
      const created = await service.create({ sessionId: target, cwd });
      const resolved =
        typeof created?.sessionId === 'string' && created.sessionId ? created.sessionId : target;
      if (resolved !== record.dshSessionId) store.setDshSessionId(chatId, resolved);
      return resolved;
    } catch (error) {
      if (!fresh) {
        // 认领失败（会话被删 / 工作目录变了）：换一个新会话 id 再来一次
        log(`画布对话会话认领失败，改用新会话：${toError(error).message}`);
        return ensureSession(chatId, true);
      }
      throw error;
    }
  }

  function parseModel(model: string | undefined): { provider: string; model: string } | null {
    if (typeof model !== 'string') return null;
    const index = model.indexOf('/');
    if (index <= 0 || index === model.length - 1) return null;
    return { provider: model.slice(0, index), model: model.slice(index + 1) };
  }

  async function applyModel(sessionId: string, model: string | undefined): Promise<void> {
    const parsed = parseModel(model);
    const service = controller();
    if (!parsed || !service?.selectModel) return;
    try {
      await service.selectModel({ sessionId, provider: parsed.provider, model: parsed.model });
    } catch (error) {
      log(`切换画布对话模型失败（继续用会话当前模型）：${toError(error).message}`);
    }
  }

  /**
   * 哪些来源**确实**配好了密钥（走 DSH 自己那套：settings 里读 apiKeyEnv + credentials.describe）。
   *
   * 返回 null = 探测能力不可用（宿主没这几个服务，或整段抛错）→ 调用方不过滤，宁多勿少。
   * 只有「明确报告没配」的来源会被排除：任何一步拿不到答案都算可用。
   */
  async function providersWithCredential(): Promise<Set<string> | null> {
    try {
      const llm = ctx.get?.('llm') as LlmLike | undefined;
      const settings = ctx.get?.('settings') as SettingsLike | undefined;
      const credentials = ctx.get?.('credentials') as CredentialsLike | undefined;
      if (
        typeof llm?.listConfigurableProviders !== 'function' ||
        typeof settings?.describe !== 'function' ||
        typeof credentials?.describe !== 'function'
      ) {
        return null;
      }
      const namespaces = settings.describe({ redactSecrets: true });
      if (!Array.isArray(namespaces)) return null;
      const ready = new Set<string>();
      for (const provider of llm.listConfigurableProviders() ?? []) {
        const id = typeof provider?.provider === 'string' ? provider.provider : '';
        if (!id) continue;
        if (id === 'deepseek-account') {
          // 账号来源（登录即用）不走 apiKeyEnv 这条路
          ready.add(id);
          continue;
        }
        let profile: unknown = namespaces.find((item) => item?.ns === provider.settingsNs)?.value;
        for (const key of provider.settingsPath ?? []) {
          profile =
            typeof profile === 'object' && profile !== null
              ? Reflect.get(profile as object, key)
              : undefined;
        }
        const ref =
          typeof profile === 'object' && profile !== null
            ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
            : undefined;
        if (typeof ref !== 'string' || !ref) {
          ready.add(id); // 不靠 apiKeyEnv 的来源：不判它死
          continue;
        }
        try {
          const described = await credentials.describe(ref);
          const info =
            described && typeof described === 'object' && ref in described
              ? (described as Record<string, { configured?: boolean }>)[ref]
              : (described as { configured?: boolean } | undefined);
          if (info?.configured === true) ready.add(id);
        } catch {
          ready.add(id); // 探测失败 → 当可用
        }
      }
      return ready;
    } catch (error) {
      log(`来源密钥探测失败（模型清单不过滤）：${toError(error).message}`);
      return null;
    }
  }

  return {
    available(): boolean {
      return controller() !== null;
    },

    status(): Record<string, unknown> {
      return {
        available: controller() !== null,
        cwd,
        activeTurns: turns.size,
        activeSessions: [...turns.keys()],
        instructed: instructed.size,
        streamFrames,
        // durable 事件是 v1.13 的收尾依据：真机上这两个计数为 0 就说明回合收尾还在走老路
        durableBound,
        durableEvents,
        turnEndEvents,
        timeoutMs,
        chatSessions: store.stats(),
      };
    },

    /** 这个 DSH 会话是不是画布对话面板的（指令注入只对它生效）。 */
    isCanvasSession(dshSessionId: string): boolean {
      return store.findByDshSessionId(dshSessionId) !== null;
    },

    /** 上下文提示：同一个会话只给一次；返回 null 表示不用再注入。 */
    takeInstructions(dshSessionId: string): string | null {
      if (instructed.has(dshSessionId)) return null;
      instructed.add(dshSessionId);
      return canvasChatInstructions(projects.get(dshSessionId));
    },

    /**
     * 面板模型下拉的内容：直接来自 DSH 的模型目录。
     *
     * 两条 v1.13 的实机教训（「点了发送没回应」的真凶之一就藏在这里）：
     *   ① **默认模型必须排第一** —— 面板第一帧在「草稿里没有可用模型」时会直接取列表第一项
     *      （canvasAgentPanel 的 syncAvailability），列表顺序就是「默认选中谁」。按目录原始顺序
     *      排的话，第一项可能是**没配密钥**的来源（本机就是 deepseek-official），于是每次都在用
     *      一个必然失败的模型。
     *   ② **证明没配密钥的来源要从清单里去掉** —— 草稿里已经存了那个坏模型 id 时，只有它
     *      「不在清单里」面板才会回退到第一项。探测不到（服务缺失/抛错）时一律保留，宁多勿少。
     */
    async models(): Promise<{ default: string | null; models: CanvasChatModel[] }> {
      const service = controller();
      let catalog: ModelCatalogLike | null = null;
      if (service?.modelCatalog) {
        try {
          catalog = await service.modelCatalog();
        } catch (error) {
          log(`读取 DSH 模型目录失败：${toError(error).message}`);
        }
      }
      const fallback =
        catalog?.default?.provider && catalog?.default?.model
          ? `${catalog.default.provider}/${catalog.default.model}`
          : null;
      const groups = (catalog?.groups ?? []).filter(
        (group) => typeof group.id === 'string' && group.id,
      );
      const ready = await providersWithCredential();
      const defaultProvider = fallback ? fallback.slice(0, fallback.indexOf('/')) : '';
      const usable = groups.filter((group) => {
        const provider = String(group.id);
        if (!ready) return true; // 探测不可用：不过滤
        return ready.has(provider) || provider === defaultProvider;
      });
      const kept = usable.length > 0 ? usable : groups;

      // 同名模型跨来源时补上来源名，否则下拉里会出现两条一模一样的「DeepSeek-V41-Flash」
      const nameCount = new Map<string, number>();
      for (const group of kept) {
        for (const model of group.models ?? []) {
          const name = String(model.name || model.id || '');
          if (name) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
        }
      }
      const models: CanvasChatModel[] = [];
      for (const group of kept) {
        const provider = String(group.id);
        for (const model of group.models ?? []) {
          if (typeof model.id !== 'string' || !model.id) continue;
          const name = model.name || model.id;
          const duplicated = (nameCount.get(String(name)) ?? 0) > 1;
          models.push({
            id: `${provider}/${model.id}`,
            label: duplicated && group.name ? `${group.name} · ${name}` : name,
            vision: 'unknown',
          });
        }
      }
      if (models.length === 0) {
        // 目录读不到（宿主没这个能力）时给一个「就用会话当前模型」的选项，
        // 否则面板会因为选不到模型而禁用发送按钮。
        models.push({ id: 'session-default', label: '当前会话模型（DSH 默认）', vision: 'unknown' });
      }
      // 默认模型排第一：面板在「草稿里的模型不在清单里」时取第一项，列表顺序就是默认值。
      const preferred = models.some((item) => item.id === fallback) ? fallback! : models[0]!.id;
      const ordered =
        preferred === models[0]!.id
          ? models
          : [models.find((item) => item.id === preferred)!, ...models.filter((item) => item.id !== preferred)];
      return { default: preferred, models: ordered };
    },

    /**
     * 跑一个回合：把用户消息投递给 DSH 会话，等它的流式帧收尾。
     *
     * 注意顺序：**先登记回合再投递** —— 投递后第一帧可能马上就回来了，
     * 登记晚一步就会丢掉开头那段正文。
     */
    async runTurn(input: CanvasChatTurnInput): Promise<CanvasChatTurnResult> {
      const service = controller();
      if (!service) throw new CanvasChatUnavailableError();
      bindStream();
      const dshSessionId = await ensureSession(input.chatId);
      if (turns.has(dshSessionId)) throw new CanvasChatBusyError();
      if (input.projectId) projects.set(dshSessionId, input.projectId);

      let settle!: () => void;
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const turn: ActiveTurn = {
        chatId: input.chatId,
        dshSessionId,
        text: '',
        requestId: '',
        turnNumber: null,
        finalText: null,
        errorText: null,
        ...(input.model ? { model: input.model } : {}),
        failure: null,
        ...(input.onDelta ? { onDelta: input.onDelta } : {}),
        ...(input.onCanvasResult ? { onCanvasResult: input.onCanvasResult } : {}),
        settle,
        timer: setTimeout(() => {
          finishTurn(
            turn,
            new CanvasChatTurnError(
              turn.errorText ?? '画布对话等待超时，本轮没有收尾。',
              turn.errorText ? 'CHAT_FAILED' : 'CHAT_TIMEOUT',
            ),
          );
        }, timeoutMs),
      };
      turns.set(dshSessionId, turn);

      const abort = () => {
        void Promise.resolve(service.cancel?.({ sessionId: turn.dshSessionId })).catch(
          () => undefined,
        );
        finishTurn(turn, new CanvasChatTurnError('已请求停止。', 'CHAT_ABORTED'));
      };
      input.signal?.addEventListener('abort', abort, { once: true });

      try {
        await applyModel(dshSessionId, input.model);
        const request = {
          requestId: `canvas-chat-${randomUUID()}`,
          sessionId: dshSessionId,
          mode: 'queue' as const,
          content: [{ type: 'text' as const, text: input.text }],
        };
        turn.requestId = request.requestId;
        const signal = input.signal ?? new AbortController().signal;
        try {
          await service.prompt(request, signal);
        } catch (error) {
          // 会话在 DSH 侧不存在（被删 / 换过工作目录）时重建一次再投
          log(`画布对话投递失败，重建会话后重试：${toError(error).message}`);
          const recreated = await ensureSession(input.chatId, true);
          if (recreated === dshSessionId) throw error;
          turns.delete(dshSessionId);
          turn.dshSessionId = recreated;
          turns.set(recreated, turn);
          await applyModel(recreated, input.model);
          await service.prompt({ ...request, sessionId: recreated }, signal);
        }
        await done;
        if (turn.failure) throw turn.failure;
        // 正文优先用最后一次 assistant/message（权威、含工具调用之后的最终答复），
        // 拿不到才退回增量拼接。
        const text = (turn.finalText ?? '').trim() || turn.text;
        return {
          text: text.trim() || '这一轮没有产生文字回复（可能只做了画布操作）。',
          dshSessionId: turn.dshSessionId,
        };
      } finally {
        input.signal?.removeEventListener('abort', abort);
        if (turns.get(turn.dshSessionId) === turn) {
          turns.delete(turn.dshSessionId);
          clearTimeout(turn.timer);
        }
      }
    },

    /** 面板的「停止」：打断该对话当前回合。 */
    async cancel(chatId: string): Promise<boolean> {
      const record = store.getSession(chatId);
      const service = controller();
      if (!record || !service?.cancel) return false;
      try {
        await service.cancel({ sessionId: record.dshSessionId });
      } catch (error) {
        log(`取消画布对话回合失败：${toError(error).message}`);
      }
      const turn = turns.get(record.dshSessionId);
      if (turn) finishTurn(turn, new CanvasChatTurnError('已请求停止。', 'CHAT_ABORTED'));
      return true;
    },

    /** 画布动作回执：canvas_control 真跑过之后让面板把 action 卡片画出来。 */
    noteCanvasAction(dshSessionId: string, action: CanvasActionNote): void {
      if (!['edit', 'undo'].includes(action.action)) return;
      const turn = turns.get(dshSessionId);
      if (!turn) return;
      try {
        turn.onCanvasResult?.(action);
      } catch {
        /* 面板侧出错不影响工具调用 */
      }
    },
  };
}

export type CanvasChatHub = ReturnType<typeof createCanvasChatHub>;
