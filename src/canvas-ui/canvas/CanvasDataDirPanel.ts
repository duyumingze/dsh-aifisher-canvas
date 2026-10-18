/**
 * 「项目数据目录」设置面板（设置 → 存储，v1.43）。
 *
 * 用户 2026-10-18 原话：「设置里添加项目自定义缓存目录」。
 *
 * 之前插件把所有数据（项目 = canvas.json、素材、资产库、通道表/密钥、工作流目录、
 * 下载、画布背景…）固定写在 `$DSH_HOME/storages/dsh-aifisher-canvas/`，界面上没有任何入口，
 * 想换盘只能整目录搬 + 动环境变量。这一页把那件事做成一个设置项：
 * 填一个绝对路径 → 应用 → **重启一次 DSH** → 之后所有数据都落在那儿。
 *
 * 三条实现口径（改之前先对一遍）：
 *   ① **不写 React**：设置页是 vendor 的 React 树，而插件里有两份 React 19 ——
 *      塞另一棵 React 树进 vendor DOM 会踩 #130。所以这里是原生 DOM + Tailwind 类，
 *      颜色一律用 `--af-*` 变量（深浅主题自动跟）。
 *   ② **只说真话**：host 的 store 在 apply() 时就按目录构造好了，改指针不会热切换。
 *      所以界面永远写「重启 DSH 后生效」，返回的 `restartRequired` 也照实显示 ——
 *      不假装已经换了（v1.31 那条「假成功」的教训）。
 *   ③ **默认复制现有数据**（纯复制、不删旧目录）：先复制、再写指针；新目录里已有同名文件就跳过，
 *      用户点两次也不会把新目录里的东西盖掉。
 */
import {
  DATA_DIR_API,
  type DataDirStatus,
  type DataDirApplyResult,
  fetchDataDirStatus,
  applyDataDir,
  resetDataDir,
  dataDirStatusText,
} from './CanvasDataDir';

/** 面板根（回归与真机脚本按它找）。 */
const PANEL_ATTRIBUTE = 'data-fisherai-data-dir';

const PANEL_CLASS = 'space-y-4';
const CARD_CLASS =
  'space-y-3 rounded-lg border border-[var(--af-border)] bg-[var(--af-surface-raised)] p-6';
const TITLE_CLASS = 'text-base font-medium text-[var(--af-text)]';
const NOTE_CLASS = 'text-xs leading-relaxed text-[var(--af-text-muted)]';
const DESCRIPTION_CLASS = 'text-sm leading-relaxed text-[var(--af-text-secondary)]';
const PATH_CLASS =
  'block break-all rounded bg-[var(--af-input)] px-2 py-1 font-mono text-[11px] ' +
  'text-[var(--af-text-secondary)]';
const INPUT_CLASS =
  'h-9 min-w-0 flex-1 rounded-lg border border-[var(--af-border)] bg-[var(--af-input)] ' +
  'px-3 font-mono text-xs text-[var(--af-text)] outline-none ' +
  'focus:border-[var(--af-border-control)]';
const BUTTON_CLASS =
  'inline-flex h-9 shrink-0 items-center justify-center rounded-lg border ' +
  'border-[var(--af-border-control)] px-3 text-xs font-medium text-[var(--af-text)] ' +
  'transition-colors hover:bg-[var(--af-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON_CLASS =
  'inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-[var(--af-info)] ' +
  'bg-[var(--af-info)] px-3 text-xs font-medium text-[var(--af-on-primary)] transition-opacity ' +
  'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

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

interface PanelState {
  status: DataDirStatus | null;
  busy: string;
  notice: { kind: 'ok' | 'error'; text: string } | null;
}

/**
 * 把「项目数据目录」面板挂到宿主元素里（宿主 = vendor 设置页「存储」分区给的那个挂载点）。
 * 返回 disposer（切分区 / 关对话框都会调用）。
 */
export function mountCanvasDataDirPanel(host: HTMLElement): () => void {
  const state: PanelState = { status: null, busy: '', notice: null };
  let disposed = false;

  const root = el('section', PANEL_CLASS);
  root.setAttribute(PANEL_ATTRIBUTE, 'panel');
  root.setAttribute('aria-labelledby', 'fisherai-data-dir-title');

  const header = el('div', 'space-y-1');
  const title = el('h3', TITLE_CLASS, '项目数据目录（缓存）');
  title.id = 'fisherai-data-dir-title';
  const description = el(
    'p',
    DESCRIPTION_CLASS,
    '项目、素材、资产库、通道与密钥、工作流目录、下载、画布背景全都落在这个目录里。' +
      '放到别的盘（比如数据盘）也行 —— 改完要重启一次 DSH 才会切过去。',
  );
  header.append(title, description);

  // ---- 现状卡片 ----
  const statusCard = el('div', CARD_CLASS);
  const statusLabel = el('p', TITLE_CLASS, '当前数据目录');
  const statusPath = el('code', PATH_CLASS);
  statusPath.setAttribute('data-fisherai-data-dir-current', 'true');
  const statusLine = el('p', NOTE_CLASS);
  statusLine.setAttribute('data-fisherai-data-dir-status', 'true');
  statusLine.setAttribute('role', 'status');
  const defaultLine = el('p', NOTE_CLASS);
  const defaultPath = el('code', 'font-mono');
  defaultPath.setAttribute('data-fisherai-data-dir-default', 'true');
  defaultLine.append(document.createTextNode('默认目录：'), defaultPath);
  statusCard.append(statusLabel, statusPath, statusLine, defaultLine);

  // ---- 修改卡片 ----
  const editCard = el('div', CARD_CLASS);
  const editLabel = el('p', TITLE_CLASS, '改到别的目录');
  const row = el('div', 'flex flex-wrap items-center gap-2');
  const input = el('input', INPUT_CLASS);
  input.type = 'text';
  input.placeholder = '绝对路径，例如 D:\\DSH数据\\canvas';
  input.setAttribute('aria-label', '项目数据目录');
  input.setAttribute('data-fisherai-data-dir-input', 'true');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const applyButton = el('button', PRIMARY_BUTTON_CLASS, '应用');
  applyButton.type = 'button';
  applyButton.setAttribute('aria-label', '应用数据目录');
  applyButton.setAttribute('data-fisherai-data-dir-apply', 'true');
  const resetButton = el('button', BUTTON_CLASS, '恢复默认');
  resetButton.type = 'button';
  resetButton.setAttribute('aria-label', '恢复默认数据目录');
  resetButton.setAttribute('data-fisherai-data-dir-reset', 'true');
  const refreshButton = el('button', BUTTON_CLASS, '刷新');
  refreshButton.type = 'button';
  refreshButton.setAttribute('aria-label', '刷新数据目录');
  refreshButton.setAttribute('data-fisherai-data-dir-refresh', 'true');
  row.append(input, applyButton, resetButton, refreshButton);

  const migrateRow = el('label', 'flex items-center gap-2 text-xs text-[var(--af-text-secondary)]');
  const migrate = el('input', 'size-3.5 accent-[var(--af-info)]');
  migrate.type = 'checkbox';
  migrate.checked = true;
  migrate.setAttribute('aria-label', '复制现有数据');
  migrate.setAttribute('data-fisherai-data-dir-migrate', 'true');
  migrateRow.append(migrate, document.createTextNode('把现有数据复制到新目录（只复制，不删旧目录）'));

  const warning = el(
    'p',
    NOTE_CLASS,
    '改完要重启一次 DSH：host 的存档、素材库、通道表在启动时按目录加载，运行中只写指针不热切换。',
  );
  editCard.append(editLabel, row, migrateRow, warning);

  const notice = el('p', 'hidden text-xs leading-relaxed');
  notice.setAttribute('data-fisherai-data-dir-notice', 'ok');

  root.append(header, statusCard, editCard, notice);
  host.append(root);

  const render = () => {
    const status = state.status;
    statusPath.textContent = status?.active ?? '（读不到）';
    defaultPath.textContent = status?.default ?? '';
    statusLine.textContent = dataDirStatusText(status);
    root.setAttribute('data-fisherai-data-dir-overridden', status?.overridden ? 'true' : 'false');
    root.setAttribute('data-fisherai-data-dir-restart', status?.restartRequired ? 'true' : 'false');
    if (status && !input.value) input.value = status.pending || status.active;
    applyButton.disabled = Boolean(state.busy);
    resetButton.disabled = Boolean(state.busy) || !status?.overridden;
    refreshButton.disabled = Boolean(state.busy);
    applyButton.textContent = state.busy === 'apply' ? '正在复制…' : '应用';
    resetButton.textContent = state.busy === 'reset' ? '正在恢复…' : '恢复默认';
    if (state.notice) {
      notice.className = `text-xs leading-relaxed ${
        state.notice.kind === 'error' ? 'text-[var(--af-danger)]' : 'text-[var(--af-text-secondary)]'
      }`;
      notice.setAttribute('data-fisherai-data-dir-notice', state.notice.kind);
      notice.setAttribute('role', state.notice.kind === 'error' ? 'alert' : 'status');
      notice.textContent = state.notice.text;
    } else {
      notice.className = 'hidden text-xs leading-relaxed';
    }
  };

  const load = async () => {
    try {
      state.status = await fetchDataDirStatus();
      render();
    } catch (error) {
      state.notice = {
        kind: 'error',
        text: error instanceof Error ? error.message : '读取数据目录失败。',
      };
      render();
    }
  };

  const run = async (kind: 'apply' | 'reset') => {
    if (state.busy) return;
    state.busy = kind;
    state.notice = null;
    render();
    try {
      const result: DataDirApplyResult =
        kind === 'apply'
          ? await applyDataDir(input.value, migrate.checked)
          : await resetDataDir();
      state.status = result.status;
      state.notice = {
        kind: 'ok',
        text: result.message,
      };
      if (kind === 'apply') input.value = result.status.pending;
    } catch (error) {
      state.notice = {
        kind: 'error',
        text: error instanceof Error ? error.message : '操作失败。',
      };
    } finally {
      state.busy = '';
      render();
    }
  };

  applyButton.addEventListener('click', () => void run('apply'));
  resetButton.addEventListener('click', () => void run('reset'));
  refreshButton.addEventListener('click', () => {
    state.notice = null;
    void load();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void run('apply');
  });

  render();
  void load();

  return () => {
    if (disposed) return;
    disposed = true;
    root.remove();
  };
}

interface PanelHolder {
  __FISHERAI_MOUNT_DATA_DIR__?: (host: HTMLElement) => (() => void) | null;
  __FISHERAI_CANVAS_DATA_DIR__?: { api: string; report: () => Record<string, unknown> };
}

/** 注册设置页挂载点（vendor 补丁在「存储」分区挂好后调它）。返回撤销函数。 */
export function registerCanvasDataDirPanel(): () => void {
  const holder = globalThis as unknown as PanelHolder;
  holder.__FISHERAI_MOUNT_DATA_DIR__ = (host: HTMLElement) => {
    try {
      return mountCanvasDataDirPanel(host);
    } catch (error) {
      // 面板挂不上不该拦住设置页（vendor 那一行调用点没有 try）
      console.error('[aifisher-canvas] 挂载「项目数据目录」设置面板失败', error);
      return null;
    }
  };
  holder.__FISHERAI_CANVAS_DATA_DIR__ = {
    api: DATA_DIR_API,
    report: () => ({
      mounted: typeof holder.__FISHERAI_MOUNT_DATA_DIR__ === 'function',
      panels: document.querySelectorAll('[data-fisherai-data-dir="panel"]').length,
    }),
  };
  return () => {
    if (holder.__FISHERAI_MOUNT_DATA_DIR__) delete holder.__FISHERAI_MOUNT_DATA_DIR__;
    if (holder.__FISHERAI_CANVAS_DATA_DIR__) delete holder.__FISHERAI_CANVAS_DATA_DIR__;
  };
}
