/**
 * 「检查更新」面板（v1.98）。
 *
 * 用户 2026-11-13 原话（第二版，把第一版砍简单了）：
 * **「做简单一点，检查更新，如果有新版本然后用户确认更新的话就新开对话把更新对话输入进去
 * 等用户点发送」**。
 *
 * 所以这块只做三件事，多一件都不做：
 *   ① 查：问 host `/update/status`（10 分钟缓存），告诉你有新版还是已最新；
 *   ② 摆一个「更新到 vX.Y.Z」按钮 —— 点它 = 用户确认更新；
 *   ③ 确认后**不下载、不替换文件、不重启**，只是新开一条画布对话，把 host 写好的更新指令
 *      填进输入框（`window.__FISHERAI_CANVAS_COMPOSE__.composeNew`，由 CanvasChatDock 提供），
 *      然后关掉设置页让你看得见那条新对话 —— **发送仍由你按**。
 *
 * 为什么走 window 桥：画布应用（`lib/canvas/canvas-app.js`）是独立 bundle，拿不到内核给
 * 会话槽位的 React props（`inputActions.setDraft` 在那里）。桥不在时降级成「复制更新指令」，
 * 用户自己新建对话粘贴 —— 不假装成功。
 *
 * 位置：设置页「高级与关于」里的宿主 div（`data-fisherai-settings-host="update"`），
 * 原生 DOM + `--af-*` 样式（同一页里还有第二份 React 树，塞 React 会踩 #130）。
 */
import { CANVAS_UI_VERSION } from './CanvasSettings';
import { closeCanvasPage } from './CanvasPagesStore';

export const UPDATE_API = '/api/aifisher/canvas/update';

/** 与 host `src/host/update/updateRouter.ts` 的返回同形（只取前端用到的字段）。 */
interface UpdateStatus {
  ok: boolean;
  current: string;
  latest: string | null;
  behind: boolean;
  upToDate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  prompt: string;
  repo: string;
  checkedAt: number;
  cached: boolean;
  error?: string;
  hint?: string;
}

/** CanvasChatDock 挂到 window 上的桥（见 src/client/CanvasChatDock.tsx 的 ComposeBridge）。 */
interface ComposeBridge {
  composeNew(text: string): Promise<{ ok: boolean; sessionId?: string; message?: string }>;
}

type Phase = 'idle' | 'checking' | 'latest' | 'behind' | 'error';

const PANEL_ATTRIBUTE = 'data-fisherai-update';
const TITLE_CLASS = 'text-base font-medium text-[var(--af-text)]';
const DESCRIPTION_CLASS = 'text-sm leading-relaxed text-[var(--af-text-secondary)]';
const NOTE_CLASS = 'text-xs leading-relaxed text-[var(--af-text-muted)]';
const BUTTON_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border ' +
  'border-[var(--af-border-control)] px-3 text-xs font-medium text-[var(--af-text)] ' +
  'transition-colors hover:bg-[var(--af-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--af-info)] ' +
  'bg-[var(--af-info)] px-3 text-xs font-medium text-[var(--af-on-primary)] ' +
  'transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const LINK_CLASS = `${BUTTON_CLASS} no-underline`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function timeLabel(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function dateLabel(value: unknown): string {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : '';
}

/** 复制一段文字（桥不在时的兜底）。返回是否成功。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const field = el('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    field.remove();
    return Boolean(copied);
  } catch {
    return false;
  }
}

/**
 * 把面板挂到宿主元素里（宿主 = 设置页 `data-fisherai-settings-host="update"`）。
 * 返回 disposer：关设置页 / 重开设置页时由页面层调用。
 */
export function mountCanvasUpdatePanel(host: HTMLElement): () => void {
  let disposed = false;
  let busy = false;
  let status: UpdateStatus | null = null;

  const root = el('section', 'space-y-3');
  root.setAttribute(PANEL_ATTRIBUTE, 'panel');
  root.setAttribute('aria-labelledby', 'fisherai-update-title');

  const header = el('div', 'flex items-start justify-between gap-4');
  const heading = el('div', 'space-y-1');
  const title = el('h3', TITLE_CLASS, '检查更新');
  title.id = 'fisherai-update-title';
  const description = el(
    'p',
    DESCRIPTION_CLASS,
    `当前 v${CANVAS_UI_VERSION}。有新版时点下面的「更新」，会新开一条对话把更新步骤填好 —— 发不发送由你决定。`,
  );
  heading.append(title, description);

  const checkButton = el('button', BUTTON_CLASS, '检查更新');
  checkButton.type = 'button';
  checkButton.setAttribute('data-fisherai-update-check', 'true');
  checkButton.setAttribute('aria-label', '检查插件更新');
  header.append(heading, checkButton);

  const statusLine = el('p', DESCRIPTION_CLASS);
  statusLine.setAttribute('data-fisherai-update-message', 'true');
  statusLine.setAttribute('role', 'status');

  const actions = el('div', 'hidden flex-wrap items-center gap-2');
  actions.setAttribute('data-fisherai-update-actions', 'true');
  const upgradeButton = el('button', PRIMARY_BUTTON_CLASS, '更新');
  upgradeButton.type = 'button';
  upgradeButton.setAttribute('data-fisherai-update-upgrade', 'true');
  upgradeButton.setAttribute('aria-label', '更新插件：新开对话并填好更新指令');
  const openLink = el('a', LINK_CLASS, '发布页');
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.setAttribute('data-fisherai-update-open', 'true');
  actions.append(upgradeButton, openLink);

  const note = el('p', NOTE_CLASS);
  note.setAttribute('data-fisherai-update-note', 'true');

  root.append(header, statusLine, actions, note);
  host.append(root);

  const render = () => {
    const phase: Phase = busy
      ? 'checking'
      : status
        ? status.ok
          ? status.behind
            ? 'behind'
            : 'latest'
          : 'error'
        : 'idle';
    root.setAttribute('data-fisherai-update-state', phase);
    checkButton.disabled = busy;
    checkButton.textContent = busy ? '正在检查…' : '检查更新';
    upgradeButton.disabled = busy || !status?.prompt;

    if (!status) {
      statusLine.textContent = busy ? '正在检查…' : '还没有检查过。';
      actions.className = 'hidden flex-wrap items-center gap-2';
      return;
    }

    const checked = timeLabel(status.checkedAt);
    const suffix = checked ? `（检查于 ${checked}${status.cached ? '，缓存' : ''}）` : '';
    if (status.ok && status.behind) {
      const published = dateLabel(status.publishedAt);
      statusLine.textContent = `有新版本 v${status.latest ?? '?'}${published ? `，发布于 ${published}` : ''}${suffix}`;
      upgradeButton.textContent = `更新到 v${status.latest ?? '?'}`;
      actions.className = 'flex flex-wrap items-center gap-2';
    } else if (status.ok) {
      statusLine.textContent = `已是最新${status.latest ? `（远端 v${status.latest}）` : ''}${suffix}`;
      actions.className = 'hidden flex-wrap items-center gap-2';
    } else {
      statusLine.textContent = `检查失败：${status.error || '未知原因'}`;
      actions.className = 'hidden flex-wrap items-center gap-2';
    }
    openLink.href = status.releaseUrl || (status.repo ? `https://github.com/${status.repo}/releases` : '#');
  };

  const check = async (force: boolean) => {
    if (busy || disposed) return;
    busy = true;
    render();
    try {
      const response = await fetch(`${UPDATE_API}/status${force ? '?force=1' : ''}`);
      const data = (await response.json().catch(() => null)) as UpdateStatus | null;
      if (disposed) return;
      /**
       * 404 / 501 = 插件刚更新、但 DSH 里跑的还是旧 host（没有这条路由）。
       * 这种时候说人话，别让用户以为「检查更新功能坏了」——重启一次 DSH 就好。
       */
      const hostOutdated = response.status === 404 || response.status === 501;
      status =
        response.ok && data && typeof data === 'object'
          ? data
          : {
              ok: false,
              current: CANVAS_UI_VERSION,
              latest: null,
              behind: false,
              upToDate: false,
              releaseUrl: null,
              publishedAt: null,
              prompt: '',
              repo: '',
              checkedAt: Date.now(),
              cached: false,
              error: hostOutdated
                ? 'DSH 里跑的插件 host 还是旧版本（没有 /update/status 路由）—— 重启一次 DSH 后就能检查更新。'
                : `接口返回 HTTP ${response.status}`,
            };
    } catch (error) {
      if (disposed) return;
      status = {
        ok: false,
        current: CANVAS_UI_VERSION,
        latest: null,
        behind: false,
        upToDate: false,
        releaseUrl: null,
        publishedAt: null,
        prompt: '',
        repo: '',
        checkedAt: Date.now(),
        cached: false,
        error: error instanceof Error ? error.message : '网络请求失败',
      };
    } finally {
      if (!disposed) {
        busy = false;
        render();
      }
    }
  };

  /** 用户确认更新：新开对话 + 预填；桥不在就退回复制指令。 */
  const upgrade = async () => {
    const prompt = status?.prompt ?? '';
    if (!prompt) return;
    upgradeButton.disabled = true;
    note.textContent = '正在新开对话…';
    const bridge = (window as unknown as { __FISHERAI_CANVAS_COMPOSE__?: ComposeBridge })
      .__FISHERAI_CANVAS_COMPOSE__;
    if (bridge && typeof bridge.composeNew === 'function') {
      try {
        const result = await bridge.composeNew(prompt);
        if (result?.ok) {
          note.textContent = '已在新对话里填好更新指令 —— 按发送就开始更新。';
          // 关掉设置页，让用户直接看到那条新对话（发送键在那边）
          closeCanvasPage();
          return;
        }
        note.textContent = `没能填进输入框：${result?.message ?? '未知原因'}。可以手动复制下面这句。`;
      } catch (error) {
        note.textContent = `没能填进输入框：${error instanceof Error ? error.message : '未知错误'}。可以手动复制下面这句。`;
      }
    }
    const copied = await copyText(prompt);
    note.textContent = copied
      ? `${note.textContent ? `${note.textContent} ` : ''}已复制更新指令 —— 新建一条对话粘贴后发送即可。`
      : `${note.textContent ? `${note.textContent} ` : ''}复制失败，请手动新建一条对话，把更新步骤输入进去。`;
    upgradeButton.disabled = false;
  };

  checkButton.addEventListener('click', () => void check(true));
  upgradeButton.addEventListener('click', () => void upgrade());

  render();
  // 面板一打开就查一次（host 里有 10 分钟缓存，不会把 GitHub 限额用光）
  void check(false);

  return () => {
    if (disposed) return;
    disposed = true;
    root.remove();
  };
}

interface PanelHolder {
  __FISHERAI_MOUNT_UPDATE_SETTINGS__?: (host: HTMLElement) => (() => void) | null;
  __FISHERAI_CANVAS_UPDATE__?: { api: string; report: () => Record<string, unknown> };
}

/**
 * 注册设置页挂载点：装配层（bootstrap）把它塞到 `__FISHERAI_MOUNT_UPDATE_SETTINGS__`，
 * 页面打开时由 `mountSettingsHosts()` 调用。返回撤销函数。
 */
export function registerCanvasUpdatePanel(): () => void {
  const holder = globalThis as unknown as PanelHolder;
  holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__ = (host: HTMLElement) => {
    try {
      return mountCanvasUpdatePanel(host);
    } catch (error) {
      // 挂不上不该拦住整页设置（空面板总比白屏好）
      console.error('[aifisher-canvas] 挂载「检查更新」面板失败', error);
      return null;
    }
  };
  holder.__FISHERAI_CANVAS_UPDATE__ = {
    api: UPDATE_API,
    report: () => ({
      mounted: typeof holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__ === 'function',
      panels: document.querySelectorAll('[data-fisherai-update="panel"]').length,
    }),
  };
  return () => {
    if (holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__) delete holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__;
    if (holder.__FISHERAI_CANVAS_UPDATE__) delete holder.__FISHERAI_CANVAS_UPDATE__;
  };
}
