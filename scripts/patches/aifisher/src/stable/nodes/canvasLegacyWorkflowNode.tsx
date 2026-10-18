/**
 * 【本文件是 dsh-aifisher-canvas 的覆盖补丁，不是上游原文】
 * 由 scripts/patches/aifisher/ 覆盖到 vendor/aifisher/ 下，源文件在 scripts/patches/ 里。
 *
 * 上游这个文件是「旧版内置工作流节点」的占位卡：内置工作流全部停用后，它只剩一句
 * 「请导入对应的 ComfyUI API JSON 后运行」和一个打开工作流库的按钮 —— 而工作流库
 * （workflowManager）在本插件里没有移植，于是这个节点实际上什么也做不了。
 *
 * 本插件的后端已经有「目录式自定义工作流」：用户把 ComfyUI 导出的 API JSON 丢进
 * $DSH_HOME/storages/dsh-aifisher-canvas/workflows/，后端就把它注册成可跑的本地工作流，
 * 并通过能力清单把**节点参数骨架**（提示词、参数控件、素材槽、输出类型）一起回给画布。
 *
 * 于是这个节点被换成「通用本地工作流节点」：
 *   - 顶部下拉切换用哪个本地工作流（自定义的都在里面，也能切回内置 MiniMaxH3 专用节点）；
 *   - 左边一列是输入槽（正向提示词槽 + 负向提示词槽 + 素材槽），位置与画布算出来的连线端点对齐，
 *     可拖线连接；v1.21 起负向提示词也是文本槽，两个提示词都能接文本节点；
 *   - 右边是提示词输入框与参数控件（数值/文本/开关/下拉，由骨架决定）；
 *     提示词槽接上文本节点之后**不再显示输入框**（改留一行只读提示）；
 *   - 底部「生成」按钮把参数发给后端：POST /api/aifisher/canvas/comfy/<工作流 id>，
 *     跑完由 canvasLocalWorkflows 在节点右侧落一个结果节点（Upload Video/Image/Audio）。
 *
 * 节点尺寸由本节点自己写回（width/height）—— 上游给旧版节点的默认尺寸是给那 240px 宽
 * 的占位卡用的，放不下参数表单。
 */
import type { CanvasComponent } from '../app/canvasComponentType';
import type * as ReactTypes from 'react';
import {
  comfyWidgetField,
  ensureComfyWidgetOptions,
  localWorkflowDefinition,
  localWorkflowOptions,
  subscribeComfyWidgets,
  subscribeLocalWorkflows,
  type LocalWorkflowDefinition,
  type LocalWorkflowOption,
} from '../media/videoWorkflows';

type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useEffect' | 'useLayoutEffect' | 'useRef'
>;

interface NodeData extends Record<string, unknown> {
  id: string;
  type: string;
  comfyMode?: string;
  title?: string;
  prompt?: string;
  /** v1.21：负向提示词（正向仍在 prompt 上）；接线的负向槽优先 */
  negativePrompt?: string;
  /** v1.21：这台节点上一次拿到的槽位顺序（槽位布局变了就按 id 重排 parentIds） */
  comfySlotIds?: string[];
  status?: string;
  progress?: number;
  errorMessage?: string;
  resultUrl?: string;
  comfyParams?: Record<string, unknown>;
  parentIds?: string[];
}

interface ConnectedNode extends Record<string, unknown> {
  id: string;
  type: string;
  url?: string;
  resultUrl?: string;
  resultUrls?: string[];
  lastFrame?: string;
  textContent?: string;
  resultText?: string;
  prompt?: string;
  text?: string;
}

interface Props extends Record<string, unknown> {
  data: NodeData;
  selected?: boolean;
  zoom?: number;
  projectId?: string;
  connectedImageNodes?: ConnectedNode[];
  onUpdate(id: string, patch: Partial<NodeData>): void;
  onConnectorDown(
    event: ReactTypes.PointerEvent,
    id: string,
    side: 'left' | 'right',
    port: number,
  ): void;
  onMiniMaxH3T2VAGenerate?: (id: string) => unknown;
}

interface Components {
  Frame: CanvasComponent;
  Header: CanvasComponent;
}

/** 节点尺寸（自己写回 node.width / node.height）。 */
const NODE_WIDTH = 720;
const HEADER_HEIGHT = 56;
const PICKER_HEIGHT = 48;
const PROMPT_TOP = HEADER_HEIGHT + PICKER_HEIGHT;
/** 正向提示词框的高度（v1.21：下面还要排一个负向提示词框，所以比 v1.20 矮一点）。 */
const PROMPT_HEIGHT = 116;
/** 负向提示词框：单行多一点点就够（用户原话里它就是「负面提示词」）。 */
const NEGATIVE_HEIGHT = 64;
const NEGATIVE_GAP = 10;
/** 提示词槽接上文本节点后，输入框换成这一行只读提示（高度要矮一截，节点跟着收）。 */
const PROMPT_CHIP_HEIGHT = 40;
/**
 * 输入槽第一行的顶部。
 * 行高 30，几何要**精确**对上画布算出来的连线端点，否则线会连在按钮旁边：
 *   节点框（border-box）有 1px 边框 → 绝对定位子元素的包含块（padding-box）从 +1 开始，
 *   所以 row.top = SLOT_TOP 时按钮圆心 = 1 + SLOT_TOP + 15 = 158 = canvasNodeRules.legacyPortY(0)。
 *   每一行间距 34（portHeight 26 + portGap 8），与 legacyPortY 完全一致。
 */
const SLOT_TOP = 142;
const SLOT_PITCH = 34;
/** 提示词框的左边（给左侧输入槽让出位置）。 */
const RIGHT_COLUMN_LEFT = 208;
/**
 * 参数区（v1.20 重新排过）：提示词框下面、**横跨整宽的两列网格**。
 * 以前参数挤在右边一列（96px 标签 + 34px 行距），9 个参数把节点拉得很高、
 * 左边一大片空白 —— 用户原话「这个节点布局太紧凑了，改一下布局」。
 */
const PARAMETER_ROW_HEIGHT = 34;
const PARAMETER_GAP_Y = 12;
const PARAMETER_GAP_X = 24;
const PARAMETER_COLUMNS = 2;
const PARAMETER_LABEL_WIDTH = 108;
const FOOTER_HEIGHT = 84;
const ERROR_HEIGHT = 46;

const COLORS = {
  border: 'var(--af-border)',
  borderControl: 'var(--af-border-control)',
  surface: 'var(--af-surface)',
  raised: 'var(--af-surface-raised)',
  input: 'var(--af-input)',
  text: 'var(--af-text)',
  secondary: 'var(--af-text-secondary)',
  muted: 'var(--af-text-muted)',
  info: 'var(--af-info)',
  danger: 'var(--af-danger)',
  dangerBg: 'var(--af-danger-bg)',
  onPrimary: 'var(--af-on-primary)',
  primary: 'var(--af-primary)',
  focus: 'var(--af-focus)',
} as const;

const controlStyle: ReactTypes.CSSProperties = {
  width: '100%',
  height: '32px',
  padding: '0 10px',
  border: `1px solid ${COLORS.borderControl}`,
  borderRadius: '7px',
  background: COLORS.input,
  color: COLORS.text,
  outline: 'none',
  fontSize: '12px',
};

const mediaSymbol: Record<string, string> = {
  text: 'T',
  image: '◇',
  video: '▶',
  audio: '♫',
  mask: '◇',
  any: '◇',
};

// ---------------------------------------------------------------- 端口跟着指针（v1.25）

/**
 * 用户原话：「能不能做在接入的时候接入口与指针有交互效果，如放大然后发光」。
 *
 * 做什么：从任意端口开始拖线之后，指针靠近哪个端口，那个「+」就放大并亮起来；
 * 拖动起点那颗一直亮着（不然线一离开起点就全灭，看不出「正在拉哪根」）。
 *
 * 为什么不用 React state 做：pointermove 每帧都来，重渲染这整张表单（下拉 + 十几行
 * 参数 + 两个输入框）会掉帧；这里直接改 `transform` / `boxShadow` 两条样式 ——
 * 这两条节点自己**不写**，所以不会与 React 打架（边框色/文字色归 React，一概不碰）。
 * 模块级只挂一次 window 监听，节点只管把自己根元素注册进来。
 */
const PORT_GLOW_RADIUS = 46;
const PORT_GLOW_GROWTH = 0.55;
const PORT_GLOW_STYLE_ID = 'fisherai-port-glow';

interface PortGlowTarget {
  root: HTMLElement;
}

const portGlowTargets = new Set<PortGlowTarget>();
let portGlowBound = false;
let portGlowActive = false;
let portGlowHeld: Element | null = null;
let portGlowPointer = { x: 0, y: 0 };
let portGlowFrame = 0;
/** 画过几次（诊断用：真机检查要能分清「没绑定 / 没触发 / 画了但没量到」）。 */
let portGlowPaints = 0;

declare global {
  interface Window {
    /** v1.25：端口发光的诊断读数（scripts/browser-check.mjs 的接入口场景用）。 */
    __FISHERAI_PORT_GLOW__?: () => {
      bound: boolean;
      active: boolean;
      targets: number;
      buttons: number;
      paints: number;
      pointer: { x: number; y: number };
    };
  }
}

function ensurePortGlowStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PORT_GLOW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PORT_GLOW_STYLE_ID;
  style.textContent = [
    // 平滑：放大与发光都过渡出来，别「啪」一下跳
    '[data-fisherai-port]{transition:transform 140ms cubic-bezier(.22,1,.36,1),box-shadow 170ms ease-out;}',
    // 不接线时，鼠标压上去也给一点反馈（接线时的放大由下面按距离算）
    '[data-fisherai-port]:hover{transform:scale(1.12);}',
  ].join('');
  (document.head ?? document.documentElement).appendChild(style);
}

function portGlowButtons(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-fisherai-port]'));
}

function clearPortGlow(button: HTMLElement): void {
  button.style.transform = '';
  button.style.boxShadow = '';
}

function paintPortGlow(): void {
  portGlowFrame = 0;
  if (!portGlowActive) return;
  portGlowPaints += 1;
  for (const target of [...portGlowTargets]) {
    for (const button of portGlowButtons(target.root)) {
      const rect = button.getBoundingClientRect();
      // jsdom / 未布局：量不出来就什么都不改
      if (!(rect.width > 1 && rect.height > 1)) continue;
      const distance = Math.hypot(
        portGlowPointer.x - (rect.left + rect.width / 2),
        portGlowPointer.y - (rect.top + rect.height / 2),
      );
      const reach = Math.max(PORT_GLOW_RADIUS, rect.width * 1.4);
      const near = distance >= reach ? 0 : 1 - distance / reach;
      const heat = Math.max(near, button === portGlowHeld ? 0.45 : 0);
      if (heat <= 0.02) {
        clearPortGlow(button);
        continue;
      }
      button.style.transform = `scale(${(1 + heat * PORT_GLOW_GROWTH).toFixed(3)})`;
      button.style.boxShadow =
        `0 0 0 ${(1 + heat * 3).toFixed(1)}px rgba(96,165,250,${(0.18 * heat).toFixed(2)}), ` +
        `0 0 ${Math.round(6 + heat * 22)}px rgba(59,130,246,${(0.28 + heat * 0.55).toFixed(2)})`;
    }
  }
}

function schedulePortGlow(): void {
  if (portGlowFrame || typeof requestAnimationFrame !== 'function') return;
  portGlowFrame = requestAnimationFrame(paintPortGlow);
}

function resetPortGlow(): void {
  if (portGlowFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(portGlowFrame);
  portGlowFrame = 0;
  for (const target of [...portGlowTargets])
    for (const button of portGlowButtons(target.root)) clearPortGlow(button);
}

function bindPortGlow(): void {
  if (portGlowBound || typeof window === 'undefined') return;
  portGlowBound = true;
  ensurePortGlowStyle();
  // 捕获阶段：端口自己的 onPointerDown 会 stopPropagation，普通冒泡收不到
  window.addEventListener(
    'pointerdown',
    (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest?.('[data-fisherai-connector-node-id]') as Element | null;
      if (!button) return;
      portGlowActive = true;
      portGlowHeld = button;
      portGlowPointer = { x: event.clientX, y: event.clientY };
      schedulePortGlow();
    },
    true,
  );
  window.addEventListener(
    'pointermove',
    (event: PointerEvent) => {
      if (!portGlowActive) return;
      portGlowPointer = { x: event.clientX, y: event.clientY };
      schedulePortGlow();
    },
    true,
  );
  const stop = () => {
    if (!portGlowActive) return;
    portGlowActive = false;
    portGlowHeld = null;
    resetPortGlow();
  };
  window.addEventListener('pointerup', stop, true);
  window.addEventListener('pointercancel', stop, true);
  window.addEventListener('blur', stop);
}

function registerPortGlow(root: HTMLElement): () => void {
  bindPortGlow();
  const target: PortGlowTarget = { root };
  portGlowTargets.add(target);
  if (typeof window !== 'undefined' && !window.__FISHERAI_PORT_GLOW__) {
    window.__FISHERAI_PORT_GLOW__ = () => ({
      bound: portGlowBound,
      active: portGlowActive,
      targets: portGlowTargets.size,
      buttons: [...portGlowTargets].reduce(
        (sum, entry) => sum + portGlowButtons(entry.root).length,
        0,
      ),
      paints: portGlowPaints,
      pointer: { ...portGlowPointer },
    });
  }
  return () => {
    portGlowTargets.delete(target);
    resetPortGlow();
  };
}

function textOf(node: ConnectedNode | undefined): string {
  if (!node) return '';
  const candidate = [node.textContent, node.resultText, node.prompt, node.text].find(
    (value) => typeof value === 'string' && value !== '',
  );
  return typeof candidate === 'string' ? candidate : '';
}

function mediaUrlOf(node: ConnectedNode | undefined): string {
  if (!node) return '';
  const candidate = [node.resultUrl, node.url, node.lastFrame, node.resultUrls?.[0]].find(
    // 画布给「文本/音频节点」的 url 是占位串（text-node-placeholder），不是真素材地址
    (value) => typeof value === 'string' && value !== '' && !value.endsWith('-placeholder'),
  );
  return typeof candidate === 'string' ? candidate : '';
}

/** 输入槽的值：文本槽取文本，素材槽取 URL。 */
function slotValueOf(slotType: string, node: ConnectedNode | undefined): string {
  return slotType === 'text' ? textOf(node) : mediaUrlOf(node);
}

export function CanvasLegacyWorkflowNode(
  React: Runtime,
  props: Props,
  { Frame }: Components,
) {
  const node = props.data;
  const onUpdate = props.onUpdate;
  const connected = props.connectedImageNodes || [];
  const [, bump] = React.useState(0);
  /** 端口发光的锚：这个节点的根元素（v1.25）。 */
  const portRoot = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const root = portRoot.current;
    if (!root) return;
    return registerPortGlow(root);
  }, [node.id]);

  // 能力清单是异步拉回来的：清单到位后要让节点重渲染一次（下拉、参数、尺寸都依赖它）
  React.useEffect(() => subscribeLocalWorkflows(() => bump((value) => value + 1)), []);
  // ComfyUI 字段候选值（lora / 模型名的下拉列表）：拉一次 + 到位后重渲染
  React.useEffect(() => subscribeComfyWidgets(() => bump((value) => value + 1)), []);
  React.useEffect(() => {
    void ensureComfyWidgetOptions();
  }, []);

  const definition: LocalWorkflowDefinition | undefined = localWorkflowDefinition(node.comfyMode);
  const options: readonly LocalWorkflowOption[] = localWorkflowOptions();
  const slots = definition?.inputs ?? [];
  const parameters = definition?.parameters ?? [];
  const textParameter = definition?.textParameter ?? null;
  const negativeTextParameter = definition?.negativeTextParameter ?? null;
  const parentIds = Array.isArray(node.parentIds) ? (node.parentIds as string[]) : [];
  const slotIndexOf = (id: string | null) =>
    id ? slots.findIndex((slot) => slot.id === id) : -1;
  const promptSlotIndex = slotIndexOf(textParameter);
  const negativeSlotIndex = slotIndexOf(negativeTextParameter);
  /** 某个槽位上接的节点给的文本（'' = 没接 / 接了个空文本节点）。 */
  const linkedTextOf = (index: number) => {
    if (index < 0) return '';
    const parentId = parentIds[index];
    if (!parentId) return '';
    return textOf(connected.find((item) => item.id === parentId));
  };
  // 提示词槽接了文本节点时，提示词就来自那个节点（本地不发 text）
  const textFromNode = linkedTextOf(promptSlotIndex);
  const negativeFromNode = linkedTextOf(negativeSlotIndex);
  /**
   * v1.21：槽位接上文本节点之后**不再显示输入框**（用户报障原话
   *「接入提示词后将不显示输入框」），只留一行只读提示，节点高度也跟着收回来。
   */
  const promptLinked = promptSlotIndex >= 0 && Boolean(parentIds[promptSlotIndex]);
  const negativeLinked = negativeSlotIndex >= 0 && Boolean(parentIds[negativeSlotIndex]);
  const showPromptBox = Boolean(definition) && Boolean(textParameter) && !promptLinked;
  const showNegativeBox =
    Boolean(definition) && Boolean(negativeTextParameter) && !negativeLinked;
  const negativeValue =
    typeof node.negativePrompt === 'string'
      ? node.negativePrompt
      : typeof (node.comfyParams || {}).negativeText === 'string'
        ? String((node.comfyParams || {}).negativeText)
        : typeof definition?.defaults?.negativeText === 'string'
          ? String(definition.defaults.negativeText)
          : '';
  const loading = node.status === 'loading';
  const error = typeof node.errorMessage === 'string' ? node.errorMessage : '';

  const slotsBottom = slots.length ? SLOT_TOP + slots.length * SLOT_PITCH : PROMPT_TOP;
  // 右列从上到下：正向提示词 → 负向提示词（接线的那个换成一行只读提示）
  const promptRowHeight = !definition
    ? 0
    : textParameter
      ? showPromptBox
        ? PROMPT_HEIGHT
        : PROMPT_CHIP_HEIGHT
      : PROMPT_CHIP_HEIGHT;
  const promptBottom = PROMPT_TOP + promptRowHeight;
  const negativeTop = promptBottom + (definition && negativeTextParameter ? NEGATIVE_GAP : 0);
  const negativeRowHeight =
    definition && negativeTextParameter ? (showNegativeBox ? NEGATIVE_HEIGHT : PROMPT_CHIP_HEIGHT) : 0;
  const rightColumnBottom = negativeRowHeight ? negativeTop + negativeRowHeight : promptBottom;
  // 参数区：提示词框 / 负向框 / 输入槽都结束之后再开始，横跨整宽
  const parameterTop = Math.max(rightColumnBottom, slotsBottom) + 16;
  const parameterRows = Math.ceil(parameters.length / PARAMETER_COLUMNS);
  const parametersBottom = parameters.length
    ? parameterTop + parameterRows * PARAMETER_ROW_HEIGHT + (parameterRows - 1) * PARAMETER_GAP_Y
    : parameterTop;
  const bodyBottom = Math.max(slotsBottom, rightColumnBottom, parametersBottom) + 12;
  const height = bodyBottom + FOOTER_HEIGHT + (error ? ERROR_HEIGHT : 0);

  /**
   * 槽位迁移（v1.21）：节点上的 parentIds 是按「能力清单里的槽位下标」存的。
   * 这一版在提示词槽后面插了「负向提示词」文本槽，老节点不改就会素材整体错一位
   * （连线指到负向槽上、真正的素材槽报「还缺输入」）。所以给节点记一份槽位签名
   * comfySlotIds：布局一变，就按槽位 id 重排 parentIds / sourcePortIndices。
   * 顺带修掉一个老坑：在面板里改绑定顺序（槽位重排）时连线也不会再串位。
   */
  const slotSignature = slots.map((slot) => slot.id).join('|');
  React.useLayoutEffect(() => {
    if (!definition || !slots.length) return;
    const current = slots.map((slot) => slot.id);
    const stored = Array.isArray(node.comfySlotIds) ? (node.comfySlotIds as string[]) : null;
    // 老节点（还没签过名）按「当前布局里没有负向槽」的旧顺序推断
    const previous = stored?.length ? stored : current.filter((id) => id !== negativeTextParameter);
    const parents = Array.isArray(node.parentIds) ? (node.parentIds as string[]) : [];
    const ports = Array.isArray(node.sourcePortIndices)
      ? (node.sourcePortIndices as number[])
      : [];
    const sameLayout =
      previous.length === current.length && current.every((id, index) => previous[index] === id);
    if (sameLayout && parents.length === current.length) return;
    const nextParents = current.map((id) => {
      const index = previous.indexOf(id);
      return index >= 0 ? (parents[index] ?? '') : '';
    });
    const nextPorts = current.map((id) => {
      const index = previous.indexOf(id);
      return index >= 0 ? (ports[index] ?? 0) : 0;
    });
    const parentsChanged =
      nextParents.length !== parents.length ||
      nextParents.some((value, index) => value !== (parents[index] ?? ''));
    const portsChanged =
      nextPorts.length !== ports.length ||
      nextPorts.some((value, index) => value !== (ports[index] ?? 0));
    if (!parentsChanged && !portsChanged && sameLayout) return;
    onUpdate(node.id, {
      parentIds: nextParents,
      sourcePortIndices: nextPorts,
      comfySlotIds: [...current],
    });
  }, [
    node.id,
    slotSignature,
    node.comfySlotIds,
    node.parentIds,
    node.sourcePortIndices,
    negativeTextParameter,
    definition,
    onUpdate,
  ]);

  // 尺寸写回节点（上游默认是 240px 宽的占位卡尺寸，放不下表单）。
  // useLayoutEffect：赶在首帧绘制前生效，看不到尺寸跳动。
  React.useLayoutEffect(() => {
    if (node.width !== NODE_WIDTH || node.height !== height) {
      onUpdate(node.id, { width: NODE_WIDTH, height });
    }
  }, [node.id, node.width, node.height, height, onUpdate]);

  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const patchParams = (key: string, value: unknown) => {
    const next = { ...(node.comfyParams || {}), [key]: value };
    onUpdate(node.id, { comfyParams: next });
  };

  const connect = (event: ReactTypes.PointerEvent, port: number) => {
    event.stopPropagation();
    props.onConnectorDown(event, node.id, 'left', port);
  };
  const connectOut = (event: ReactTypes.PointerEvent) => {
    event.stopPropagation();
    props.onConnectorDown(event, node.id, 'right', 0);
  };

  const badge = loading
    ? '运行中'
    : node.status === 'success'
      ? '已完成'
      : node.status === 'error'
        ? '失败'
        : '就绪';

  const slotRow = (index: number) => {
    const slot = slots[index];
    const parentId = (node.parentIds || [])[index];
    const parent = connected.find((item) => item.id === parentId);
    const value = slotValueOf(slot.type, parent);
    const linked = Boolean(parentId) && Boolean(value);
    const top = SLOT_TOP + index * SLOT_PITCH;
    return React.createElement(
      'div',
      {
        key: slot.id,
        'data-fisherai-local-workflow-slot': slot.id,
        style: {
          position: 'absolute',
          left: 0,
          top,
          height: SLOT_PITCH - 4,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        },
      },
      React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': '连接' + slot.label,
          'data-fisherai-port': 'true',
          'data-fisherai-connector-node-id': node.id,
          'data-fisherai-connector-side': 'left',
          'data-fisherai-connector-port-index': index,
          onPointerDown: (event: ReactTypes.PointerEvent) => connect(event, index),
          style: {
            flex: 'none',
            width: '30px',
            height: '30px',
            // 圆心落在节点框左缘（含 1px 边框）：-16 + 15 = -1
            marginLeft: '-16px',
            borderRadius: '9999px',
            border: `1px solid ${linked ? COLORS.info : COLORS.borderControl}`,
            background: COLORS.input,
            color: linked ? COLORS.info : COLORS.secondary,
            fontSize: '18px',
            lineHeight: '26px',
            cursor: 'crosshair',
          },
        },
        '+',
      ),
      React.createElement(
        'div',
        { style: { minWidth: 0, maxWidth: '128px' } },
        React.createElement(
          'div',
          {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '11px',
              fontWeight: 600,
              color: linked ? COLORS.text : COLORS.secondary,
            },
          },
          slot.label + (slot.required ? ' *' : ''),
        ),
        React.createElement(
          'div',
          {
            style: {
              marginTop: '2px',
              fontSize: '9px',
              color: linked ? COLORS.info : COLORS.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          linked
            ? slot.type === 'text'
              ? '已接入文本'
              : '已连接素材'
            : mediaSymbol[slot.type] + ' 等待连接',
        ),
      ),
    );
  };

  /**
   * 一个参数格（v1.20）：自动两列排布，标签宽 108、控件高 34。
   * `data-fisherai-local-workflow-parameter` 契约不变（回归/browser-check 靠它数参数）。
   */
  const parameterCell = (parameter: LocalWorkflowDefinition['parameters'][number]) => {
    const stored = (node.comfyParams || {})[parameter.id];
    const value = stored !== undefined && stored !== '' ? stored : parameter.default;
    // ComfyUI 扫到的候选（lora_name / ckpt_name / sampler…）：有列表就变下拉。
    // 模板里已经带 options（host 扫描时 ComfyUI 在线）时以模板为准。
    const scanned = comfyWidgetField(parameter.classType, parameter.field);
    const choices =
      parameter.options?.length
        ? parameter.options.map((option) => ({ value: option.value, label: option.label }))
        : scanned?.control === 'select' && scanned.options?.length
          ? scanned.options.map((optionValue) => ({ value: optionValue, label: optionValue }))
          : null;
    const numeric = scanned?.control === 'number' ? scanned : null;
    const asSelect = Boolean(choices?.length) && parameter.type !== 'number' && parameter.type !== 'toggle';
    const current = value === undefined ? '' : String(value);
    // 模板里的当前值可能不在本次扫描结果里（ComfyUI 没开/换了机器）：也得能选回它自己
    const missingCurrent =
      asSelect && current !== '' && !choices!.some((option) => option.value === current)
        ? [{ value: current, label: `${current}（不在清单里）` }]
        : [];
    const change = (event: ReactTypes.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const raw = event.target.value;
      if (parameter.type === 'number') {
        if (raw === '') patchParams(parameter.id, '');
        else {
          const number = Number(raw);
          if (Number.isFinite(number)) patchParams(parameter.id, number);
        }
        return;
      }
      patchParams(parameter.id, raw);
    };
    let control: ReactTypes.ReactNode;
    if (asSelect) {
      control = React.createElement(
        'select',
        {
          'aria-label': parameter.label,
          'data-fisherai-local-workflow-select': parameter.id,
          value: current,
          onChange: change,
          onPointerDown: stop,
          style: { ...controlStyle, cursor: 'pointer' },
        },
        [...missingCurrent, ...choices!].map((option) =>
          React.createElement('option', { value: option.value, key: option.value }, option.label),
        ),
      );
    } else if (parameter.type === 'toggle') {
      control = React.createElement('input', {
        'aria-label': parameter.label,
        type: 'checkbox',
        checked: Boolean(value),
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
          patchParams(parameter.id, event.target.checked),
        onPointerDown: stop,
        style: { width: '18px', height: '18px', accentColor: COLORS.focus },
      });
    } else if (parameter.type === 'number') {
      control = React.createElement('input', {
        'aria-label': parameter.label,
        type: 'number',
        value: current,
        ...(parameter.min !== undefined ? { min: parameter.min } : numeric?.min !== undefined ? { min: numeric.min } : {}),
        ...(parameter.max !== undefined ? { max: parameter.max } : numeric?.max !== undefined ? { max: numeric.max } : {}),
        ...(parameter.step !== undefined ? { step: parameter.step } : numeric?.step !== undefined ? { step: numeric.step } : {}),
        onChange: change,
        onPointerDown: stop,
        style: controlStyle,
      });
    } else {
      control = React.createElement('input', {
        'aria-label': parameter.label,
        type: 'text',
        value: current,
        onChange: change,
        onPointerDown: stop,
        style: controlStyle,
      });
    }
    return React.createElement(
      'label',
      {
        key: parameter.id,
        'data-fisherai-local-workflow-parameter': parameter.id,
        'data-control': asSelect ? 'select' : parameter.type,
        title: parameter.label,
        style: {
          display: 'grid',
          gridTemplateColumns: `${PARAMETER_LABEL_WIDTH}px minmax(0,1fr)`,
          alignItems: 'center',
          gap: '10px',
          height: `${PARAMETER_ROW_HEIGHT}px`,
        },
      },
      React.createElement(
        'span',
        {
          style: {
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            fontWeight: 600,
            color: COLORS.secondary,
          },
        },
        parameter.label,
      ),
      control,
    );
  };

  /** 参数区容器：横跨整宽的两列网格（v1.20 布局重排的核心）。 */
  const parameterGrid = parameters.length
    ? React.createElement(
        'div',
        {
          'data-fisherai-local-workflow-parameters': 'true',
          'data-columns': String(PARAMETER_COLUMNS),
          style: {
            position: 'absolute',
            left: '16px',
            right: '16px',
            top: `${parameterTop}px`,
            display: 'grid',
            gridTemplateColumns: `repeat(${PARAMETER_COLUMNS}, minmax(0, 1fr))`,
            columnGap: `${PARAMETER_GAP_X}px`,
            rowGap: `${PARAMETER_GAP_Y}px`,
          },
        },
        ...parameters.map((parameter) => parameterCell(parameter)),
      )
    : null;

  const picker = React.createElement(
    'select',
    {
      'aria-label': '本地工作流',
      'data-fisherai-local-workflow-picker': 'true',
      value: node.comfyMode || '',
      onChange: (event: ReactTypes.ChangeEvent<HTMLSelectElement>) => {
        const next = event.target.value;
        if (!next || next === node.comfyMode) return;
        // 换工作流：参数、错误、进度都归零（不同工作流的参数名不一样）
        onUpdate(node.id, {
          comfyMode: next,
          comfyParams: {},
          status: 'idle',
          progress: 0,
          errorMessage: undefined,
        });
      },
      onPointerDown: stop,
      style: {
        width: '100%',
        height: '36px',
        padding: '0 10px',
        border: `1px solid ${COLORS.borderControl}`,
        borderRadius: '8px',
        background: COLORS.input,
        color: COLORS.text,
        fontSize: '12.5px',
        cursor: 'pointer',
      },
    },
    // 当前 comfyMode 不在清单里（模板被删了/旧版停用节点）也要能显示出来
    ...(node.comfyMode && !options.some((option) => option.id === node.comfyMode)
      ? [React.createElement('option', { value: node.comfyMode, key: node.comfyMode }, node.comfyMode + '（不在清单里）')]
      : []),
    ...options.map((option) =>
      React.createElement('option', { value: option.id, key: option.id }, option.label),
    ),
  );

  /**
   * 文本槽接上文本节点之后显示的**只读**一行（不是输入框）：
   * 用户要求「接入提示词后将不显示输入框」，这里把接进来的内容摊一下就好。
   */
  const linkedChip = (
    key: string,
    label: string,
    text: string,
    top: number,
    height: number,
  ) =>
    React.createElement(
      'div',
      {
        key,
        'data-fisherai-local-workflow-linked': key,
        'aria-label': label,
        title: text,
        style: {
          position: 'absolute',
          left: RIGHT_COLUMN_LEFT,
          right: '16px',
          top,
          height: Math.max(24, height - 8),
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 10px',
          border: `1px dashed ${COLORS.borderControl}`,
          borderRadius: '9px',
          background: COLORS.input,
          color: COLORS.secondary,
          fontSize: '11px',
          lineHeight: 1.4,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        },
      },
      React.createElement(
        'span',
        { style: { flex: 'none', color: COLORS.info, fontWeight: 700 } },
        label,
      ),
      React.createElement(
        'span',
        {
          style: {
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        },
        text || '（接进来的文本节点是空的）',
      ),
    );

  /** 正向提示词：输入框 / 只读一行（接了文本节点）/ 不需要提示词的说明。 */
  const promptArea = !definition
    ? null
    : showPromptBox
      ? React.createElement(
          'textarea',
          {
            'aria-label': '提示词',
            'data-fisherai-local-workflow-prompt': 'true',
            value: typeof node.prompt === 'string' ? node.prompt : '',
            placeholder: '输入提示词…（也可以接一个文本节点到左边的提示词槽）',
            onChange: (event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
              onUpdate(node.id, { prompt: event.target.value }),
            onPointerDown: stop,
            style: {
              position: 'absolute',
              left: RIGHT_COLUMN_LEFT,
              right: '16px',
              top: PROMPT_TOP,
              height: PROMPT_HEIGHT,
              padding: '9px 12px',
              border: `1px solid ${COLORS.borderControl}`,
              borderRadius: '10px',
              background: COLORS.input,
              color: COLORS.text,
              fontSize: '12.5px',
              lineHeight: 1.7,
              resize: 'none',
              outline: 'none',
            },
          },
        )
      : promptLinked
        ? linkedChip(
            'text',
            '提示词 ← 文本节点',
            textFromNode,
            PROMPT_TOP,
            PROMPT_CHIP_HEIGHT,
          )
        : React.createElement(
            'div',
            {
              'data-fisherai-local-workflow-no-prompt': 'true',
              style: {
                position: 'absolute',
                left: RIGHT_COLUMN_LEFT,
                right: '16px',
                top: PROMPT_TOP,
                height: PROMPT_CHIP_HEIGHT - 8,
                display: 'flex',
                alignItems: 'center',
                color: COLORS.muted,
                fontSize: '11px',
              },
            },
            '这个工作流不需要提示词',
          );

  /**
   * 负向提示词（v1.21）：
   *   - 负向槽接了文本节点 → 只读一行（不显示输入框）；
   *   - 否则 → 一个矮一点的输入框，值存在 node.negativePrompt 上
   *     （老节点可能把它存在 comfyParams.negativeText 里，读一份回来不至于丢）。
   */
  const negativeArea = !definition || !negativeTextParameter
    ? null
    : negativeLinked
      ? linkedChip(
          'negativeText',
          '负向提示词 ← 文本节点',
          negativeFromNode,
          negativeTop,
          PROMPT_CHIP_HEIGHT,
        )
      : React.createElement(
          'textarea',
          {
            'aria-label': '负向提示词',
            'data-fisherai-local-workflow-negative-prompt': 'true',
            value: negativeValue,
            placeholder: '负向提示词（可不填；也可以接一个文本节点到左边的负向槽）',
            onChange: (event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
              onUpdate(node.id, { negativePrompt: event.target.value }),
            onPointerDown: stop,
            style: {
              position: 'absolute',
              left: RIGHT_COLUMN_LEFT,
              right: '16px',
              top: negativeTop,
              height: NEGATIVE_HEIGHT,
              padding: '7px 12px',
              border: `1px solid ${COLORS.borderControl}`,
              borderRadius: '10px',
              background: COLORS.input,
              color: COLORS.text,
              fontSize: '12px',
              lineHeight: 1.6,
              resize: 'none',
              outline: 'none',
            },
          },
        );

  const footer = React.createElement(
    'div',
    {
      'data-fisherai-local-workflow-actions': 'true',
      style: {
        position: 'absolute',
        left: '16px',
        right: '16px',
        bottom: '14px',
        height: '48px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      },
    },
    React.createElement(
      'div',
      { style: { minWidth: 0, fontSize: '10px', color: COLORS.muted, lineHeight: 1.5 } },
      React.createElement('div', null, loading ? `运行中… ${node.progress ?? 0}%` : '结果会落在节点右侧'),
      React.createElement(
        'div',
        { style: { marginTop: '2px' } },
        parameters.length + slots.length
          ? `${slots.length} 个输入 · ${parameters.length} 个参数`
          : '这个工作流没有可调参数',
      ),
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        'data-fisherai-local-workflow-generate': 'true',
        'aria-label': '生成',
        disabled: loading,
        onClick: () => props.onMiniMaxH3T2VAGenerate?.(node.id),
        onPointerDown: stop,
        style: {
          marginLeft: 'auto',
          flex: 'none',
          height: '44px',
          minWidth: '104px',
          padding: '0 18px',
          borderRadius: '9999px',
          border: `1px solid ${loading ? COLORS.border : COLORS.text}`,
          background: loading ? COLORS.raised : COLORS.primary,
          color: loading ? COLORS.muted : COLORS.onPrimary,
          fontSize: '13px',
          fontWeight: 700,
          cursor: loading ? 'not-allowed' : 'pointer',
        },
      },
      loading ? '…' : '生成 ↑',
    ),
  );

  const errorBox = error
    ? React.createElement(
        'div',
        {
          role: 'alert',
          'data-fisherai-local-workflow-error': 'true',
          style: {
            position: 'absolute',
            left: '16px',
            right: '16px',
            bottom: `${FOOTER_HEIGHT}px`,
            maxHeight: `${ERROR_HEIGHT - 6}px`,
            overflow: 'auto',
            padding: '5px 8px',
            border: `1px solid ${COLORS.danger}`,
            borderRadius: '7px',
            background: COLORS.dangerBg,
            color: COLORS.danger,
            fontSize: '11px',
            lineHeight: 1.45,
          },
        },
        error,
      )
    : null;

  return React.createElement(
    Frame,
    {
      data: node,
      selected: props.selected,
      isBareCard: true,
      onNodePointerDown: props.onNodePointerDown,
      onContextMenu: props.onContextMenu,
      onConnectorDown: props.onConnectorDown,
      zoom: props.zoom,
      isHoveredForConnection: props.isHoveredForConnection,
      isInvalidHover: props.isInvalidHover,
      onMouseEnter: props.onMouseEnter,
      onMouseLeave: props.onMouseLeave,
    },
    React.createElement(
      'div',
      {
        ref: portRoot,
        'data-fisherai-local-workflow-node': 'true',
        style: {
          position: 'relative',
          // border-box：节点框的宽高由画布给（640×H），带 1px 边框也不能撑出去
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          overflow: 'visible',
          borderRadius: '12px',
          border: `1px solid ${props.selected ? COLORS.info : COLORS.border}`,
          background: COLORS.surface,
          color: COLORS.text,
          fontFamily: "Inter, 'Microsoft YaHei UI', system-ui, sans-serif",
        },
      },
      // 头部：品牌图 + 标题 + 状态
      React.createElement(
        'div',
        {
          style: {
            position: 'absolute',
            left: '16px',
            right: '16px',
            top: 0,
            height: `${HEADER_HEIGHT}px`,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          },
        },
        React.createElement('img', {
          // v1.28：这份工作流配了自己的图（左侧「工作流节点」面板里上传的）就显示它，
          // 没配图仍用品牌标 —— 头部这块只有 22px，不占布局、不影响槽位几何。
          src: definition?.coverUrl || '/aifisher-mark-white.svg',
          alt: '',
          width: 22,
          height: 22,
          'data-fisherai-local-workflow-cover': definition?.coverUrl ? 'custom' : 'brand',
          style: {
            flex: 'none',
            objectFit: definition?.coverUrl ? 'cover' : 'contain',
            borderRadius: definition?.coverUrl ? '6px' : 0,
          },
        }),
        React.createElement(
          'div',
          {
            style: {
              minWidth: 0,
              fontSize: '14px',
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          definition?.label || node.title || '本地工作流',
        ),
        React.createElement(
          'span',
          {
            'data-fisherai-local-workflow-status': badge,
            style: {
              marginLeft: 'auto',
              flex: 'none',
              padding: '4px 8px',
              borderRadius: '999px',
              background: loading ? COLORS.raised : COLORS.input,
              color: loading ? COLORS.info : node.status === 'success' ? COLORS.info : COLORS.muted,
              fontSize: '9px',
              fontWeight: 700,
            },
          },
          badge,
        ),
      ),
      // 工作流选择器
      React.createElement(
        'div',
        {
          style: {
            position: 'absolute',
            left: '16px',
            right: '16px',
            top: `${HEADER_HEIGHT}px`,
            height: `${PICKER_HEIGHT - 8}px`,
          },
        },
        picker,
      ),
      // 左列：输入槽（位置与画布算出来的连线端点一致）
      ...slots.map((_slot, index) => slotRow(index)),
      // 提示词（接上文本节点后这里是只读一行，不是输入框）
      promptArea,
      // 负向提示词（v1.21：文本节点可以接进来；没接就是输入框）
      negativeArea,
      // 参数（v1.20：提示词下面横跨整宽的两列网格）
      parameterGrid,
      errorBox,
      footer,
      // 输出连线端点（右边缘，y = 158 与 legacyPortY(0) 对齐）
      React.createElement(
        'button',
        {
          type: 'button',
          'aria-label': '连接输出结果',
          'data-fisherai-port': 'true',
          'data-fisherai-connector-node-id': node.id,
          'data-fisherai-connector-side': 'right',
          'data-fisherai-connector-port-index': 0,
          onPointerDown: connectOut,
          style: {
            position: 'absolute',
            right: '-16px',
            top: `${SLOT_TOP}px`,
            width: '30px',
            height: '30px',
            borderRadius: '9999px',
            border: `1px solid ${COLORS.borderControl}`,
            background: COLORS.input,
            color: COLORS.secondary,
            fontSize: '18px',
            lineHeight: '26px',
            cursor: 'crosshair',
          },
        },
        '+',
      ),
      // 未知工作流（模板被删/旧版停用节点）时的说明
      definition
        ? null
        : React.createElement(
            'div',
            {
              'data-fisherai-local-workflow-missing': 'true',
              style: {
                position: 'absolute',
                left: RIGHT_COLUMN_LEFT,
                right: '16px',
                top: PROMPT_TOP,
                color: COLORS.muted,
                fontSize: '12px',
                lineHeight: 1.7,
              },
            },
            '这个工作流当前不在本地清单里（模板文件可能被删了，或是旧版已停用的内置节点）。',
            React.createElement('br'),
            '在上面的下拉框里选一个本地工作流即可继续用。',
          ),
    ),
  );
}
