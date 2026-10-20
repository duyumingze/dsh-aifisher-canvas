/**
 * 画布系统通知队列（v1.59）：长任务收口、自动重试这类「宿主想告诉用户/助手」的消息。
 *
 * 与 generationPush 是同一个形状（主动 prompt 推不出去就留到该会话下一回合注入），
 * 但载荷不同：这里是**任意一段话**，不是生成批次事件。分开写而不是塞进 generationPush：
 * 那个模块的语义是「按批次成组」（同一批多个节点只打扰一次），把长任务通知混进去会把
 * 成组逻辑搅乱。
 *
 * 三条护栏与 generationPush 一致：
 *   1. 同一会话两次推送至少隔 `minGapMs`（默认 3s）；
 *   2. 合并窗口 `flushDelayMs`（默认 800ms）：一次任务收口 + 一次重试准备只算两条消息，
 *      不必分成多条；
 *   3. 推不出去（没有 sessionController / 会话归档 / prompt 抛错）→ 留在队列，
 *      由 `agent/pre-step` 在会话下一次开始时补进去，宁可晚一轮，不静默吞掉。
 */
import { randomUUID } from 'node:crypto';

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

export interface CanvasNoticeQueueOptions {
  ctx: CordisLike;
  flushDelayMs?: number;
  minGapMs?: number;
}

export function createCanvasNoticeQueue(options: CanvasNoticeQueueOptions) {
  const { ctx } = options;
  const flushDelayMs = options.flushDelayMs ?? 800;
  const minGapMs = options.minGapMs ?? 3000;

  /** sessionId → 待投递文本（合并成一条）。 */
  const pending = new Map<string, string>();
  /** sessionId → 合并窗口定时器。 */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessionId → 上次主动推送时刻。 */
  const lastPushedAt = new Map<string, number>();
  let pushed = 0;
  let failed = 0;
  let injected = 0;

  function controller(): ControllerLike | null {
    try {
      const service = ctx.get?.('sessionController') as ControllerLike | undefined;
      return service && typeof service.prompt === 'function' ? service : null;
    } catch {
      return null;
    }
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
    const text = pending.get(sessionId);
    if (!text) return;
    const service = controller();
    if (!service) return; // 没有会话服务：留着，等 pre-step 注入
    const gap = minGapMs - (Date.now() - (lastPushedAt.get(sessionId) ?? 0));
    if (gap > 0) {
      schedule(sessionId, gap);
      return;
    }
    pending.delete(sessionId);
    try {
      await service.prompt(
        {
          requestId: `canvas-notice-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      );
      pushed += 1;
      lastPushedAt.set(sessionId, Date.now());
    } catch (error) {
      failed += 1;
      // 放回队列（而不是丢）：下一次回合由 pre-step 补给它
      pending.set(sessionId, `${text}\n\n${pending.get(sessionId) ?? ''}`.trim());
      ctx.logger?.warn?.(
        `[aifisher-canvas] 画布通知推送失败（留待下一回合注入）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    /** 排一条通知（同一会话短时间内多条会合并成一条）。 */
    push(sessionId: string, text: string): void {
      if (!sessionId || !text.trim()) return;
      const merged = pending.get(sessionId);
      pending.set(sessionId, merged ? `${merged}\n\n${text.trim()}` : text.trim());
      schedule(sessionId, flushDelayMs);
    },

    /** pre-step 兜底：取走这个会话还没投递的通知（只取一次）。 */
    takePendingText(sessionId: string): string | null {
      const text = pending.get(sessionId);
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

    async flushNow(sessionId?: string): Promise<void> {
      if (sessionId) {
        await flush(sessionId);
        return;
      }
      for (const id of [...pending.keys()]) await flush(id);
    },

    stats(): Record<string, unknown> {
      return { pushed, failed, injected, pendingSessions: pending.size, flushDelayMs, minGapMs };
    },

    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
    },
  };
}

export type CanvasNoticeQueue = ReturnType<typeof createCanvasNoticeQueue>;
