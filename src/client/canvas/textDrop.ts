/**
 * 画布：把 .md / .txt 拖进来 → 直接生成一个文本节点（v1.87）。
 *
 * 用户 2026-11-01 原话：「现在画布里的文本节点不兼容 .md 格式的文件，导入 .md 文件内容
 * 格式完全不正确。可以做一个能直接拖入 .md 文件到画布生成文本节点」。
 *
 * 以前拖文件的唯一去处是画布的 `onDrop` → `upload()`，它只认图片/视频/音频：
 * `classifyMedia()` 不认识 .md 就 `window.alert('无法识别的文件类型')`，什么都没发生。
 * 文本节点自己的「导入文本」更是把 .md 送去 host 解析成**纯文本**，标题/列表/加粗
 * 全成了字面量 —— 这就是用户说的「格式完全不正确」。
 *
 * 这里做两件事：
 *   ① 在 **window 捕获阶段**拦下落在画布里的文本文件（React 的 onDrop 挂在容器上，
 *      捕获先到；不拦会先弹一句「无法识别的文件类型」）。图片/视频/音频一律放行，
 *      仍走画布原来的上传链路。
 *   ② 本机解析：Markdown 用 vendor 的 `textDocumentFromMarkdown()`（构建期追加，
 *      见 scripts/vendor-aifisher.mjs 3.13 段）翻成节点自己的 tiptap 文档，纯文本
 *      格式按行成段。两条路最后都过 `createTextDocumentPatch()` —— textContent 与
 *      textRichContent 必须一起产出，否则文本节点会退回「纯段落、格式丢失」的样子。
 *
 * 落点：`fisherai:add-canvas-node`（节点搜索用的同一个出口，vendor 补丁让它可以带
 * `textPatch`），世界坐标换算与 Shift+A 搜索面板完全一致：`#canvas-viewport-content`
 * 的 translate3d/scale 就是屏幕 → 世界的那条映射，`#canvas-background` 是它的原点。
 * 节点以指针为**中心**（画布侧建节点桥统一按 nodeWidth/nodeHeight 反推左上角）。
 */
import {
  createTextDocumentPatch,
  isMarkdownFileName,
  textDocumentFromMarkdown,
  textDocumentFromPlainText,
} from '../../../vendor/aifisher/src/stable/text/textDocument';

/** 拖进来会被当成「文本」的扩展名（与文本节点「导入文本」的 accept 大体一致，去掉了 docx）。 */
const TEXT_FILE_NAME =
  /\.(md|markdown|mdown|mkd|mkdn|mdx|mdwn|mdtxt|mdtext|txt|text|log|csv|tsv|json|jsonl|yaml|yml|srt|vtt)$/i;

/** 一份正文拖进来超过 2 MB 就不落节点：文本节点是「摆提示词/分镜稿」的，不是装整本书的。 */
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** 一次拖多份文件时的斜向错位（避免叠成一摞，看不清有几张）。 */
const NODE_STACK_OFFSET = 36;

export interface CanvasTextDropReport {
  /** 拦下的拖入次数（文本文件才开始计数）。 */
  drops: number;
  /** 真的建出文本节点的个数。 */
  created: number;
  /** 解析/落库失败的个数。 */
  skipped: number;
  lastError: string;
  lastFile: string;
  /** markdown / text —— 这份文件走的是哪条解析。 */
  lastKind: string;
  lastChars: number;
  lastPoint: { x: number; y: number } | null;
}

interface CanvasViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '文本文件读取失败';
}

/** `#canvas-viewport-content` 的内联 transform —— 画布自己就是靠它做屏幕↔世界的映射。 */
function canvasViewportTransform(): CanvasViewportTransform {
  const transform = document.getElementById('canvas-viewport-content')?.style.transform ?? '';
  const translate = /translate3d\(\s*([-0-9.eE+]+)px,\s*([-0-9.eE+]+)px,\s*0(?:px)?\s*\)/.exec(
    transform,
  );
  const scale = /scale\(\s*([-0-9.eE+]+)\s*\)/.exec(transform);
  const x = translate ? Number.parseFloat(translate[1]) : 0;
  const y = translate ? Number.parseFloat(translate[2]) : 0;
  const zoom = scale ? Number.parseFloat(scale[1]) : 1;
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
  };
}

/** 视口坐标 → 画布世界坐标（与节点搜索面板同一套公式）。 */
function dropPoint(clientX: number, clientY: number): { x: number; y: number } | undefined {
  const rect = document.getElementById('canvas-background')?.getBoundingClientRect();
  const viewport = canvasViewportTransform();
  const x = (clientX - (rect?.left ?? 0) - viewport.x) / viewport.zoom;
  const y = (clientY - (rect?.top ?? 0) - viewport.y) / viewport.zoom;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/**
 * 画布里自带文件拖放入口的区域 —— 拖进去要先让给它，不能抢：
 *   `[data-fisherai-workflow-manager]` 工作流库面板（拖 ComfyUI 工作流 JSON 进来自动导入）、
 *   以及任何 `<dialog>` / `role="dialog"` 浮层（节点搜索、各种设置弹层）。
 * 这几个选择器来自上游：workflowManager.ts 的 HOST_ATTRIBUTE 与 fwm 弹窗。
 */
const FOREIGN_DROP_ZONE =
  '[data-fisherai-workflow-manager], [data-fisherai-workflow-library-dialog], dialog, [role="dialog"]';

/** 落点该不该由我们接管：必须在画布里，且不在别人自己的拖放区上。 */
function dropAllowed(target: EventTarget | null): boolean {
  const element = target && typeof (target as Element).closest === 'function' ? (target as Element) : null;
  if (!element?.closest('#canvas-background, .af-canvas-mount')) return false;
  return !element.closest(FOREIGN_DROP_ZONE);
}

function textFilesOf(event: DragEvent): File[] {
  const list = event.dataTransfer?.files;
  if (!list || !list.length) return [];
  return Array.from(list).filter((file) => TEXT_FILE_NAME.test(String(file.name ?? '')));
}

function readFileText(file: File): Promise<string> {
  // File.text() 在目标浏览器里都有；jsdom 也实现了。老环境退回 FileReader。
  if (typeof file.text === 'function') return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文本文件读取失败'));
    reader.readAsText(file);
  });
}

const TOAST_BOTTOM = 96;

function toast(text: string, tone: 'ok' | 'error' = 'ok'): void {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-fisherai-text-drop-toast]').forEach((node) => node.remove());
  const element = document.createElement('div');
  element.dataset.fisheraiTextDropToast = tone;
  element.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  element.textContent = text;
  element.style.cssText = [
    'position:fixed',
    'left:50%',
    `bottom:${TOAST_BOTTOM}px`,
    'transform:translateX(-50%)',
    'z-index:12000',
    'max-width:min(620px,calc(100vw - 48px))',
    'padding:9px 14px',
    'border-radius:10px',
    'border:1px solid ' + (tone === 'error' ? 'var(--af-danger,#f87171)' : 'var(--af-border,#333a45)'),
    'background:var(--af-surface-raised,#1f2430)',
    'color:' + (tone === 'error' ? 'var(--af-danger,#f87171)' : 'var(--af-text,#e5e7eb)'),
    'font-size:12px',
    'line-height:1.6',
    'box-shadow:0 12px 32px rgba(0,0,0,.45)',
    'pointer-events:none',
    'white-space:pre-wrap',
  ].join(';');
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 3600);
}

/**
 * 以指针为中心建一个带正文的文本节点。
 *
 * 只派发事件、不直接改 store：节点 store 在 vendor 的 useCanvasNodes 里，`fisherai:add-canvas-node`
 * 是它唯一对外出口（节点搜索也走这条），默认模型、尺寸、选中、脏标记全都一致。
 */
function requestTextNode(
  point: { x: number; y: number },
  patch: { textContent: string; textRichContent: unknown },
): void {
  window.dispatchEvent(
    new CustomEvent('fisherai:add-canvas-node', {
      detail: { type: 'Text', point, textPatch: patch },
    }),
  );
}

export function installCanvasTextFileDrop(): () => void {
  const holder = window as unknown as { __FISHERAI_CANVAS_TEXT_DROP__?: CanvasTextDropReport };
  const report: CanvasTextDropReport = {
    drops: 0,
    created: 0,
    skipped: 0,
    lastError: '',
    lastFile: '',
    lastKind: '',
    lastChars: 0,
    lastPoint: null,
  };
  holder.__FISHERAI_CANVAS_TEXT_DROP__ = report;

  const createFromFiles = async (
    files: File[],
    point: { x: number; y: number },
    ignored: number,
  ) => {
    // 同一次拖里混了图片/视频：那几份我们既不能上传（已 stopPropagation）也不能当正文，
    // 说出来比静默吞掉强 —— 用户再单独拖一次就好。
    if (ignored > 0) {
      toast(`同批还有 ${ignored} 个非文本文件没处理，图片/视频请单独拖一次。`);
    }
    for (const [index, file] of files.entries()) {
      const spot = {
        x: point.x + index * NODE_STACK_OFFSET,
        y: point.y + index * NODE_STACK_OFFSET,
      };
      try {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          throw new Error(
            `${file.name} 太大（${(file.size / 1024 / 1024).toFixed(1)} MB），拖入上限 2 MB。`,
          );
        }
        const source = await readFileText(file);
        if (!source.trim()) throw new Error(`${file.name} 没有正文。`);
        const markdown = isMarkdownFileName(file.name);
        const document = markdown
          ? textDocumentFromMarkdown(source)
          : textDocumentFromPlainText(source);
        // 必须过这一层：它把 schema 校验与「纯文本镜像」一起算出来，
        // 少了镜像文本，文本节点下次渲染就会退回纯段落。
        const patch = createTextDocumentPatch(document);
        requestTextNode(spot, patch);
        report.created += 1;
        report.lastFile = file.name;
        report.lastKind = markdown ? 'markdown' : 'text';
        report.lastChars = patch.textContent.length;
        report.lastError = '';
      } catch (error) {
        report.skipped += 1;
        report.lastFile = file.name;
        report.lastError = message(error);
        toast(report.lastError, 'error');
        console.error('[aifisher-canvas] 拖入文本文件失败', error);
      }
    }
  };

  // 拖进来时给个「可以放」的光标反馈（不拦图片/视频：那是画布自己的上传）。
  const onDragOver = (event: DragEvent) => {
    if (!textFilesOf(event).length) return;
    if (!dropAllowed(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent) => {
    const files = textFilesOf(event);
    if (!files.length) return;
    if (!dropAllowed(event.target)) return;
    // 捕获阶段就掐断：画布容器的 onDrop 只认媒体文件，放过去会弹「无法识别的文件类型」。
    event.preventDefault();
    event.stopPropagation();
    report.drops += 1;
    const point = dropPoint(event.clientX, event.clientY);
    if (!point) {
      report.skipped += 1;
      report.lastError = '算不出落点，请把文件拖到画布中间再试';
      toast(report.lastError, 'error');
      return;
    }
    report.lastPoint = point;
    const total = event.dataTransfer?.files?.length ?? files.length;
    void createFromFiles(files, point, Math.max(0, total - files.length));
  };

  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('drop', onDrop, true);
  return () => {
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('drop', onDrop, true);
    if (holder.__FISHERAI_CANVAS_TEXT_DROP__ === report) {
      delete holder.__FISHERAI_CANVAS_TEXT_DROP__;
    }
  };
}
