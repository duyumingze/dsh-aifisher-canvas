/**
 * 画布右侧对话面板的落盘层（host 半）。
 *
 * 面板（vendor 的 canvasAgentPanel + canvasAgentChat）按上游 AIFISHER 那套 HTTP 契约说话：
 *   GET/PUT /api/aifisher/canvas/agent/workspace?projectId=…   每个项目的「助手草稿」
 *   GET     /api/aifisher/canvas/chat/sessions                 对话历史列表
 *   GET     /api/aifisher/canvas/chat/sessions/:id             一份对话的全部消息
 *   DELETE  /api/aifisher/canvas/chat/sessions/:id
 *
 * 上游这份数据在后端数据库里；DSH 版落到一个 JSON 文件（原子写）：
 *   $DSH_HOME/storages/dsh-aifisher-canvas/agent-chat.json
 *
 * 两个概念别混：**画布对话 id**（面板生成，`crypto.randomUUID()`，前端会话标识）
 * 与 **DSH 会话 id**（`session-<uuid>`，真正跑 agent 的那个会话）。这里存的是两者的映射
 * —— 面板历史里点开一条对话，等价于回到同一个 DSH 会话继续问（上下文还在）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 面板渲染的一条消息（形状照 vendor 的 ChatMessage 精简）。 */
export interface ChatStoredMessage {
  role: string;
  content: string;
  timestamp?: string;
  stopped?: boolean;
  actions?: unknown[];
}

export interface ChatSessionRecord {
  id: string;
  /** 真正跑 agent 的 DSH 会话 id（`session-<uuid>`）。 */
  dshSessionId: string;
  topic: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatStoredMessage[];
}

export interface ChatSessionSummary {
  id: string;
  topic: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 助手草稿（每个项目一份）：面板自己读写，字段含义由 vendor 的 AgentWorkspace 定。 */
export interface AgentWorkspaceDraft {
  revision: number;
  value: Record<string, unknown>;
}

interface StoreShape {
  version: 1;
  sessions: Record<string, ChatSessionRecord>;
  workspaces: Record<string, AgentWorkspaceDraft>;
}

export interface AgentChatStoreOptions {
  /** 数据文件路径（缺省由调用方给 `<数据目录>/agent-chat.json`）。 */
  filePath: string;
  /** 单条对话最多留多少条消息（超出丢最旧的，防止文件无限长大）。 */
  maxMessagesPerSession?: number;
  /** 最多保留多少条对话（按 updatedAt 淘汰最旧的）。 */
  maxSessions?: number;
}

/** 助手草稿的缺省值：面板要求 `value.prompt` 一定是字符串，否则判定格式无效。 */
export function emptyWorkspaceValue(): Record<string, unknown> {
  return {
    prompt: '',
    modelId: '',
    effort: '',
    apiSessionId: '',
    codexSessionId: '',
    nodeReferences: [],
    excludedNodes: [],
  };
}

function emptyStore(): StoreShape {
  return { version: 1, sessions: {}, workspaces: {} };
}

/** 用第一条用户消息当标题（上游也是这么起 topic 的）。 */
function topicFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '新对话';
  return flat.length <= 24 ? flat : `${flat.slice(0, 24)}…`;
}

export function createAgentChatStore(options: AgentChatStoreOptions) {
  const filePath = options.filePath;
  const maxMessages = options.maxMessagesPerSession ?? 200;
  const maxSessions = options.maxSessions ?? 60;
  let data = load();
  let writing: Promise<void> = Promise.resolve();

  function load(): StoreShape {
    try {
      if (!existsSync(filePath)) return emptyStore();
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoreShape>;
      const sessions: Record<string, ChatSessionRecord> = {};
      for (const [id, record] of Object.entries(parsed.sessions ?? {})) {
        if (!record || typeof record !== 'object') continue;
        if (typeof record.dshSessionId !== 'string' || !record.dshSessionId) continue;
        sessions[id] = {
          id,
          dshSessionId: record.dshSessionId,
          topic: typeof record.topic === 'string' && record.topic ? record.topic : '新对话',
          createdAt: Number(record.createdAt) || Date.now(),
          updatedAt: Number(record.updatedAt) || Date.now(),
          messages: Array.isArray(record.messages)
            ? record.messages
                .filter(
                  (message): message is ChatStoredMessage =>
                    Boolean(message) &&
                    typeof message === 'object' &&
                    typeof (message as ChatStoredMessage).content === 'string' &&
                    typeof (message as ChatStoredMessage).role === 'string',
                )
                // v1.13：空正文的助手消息是历史遗留（早先回合静默失败时落下的），
                // 面板会把它们渲染成空气泡 —— 读的时候直接丢掉。
                .filter(
                  (message) => !(message.role === 'assistant' && message.content.trim() === ''),
                )
            : [],
        };
      }
      const workspaces: Record<string, AgentWorkspaceDraft> = {};
      for (const [id, draft] of Object.entries(parsed.workspaces ?? {})) {
        if (!draft || typeof draft !== 'object') continue;
        workspaces[id] = {
          revision: Number(draft.revision) || 0,
          value: { ...emptyWorkspaceValue(), ...(draft.value ?? {}) },
        };
      }
      return { version: 1, sessions, workspaces };
    } catch (error) {
      try {
        if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败就忽略 */
      }
      console.error('[aifisher-canvas] 画布对话数据读取失败，已重置为空库', error);
      return emptyStore();
    }
  }

  function persist(): Promise<void> {
    writing = writing.then(async () => {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, filePath);
    });
    return writing;
  }

  /** 淘汰最旧的对话，别让这个文件无限长大。 */
  function prune(): void {
    const entries = Object.values(data.sessions);
    if (entries.length <= maxSessions) return;
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const stale of entries.slice(maxSessions)) delete data.sessions[stale.id];
  }

  return {
    filePath,

    stats(): Record<string, unknown> {
      const sessions = Object.values(data.sessions);
      return {
        path: filePath,
        sessions: sessions.length,
        messages: sessions.reduce((sum, item) => sum + item.messages.length, 0),
        workspaces: Object.keys(data.workspaces).length,
        updatedAt: sessions.reduce((max, item) => Math.max(max, item.updatedAt), 0),
      };
    },

    /** GET /chat/sessions —— 面板的历史列表（新的在前）。 */
    listSessions(): ChatSessionSummary[] {
      return Object.values(data.sessions)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((record) => ({
          id: record.id,
          topic: record.topic,
          messageCount: record.messages.length,
          createdAt: new Date(record.createdAt).toISOString(),
          updatedAt: new Date(record.updatedAt).toISOString(),
        }));
    },

    getSession(id: string): ChatSessionRecord | null {
      return data.sessions[id] ?? null;
    },

    /** 这些 DSH 会话归画布对话面板所有（指令注入、诊断都按它判断）。 */
    dshSessionIds(): string[] {
      return Object.values(data.sessions).map((record) => record.dshSessionId);
    },

    findByDshSessionId(dshSessionId: string): ChatSessionRecord | null {
      return (
        Object.values(data.sessions).find((record) => record.dshSessionId === dshSessionId) ?? null
      );
    },

    /**
     * 保证这个画布对话有一条对应的 DSH 会话记录；第一次访问时才去建 DSH 会话，
     * 所以「新建对话」在用户真的发消息之前不会在 DSH 里留下空会话。
     */
    ensureSession(id: string, createDshSessionId: () => string): ChatSessionRecord {
      const existing = data.sessions[id];
      if (existing) return existing;
      const now = Date.now();
      const record: ChatSessionRecord = {
        id,
        dshSessionId: createDshSessionId(),
        topic: '新对话',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      data.sessions[id] = record;
      prune();
      return record;
    },

    /** DSH 会话被外部换掉时（建会话失败重试）更新映射。 */
    setDshSessionId(id: string, dshSessionId: string): void {
      const record = data.sessions[id];
      if (!record) return;
      record.dshSessionId = dshSessionId;
      record.updatedAt = Date.now();
      void persist();
    },

    appendMessages(id: string, messages: ChatStoredMessage[]): ChatSessionRecord | null {
      const record = data.sessions[id];
      if (!record) return null;
      for (const message of messages) {
        record.messages.push(message);
        if (message.role === 'user' && record.topic === '新对话') {
          record.topic = topicFrom(message.content);
        }
      }
      if (record.messages.length > maxMessages) {
        record.messages.splice(0, record.messages.length - maxMessages);
      }
      record.updatedAt = Date.now();
      void persist();
      return record;
    },

    setTopic(id: string, topic: string): void {
      const record = data.sessions[id];
      if (!record || !topic.trim()) return;
      record.topic = topic.trim().slice(0, 80);
      void persist();
    },

    deleteSession(id: string): boolean {
      if (!data.sessions[id]) return false;
      delete data.sessions[id];
      void persist();
      return true;
    },

    /** GET /agent/workspace —— 没有就现造一份（revision 0）。 */
    getWorkspace(projectId: string): AgentWorkspaceDraft {
      const existing = data.workspaces[projectId];
      if (existing) return existing;
      return { revision: 0, value: emptyWorkspaceValue() };
    },

    /**
     * PUT /agent/workspace —— 面板提交的 `revision` 必须正好是当前版本，
     * 保存成功后 +1（前端会核对 `revision === 上次 + 1`，对不上就当保存失败）。
     */
    putWorkspace(
      projectId: string,
      revision: number,
      value: Record<string, unknown>,
    ): { ok: true; revision: number } | { ok: false; revision: number } {
      const current = data.workspaces[projectId]?.revision ?? 0;
      if (revision !== current) return { ok: false, revision: current };
      const next = current + 1;
      data.workspaces[projectId] = {
        revision: next,
        value: { ...emptyWorkspaceValue(), ...value },
      };
      void persist();
      return { ok: true, revision: next };
    },
  };
}

export type AgentChatStore = ReturnType<typeof createAgentChatStore>;
