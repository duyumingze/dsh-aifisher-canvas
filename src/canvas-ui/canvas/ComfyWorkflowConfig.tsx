/**
 * 「ComfyUI 工作流配置」面板（画布左侧工具条第三个按钮，替换掉原来的「SKILL 社区」）。
 *
 * 它做什么：把**目录式自定义工作流**（$DSH_HOME/storages/dsh-aifisher-canvas/workflows/）
 * 的配置变成可视化操作 —— 选一个工作流 → 在**节点图**上点节点 → 右侧勾这个节点的字段
 * （勾中的写进 `<名字>.meta.json` 的 `bindings`，取消勾选的推断项写 `null`）→
 * 起个节点名 / 给参数起中文标签 → **保存配置** 或 **直接添加到画布**。
 *
 * v1.19（用户 2026-10-17：「希望 comfui api 配置可以像参考图一样可视化配置」+ 一张参考图）：
 * 中间那块从「一长串候选字段」换成**ComfyUI 节点图**（src/canvas-ui/canvas/ComfyWorkflowGraph.tsx
 * 画、src/host/comfyui/workflowGraph.ts 排版），右侧浮一个检查器：
 *   点图上某个节点 → 只列这个节点的字段（参考图那个「MiniMax H3 Easy 加载器 · #1」）；
 *   点右上角的 ✕ / 没选节点 → 回到「全部字段」+ 过滤框（v1.16 的全局清单没丢，只是挪进浮层）。
 * 参考图里还有「试运行 / 输出结果」两步，那是上游 workflow-library 后端才有的东西，本插件不搬 ——
 * 试运行请在画布节点上直接点生成（走同一条 /comfy/<工作流> 通道）。
 *
 * v1.20（用户 2026-10-17：「想要切换个 lora 模型，但是要我输入文字，能否自动扫描我的 comfui 做出列表让我选」）：
 *   - 候选行副标题会标出「下拉 N 项（扫 ComfyUI）」—— 候选来自 `GET /api/comfy/widget-options`
 *     （host 扫 /object_info 得到的枚举快照，见 src/host/comfyui/widgetOptions.ts）；
 *   - 底栏多一个「扫描 ComfyUI」按钮（aria-label「扫描 ComfyUI 参数」）：装了新 lora 之后点一下，
 *     面板重读视图 + 让画布节点的能力清单重拉（节点上的参数立刻变成新列表）。
 *
 * 结构契约（回归依赖，改前先看 docs/canvas-ui-shadcn.md）：
 *   - 面板根 `role="dialog"` + `aria-label="ComfyUI 工作流配置"` + `data-fisherai-workflow-config-dialog`；
 *   - 工具条入口按钮 `aria-label="ComfyUI 工作流配置"` + `data-fisherai-workflow-config-trigger`；
 *   - 每个候选字段一行：`data-fisherai-workflow-config-candidate="<节点id.inputs.字段>"` + `aria-checked`；
 *   - 工作流列表每项：`data-fisherai-workflow-config-item="<工作流 id>"`；
 *   - 节点图：`data-fisherai-workflow-config-graph`（带 data-nodes/data-edges/data-zoom），
 *     每个节点 `data-fisherai-workflow-config-graph-node="<节点id>"`，连线 `...-graph-edge="from->to"`；
 *   - 检查器：`data-fisherai-workflow-config-inspector="all|<节点id>"`，✕ 的 aria-label 是「返回全部字段」；
 *   - 保存 / 添加到画布按钮的 `aria-label` 分别是「保存配置」「添加到画布」。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（整块面板会消失）。
 */
import * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import {
  CheckIcon,
  CircleCheckIcon,
  FolderIcon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SearchIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  XIcon,
} from 'lucide-react';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { ScrollArea } from '@/ui/scroll-area';
import { cn } from '@/lib/utils';
import { canvasPortalTarget } from '@/lib/portal';
import {
  ensureLocalWorkflows,
  resetLocalWorkflows,
} from '../../../vendor/aifisher/src/stable/media/videoWorkflows';
import { ComfyWorkflowGraph, type ComfyWorkflowGraphProps, type GraphView } from './ComfyWorkflowGraph';
import {
  closeComfyWorkflowConfig,
  rememberWorkflowConfigSelection,
  subscribeWorkflowConfigRequest,
  workflowConfigSelectedId,
  workflowConfigSnapshot,
} from './ComfyWorkflowConfigStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useSyncExternalStore'
>;

interface Props {
  view: string;
  viewport?: { x: number; y: number; zoom: number };
}

/** 节点图组件的 React 绑定（它是 (react, props) 两参组件，不能直接 createElement）。 */
const reactRuntime = ReactTypes as unknown as Parameters<typeof ComfyWorkflowGraph>[0];
const ComfyWorkflowGraphBound: ReactTypes.ComponentType<ComfyWorkflowGraphProps> = (props) =>
  ComfyWorkflowGraph(reactRuntime, props);
ComfyWorkflowGraphBound.displayName = 'ComfyWorkflowGraphBound';

/** host 侧 workflowConfig.ts 的线上形状（只写用到的字段）。 */
interface Candidate {
  id: string;
  key: string;
  nodeId: string;
  classType: string;
  nodeTitle: string;
  field: string;
  kind: 'parameter' | 'media' | 'text' | 'negativeText';
  control: string;
  valueType: string;
  defaultValue?: unknown;
  /** v1.20：这个字段能选什么（meta 里手写的，或扫 ComfyUI /object_info 来的） */
  options?: Array<{ value: string; label: string }>;
  optionsSource?: 'meta' | 'comfyui';
  min?: number;
  max?: number;
  step?: number;
  selected: boolean;
  bindingKey?: string;
  label: string;
  labelIsCustom: boolean;
}

interface ConfigSummary {
  id: string;
  title: string;
  file: string;
  metaFile: string;
  hasMeta: boolean;
  category: string;
  outputType: 'images' | 'videos' | 'audios';
  modes: string[];
  candidateCount: number;
  selectedCount: number;
  disabledCount: number;
  diagnostics: Array<{ file: string; code: string; message: string }>;
}

interface BindingRow {
  key: string;
  label: string;
  targets: string[];
  inferred: boolean;
  declared: boolean;
}

interface ConfigView {
  ok: true;
  dir: string;
  defaultDir?: string;
  isCustom?: boolean;
  workflow: {
    id: string;
    title: string;
    file: string;
    metaFile: string;
    metaPath: string;
    hasMeta: boolean;
    category: string;
    outputType: 'images' | 'videos' | 'audios';
    modes: string[];
    timeoutMs: number;
    outputNodeId: string;
    promptNodeId: string | null;
    negativePromptNodeId: string | null;
    requiredInputs: string[];
  };
  candidates: Candidate[];
  /** v1.19：host 排好的节点图（可视化配置那半边）；老 host 可能没有 */
  graph?: GraphView;
  bindings: BindingRow[];
  disabled: string[];
  missing: Array<{ key: string; targets: string[] }>;
  totals: { fields: number; selected: number; parameters: number; media: number };
  diagnostics: Array<{ file: string; code: string; message: string }>;
}

const BASE = '/api/aifisher/canvas/comfy/workflow-config';
const BINDING_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

const OUTPUT_LABELS: Record<string, string> = {
  images: '图片',
  videos: '视频',
  audios: '音频',
};

const KIND_LABELS: Record<string, string> = {
  media: '素材槽',
  text: '提示词',
  negativeText: '负向提示词',
  parameter: '参数',
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 画布正中在世界坐标里的位置（「直接添加到画布」把节点落在这儿）。 */
function canvasCenterPoint(viewport: Props['viewport']): { x: number; y: number } {
  const zoom = Number.isFinite(viewport?.zoom) && (viewport?.zoom ?? 0) > 0 ? viewport!.zoom : 1;
  const rect = (
    document.getElementById('canvas-background') ?? document.querySelector('.af-canvas-mount')
  )?.getBoundingClientRect();
  const width = rect && rect.width > 0 ? rect.width : window.innerWidth;
  const height = rect && rect.height > 0 ? rect.height : window.innerHeight;
  return {
    x: (width / 2 - (viewport?.x ?? 0)) / zoom,
    y: (height / 2 - (viewport?.y ?? 0)) / zoom,
  };
}

/** 滚轮护栏：画布在 document 上装了「画布永不滚动」的监听，面板内的滚动不能被它决定。 */
function onPanelWheel(event: ReactTypes.WheelEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

export function ComfyWorkflowConfig(react: Runtime, props: Props) {
  const h = react.createElement;

  /**
   * 开关状态来自 store（不是本地 useState）：Controls 槽位的绑定层每次渲染都会造新的
   * 组件类型，面板子树会被重挂载（见 ComfyWorkflowConfigStore.ts 的注释）——
   * 本地 state 里的 open 会归零、闭包里的 setOpen 会打空。store 是模块级的，重挂载读到的
   * 就是真值，于是「保存并添加到画布」之后能真的关掉。
   */
  const store = react.useSyncExternalStore(subscribeWorkflowConfigRequest, workflowConfigSnapshot);
  const open = store.open;
  const openVersion = store.version;
  const [list, setList] = react.useState<ConfigSummary[] | null>(null);
  const [dir, setDir] = react.useState('');
  /** 目录输入框：直接编辑 + 「应用」（v1.18 起目录可自定义，不再写死在 host 里） */
  const [dirDraft, setDirDraft] = react.useState('');
  const [dirDefault, setDirDefault] = react.useState('');
  /** 当前目录是用户自定义的（badge + 「默认」按钮用） */
  const [dirCustom, setDirCustom] = react.useState(false);
  const [dirBusy, setDirBusy] = react.useState(false);
  /** 「扫描 ComfyUI」按钮的忙碌态（v1.20：拉 /object_info 拿 lora/模型的下拉候选） */
  const [scanBusy, setScanBusy] = react.useState(false);
  /** 用户动过输入框就别被 refresh 回来的值回冲（用 ref 是因为 loadList 是 [] 依赖的 callback） */
  const dirDirtyRef = react.useRef(false);
  const [listError, setListError] = react.useState('');
  const [selectedId, setSelectedId] = react.useState<string | null>(() => workflowConfigSelectedId());
  const [view, setView] = react.useState<ConfigView | null>(null);
  const [viewError, setViewError] = react.useState('');
  const [loading, setLoading] = react.useState(false);
  const [busy, setBusy] = react.useState('');
  const [notice, setNotice] = react.useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [comfy, setComfy] = react.useState<{ online: boolean; url: string } | null>(null);
  const [filter, setFilter] = react.useState('');
  /** 画布节点名称（= meta.title） */
  const [titleDraft, setTitleDraft] = react.useState('');
  /** 勾选状态：候选 id → 绑定键（键名沿用已有的，新勾的用面板建议的） */
  const [picked, setPicked] = react.useState<Record<string, string>>({});
  /** 参数中文标签：绑定键 → 用户填的文本（空串 = 不写，用自动标签） */
  const [labels, setLabels] = react.useState<Record<string, string>>({});
  /** 画布图上选中的节点（null = 检查器显示「全部字段」） */
  const [selectedNodeId, setSelectedNodeId] = react.useState<string | null>(null);
  const [dirty, setDirty] = react.useState(false);

  /** 请求序号：快速切换工作流时丢掉过期响应（不然会闪回上一个工作流的字段）。 */
  const requestRef = react.useRef(0);
  /** 记住上次「请求打开」的版本：只有真·重新请求才重置面板状态。 */
  const handledVersionRef = react.useRef(-1);

  const hydrate = react.useCallback((next: ConfigView) => {
    const pickedNext: Record<string, string> = {};
    for (const candidate of next.candidates) {
      if (!candidate.selected) continue;
      pickedNext[candidate.id] = candidate.bindingKey ?? candidate.key;
    }
    const labelsNext: Record<string, string> = {};
    for (const candidate of next.candidates) {
      if (!candidate.selected) continue;
      const key = pickedNext[candidate.id];
      if (candidate.labelIsCustom) labelsNext[key] = candidate.label;
    }
    setPicked(pickedNext);
    setLabels(labelsNext);
    setTitleDraft(next.workflow.title);
    setSelectedNodeId(null);
    setDirty(false);
  }, []);

  const loadList = react.useCallback(async (refresh: boolean) => {
    setListError('');
    try {
      const response = await fetch(`${BASE}${refresh ? '?refresh=1' : ''}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      if (!response.ok) {
        setListError(String(data.error ?? `读取工作流清单失败（HTTP ${response.status}）`));
        setList([]);
        return;
      }
      const configs = (data.configs as ConfigSummary[] | undefined) ?? [];
      setList(configs);
      const nextDir = String(data.dir ?? '');
      setDir(nextDir);
      setDirDefault(String(data.defaultDir ?? ''));
      setDirCustom(data.isCustom === true);
      // 用户正在改输入框时别覆盖他的草稿
      if (!dirDirtyRef.current) setDirDraft(nextDir);
      setSelectedId((current) => current ?? configs[0]?.id ?? null);
    } catch (error) {
      setList([]);
      setListError(error instanceof Error ? error.message : '读取工作流清单失败');
    }
  }, []);

  const loadView = react.useCallback(
    async (id: string) => {
      const epoch = ++requestRef.current;
      setLoading(true);
      setViewError('');
      try {
        const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
          headers: { Accept: 'application/json' },
        });
        const data = await readJson(response);
        if (epoch !== requestRef.current) return;
        if (!response.ok) {
          setView(null);
          setViewError(String(data.error ?? `读取「${id}」失败（HTTP ${response.status}）`));
          return;
        }
        const next = data as unknown as ConfigView;
        setView(next);
        hydrate(next);
      } catch (error) {
        if (epoch !== requestRef.current) return;
        setView(null);
        setViewError(error instanceof Error ? error.message : '读取工作流配置失败');
      } finally {
        if (epoch === requestRef.current) setLoading(false);
      }
    },
    [hydrate],
  );

  /**
   * 改工作流目录（v1.18）。`null` = 恢复默认目录。
   * 换了目录就是换了整套工作流：清空选中态与视图、重扫，并让画布节点的可选项重拉。
   */
  const applyDir = react.useCallback(
    async (next: string | null) => {
      setDirBusy(true);
      setNotice(null);
      try {
        const response = await fetch(`${BASE}-dir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: next }),
        });
        const data = await readJson(response);
        if (!response.ok) {
          setNotice({
            kind: 'error',
            text: String(data.error ?? `切换目录失败（HTTP ${response.status}）`),
          });
          return;
        }
        const applied = String(data.dir ?? '');
        setDir(applied);
        setDirDefault(String(data.defaultDir ?? ''));
        setDirCustom(data.isCustom === true);
        setDirDraft(applied);
        dirDirtyRef.current = false;
        setList(null);
        setSelectedId(null);
        setView(null);
        setViewError('');
        setFilter('');
        setSelectedNodeId(null);
        await loadList(true);
        // 画布节点的可选工作流来自能力清单（client 侧有缓存）：换目录后要重拉
        resetLocalWorkflows();
        void ensureLocalWorkflows();
        setNotice({
          kind: 'ok',
          text:
            data.created === true
              ? `已切换到 ${applied}（目录已新建）`
              : `工作流目录已切换到 ${applied}`,
        });
      } catch (error) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : '切换目录失败' });
      } finally {
        setDirBusy(false);
      }
    },
    [loadList],
  );

  /**
   * 静默补一次「ComfyUI 字段候选值」（v1.20）：面板一打开、ComfyUI 在线就拉一次
   * （host 侧有 5 分钟 TTL，不会每开一次都真扫 object_info），拿到后重读当前工作流的视图 ——
   * 于是用户不用先点「扫描 ComfyUI」也能看到「下拉 N 项」。失败就静默（参数还是文本输入框）。
   */
  const warmWidgetOptions = react.useCallback(async () => {
    try {
      const response = await fetch('/api/aifisher/canvas/comfy/widget-options', {
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      if (data.ok !== true) return;
      if (selectedId) void loadView(selectedId);
    } catch {
      // 扫不到候选不影响配置：没有下拉就还是文本输入框
    }
  }, [selectedId, loadView]);

  const loadComfy = react.useCallback(async () => {
    try {
      const response = await fetch('/api/aifisher/canvas/comfy/ping', {
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      setComfy({ online: data.online === true, url: String(data.url ?? '') });
      // 在线才值得扫：ComfyUI 没开时这一步只会白等（旧快照已经在 host 手里了）
      if (data.online === true) void warmWidgetOptions();
    } catch {
      setComfy({ online: false, url: '' });
    }
  }, [warmWidgetOptions]);

  /**
   * 扫描 ComfyUI 的字段候选值（v1.20）。
   *
   * 用户原话：「我想要切换个 lora 模型，但是要我输入文字，能否自动扫描我的 comfui 做出列表让我选」。
   * host 把 /object_info 压成小快照（storages/.../comfy-widget-options.json），这里只是**手动触发一次重扫**
   * （装了新 lora 之后点一下），然后：
   *   ① 重新读当前工作流的视图 → 面板里直接看到「下拉 N 项」；
   *   ② 让画布节点的能力清单重拉 → 节点上的参数变成真正的 `<select>`（不用刷新页面）。
   */
  const scanWidgets = react.useCallback(async () => {
    setScanBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/aifisher/canvas/comfy/widget-options?refresh=1', {
        headers: { Accept: 'application/json' },
      });
      const data = await readJson(response);
      if (data.ok === false) {
        setNotice({
          kind: 'error',
          text: `扫不到 ComfyUI：${String(data.error ?? data.code ?? '未知错误')}。下拉仍用上次扫到的那份快照。`,
        });
      } else {
        setNotice({
          kind: 'ok',
          text:
            `已扫描 ComfyUI：${String(data.fields ?? 0)} 个下拉字段 / ` +
            `${String(data.options ?? 0)} 个候选值（lora、模型、采样器…）`,
        });
      }
      resetLocalWorkflows();
      void ensureLocalWorkflows();
      // 已经挂在画布上的节点也重拿一份候选（vendor 侧监听了这个事件）
      window.dispatchEvent(new CustomEvent('fisherai:comfy-widgets-refresh'));
      if (selectedId) void loadView(selectedId);
      void loadComfy();
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : '扫描 ComfyUI 失败',
      });
    } finally {
      setScanBusy(false);
    }
  }, [selectedId, loadView, loadComfy]);

  // 打开（或重新请求打开）：拉清单 + ComfyUI 状态
  // 清单每次都 refresh，用户在目录里丢 JSON 后立刻能看见；重挂载时也走这里补数据。
  react.useEffect(() => {
    if (!open) return;
    if (handledVersionRef.current !== openVersion) {
      handledVersionRef.current = openVersion;
      setNotice(null);
      setFilter('');
      setList(null);
      setView(null);
      // 新一次打开：目录输入框回到服务端的真值（草稿不留到下一次）
      dirDirtyRef.current = false;
      setDirDraft('');
    }
    void loadList(true);
    void loadComfy();
    // 面板打开时先把画布右键菜单关掉（避免两层浮层叠着）
    window.dispatchEvent(new CustomEvent('fisherai:close-canvas-menu'));
  }, [open, openVersion, loadList, loadComfy]);

  // 选中变化 → 拉该工作流的配置
  react.useEffect(() => {
    if (!open || !selectedId) return;
    void loadView(selectedId);
  }, [open, selectedId, loadView]);

  // Esc 关闭
  react.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeComfyWorkflowConfig();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const close = react.useCallback(() => closeComfyWorkflowConfig(), []);

  /** 选工作流：同时记到 store（面板重挂载后还停在同一个上）。 */
  const selectWorkflow = react.useCallback((id: string) => {
    rememberWorkflowConfigSelection(id);
    setSelectedId(id);
  }, []);

  const toggle = react.useCallback((candidate: Candidate) => {
    setDirty(true);
    setPicked((current) => {
      const next = { ...current };
      if (next[candidate.id]) {
        delete next[candidate.id];
      } else {
        const key = candidate.bindingKey ?? candidate.key;
        // 同一个键被别的候选占着（多节点同名字段）时，换一个不冲突的后缀
        const taken = new Set(Object.entries(next).map(([id, value]) => (id === candidate.id ? '' : value)));
        let finalKey = key;
        let index = 2;
        while (taken.has(finalKey)) {
          finalKey = `${key.replace(/\d+$/, '')}${index}`;
          index += 1;
        }
        next[candidate.id] = finalKey;
      }
      return next;
    });
  }, []);

  const payload = react.useMemo(() => {
    if (!view) return null;
    const bindings: Record<string, string | string[]> = {};
    const byKey = new Map<string, string[]>();
    for (const [candidateId, key] of Object.entries(picked)) {
      const listOf = byKey.get(key) ?? [];
      listOf.push(candidateId);
      byKey.set(key, listOf);
    }
    for (const [key, targets] of byKey) bindings[key] = targets.length === 1 ? targets[0] : targets;
    // 已经有绑定、但这次没勾的键 → null（显式关闭；推断出来的那些靠它才能摘掉）
    for (const binding of view.bindings) {
      if (!byKey.has(binding.key)) bindings[binding.key] = null as unknown as string;
    }
    const parameters: Record<string, { label: string } | null> = {};
    const pickedKeys = new Set(Object.values(picked));
    for (const key of pickedKeys) {
      const label = (labels[key] ?? '').trim();
      parameters[key] = label ? { label } : null;
    }
    for (const binding of view.bindings) {
      if (!pickedKeys.has(binding.key)) parameters[binding.key] = null;
    }
    return { title: titleDraft.trim(), bindings, parameters };
  }, [view, picked, labels, titleDraft]);

  const save = react.useCallback(
    async (options: { thenAdd?: boolean } = {}) => {
      if (!view || !payload) return;
      if (!payload.title) {
        setNotice({ kind: 'error', text: '画布节点名称不能为空。' });
        return;
      }
      const badKey = Object.keys(payload.bindings).find((key) => !BINDING_KEY_PATTERN.test(key));
      if (badKey) {
        setNotice({ kind: 'error', text: `参数键「${badKey}」不合法（只能用字母、数字、下划线）。` });
        return;
      }
      setBusy('save');
      setNotice(null);
      try {
        const response = await fetch(`${BASE}/${encodeURIComponent(view.workflow.id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await readJson(response);
        if (!response.ok) {
          setNotice({ kind: 'error', text: String(data.error ?? `保存失败（HTTP ${response.status}）`) });
          return;
        }
        const next = data as unknown as ConfigView;
        setView(next);
        hydrate(next);
        void loadList(false);
        // 画布节点的工作流清单来自能力清单（client 侧有缓存）：保存后要重拉，
        // 否则节点上的参数还是保存前那一版
        resetLocalWorkflows();
        void ensureLocalWorkflows();
        if (options.thenAdd) {
          window.dispatchEvent(
            new CustomEvent('fisherai:add-canvas-node', {
              detail: {
                type: 'ComfyUI',
                comfyMode: next.workflow.id,
                point: canvasCenterPoint(props.viewport),
              },
            }),
          );
          closeComfyWorkflowConfig();
          return;
        }
        setNotice({ kind: 'ok', text: `已保存到 ${next.workflow.metaFile}` });
      } catch (error) {
        setNotice({
          kind: 'error',
          text: error instanceof Error ? error.message : '保存失败',
        });
      } finally {
        setBusy('');
      }
    },
    [view, payload, hydrate, loadList, props.viewport],
  );

  /**
   * 节点 id → 候选数 / 已勾数（图上节点头部的小数字 + 检查器标题里的「已勾 x / y」）。
   * ⚠️ 这个 useMemo 必须留在 `if (!open) return null` **之前**：面板关着时提前返回、
   * 打开时多跑两个 hook 会直接撞 React error #310（Rendered more hooks than during the previous render）。
   */
  const nodeCounts = react.useMemo(() => {
    const result: Record<string, { total: number; selected: number }> = {};
    for (const candidate of view?.candidates ?? []) {
      const entry = result[candidate.nodeId] ?? { total: 0, selected: 0 };
      entry.total += 1;
      if (picked[candidate.id]) entry.selected += 1;
      result[candidate.nodeId] = entry;
    }
    return result;
  }, [view, picked]);
  /** 同一份勾选状态给图用（图上给已勾的行点亮小圆点） */
  const pickedFlags = react.useMemo(() => {
    const result: Record<string, true> = {};
    for (const id of Object.keys(picked)) result[id] = true;
    return result;
  }, [picked]);

  if (!open) return null;

  // ---------------------------------------------------------------- 片段渲染

  const badge = (text: string, tone: 'muted' | 'accent' = 'muted') =>
    h(
      'span',
      {
        className: cn(
          'shrink-0 rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium leading-none',
          tone === 'accent'
            ? 'bg-primary text-primary-foreground'
            : 'bg-secondary text-muted-foreground',
        ),
      },
      text,
    );

  const item = (config: ConfigSummary) => {
    const active = config.id === selectedId;
    return h(
      'button',
      {
        key: config.id,
        type: 'button',
        'data-fisherai-workflow-config-item': config.id,
        'aria-current': active ? 'true' : undefined,
        onClick: () => selectWorkflow(config.id),
        className: cn(
          'flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-left transition-colors',
          active
            ? 'border-input bg-secondary text-foreground'
            : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ),
      },
      h(
        'span',
        { className: 'flex items-center gap-1.5' },
        h(WorkflowIcon, { className: 'size-3.5 shrink-0 opacity-70' }),
        h('span', { className: 'min-w-0 flex-1 truncate text-xs font-medium' }, config.title),
      ),
      h(
        'span',
        { className: 'flex items-center gap-1 pl-5 text-[10px] text-muted-foreground' },
        h('span', { className: 'truncate' }, config.file),
        h('span', { className: 'shrink-0' }, `· 已选 ${config.selectedCount}/${config.candidateCount}`),
        config.hasMeta ? null : h('span', { className: 'shrink-0 text-[var(--af-text-muted)]' }, '· 未配置'),
      ),
      config.diagnostics.length
        ? h(
            'span',
            { className: 'flex items-center gap-1 pl-5 text-[10px] text-[var(--af-danger,#f87171)]' },
            h(TriangleAlertIcon, { className: 'size-3 shrink-0' }),
            h('span', { className: 'truncate' }, config.diagnostics[0].code),
          )
        : null,
    );
  };

  const filtered = (view?.candidates ?? []).filter((candidate) => {
    const query = filter.trim().toLowerCase();
    if (!query) return true;
    return [candidate.label, candidate.field, candidate.classType, candidate.nodeTitle, candidate.key]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });

  /**
   * 一行候选字段。
   * `options.label` 只在「节点模式」用：检查器标题已经写着是哪个节点，行内再重复一遍节点标题
   * 只会把「随机种子」挤成「KSampl…」（参考图里那列就是纯字段名）。
   */
  const candidateRow = (candidate: Candidate, options: { label?: string } = {}) => {
    const key = picked[candidate.id];
    const selected = Boolean(key);
    const label = options.label ?? candidate.label;
    return h(
      'div',
      {
        key: candidate.id,
        role: 'checkbox',
        'aria-checked': selected ? 'true' : 'false',
        'aria-label': candidate.label,
        'data-fisherai-workflow-config-candidate': candidate.id,
        'data-selected': selected ? 'true' : 'false',
        tabIndex: 0,
        onClick: (event: ReactTypes.MouseEvent) => {
          const target = event.target as HTMLElement | null;
          // 行内的标签输入框有自己的交互，别把点它当成「取消勾选」
          if (target && typeof target.closest === 'function' && target.closest('input,textarea')) return;
          toggle(candidate);
        },
        onKeyDown: (event: ReactTypes.KeyboardEvent) => {
          if (event.key !== ' ' && event.key !== 'Enter') return;
          event.preventDefault();
          toggle(candidate);
        },
        className: cn(
          'flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 py-1 transition-colors',
          selected ? 'bg-secondary/70' : 'hover:bg-accent/50',
        ),
      },
      h(
        'span',
        {
          className: cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[3px] border',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
          ),
        },
        selected ? h(CheckIcon, { className: 'size-3' }) : null,
      ),
      h(
        'span',
        { className: 'min-w-0 flex-1' },
        h('span', { className: 'block truncate text-xs' }, label),
        h(
          'span',
          { className: 'block truncate text-[10px] text-muted-foreground' },
          `${candidate.classType} · #${candidate.nodeId}.${candidate.field}` +
            (candidate.control === 'number' ? ` · ${candidate.valueType}` : '') +
            (candidate.options?.length
              ? ` · 下拉 ${candidate.options.length} 项${candidate.optionsSource === 'comfyui' ? '（扫 ComfyUI）' : ''}`
              : ''),
        ),
      ),
      selected
        ? h(Input, {
            key: 'label',
            value: labels[key ?? ''] ?? '',
            placeholder: '标签',
            title: '给这个参数起个中文标签（留空则用上面那行自动标签）',
            'aria-label': `参数标签 ${candidate.label}`,
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
              const value = event.target.value;
              setDirty(true);
              setLabels((current) => ({ ...current, [key ?? '']: value }));
            },
            className: 'h-6 w-28 shrink-0 px-1.5 text-[11px]',
          })
        : null,
      badge(KIND_LABELS[candidate.kind] ?? candidate.kind, selected ? 'accent' : 'muted'),
    );
  };

  const selectedCount = view ? Object.keys(picked).length : 0;
  const graph = view?.graph;

  const comfyBadge = h(
    'span',
    { className: 'flex items-center gap-1.5 text-[11px] text-muted-foreground' },
    h(ServerIcon, { className: 'size-3.5 shrink-0' }),
    h(
      'span',
      {
        'data-fisherai-workflow-config-comfy': comfy ? (comfy.online ? 'online' : 'offline') : 'unknown',
        className: cn(
          'font-medium',
          comfy?.online ? 'text-[var(--af-success,#4ade80)]' : 'text-muted-foreground',
        ),
      },
      comfy ? (comfy.online ? 'ComfyUI 在线' : 'ComfyUI 未连上') : 'ComfyUI 状态查询中…',
    ),
    comfy?.url ? h('span', { className: 'max-w-56 truncate' }, comfy.url) : null,
  );

  /** 自动标签是「节点标题 · 字段」，节点模式里把前缀摘掉（标题已经在检查器头上了）。 */
  const withoutNodePrefix = (candidate: Candidate, title: string) => {
    const prefix = `${title} · `;
    return candidate.label.startsWith(prefix) ? candidate.label.slice(prefix.length) : candidate.label;
  };

  /**
   * 检查器里的字段清单（勾选行还是 v1.16 那套 DOM 契约，回归靠它）。
   *
   * ⚠️ 这里**不用 ScrollArea**：Radix 的 viewport 里有一层 `display: table` 的包裹层，
   * 宽度会跟着内容长（长行 → 撑出面板 → 行尾的标签输入框/徽章被裁掉，v1.19 截图里看的很明显）。
   * 检查器是窄浮层，一个原生 `overflow-y-auto` 的 div 就够，行内的 truncate 也才真的生效。
   */
  const candidateList = (rows: Candidate[], emptyText: string, stripTitle?: string) =>
    h(
      'div',
      { className: 'min-h-0 flex-1 overflow-hidden' },
      h(
        'div',
        {
          'data-fisherai-workflow-config-fields': 'true',
          'data-count': String(rows.length),
          className: 'flex h-full flex-col gap-0.5 overflow-y-auto p-1.5',
        },
        rows.length
          ? rows.map((candidate) =>
              candidateRow(candidate, stripTitle ? { label: withoutNodePrefix(candidate, stripTitle) } : {}),
            )
          : h('div', { className: 'px-3 py-6 text-center text-[11px] text-muted-foreground' }, emptyText),
      ),
    );

  const selectedNode = selectedNodeId && graph
    ? (graph.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;
  const nodeRows = selectedNodeId && view
    ? view.candidates.filter((candidate) => candidate.nodeId === selectedNodeId)
    : [];

  /**
   * 右侧检查器（参考图右侧那块浮层）：
   *   - 默认 = 「全部字段」+ 过滤框（v1.16 的全局勾选清单还在，只是挪进了浮层）；
   *   - 点了图上的节点 = 只列**这个节点**的字段（参考图那个「MiniMax H3 Easy 加载器 · #1」）。
   */
  const inspector = view
    ? selectedNode
      ? h(
          'div',
          {
            'data-fisherai-workflow-config-inspector': selectedNode.id,
            className:
              'absolute top-11 right-2 bottom-2 flex w-[268px] flex-col overflow-hidden rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-sm',
          },
          h(
            'div',
            { className: 'flex items-start gap-1 border-b border-border px-2 py-1.5' },
            h(
              'div',
              { className: 'min-w-0 flex-1' },
              h('div', { className: 'truncate text-xs font-medium' }, `${selectedNode.title} · #${selectedNode.id}`),
              h(
                'div',
                { className: 'truncate text-[10px] text-muted-foreground' },
                `${selectedNode.classType === selectedNode.title ? '' : `${selectedNode.classType} · `}` +
                  `已勾 ${nodeCounts[selectedNode.id]?.selected ?? 0} / ${nodeCounts[selectedNode.id]?.total ?? 0}`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '返回全部字段',
                title: '返回全部字段',
                onClick: () => setSelectedNodeId(null),
                className: 'shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground',
              },
              h(XIcon, { className: 'size-3.5' }),
            ),
          ),
          candidateList(
            nodeRows,
            '这个节点没有可配置字段（字段都被连线喂了，或者它是纯输出节点）',
            selectedNode.title,
          ),
        )
      : h(
          'div',
          {
            'data-fisherai-workflow-config-inspector': 'all',
            className:
              'absolute top-11 right-2 bottom-2 flex w-[268px] flex-col overflow-hidden rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-sm',
          },
          h(
            'div',
            { className: 'flex flex-col gap-1 border-b border-border px-2 py-1.5' },
            h(
              'div',
              { className: 'flex items-center gap-1.5' },
              h(ListIcon, { className: 'size-3.5 shrink-0 text-muted-foreground' }),
              h('span', { className: 'text-xs font-medium' }, '全部字段'),
              h(
                'span',
                { className: 'ml-auto shrink-0 text-[10px] text-muted-foreground' },
                `${filtered.length} / ${view.candidates.length}`,
              ),
            ),
            h(
              'div',
              { className: 'relative' },
              h(SearchIcon, {
                className: 'pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground',
              }),
              h(Input, {
                value: filter,
                'aria-label': '过滤参数',
                placeholder: '过滤字段 / 节点…',
                onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setFilter(event.target.value),
                className: 'h-7 pl-6 text-[11px]',
              }),
            ),
            h(
              'div',
              { className: 'text-[10px] text-muted-foreground' },
              '点左边图上的节点 → 只看那个节点的字段',
            ),
          ),
          candidateList(
            filtered,
            view.candidates.length ? '没有匹配的字段' : '这个工作流里没有可配置的字段',
          ),
        )
    : null;

  const detail = view
    ? h(
        react.Fragment,
        null,
        // 顶部一条：画布节点名称 + 已选计数 + ComfyUI 状态（参考图顶部那行）
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2' },
          h('span', { className: 'shrink-0 text-[11px] text-muted-foreground' }, '画布节点名称'),
          h(Input, {
            value: titleDraft,
            'aria-label': '画布节点名称',
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
              setTitleDraft(event.target.value);
              setDirty(true);
            },
            className: 'h-7 max-w-80 flex-1 text-xs',
          }),
          h(
            'span',
            { className: 'shrink-0 text-[11px] font-medium', 'data-fisherai-workflow-config-count': String(selectedCount) },
            `已选 ${selectedCount} / ${view.totals.fields}`,
          ),
          h('span', { className: 'ml-auto flex items-center' }, comfyBadge),
        ),
        // 第二行：输出类型 / 输出节点 / 候选统计 / 图上节点与连线数
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1' },
          badge(`${OUTPUT_LABELS[view.workflow.outputType] ?? view.workflow.outputType}结果`),
          h(
            'span',
            { className: 'text-[11px] text-muted-foreground' },
            `输出节点 #${view.workflow.outputNodeId || '未识别'}`,
          ),
          h(
            'span',
            { className: 'text-[11px] text-muted-foreground' },
            `候选字段 ${view.totals.fields} 个（参数 ${view.totals.parameters} · 素材槽 ${view.totals.media}）`,
          ),
          graph
            ? h(
                'span',
                {
                  'data-fisherai-workflow-config-graph-meta': 'true',
                  className: 'text-[11px] text-muted-foreground',
                },
                `节点 ${graph.nodes.length} 个 · 连线 ${graph.edges.length} 条`,
              )
            : null,
        ),
        // 主体：左边是节点图，右边浮着检查器（点节点 → 只看这个节点的字段）
        graph
          ? h(
              'div',
              { className: 'relative flex min-h-0 flex-1' },
              h(ComfyWorkflowGraphBound, {
                graph,
                counts: nodeCounts,
                pickedIds: pickedFlags,
                selectedNodeId,
                onSelectNode: (id: string | null) => setSelectedNodeId(id),
              }),
              inspector,
            )
          : h(
              ScrollArea,
              { className: 'min-h-0 flex-1' },
              h(
                'div',
                {
                  'data-fisherai-workflow-config-fields': 'true',
                  'data-count': String(filtered.length),
                  className: 'flex flex-col gap-0.5 p-1.5',
                },
                filtered.length
                  ? filtered.map((candidate) => candidateRow(candidate))
                  : h(
                      'div',
                      { className: 'px-3 py-6 text-center text-xs text-muted-foreground' },
                      view.candidates.length ? '没有匹配的字段' : '这个工作流里没有可配置的字段',
                    ),
              ),
            ),
        view.missing.length || view.diagnostics.length
          ? h(
              'div',
              {
                'data-fisherai-workflow-config-diagnostics': 'true',
                className:
                  'max-h-24 overflow-y-auto border-t border-border px-3 py-1.5 text-[10px] text-[var(--af-danger,#f87171)]',
              },
              view.missing.map((entry) =>
                h('div', { key: `missing-${entry.key}` }, `绑定 ${entry.key} 的位址在模板里找不到：${entry.targets.join('、')}`),
              ),
              view.diagnostics.map((entry, index) =>
                h('div', { key: `diag-${index}` }, `${entry.file || '(目录)'} ${entry.code} ${entry.message}`),
              ),
            )
          : null,
      )
    : h(
        'div',
        { className: 'flex flex-1 items-center justify-center px-6 text-center' },
        h(
          'div',
          { className: 'text-xs text-muted-foreground' },
          viewError ||
            (list && list.length
              ? loading
                ? '正在读取配置…'
                : '选左边一个工作流开始配置'
              : '还没有自定义工作流：把 ComfyUI 导出的 API 格式 JSON 放进下面的目录（目录可以在左下角改），再点「重新扫描」。'),
          dir ? h('div', { className: 'mt-2 break-all text-[10px] opacity-70' }, dir) : null,
        ),
      );

  const body = h(
    'div',
    { className: 'flex min-h-0 flex-1' },
    h(
      'div',
      { className: 'flex w-60 shrink-0 flex-col border-r border-border' },
      h(
        ScrollArea,
        { className: 'min-h-0 flex-1' },
        h(
          'div',
          { className: 'flex flex-col gap-1 p-1.5' },
          list === null
            ? h('div', { className: 'px-2 py-6 text-center text-[11px] text-muted-foreground' }, '读取中…')
            : list.length
              ? list.map(item)
              : h(
                  'div',
                  { className: 'px-2 py-6 text-center text-[11px] text-muted-foreground' },
                  listError || '目录里还没有 JSON',
                ),
        ),
      ),
      h(
        'div',
        { className: 'flex flex-col gap-1 border-t border-border p-1.5' },
        // 目录（v1.18 可自定义）：标题行 + 输入框 + [应用][默认][重新扫描]
        h(
          'div',
          { className: 'flex items-center gap-1 px-1' },
          h(FolderIcon, { className: 'size-3 shrink-0 text-muted-foreground' }),
          h('span', { className: 'text-[10px] text-muted-foreground' }, '工作流目录'),
          dirCustom
            ? h(
                'span',
                {
                  'data-fisherai-workflow-config-dir-custom': 'true',
                  className: 'ml-auto shrink-0 rounded-[3px] bg-secondary px-1 text-[9px] leading-4 text-muted-foreground',
                },
                '自定义',
              )
            : h(
                'span',
                { className: 'ml-auto shrink-0 text-[9px] leading-4 text-muted-foreground/70' },
                '默认',
              ),
        ),
        h(Input, {
          value: dirDraft,
          'aria-label': '工作流目录',
          placeholder: 'D:\\ComfyUI\\我的工作流',
          title: [
            dirDefault ? `当前（${dirCustom ? '自定义' : '默认'}）：${dir}` : dir,
            dirDefault ? `默认目录：${dirDefault}` : '',
            '填一个绝对路径（不存在会自动新建）；点「默认」回到默认目录',
          ]
            .filter(Boolean)
            .join('\n'),
          spellCheck: false,
          onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
            dirDirtyRef.current = true;
            setDirDraft(event.target.value);
          },
          onKeyDown: (event: ReactTypes.KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const next = dirDraft.trim();
            if (!next || dirBusy) return;
            void applyDir(next);
          },
          className: 'h-7 px-1.5 text-[10px]',
        }),
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-1' },
          h(
            Button,
            {
              type: 'button',
              size: 'sm',
              'aria-label': '应用目录',
              disabled: dirBusy || !dirDraft.trim() || dirDraft.trim() === dir,
              onClick: () => void applyDir(dirDraft.trim()),
              className: 'h-6 gap-1 px-2 text-[10px]',
            },
            h(SaveIcon, { className: 'size-3' }),
            dirBusy ? '切换中…' : '应用',
          ),
          dirCustom
            ? h(
                Button,
                {
                  type: 'button',
                  variant: 'secondary',
                  size: 'sm',
                  'aria-label': '恢复默认目录',
                  disabled: dirBusy,
                  onClick: () => void applyDir(null),
                  className: 'h-6 px-2 text-[10px]',
                },
                '默认',
              )
            : null,
          h(
            Button,
            {
              type: 'button',
              variant: 'secondary',
              size: 'sm',
              'aria-label': '重新扫描目录',
              disabled: dirBusy,
              onClick: () => {
                setNotice(null);
                setList(null);
                void loadList(true);
                if (selectedId) void loadView(selectedId);
              },
              className: 'h-6 gap-1 px-2 text-[10px]',
            },
            h(RefreshCwIcon, { className: 'size-3' }),
            '重新扫描',
          ),
          // v1.20：扫 ComfyUI 的 /object_info → lora / 模型名 / 采样器这些字段在画布节点上变下拉
          h(
            Button,
            {
              type: 'button',
              variant: 'secondary',
              size: 'sm',
              'aria-label': '扫描 ComfyUI 参数',
              'data-fisherai-workflow-config-scan-comfy': 'true',
              disabled: dirBusy || scanBusy,
              title: '读 ComfyUI 的 /object_info，把 lora、模型名、采样器这些字段变成下拉列表',
              onClick: () => void scanWidgets(),
              className: 'h-6 gap-1 px-2 text-[10px]',
            },
            h(ServerIcon, { className: 'size-3' }),
            scanBusy ? '扫描中…' : '扫描 ComfyUI',
          ),
        ),
      ),
    ),
    h('div', { className: 'flex min-w-0 flex-1 flex-col' }, detail),
  );

  const footer = h(
    'div',
    { className: 'flex items-center gap-2 border-t border-border px-3 py-2' },
    notice
      ? h(
          'span',
          {
            'data-fisherai-workflow-config-notice': notice.kind,
            className: cn(
              'flex min-w-0 flex-1 items-center gap-1.5 text-[11px]',
              notice.kind === 'error' ? 'text-[var(--af-danger,#f87171)]' : 'text-muted-foreground',
            ),
          },
          notice.kind === 'ok' ? h(CircleCheckIcon, { className: 'size-3.5 shrink-0' }) : null,
          h('span', { className: 'truncate' }, notice.text),
        )
      : h(
          'span',
          { className: 'min-w-0 flex-1 text-[10px] text-muted-foreground' },
          view
            ? `保存后写回 ${view.workflow.metaFile}；勾中的字段会出现在画布节点的可调参数里。`
            : '',
        ),
    h(
      Button,
      {
        type: 'button',
        variant: 'secondary',
        size: 'sm',
        disabled: !view || busy !== '',
        'aria-label': '保存配置',
        onClick: () => void save(),
        className: 'h-7 gap-1 text-xs',
      },
      h(SaveIcon, { className: 'size-3.5' }),
      busy === 'save' && !dirty ? '保存中…' : '保存配置',
    ),
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        disabled: !view || busy !== '',
        'aria-label': '添加到画布',
        onClick: () => void save({ thenAdd: true }),
        className: 'h-7 gap-1 text-xs',
      },
      h(PlusIcon, { className: 'size-3.5' }),
      dirty ? '保存并添加到画布' : '直接添加到画布',
    ),
  );

  const panel = h(
    'div',
    {
      key: 'panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'ComfyUI 工作流配置',
      'data-fisherai-workflow-config-dialog': 'true',
      'data-fisherai-workflow-config-selected': selectedId ?? '',
      'data-fisherai-workflow-config-dirty': dirty ? 'true' : 'false',
      onPointerDown: (event: ReactTypes.PointerEvent) => event.stopPropagation(),
      onWheel: onPanelWheel,
      onContextMenu: (event: ReactTypes.MouseEvent) => event.preventDefault(),
      className:
        'flex h-[min(820px,90vh)] w-[min(1240px,95vw)] flex-col overflow-hidden rounded-xl border ' +
        'border-border bg-popover text-popover-foreground shadow-2xl',
    },
    h(
      'div',
      { className: 'flex items-center gap-2 border-b border-border px-3 py-2' },
      h(SlidersHorizontalIcon, { className: 'size-4 shrink-0 text-muted-foreground' }),
      h('span', { className: 'text-sm font-medium' }, 'ComfyUI 工作流配置'),
      h(
        'span',
        { className: 'min-w-0 flex-1 truncate text-[11px] text-muted-foreground' },
        list ? `${list.length} 个自定义工作流` : '',
      ),
      h(
        'button',
        {
          type: 'button',
          'aria-label': '关闭 ComfyUI 工作流配置',
          onClick: close,
          className: 'rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
        },
        h(XIcon, { className: 'size-4' }),
      ),
    ),
    body,
    footer,
  );

  const backdrop = h(
    'div',
    {
      key: 'backdrop',
      'data-fisherai-workflow-config-backdrop': 'true',
      onPointerDown: (event: ReactTypes.PointerEvent) => {
        if (event.target === event.currentTarget) close();
      },
      className: 'fixed inset-0 z-[11900] flex items-center justify-center bg-black/60 backdrop-blur-[2px]',
    },
    panel,
  );

  const root = h(react.Fragment, null, backdrop);
  const target = canvasPortalTarget();
  if (target) return createPortal(root, target) as ReactTypes.ReactNode;
  return root;
}

ComfyWorkflowConfig.displayName = 'ComfyWorkflowConfigShadcn';
