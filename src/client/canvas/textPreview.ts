/**
 * 文本节点全屏预览（v1.89）。
 *
 * 用户 2026-11-01 原话：「还有做一个文本节点全屏预览的功能」。
 *
 * 画布上文本节点只有卡片那么大：从 .md 拖进来的分镜稿 / 剧本动辄几千字，卡里只能看到
 * 开头几行。上游给的能力是「全屏**编辑**」（编辑器工具栏那个最大化按钮），但那要先选中、
 * 再进编辑态，而且一旦进去就在改内容 —— 只想读一遍的时候并不合适。
 *
 * 所以这里补的是「只读全屏」：
 *   · 入口挂在文本节点头部的按钮条（`.af-text-primary-tools`，和「导入文本」并排），
 *     按钮样式直接用上游的 `.af-text-header-button`，不需要新皮肤；
 *   · 打开后把节点里**已经渲染出来的正文 DOM** 克隆一份塞进浮层 —— 不新建 tiptap 实例、
 *     不碰节点数据、不进编辑态，所以标题/列表/表格/加粗的观感和卡片里完全一致；
 *   · 浮层内容可选中复制、可调字号、Esc / 点空白 / 「关闭」三种退出方式。
 *
 * 为什么不是给 vendor 打补丁：上游的 CanvasTextNodeContent 是 React 组件，改它要动
 * vendor 树（每次构建重新生成）；而这个功能只需要「在头部多挂一个按钮 + 一个浮层」，
 * 用 DOM 侧的同位观察就够了 —— 与 canvasGrid / knife 的做法一致。React 重渲染头部时
 * 我们的按钮会跟着消失，MutationObserver 会立刻补回来。
 */
import { reportCanvasWarning } from './diagnostics';

/** 文本节点的正文容器（上游 CanvasTextNodeContent 的 data-testid）。 */
const TEXT_NODE_CONTENT = '[data-testid="canvas-node-text-content"]';
/** 节点头部的按钮条（「导入文本」/ 标签所在那一行）。 */
const HEADER_TOOLS = '.af-text-primary-tools';
/** 我们注入的入口按钮的标记属性（重扫时用它判重）。 */
const BUTTON_MARK = 'data-af-text-preview-button';
/** 浮层根节点的类名。 */
const OVERLAY_CLASS = 'af-text-preview';
/** 字号档位（px）：默认 16，够读正文又不至于一行字太少。 */
const FONT_STEPS = [13, 15, 16, 18, 20, 22, 26, 30] as const;
const DEFAULT_FONT = 16;

export interface CanvasTextPreviewReport {
  /** 真实打开过几次。 */
  opened: number;
  /** 关掉过几次。 */
  closed: number;
  /** 装上的入口按钮数量（按节点算）。 */
  buttons: number;
  /** 上一次打开时的正文长度与标题。 */
  lastChars: number;
  lastTitle: string;
  lastFont: number;
  lastError: string;
  /** 浮层当前开着没有。 */
  open: boolean;
}

const ICON_EXPAND =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 2H2v4M10 2h4v4M10 14h4v-4M6 14H2v-4"/></svg>';

const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>';

/**
 * 克隆出来的正文要洗一遍：编辑器 DOM 带着 contenteditable / PM 私有属性 /
 * 空段落占位符 —— 直接抄过去会让浮层里的文字可以「打字」，而且多出一截空白。
 */
function sanitizeRenderedHtml(html: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.querySelectorAll('[class*="ProseMirror-trailingbreak"]').forEach((node) => node.remove());
  holder.querySelectorAll('[contenteditable]').forEach((node) => node.removeAttribute('contenteditable'));
  holder.querySelectorAll('[spellcheck], [translate]').forEach((node) => {
    node.removeAttribute('spellcheck');
    node.removeAttribute('translate');
  });
  holder.querySelectorAll('[data-pm-slice]').forEach((node) => node.removeAttribute('data-pm-slice'));
  holder.querySelectorAll('.is-empty').forEach((node) => node.classList.remove('is-empty'));
  holder.querySelectorAll('.selectedCell').forEach((node) => node.classList.remove('selectedCell'));
  return holder.innerHTML;
}

/** 落不到富文档时（jsdom / 编辑器还没挂上）退回纯文本：一行一段。 */
function plainHtml(text: string): string {
  const holder = document.createElement('div');
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    holder.appendChild(paragraph);
  }
  return holder.innerHTML;
}

/** 头部标题：`[data-af-node-title]` 里那个「重命名这个节点」的按钮文字。 */
function nodeTitle(node: Element): string {
  const title =
    node.querySelector('[data-af-node-title] [role="button"] span')?.textContent ??
    node.querySelector('[data-af-node-title] [role="button"]')?.textContent ??
    '';
  return title.trim() || '文本节点';
}

export function canvasTextPreviewStyleText(): string {
  return `
/* ---- 文本节点全屏预览（v1.89）----
   浮层铺满窗口；正文沿用画布编辑器自己的排版（.af-text-editor-document 那套），
   只是把字号放到「读稿」的尺寸并居中成一栏。 */
.af-text-preview {
  position: fixed;
  inset: 0;
  z-index: 12100;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--af-canvas, #0e0f13) 90%, #000);
  color: var(--af-text, #e5e7eb);
  font-family: inherit;
}
.af-text-preview-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--af-border, #333a45);
  background: var(--af-surface, #171a21);
}
.af-text-preview-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.af-text-preview-meta {
  flex: none;
  font-size: 11px;
  color: var(--af-text-muted, #8b8f98);
  white-space: nowrap;
}
.af-text-preview-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}
.af-text-preview-tools button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 9px;
  border: 1px solid var(--af-border-control, #3b4250);
  border-radius: 6px;
  background: var(--af-surface-raised, #1f2430);
  color: var(--af-text, #e5e7eb);
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
}
.af-text-preview-tools button:hover:not(:disabled) { background: var(--af-hover, #262c38); }
.af-text-preview-tools button:focus-visible {
  outline: 2px solid var(--af-focus, #60a5fa);
  outline-offset: 2px;
}
.af-text-preview-tools button:disabled { opacity: 0.45; cursor: default; }
.af-text-preview-tools .af-text-preview-close { padding: 5px 7px; }
.af-text-preview-button { flex: 0 0 auto; padding: 5px 6px; }
.af-text-preview-editor {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  padding: 0 10px 14px;
}
.af-text-preview-editor .af-text-editor-scroll {
  background: var(--af-surface, #171a21);
  border: 1px solid var(--af-border, #333a45);
  border-radius: 14px;
}
.af-text-preview-editor .af-text-editor-document {
  max-width: 900px;
  margin: 0 auto;
  padding: 30px clamp(18px, 4vw, 56px) 96px;
  font-size: var(--af-preview-font, 16px);
  line-height: 1.85;
  cursor: text;
  user-select: text;
}
.af-text-preview-editor .af-text-editor-document p {
  font-size: inherit !important;
  line-height: inherit;
  margin: 0 0 0.85em !important;
  min-height: 1em;
}
.af-text-preview-editor .af-text-editor-document h1,
.af-text-preview-editor .af-text-editor-document h2,
.af-text-preview-editor .af-text-editor-document h3 {
  margin: 1.1em 0 0.6em;
  line-height: 1.35;
}
.af-text-preview-editor .af-text-editor-document > :first-child { margin-top: 0; }
.af-text-preview-editor .af-text-editor-document ul,
.af-text-preview-editor .af-text-editor-document ol { margin: 0 0 0.9em; }
.af-text-preview-editor .af-text-editor-document li p { margin: 0 0 0.2em !important; }
.af-text-preview-empty {
  max-width: 900px;
  margin: 0 auto;
  padding: 40px 24px;
  color: var(--af-text-muted, #8b8f98);
  font-size: 13px;
  text-align: center;
}
.af-text-preview [data-af-text-preview-toast] {
  position: absolute;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  padding: 7px 13px;
  border-radius: 8px;
  border: 1px solid var(--af-border-control, #3b4250);
  background: var(--af-surface-raised, #1f2430);
  color: var(--af-text, #e5e7eb);
  font-size: 12px;
  pointer-events: none;
}
`;
}

/** 复制正文：优先 Clipboard API，拿不到就退回 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限被拒 / 非安全上下文：走下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.('copy') === true;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function installCanvasTextPreview(): () => void {
  if (typeof document === 'undefined') return () => {};
  const holder = window as unknown as { __FISHERAI_CANVAS_TEXT_PREVIEW__?: CanvasTextPreviewReport };
  const report: CanvasTextPreviewReport = {
    opened: 0,
    closed: 0,
    buttons: 0,
    lastChars: 0,
    lastTitle: '',
    lastFont: DEFAULT_FONT,
    lastError: '',
    open: false,
  };
  holder.__FISHERAI_CANVAS_TEXT_PREVIEW__ = report;

  let overlay: HTMLElement | null = null;
  let overlayBody: HTMLElement | null = null;
  let overlayTitle: HTMLElement | null = null;
  let overlayMeta: HTMLElement | null = null;
  let fontStep = FONT_STEPS.indexOf(DEFAULT_FONT);
  let toastTimer = 0;

  const setFontStep = (next: number) => {
    const clamp = Math.min(FONT_STEPS.length - 1, Math.max(0, next));
    fontStep = clamp;
    const font = FONT_STEPS[clamp];
    report.lastFont = font;
    if (overlayBody) overlayBody.style.setProperty('--af-preview-font', `${font}px`);
    if (overlayMeta) overlayMeta.dataset.font = String(font);
    const smaller = overlay?.querySelector<HTMLButtonElement>('[data-act="smaller"]');
    const larger = overlay?.querySelector<HTMLButtonElement>('[data-act="larger"]');
    if (smaller) smaller.disabled = clamp === 0;
    if (larger) larger.disabled = clamp === FONT_STEPS.length - 1;
    const label = overlay?.querySelector<HTMLElement>('[data-af-text-preview-font]');
    if (label) label.textContent = `字号 ${font}`;
  };
  const toast = (text: string) => {
    if (!overlay) return;
    overlay.querySelectorAll('[data-af-text-preview-toast]').forEach((node) => node.remove());
    const element = document.createElement('div');
    element.setAttribute('data-af-text-preview-toast', 'true');
    element.setAttribute('role', 'status');
    element.textContent = text;
    overlay.appendChild(element);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => element.remove(), 1800);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!overlay) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // 浮层开着时画布的热键（Delete / Ctrl+A / 空格平移…）一概不接
    event.stopPropagation();
  };

  const close = () => {
    if (!overlay) return;
    const element = overlay;
    overlay = null;
    overlayBody = null;
    overlayTitle = null;
    overlayMeta = null;
    report.open = false;
    report.closed += 1;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    element.remove();
  };

  const open = (node: Element) => {
    close();
    const source = node.querySelector('.af-text-editor-document');
    const fallback = node.querySelector(TEXT_NODE_CONTENT)?.textContent ?? '';
    const chars = Array.from(fallback).length;
    const title = nodeTitle(node);

    const root = document.createElement('div');
    root.className = OVERLAY_CLASS;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', `${title} · 全屏预览`);
    root.innerHTML = [
      '<div class="af-text-preview-bar">',
      '<span class="af-text-preview-title"></span>',
      '<span class="af-text-preview-meta" data-af-text-preview-meta></span>',
      '<div class="af-text-preview-tools">',
      '<button type="button" data-act="smaller" aria-label="缩小字号">A−</button>',
      '<button type="button" data-act="larger" aria-label="放大字号">A+</button>',
      '<span class="af-text-preview-meta" data-af-text-preview-font></span>',
      '<button type="button" data-act="copy">复制全文</button>',
      '<button type="button" data-act="close" class="af-text-preview-close" aria-label="关闭全屏预览">',
      ICON_CLOSE,
      '关闭 · Esc',
      '</button>',
      '</div>',
      '</div>',
      '<div class="af-text-editor af-text-preview-editor" data-editable="true">',
      '<div class="af-text-editor-scroll">',
      '<div class="af-text-editor-document" data-af-text-preview-document="true"></div>',
      '</div>',
      '</div>',
    ].join('');

    overlayTitle = root.querySelector('.af-text-preview-title');
    overlayMeta = root.querySelector('[data-af-text-preview-meta]');
    overlayBody = root.querySelector('[data-af-text-preview-document]');
    if (overlayTitle) overlayTitle.textContent = title;
    if (overlayMeta) {
      overlayMeta.textContent = chars > 0 ? `${chars.toLocaleString()} 字 · 只读` : '只读';
    }

    const html = source
      ? sanitizeRenderedHtml(source.innerHTML)
      : plainHtml(fallback);
    if (overlayBody) {
      if (html.trim()) overlayBody.innerHTML = html;
      else {
        const empty = document.createElement('div');
        empty.className = 'af-text-preview-empty';
        empty.textContent = '这个文本节点还没有正文 —— 双击卡片可以编辑，或把 .md / .txt 拖进画布。';
        overlayBody.appendChild(empty);
      }
    }

    // 浮层里的一切都不要漏给画布：拖动/滚轮/右键/按键都会让底下的画布跟着动。
    root.addEventListener('pointerdown', (event) => {
      if (event.target === root) {
        close();
        return;
      }
      event.stopPropagation();
    });
    root.addEventListener('contextmenu', (event) => event.stopPropagation());
    root.addEventListener('wheel', (event) => event.stopPropagation(), true);
    root.addEventListener('dblclick', (event) => event.stopPropagation());
    root.querySelector('[data-act="smaller"]')?.addEventListener('click', () => setFontStep(fontStep - 1));
    root.querySelector('[data-act="larger"]')?.addEventListener('click', () => setFontStep(fontStep + 1));
    root.querySelector('[data-act="close"]')?.addEventListener('click', close);
    root.querySelector('[data-act="copy"]')?.addEventListener('click', () => {
      const text = overlayBody?.innerText ?? '';
      void copyText(text).then((ok) => toast(ok ? '已复制全文' : '复制失败：浏览器不让写剪贴板'));
    });

    overlay = root;
    document.body.appendChild(root);
    setFontStep(Math.max(0, FONT_STEPS.indexOf(DEFAULT_FONT)));
    report.open = true;
    report.opened += 1;
    report.lastChars = chars;
    report.lastTitle = title;
    report.lastError = '';
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    // 打开就把焦点放进浮层：Esc / Tab 才不会留在下面的画布上
    root.tabIndex = -1;
    root.focus({ preventScroll: true });
  };

  const makeButton = (node: Element) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'af-text-header-button af-text-preview-button';
    button.setAttribute(BUTTON_MARK, 'true');
    button.setAttribute('aria-label', '全屏预览正文');
    button.title = '全屏预览正文（只读：可选中复制，Esc 关闭）';
    // 只放图标、不写文字：头部那条按钮条（`.af-text-primary-tools`）在 252px 宽的文本卡上
    // 只有 76% 宽度，塞进「导入文本」+ 标签之后放不下第四个带字的按钮。
    button.innerHTML = ICON_EXPAND;
    // 头部按钮条自己的指针事件会传到画布（拖节点）：这里全程吞掉，只留点击。
    for (const type of ['pointerdown', 'mousedown', 'dblclick'] as const) {
      button.addEventListener(type, (event) => event.stopPropagation());
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        open(node);
      } catch (error) {
        report.lastError = error instanceof Error ? error.message : String(error);
        reportCanvasWarning('文本节点全屏预览打开失败', { error: report.lastError });
        close();
      }
    });
    return button;
  };

  /** 给画布上每个文本节点补一个入口按钮（已经有就跳过）。 */
  const scan = () => {
    let attached = 0;
    for (const node of Array.from(document.querySelectorAll('[data-node-id]'))) {
      if (!node.querySelector(TEXT_NODE_CONTENT)) continue;
      if (node.querySelector(`[${BUTTON_MARK}]`)) continue;
      const tools = node.querySelector(HEADER_TOOLS);
      if (!tools) continue;
      tools.appendChild(makeButton(node));
    }
    // 头部按钮条只在「单选这个节点」时才渲染，所以这里按真实装上的按钮数记账。
    attached = document.querySelectorAll(`[${BUTTON_MARK}]`).length;
    report.buttons = attached;
    return attached;
  };

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    const run = () => {
      frame = 0;
      try {
        scan();
      } catch (error) {
        report.lastError = error instanceof Error ? error.message : String(error);
      }
    };
    // jsdom 有 rAF；万一没有就退回定时器（80ms 足够「点了就出现」的体感）
    frame =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(run)
        : (window.setTimeout(run, 80) as unknown as number);
  };

  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => schedule())
      : null;
  observer?.observe(document.body, { childList: true, subtree: true });
  // 首屏节点可能是挂载前就画好的：先扫一遍，再让观察者接手后续增删。
  schedule();

  return () => {
    close();
    observer?.disconnect();
    if (frame) {
      if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      window.clearTimeout(frame);
      frame = 0;
    }
    document.querySelectorAll(`[${BUTTON_MARK}]`).forEach((node) => node.remove());
    if (holder.__FISHERAI_CANVAS_TEXT_PREVIEW__ === report) {
      delete holder.__FISHERAI_CANVAS_TEXT_PREVIEW__;
    }
  };
}
