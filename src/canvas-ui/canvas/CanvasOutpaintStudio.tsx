/**
 * 「整页扩图」工作台（v1.83，设计稿 A：参数态）。
 *
 * ## 为什么是整页
 *
 * v1.82 的扩图面板挂在**节点工具条下面**，本质是节点气泡：它能到 520px 已经是极限，
 * 再往大放（880 / 560 两次实测）不是越出画布左边，就是把两栏挤成一行字。原因是
 * 它长在节点卡里，而节点卡在带 transform 的画布 viewport 里 —— `fixed` 会被困住，
 * `100vw` 也对不上画布容器。
 *
 * 这一版把它挂成**画布容器的兄弟图层**：portal 到 `.af-canvas-mount`，矩形按
 * `canvasOverlayBox()` 量出来的画布实际尺寸（与图片编辑工作台同一套做法）。于是
 * 顶栏 / 大舞台 / 右侧参数栏三块都有了真正的空间，扩图终于能「看着整张目标画幅调参」。
 *
 * ## 红线没动
 *
 * - **不直接生图**：主按钮只调 `__FISHERAI_CANVAS_OUTPAINT__.create()` —— 先落
 *   「扩图画面」，再建一个空的图像生成节点，生成按钮在节点上由用户点。
 * - **模型跟着通道走**：模型 / 比例候选全部来自 `__FISHERAI_OUTPAINT__.model()`，
 *   本页不自己挑模型，也不写死上游目录里那些没有后端的条目。
 * - **几何口径不重算**：能解码出原图像素时用 `outpaintGeometry()`（与落盘同一份函数）；
 *   解码不到（jsdom / 跨域）就退回装配层的 `preview()`，面板上写的就是待会要落的那张。
 *
 * ## 结构契约（回归 / 真机检查依赖，一个都不能少）
 *
 * 根 `role="dialog"` + `aria-label="扩图"` + `data-fisherai-outpaint-panel="true"` +
 * `data-fisherai-outpaint-model`；九宫格 `data-fisherai-outpaint-anchor="<value>"`（9 个、
 * 带 aria-pressed / aria-label「原图位置 X」）；比例 `data-fisherai-outpaint-ratio="16:9"`；
 * 提示词 `data-fisherai-outpaint-content`；预览 `data-fisherai-outpaint-preview` +
 * `data-fisherai-outpaint-preview-size` + 里面的 `data-fisherai-outpaint-preview-image`；
 * 主按钮 `data-fisherai-outpaint-create` + aria-label「生成扩图画面」；关闭「关闭扩图」；
 * 模型读数 `data-fisherai-outpaint-model-name`。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）—— 产物里 React 有两份副本。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import { createPortal } from 'react-dom';
import {
  Check as CheckIcon,
  Image as ImageIcon,
  LoaderCircle as LoaderCircleIcon,
  Scaling as ScalingIcon,
  X as XIcon,
} from 'lucide-react';

import { canvasPortalTarget } from '@/lib/portal';
import { activateModal } from '../../../vendor/aifisher/src/stable/design/modalFocus';
import { fitInside, WORKBENCH_ROOT_CLASS, type WorkbenchSize } from './imageWorkbench';
import { useCanvasOverlayBox } from './imageWorkbenchOverlay';
import {
  anchorSpec,
  OUTPAINT_ANCHORS,
  OUTPAINT_MAX_SIDE,
  outpaintGeometry,
  outpaintSourceSize,
  type OutpaintGeometry,
  type OutpaintSource,
} from './CanvasOutpaint';
import {
  closeOutpaintStudio,
  currentOutpaintStudio,
  subscribeOutpaintStudio,
  type OutpaintStudioNode,
} from './CanvasOutpaintStudioStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

/** `__FISHERAI_OUTPAINT__`（装配层 bootstrap.ts 注册）里本页用到的两个方法。 */
interface OutpaintBridge {
  model(): { name: string; ratios: string[]; defaultRatio: string; channelModel: boolean } | null;
  preview?(
    source: OutpaintSource,
    options?: { ratio?: string; anchor?: string },
  ): (OutpaintGeometry & { exact: boolean }) | null;
}

/** `__FISHERAI_CANVAS_OUTPAINT__.create()` 的返回形状（vendor 补丁 3.8p）。 */
interface OutpaintCreateBridge {
  create(
    sourceId: string,
    options?: { ratio?: string; anchor?: string; content?: string },
  ): Promise<{
    ok: boolean;
    id?: string;
    compositeId?: string;
    url?: string;
    prompt?: string;
    model?: string;
    error?: string;
  }>;
}

type Geometry = OutpaintGeometry & { exact: boolean };

/** 延展提示词的快捷短语（点了往输入框里补一句，不是「假开关」）。 */
const CONTENT_HINTS: Array<{ label: string; text: string }> = [
  { label: '自然延续', text: '画面自然延续，环境与细节连贯' },
  { label: '保持光线方向', text: '新区域保持原有光照方向与色温' },
  { label: '补全招牌', text: '补全画面里被切断的招牌与物件' },
];

function outpaintWindow(): {
  __FISHERAI_OUTPAINT__?: OutpaintBridge;
  __FISHERAI_CANVAS_OUTPAINT__?: OutpaintCreateBridge;
} {
  return window as unknown as {
    __FISHERAI_OUTPAINT__?: OutpaintBridge;
    __FISHERAI_CANVAS_OUTPAINT__?: OutpaintCreateBridge;
  };
}

function percent(value: number, total: number): string {
  return `${(value / Math.max(1, total)) * 100}%`;
}

export interface CanvasOutpaintStudioProps {
  /** 诊断 / 回归可传一份固定请求，不传就订阅全局 store（真机路径）。 */
  request?: ReturnType<typeof currentOutpaintStudio>;
}

export function CanvasOutpaintStudio(react: Runtime, props: CanvasOutpaintStudioProps = {}) {
  const h = createElement(react);
  const overlay = useCanvasOverlayBox(react);
  const request = react.useSyncExternalStore(
    subscribeOutpaintStudio,
    currentOutpaintStudio,
    currentOutpaintStudio,
  );
  const active = props.request ?? request;

  const rootRef = react.useRef<HTMLDivElement | null>(null);
  const stageRef = react.useRef<HTMLDivElement | null>(null);
  const closeRef = react.useRef(closeOutpaintStudio);
  const createRef = react.useRef<() => void>(() => {});

  const [ratio, setRatio] = react.useState('');
  const [anchor, setAnchor] = react.useState('center');
  const [content, setContent] = react.useState('');
  const [busy, setBusy] = react.useState(false);
  const [error, setError] = react.useState('');
  const [sourceSize, setSourceSize] = react.useState<WorkbenchSize | null>(null);
  const [stageBox, setStageBox] = react.useState<WorkbenchSize>({ width: 0, height: 0 });

  const node = active?.node as OutpaintStudioNode | undefined;
  const requestKey = active?.key ?? 0;
  const resultUrl = typeof node?.resultUrl === 'string' ? node.resultUrl : '';

  const modelInfo = node ? (outpaintWindow().__FISHERAI_OUTPAINT__?.model?.() ?? null) : null;
  const ratios = modelInfo?.ratios ?? [];

  /** 每次打开都回到默认值（上一位打开时的比例 / 提示词不能漏到这张图上）。 */
  react.useEffect(() => {
    if (!active) return;
    const info = outpaintWindow().__FISHERAI_OUTPAINT__?.model?.() ?? null;
    setRatio(info?.defaultRatio ?? info?.ratios?.[0] ?? '');
    setAnchor('center');
    setContent('');
    setError('');
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  /** 读原图真实像素（拿不到就走装配层的按比例估算）。 */
  react.useEffect(() => {
    if (!resultUrl) {
      setSourceSize(null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const width = Number(image.naturalWidth) || 0;
      const height = Number(image.naturalHeight) || 0;
      setSourceSize(width >= 2 && height >= 2 ? { width, height } : null);
    };
    image.onerror = () => {
      if (!cancelled) setSourceSize(null);
    };
    try {
      image.src = resultUrl;
    } catch {
      setSourceSize(null);
    }
    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [resultUrl]);

  const activeRatio =
    ratio && ratios.includes(ratio) ? ratio : (modelInfo?.defaultRatio ?? ratios[0] ?? '');

  /** 扩图画面的几何：与落盘那张图同一套公式（`prepare()` 也走这一份）。 */
  const geometry = react.useMemo<Geometry | null>(() => {
    if (!node) return null;
    if (sourceSize) {
      return {
        ...outpaintGeometry({
          width: sourceSize.width,
          height: sourceSize.height,
          ratio: activeRatio,
          anchor,
        }),
        exact: true,
      };
    }
    const preview = outpaintWindow().__FISHERAI_OUTPAINT__?.preview;
    if (typeof preview === 'function') {
      const value = preview(node as OutpaintSource, { ratio: activeRatio, anchor });
      if (value) return value;
    }
    const meta = outpaintSourceSize(node as OutpaintSource);
    return {
      ...outpaintGeometry({
        width: meta.width,
        height: meta.height,
        ratio: activeRatio,
        anchor,
      }),
      exact: meta.exact,
    };
  }, [node, sourceSize, activeRatio, anchor]);

  /** 舞台尺寸跟着容器走：目标画幅按等比塞进中间那块（不裁、不放大到糊）。 */
  const measureStage = react.useCallback(() => {
    const element = stageRef.current;
    if (!element) return;
    setStageBox({ width: element.clientWidth, height: element.clientHeight });
  }, []);
  react.useEffect(() => {
    if (!active || !geometry) return;
    measureStage();
    const element = stageRef.current;
    const observer =
      typeof ResizeObserver !== 'undefined' && element ? new ResizeObserver(measureStage) : null;
    if (element) observer?.observe(element);
    window.addEventListener('resize', measureStage);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measureStage);
    };
  }, [active, geometry?.width, geometry?.height, measureStage]);

  /** 首页才有 modal 契约（Esc 关闭 / 焦点进页面 / 背后画布 inert）。 */
  react.useEffect(() => {
    if (!active || !rootRef.current) return;
    // initialFocus 指回页面本身：默认会落在「第一个可聚焦元素」＝右上角 ✕ 上，
    // 一进来就顶着一个焦点环，还容易让空格/回车直接关掉页面。
    return activateModal(rootRef.current, () => closeRef.current(), {
      initialFocus: rootRef.current,
    });
  }, [active, requestKey]);

  const create = react.useCallback(async () => {
    if (!node?.id) return;
    if (busy) return;
    const bridge = outpaintWindow().__FISHERAI_CANVAS_OUTPAINT__;
    if (!bridge || typeof bridge.create !== 'function') {
      setError('扩图模块还没装配好，刷新页面后重试。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await bridge.create(node.id, { anchor, ratio: activeRatio, content });
      if (!result || !result.ok) {
        setError((result && result.error) || '生成扩图画面失败。');
        return;
      }
      // 建好就收起：两张新节点（扩图画面 + 空生成节点）已经在画布上并选中。
      closeRef.current();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成扩图画面失败。');
    } finally {
      setBusy(false);
    }
  }, [node?.id, busy, anchor, activeRatio, content]);
  createRef.current = () => {
    void create();
  };

  if (!active || !node) return null;

  const spec = anchorSpec(anchor);
  const pad = geometry?.pad;
  const previewBox = geometry
    ? fitInside(
        { width: Math.max(1, geometry.width), height: Math.max(1, geometry.height) },
        { width: stageBox.width, height: stageBox.height },
        22,
      )
    : { width: 0, height: 0 };
  const sourceLabel = geometry
    ? geometry.exact
      ? `${geometry.imageWidth} × ${geometry.imageHeight}`
      : activeRatio || '原图'
    : '—';
  const targetLabel = geometry
    ? geometry.exact
      ? `${geometry.width} × ${geometry.height}`
      : `目标画幅 ${activeRatio || '—'}`
    : '—';
  const extensionPercent = geometry
    ? Math.round(
        (1 - (geometry.imageWidth * geometry.imageHeight) / (geometry.width * geometry.height)) * 100,
      )
    : 0;
  const pads = geometry
    ? ([
        ['左', pad?.left ?? 0],
        ['右', pad?.right ?? 0],
        ['上', pad?.top ?? 0],
        ['下', pad?.bottom ?? 0],
      ] as Array<[string, number]>).filter(([, value]) => value > 0)
    : [];
  const sidesText = pads.length ? pads.map(([side, value]) => `${side} ${value} px`).join('、') : '';

  const fieldsetTitle = (title: string, right?: string) =>
    h(
      'div',
      { className: 'afw-sect-t' },
      title,
      right ? h('span', { className: 'r' }, right) : null,
    );

  const header = h(
    'header',
    { className: 'afw-top' },
    h(ScalingIcon, { className: 'afo-head-ico' }),
    h('span', { className: 'afw-title' }, '扩图'),
    h('span', { className: 'afw-badge' }, node.title ? String(node.title) : '画布节点'),
    h(
      'span',
      { className: 'afw-sub afo-dim' },
      geometry?.exact ? `${geometry.imageWidth} × ${geometry.imageHeight}` : `比例 ${activeRatio || '—'}`,
    ),
    h('div', { className: 'min-w-0 flex-1' }),
    h('span', { className: 'afw-badge mint' }, activeRatio || '—'),
    h(
      'button',
      {
        type: 'button',
        className: 'afw-iconbtn',
        'aria-label': '关闭扩图',
        title: '关闭（Esc）',
        onClick: () => closeOutpaintStudio(),
      },
      h(XIcon, {}),
    ),
  );

  const stageHint = geometry
    ? `原图${spec.label} · ${geometry.exact && sidesText ? `${sidesText} · ` : ''}目标 ${activeRatio || '—'}`
    : '正在读取原图尺寸…';

  const frame = geometry
    ? h(
        'div',
        { className: 'afo-frame-wrap' },
        h(
          'div',
          {
            className: 'afo-frame',
            'data-fisherai-outpaint-preview': 'true',
            'data-fisherai-outpaint-preview-size': `${geometry.width}x${geometry.height}`,
            style: {
              width: previewBox.width || '72%',
              height: previewBox.height || '72%',
            },
          },
          // 四个待补区域：斜纹 + 冷色描边，一眼看出「这块还没画」。
          ...(
            [
              [
                'afo-zone-l',
                {
                  left: 0,
                  top: 0,
                  width: percent(geometry.offsetX, geometry.width),
                  height: '100%',
                },
              ],
              [
                'afo-zone-r',
                {
                  left: percent(geometry.offsetX + geometry.imageWidth, geometry.width),
                  top: 0,
                  right: 0,
                  height: '100%',
                },
              ],
              [
                'afo-zone-t',
                {
                  left: percent(geometry.offsetX, geometry.width),
                  top: 0,
                  width: percent(geometry.imageWidth, geometry.width),
                  height: percent(geometry.offsetY, geometry.height),
                },
              ],
              [
                'afo-zone-b',
                {
                  left: percent(geometry.offsetX, geometry.width),
                  top: percent(geometry.offsetY + geometry.imageHeight, geometry.height),
                  width: percent(geometry.imageWidth, geometry.width),
                  bottom: 0,
                },
              ],
            ] as Array<[string, ReactTypes.CSSProperties]>
          ).map(([className, style]) =>
            h('span', { key: className, className: `afo-zone ${className}`, style }),
          ),
          h('img', {
            'data-fisherai-outpaint-preview-image': 'true',
            src: resultUrl,
            alt: '原图在扩图画面里的位置',
            draggable: false,
            style: {
              position: 'absolute',
              left: percent(geometry.offsetX, geometry.width),
              top: percent(geometry.offsetY, geometry.height),
              width: percent(geometry.imageWidth, geometry.width),
              height: percent(geometry.imageHeight, geometry.height),
            },
          }),
          ...(
            [
              ['左', geometry.pad.left, 'afo-chip-left'],
              ['右', geometry.pad.right, 'afo-chip-right'],
              ['上', geometry.pad.top, 'afo-chip-top'],
              ['下', geometry.pad.bottom, 'afo-chip-bottom'],
            ] as Array<[string, number, string]>
          )
            .filter(([, value]) => value > 0)
            .map(([side, value, className]) =>
              h(
                'span',
                { key: className, className: `afo-ext-chip ${className}` },
                `${side} + ${value} px`,
              ),
            ),
          h('span', { className: 'afo-corner afo-corner-tl' }),
          h('span', { className: 'afo-corner afo-corner-tr' }),
          h('span', { className: 'afo-corner afo-corner-bl' }),
          h('span', { className: 'afo-corner afo-corner-br' }),
          h('span', { className: 'afo-src-chip' }, `原图 ${sourceLabel} · 不动`),
        ),
      )
    : null;

  const stage = h(
    'section',
    { className: 'afw-stage afo-stage', ref: stageRef },
    h('div', { className: 'afo-stage-hint' }, stageHint),
    frame,
    !resultUrl
      ? h('div', { className: 'afo-stage-empty' }, '这张图还没有结果，先等它生成完成。')
      : null,
  );

  const footline = h(
    'footer',
    { className: 'afo-footline' },
    h(
      'span',
      {},
      '目标 ',
      h('b', {}, targetLabel),
      geometry?.exact ? ` · ${activeRatio || '—'} · 扩图面积 ${extensionPercent}%` : '',
    ),
    h(
      'span',
      { className: 'afo-keys' },
      h('kbd', { className: 'afo-kbd' }, 'Shift'),
      h('kbd', { className: 'afo-kbd' }, 'Enter'),
      '生成',
    ),
  );

  const anchors = h(
    'div',
    { className: 'afo-anchors' },
    ...OUTPAINT_ANCHORS.map((item) => {
      const pressed = anchor === item.value;
      return h(
        'button',
        {
          key: item.value,
          type: 'button',
          title: item.hint,
          'aria-label': `原图位置 ${item.label}`,
          'data-fisherai-outpaint-anchor': item.value,
          'aria-pressed': pressed,
          className: pressed ? 'afo-anchor afo-anchor-on' : 'afo-anchor',
          onClick: () => setAnchor(item.value),
        },
        pressed && resultUrl
          ? h('img', { src: resultUrl, alt: '', draggable: false })
          : h('span', { className: 'afo-anchor-dot' }),
      );
    }),
  );

  const ratioChips = h(
    'div',
    { className: 'afo-ratios' },
    ...ratios.map((value) =>
      h(
        'button',
        {
          key: value,
          type: 'button',
          'data-fisherai-outpaint-ratio': value,
          'aria-pressed': activeRatio === value,
          className: activeRatio === value ? 'afo-ratio afo-ratio-on' : 'afo-ratio',
          onClick: () => setRatio(value),
        },
        value,
      ),
    ),
  );

  const inspector = h(
    'aside',
    { className: 'afw-insp afo-insp', 'aria-label': '扩图参数' },
    h(
      'div',
      { className: 'afw-insp-head' },
      h('span', { className: 'afo-ico' }, h(ScalingIcon, {})),
      h(
        'div',
        { className: 'min-w-0' },
        h('h2', {}, '扩图'),
        h('div', { className: 'afw-sub' }, `原图位置 · ${spec.label}`),
      ),
    ),
    h(
      'div',
      { className: 'afw-insp-body' },
      h(
        'div',
        { className: 'afw-sect' },
        fieldsetTitle('原图位置', spec.label),
        h(
          'div',
          { className: 'afo-anchor-row' },
          anchors,
          h(
            'div',
            { className: 'afo-anchor-desc' },
            h('span', { className: 'afo-anchor-t' }, spec.hint),
            h(
              'span',
              { className: 'afw-note' },
              geometry?.exact && pads.length
                ? `目标画面 ${geometry.width} × ${geometry.height}，原图不变、其余区域待补。`
                : '贴边放置时只朝对面延展；居中则四周一起扩。',
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'afw-sect' },
        fieldsetTitle('目标比例', activeRatio || '—'),
        ratios.length
          ? ratioChips
          : h(
              'p',
              {
                'data-fisherai-outpaint-status': 'empty',
                className: 'afo-empty',
              },
              '没有可用的图像模型：先去「设置 → 闭源服务」配一条通道并勾选图像模型。',
            ),
      ),
      h(
        'div',
        { className: 'afw-sect' },
        fieldsetTitle('输出尺寸', geometry?.exact ? '保持原图像素密度' : '按比例'),
        h(
          'div',
          { className: 'afo-size' },
          geometry?.exact
            ? [
                h('span', { key: 'w', className: 'afo-size-n' }, String(geometry.width)),
                h('span', { key: 'x', className: 'afo-size-x' }, '×'),
                h('span', { key: 'h', className: 'afo-size-n' }, String(geometry.height)),
              ]
            : h('span', { className: 'afo-size-n' }, activeRatio || '—'),
          h('span', { className: 'afo-size-from' }, `原图 ${sourceLabel}`),
        ),
        h(
          'div',
          { className: 'afw-note' },
          geometry?.exact
            ? `扩图面积 ${extensionPercent}%；超过 ${OUTPAINT_MAX_SIDE}px 会整体等比缩小后再落盘。`
            : '目标像素要等原图解码出来才算得准，这里先按比例显示。',
        ),
      ),
      h(
        'div',
        { className: 'afw-sect' },
        fieldsetTitle('扩展提示词', '可选'),
        h('textarea', {
          'data-fisherai-outpaint-content': 'true',
          'aria-label': '延展内容',
          rows: 3,
          value: content,
          placeholder: '例如：两侧延伸出更多沙滩和海面',
          className: 'afo-textarea',
          onChange: (event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
            setContent(event.target.value),
        }),
        h(
          'div',
          { className: 'afo-hints' },
          ...CONTENT_HINTS.map((item) =>
            h(
              'button',
              {
                key: item.label,
                type: 'button',
                className: 'afo-hint',
                onClick: () =>
                  setContent((old) => (old.includes(item.text) ? old : old ? `${old}；${item.text}` : item.text)),
              },
              item.label,
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'afw-sect' },
        fieldsetTitle('模型'),
        h(
          'div',
          { className: 'afo-model' },
          h(ImageIcon, { className: 'afo-model-ico' }),
          h(
            'span',
            { 'data-fisherai-outpaint-model-name': 'true', title: modelInfo?.name ?? '' },
            modelInfo?.name ?? '—',
          ),
          modelInfo?.channelModel ? h('span', { className: 'afo-tag' }, '你的通道') : null,
        ),
        h('div', { className: 'afw-note' }, '模型跟着你的通道走，不会落到上游那些没有后端的条目上。'),
      ),
    ),
    h(
      'footer',
      { className: 'afw-insp-foot afo-actions' },
      // 状态行放在按钮上方而不是参数区最底：900 高的窗口里参数区会滚动，
      // 「先出画面、再接节点、生成由你点」这条口径必须一直看得见。
      error
        ? h(
            'span',
            { role: 'alert', 'data-fisherai-outpaint-status': 'error', className: 'afw-alert' },
            error,
          )
        : h(
            'span',
            {
              role: 'status',
              'data-fisherai-outpaint-status': ratios.length ? 'ready' : 'empty',
              className: 'afo-foot-status',
            },
            ratios.length
              ? '先出扩图画面，再接一个图像生成节点；生成由你点。'
              : '需要一条图像通道才能扩图。',
          ),
      h(
        'button',
        {
          type: 'button',
          'data-fisherai-outpaint-create': 'true',
          'aria-label': '生成扩图画面',
          disabled: busy || !modelInfo || ratios.length === 0,
          onClick: () => void create(),
          className: 'afo-create',
        },
        busy ? h(LoaderCircleIcon, { className: 'afo-spin' }) : h(CheckIcon, {}),
        busy ? '正在生成扩图画面…' : '生成扩图画面',
      ),
    ),
  );

  const body = h(
    'div',
    { className: 'afw-body afo-body' },
    h('div', { className: 'afw-main afo-main' }, stage, footline),
    inspector,
  );

  const root = h(
    'div',
    {
      ref: rootRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '扩图',
      'data-fisherai-outpaint-panel': 'true',
      'data-fisherai-outpaint-model': modelInfo?.name ?? '',
      tabIndex: -1,
      style: {
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
        // 整页是 dialog 表面：焦点落在它身上时不要画焦点环（内联压过 DSH 的全局 outline）。
        outline: 'none',
      },
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      onKeyDown: (event: ReactTypes.KeyboardEvent) => {
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          createRef.current();
        }
      },
      className: `${WORKBENCH_ROOT_CLASS} afo-root`,
    },
    header,
    body,
  );
  const target = canvasPortalTarget();
  return target ? (createPortal(root, target) as ReactTypes.ReactNode) : root;
}

CanvasOutpaintStudio.displayName = 'CanvasOutpaintStudioPage';

/** 排查用读数（`canvasAppBuildInfo().outpaintStudio`）。 */
export { outpaintStudioReport } from './CanvasOutpaintStudioStore';
export { installOutpaintStudioBridge } from './CanvasOutpaintStudioStore';
