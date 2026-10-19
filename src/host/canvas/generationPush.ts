/**
 * 生成事件推送（v1.57）：把「一批生成跑完了」这件事，**推到画布对话面板**。
 *
 * ## 推是什么
 *
 * 「画布对话面板」在 DSH 版里就是右侧栏那个 **DSH 原生会话**（CanvasChatDock 渲染的是内核会话）。
 * 所以推送不是自造一套消息流，而是往**同一个 DSH 会话**里投一条消息：
 *
 *   sessionController.prompt({ sessionId, mode:'queue', content:[{type:'text', text}] })
 *
 * 这一投会带来两件事，而且都是我们想要的：
 *   ① 用户在面板里**看见**它（一条标记了「宿主推送、不是用户发言」的消息）；
 *   ② agent **拿到**它 —— 于是它可以在同一轮里 `preview` 看图自评、修失败、重新准备，
 *      而不是等用户想起来再问一句「生成完了吗」。
 *
 * ## 三条护栏
 *
 *   1. **只推 Agent 准备的批次**：绑定来自 `/agent/plans`（prepareGeneration 落库），
 *      用户在画布上直接点生成的那些不进这条链路（任务队列面板本来就是它们的实时视图）。
 *   2. **合并窗口 + 冷却**：批次收口后先等 `flushDelayMs`（默认 1.2s），把同一会话里接连收口的
 *      几批并成一条；同一会话两次推送至少隔 `minGapMs`（默认 3s）。避免「一次确认 3 个镜头 →
 *      3 条系统消息 → 3 次模型调用」。
 *   3. **推不出去就留给下一次回合**：宿主没有 sessionController、会话已归档、prompt 抛错时，
 *      事件**放回队列**（不丢），由 `agent/pre-step` 在会话下一次真正开始时注入
 *      （见 index.ts 的 installGenerationEventNotices）。宁可晚一点，不可静默吞掉。
 *
 * 注入正文统一走 generationEvents.formatGenerationBatch：开头点明「不是用户发言」，
 * 结尾重申「重新准备可以，最后仍要用户点确认」。
 */
import { randomUUID } from 'node:crypto';
import {
  formatGenerationBatches,
  type GenerationBatchResult,
  type GenerationEvents,
} from './generationEvents';

interface ControllerLike {
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue' | 'steer';
      content: readonly { type: 'text'; text: string }[];
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

interface CordisLike {
  get?(name: string): unknown;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void };
}

export interface GenerationPushOptions {
  ctx: CordisLike;
  events: GenerationEvents;
  /** 批次收口后的合并窗口（默认 1200ms；`AIFISHER_EVENTS_FLUSH_MS` 可覆盖）。 */
  flushDelayMs?: number;
  /** 同一会话两次主动推送的最小间隔（默认 3000ms）。 */
  minGapMs?: number;
}

function envNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function createGenerationPush(options: GenerationPushOptions) {
  const { ctx, events } = options;
  const flushDelayMs =
    options.flushDelayMs ?? envNumber('AIFISHER_EVENTS_FLUSH_MS') ?? 1200;
  const minGapMs = options.minGapMs ?? envNumber('AIFISHER_EVENTS_MIN_GAP_MS') ?? 3000;

  /** sessionId → 还没推出去/还没被回合取走的批次（按收口先后）。 */
  const pending = new Map<string, GenerationBatchResult[]>();
  /** sessionId → 合并窗口定时器。 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessionId → 上次主动推送时刻（冷却）。 */
  const lastPushedAt = new Map<string, number>();
  let pushed = 0;
  let failed = 0;
  let injected = 0;

  function log(message: string, detail?: unknown): void {
    try {
      ctx.logger?.info?.(`[aifisher-canvas] ${message}`, detail ?? '');
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  function controller(): ControllerLike | null {
    try {
      const service = ctx.get?.('sessionController') as ControllerLike | undefined;
      return service && typeof service.prompt === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  function textFor(sessionId: string): string | null {
    const list = pending.get(sessionId);
    if (!list || list.length === 0) return null;
    return formatGenerationBatches(list);
  }

  function schedule(sessionId: string, delay: number): void {
    if (timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void flush(sessionId);
    }, Math.max(0, delay));
    (timer as unknown as { unref?: () => void }).unref?.();
    timers.set(sessionId, timer);
  }

  async function flush(sessionId: string): Promise<void> {
    const list = pending.get(sessionId);
    if (!list || list.length === 0) return;
    const service = controller();
    if (!service) {
      // 没有会话服务（老宿主/单测）：留着 —— 下次这个会话真的跑一回合时由 pre-step 注入
      return;
    }
    const gap = minGapMs - (Date.now() - (lastPushedAt.get(sessionId) ?? 0));
    if (gap > 0) {
      schedule(sessionId, gap);
      return;
    }
    const text = textFor(sessionId);
    if (!text) return;
    pending.delete(sessionId);
    try {
      await service.prompt(
        {
          requestId: `canvas-generation-events-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      );
      pushed += 1;
      lastPushedAt.set(sessionId, Date.now());
      log(`生成事件已推送进画布对话面板（${sessionId}）`);
    } catch (error) {
      failed += 1;
      // 放回队首，别丢事件：下一次回合一开就把它们塞给模型（另一个入口）
      pending.set(sessionId, [...list, ...(pending.get(sessionId) ?? [])]);
      log(
        `生成事件推送失败（留待下一回合注入）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function enqueue(payload: GenerationBatchResult): void {
    const list = pending.get(payload.sessionId) ?? [];
    list.push(payload);
    pending.set(payload.sessionId, list);
    schedule(payload.sessionId, flushDelayMs);
  }

  const unsubscribe = events.onBatchComplete(enqueue);

  return {
    /** 诊断：推送层自己看到的数字。 */
    stats(): Record<string, unknown> {
      return {
        pushed,
        failed,
        injected,
        pendingSessions: pending.size,
        pendingBatches: [...pending.values()].reduce((sum, list) => sum + list.length, 0),
        flushDelayMs,
        minGapMs,
      };
    },

    /**
     * pre-step 兜底：会话自己开始一回合时，把还没推出去的事件取走（只取一次）。
     *
     * 返回 null = 没有待注入的事件（绝大多数回合走这条）。
     */
    takePendingText(sessionId: string): string | null {
      const text = textFor(sessionId);
      if (!text) return null;
      pending.delete(sessionId);
      const timer = timers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(sessionId);
      }
      injected += 1;
      return text;
    },

    /** 测试/诊断用：立刻尝试推送（不等合并窗口）。 */
    async flushNow(sessionId?: string): Promise<void> {
      if (sessionId) {
        await flush(sessionId);
        return;
      }
      for (const id of [...pending.keys()]) await flush(id);
    },

    dispose(): void {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type GenerationPush = ReturnType<typeof createGenerationPush>;
