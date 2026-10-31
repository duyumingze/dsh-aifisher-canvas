/**
 * 画布应用装配（对应上游 src/stable/main.ts 里那一串 installXxx）。
 *
 * 上游 main.ts 有 47 个 installer，多数是连 AIFISHER 后端/账号/agent/drama 的。
 * 这里是「纯画布行为 + 刷新不丢 + 本机可跑」这一批：
 *
 *   —— 画布骨架（v0.6 起就在）——
 *     canvasNavigation        注入 will-change 合成策略 <style> + wheel 捕获守卫（install 时有真副作用）
 *     canvasSession           纯 sessionStorage：刷新后能回到同一个项目（关键）
 *     canvasAutoSave          自动保存（走我们 host 的本地后端）
 *     canvasClipboard/Connections/ContextActions/Editing/Groups/Layout/Selection
 *                             把画布编辑能力注册成全局（画布内部多数走 import 直调，这里是提前注册+去重）
 *     workflowPresetComposition
 *     canvasAppearance        不装则 --af-* 外观变量不落地，整页配色不对
 *     mediaNodeSizing / designSystem  顺手装（节点尺寸策略、toast/确认框样式）
 *
 *   —— UI 补全（v1.1）—— 这些上游是单独一行 install，被漏掉后画布上有东西真的不工作：
 *     videoPlayback           视频节点的音量记忆 / 离屏暂停 / 缓冲态（useCanvasVideoPlayback 读全局，没有就退化成裸 <video>）
 *     minimaxH3               MiniMax H3 节点的端口几何与模式（canvasNodeRules / 连线层读全局）
 *     minimaxPromptScroll     提示词框横向滚动条误出、滚动条过粗（纯 CSS 注入）
 *     generationScheduler     「生成中」状态与提示词装饰（canvasImagePreview / mediaComposer /
 *                             canvasTextComposer / CanvasTextNodeContent 都读全局；上游靠生成路径懒装，
 *                             这里显式装一遍，保证任何早于生成路径的读取也拿得到）
 *     promptExpand            提示词编辑器的「放大编辑」浮层按钮（DOM 注入 + 观察者）
 *     projectDashboardChrome  dashboard 的资源链接 / 项目封面预览 / 设置按钮（DOM 注入 + 观察者）
 *     nodeFramework / localProfile / mediaEditing / promptPresets /
 *     imageMode / videoMode / midjourneyReferences / imageResultHistory
 *                             上游在调用点懒装（`installXxx()` 直接写在组件里），这里显式装一遍：
 *                             保证任何早于组件的读取也能拿到，且与上游行为一致。
 *
 *   丢（本轮仍不装，代码都还在 vendor 里）：
 *     agent / drama / storyboard / 技能社区 / 反馈中心 / 账号中继 / 桌面更新 / 桌面重连提示
 *       —— 对应的 AIFISHER 后端（chat、drama、feedback、relay…）没有移植，装上只会 404。
 *          注意：官方画布头部那行「意见反馈 [未登录]」正是 feedbackCenter 挂的，反馈中心不装
 *          等于账号入口一起没了；v1.3 曾经用 installCanvasAccountCenter 单独把「登录」补回来，
 *          2026-10-16 又整体移除（它连的 identity 账号与用户的接口站账号是两套体系，见下）。
 *     workflowManager / workflowCanvasNodes / preferenceStore
 *       —— workflow-runtime 整块未移植；preferenceStore 需要账号级偏好后端，
 *          缺省时 preferenceStorage 会自动降级到 localStorage（够用，且不写坏数据）。
 *     agentModelAvailability
 *       —— 画布内 Agent 的模型可用性桥（读闭源渠道目录）；画布内 Agent 整块没移植。
 *       注意 **modelPicker 不在「丢」名单里**：候选模型由 canvasModelSelector 打开下拉时
 *       懒挂（`mountModelPicker`），分组/价格来自 host 的 `/generation/sources` 与
 *       `/generation/model-availability` —— 画布上那条「火山方舟」与 ≈¥0.3 的报价就是它显示的。
 *
 *   —— UI 补全（v1.2）—— 这三块 v1.1 做完了 host 侧却没装前端，纯漏装：
 *     mediaDownloadFileName   节点工具条「下载」读 `window.__FISHERAI_MEDIA_DOWNLOAD__`，
 *                             没有它就直接抛「素材不可用」（图片预览里那条懒装路径只管预览里的按钮）；
 *                             host 侧 /media-download/* 早就好了。
 *     promptAssistant         提示词助手 client（`window.__FISHERAI_PROMPT_ASSISTANT__`），
 *                             host 侧 /prompt-assistant/*（优化提示词 / 看图描述）已实现。
 *                             注意：**上游 2.0.7 里没有读这个全局的组件**，装上只是把能力摆到位
 *                             （与上游 main.ts 一致），入口要等 vendor 升到 2.0.30+ 才会出现。
 *     localRuntimeClient +    画布头部的「ComfyUI 待启动 / 运行中」状态胶囊（含日志浮层）。
 *     comfyLogPanel           它读的就是 host 的 /local-runtime/*（v1.1 已实现，只读、不托管进程），
 *                             配合 vendor 3.8c 三行补丁，胶囊按真实状态显示（详见补丁注释）。
 *     这一批都是 DOM/CSS 侧能力，装不上也不该拦住画布（循环里逐条 try/catch）。
 *
 *   —— v1.3（2026-10-16 已整体移除）——
 *     installCanvasAccountCenter   画布头部账号入口 + 登录·注册·找回·退出弹窗。
 *     移除原因：它走的是 host 的 /api/aifisher/account/*（identity.work-fisher.com，
 *     即官方客户端那套身份账号），而用户手上是 api.work-fisher.com（FisherAI 接口站）
 *     的账号 —— 两套体系，登不上只添乱；插件里也没有任何功能依赖它。
 *
 *   —— v1.44 ~ v1.48：点阵三层嵌套、宫格裁剪 nova、节点搜索「新建并移动」、拉线跟手 ——
 *     （都不在这里：前者在 canvasGrid.ts + CanvasEffectsStore，其余在 src/canvas-ui 与 vendor 补丁）
 *
 *   —— v1.49：切刀（Ctrl + 右键拖拽切开连线）——
 *     installCanvasKnife   手势 / 预览 / 命中在 src/client/canvas/knife.ts；
 *                          真正断开由 vendor 补丁 3.8t（canvasEdges 加身份属性 +
 *                          canvasApplication 里的 `__FISHERAI_CANVAS_KNIFE__.cut` 桥）落地。
 *
 * 另外注意：节点尺寸规则里有一处上游缺陷（`?.getNodeSize(node).width`），
 * 已在 vendor 阶段补上 `?.`（见 scripts/vendor-aifisher.mjs 的「修上游缺陷」段），
 * 所以这里不需要再塞 __FISHERAI_WORKFLOW_NODES__ 假适配器。
 */
import { installStableCanvasClipboard } from '../../../vendor/aifisher/src/stable/canvas/canvasClipboard';
import { installStableCanvasConnections } from '../../../vendor/aifisher/src/stable/canvas/canvasConnections';
import { installStableCanvasContextActions } from '../../../vendor/aifisher/src/stable/canvas/canvasContextActions';
import { installStableCanvasEditing } from '../../../vendor/aifisher/src/stable/canvas/canvasEditing';
import { installStableCanvasGroups } from '../../../vendor/aifisher/src/stable/canvas/canvasGroups';
import { installStableCanvasLayout } from '../../../vendor/aifisher/src/stable/canvas/canvasLayout';
import { installStableCanvasNavigation } from '../../../vendor/aifisher/src/stable/canvas/canvasNavigation';
import { installStableCanvasSelection } from '../../../vendor/aifisher/src/stable/canvas/canvasSelection';
import { installWorkflowPresetComposition } from '../../../vendor/aifisher/src/stable/canvas/workflowPresetComposition';
import { installCanvasAppearance } from '../../../vendor/aifisher/src/stable/appearance/canvasAppearance';
import { installMediaNodeSizing } from '../../../vendor/aifisher/src/stable/media/mediaNodeSizing';
import { installCanvasAutoSave } from '../../../vendor/aifisher/src/stable/persistence/canvasAutoSave';
import { installCanvasSession } from '../../../vendor/aifisher/src/stable/persistence/canvasSession';
import { installStableDesignSystem } from '../../../vendor/aifisher/src/stable/design/designSystem';
import { installNodeFramework } from '../../../vendor/aifisher/src/stable/nodes/nodeFramework';
// v1.81：画布换肤（方案 C 玻璃面板）配套的两个新模块 —— 界面缩放与生成中噪波点阵。
import { installCanvasUiScale } from './uiScale';
import { installCanvasGenerationDots } from './genDots';
import { installCompositorBridge } from './compositor/bridge';
// v1.87：拖入 .md / .txt 直接生成文本节点（Markdown 在本机翻成富文档）。
import { installCanvasTextFileDrop } from './textDrop';
import { installCanvasTextPreview } from './textPreview';
import { installImageModeAdapter } from '../../../vendor/aifisher/src/stable/generation/imageMode';
import { installVideoModeAdapter } from '../../../vendor/aifisher/src/stable/generation/videoMode';
import { installMidjourneyReferenceAdapter } from '../../../vendor/aifisher/src/stable/generation/midjourneyReferences';
import { installImageResultHistory } from '../../../vendor/aifisher/src/stable/generation/imageResultHistory';
import { installGenerationScheduler } from '../../../vendor/aifisher/src/stable/generation/generationScheduler';
import { installStableVideoPlayback } from '../../../vendor/aifisher/src/stable/media/videoPlayback';
import { installMediaEditing } from '../../../vendor/aifisher/src/stable/media/mediaEditing';
import { installMiniMaxH3CanvasAdapter } from '../../../vendor/aifisher/src/stable/media/minimaxH3';
import { installMiniMaxPromptScroll } from '../../../vendor/aifisher/src/stable/media/minimaxPromptScroll';
import { installLocalProfile } from '../../../vendor/aifisher/src/stable/profile/localProfile';
import { installPromptPresets } from '../../../vendor/aifisher/src/stable/prompt/promptPresets';
import { installPromptExpand } from '../../../vendor/aifisher/src/stable/prompt/promptExpand';
import { installPromptAssistant } from '../../../vendor/aifisher/src/stable/prompt/promptAssistant';
import { installProjectDashboardChrome } from '../../../vendor/aifisher/src/stable/navigation/projectDashboardChrome';
import { installMediaDownloadFileName } from '../../../vendor/aifisher/src/stable/media/mediaDownloadFileName';
import { mountMediaDownloadSettings } from '../../../vendor/aifisher/src/stable/media/mediaDownloadSettings';
import { mountLocalRuntimeSettings } from '../../../vendor/aifisher/src/stable/local/localRuntimeSettings';
import { mountSourceSettings } from '../../../vendor/aifisher/src/stable/generation/sourceSettings';
import { createSourceSettingsClient } from '../../../vendor/aifisher/src/stable/generation/sourceSettingsClient';
import { createLocalRuntimeClient } from '../../../vendor/aifisher/src/stable/local/localRuntimeClient';
import { mountLocalUpdateSettings } from '../../../vendor/aifisher/src/stable/update/localUpdateSettings';
import { readLocalUser } from '../../../vendor/aifisher/src/stable/profile/localUser';
import { preferenceStorage } from '../../../vendor/aifisher/src/stable/persistence/preferenceStore';
import { installLocalRuntimeClient } from '../../../vendor/aifisher/src/stable/local/localRuntimeClient';
import { installComfyLogPanel } from '../../../vendor/aifisher/src/stable/local/comfyLogPanel';
import type { AgentModelAvailabilityBridge } from '../../../vendor/aifisher/src/stable/generation/agentModelAvailability';
import { ensureLocalWorkflows } from '../../../vendor/aifisher/src/stable/media/videoWorkflows';
import { refreshChannelModelRegistry } from '../../canvas-ui/canvas/CloudChannelModels';
import { registerCloudChannelPanel } from '../../canvas-ui/canvas/CloudChannelPanel';
import { registerCanvasEffectsPanel } from '../../canvas-ui/canvas/CanvasEffectsPanel';
import { registerCanvasDataDirPanel } from '../../canvas-ui/canvas/CanvasDataDirPanel';
import {
  canvasEffects,
  canvasEffectsReport,
  setCanvasEffect,
  toggleCanvasEffect,
  type CanvasEffectKey,
} from '../../canvas-ui/canvas/CanvasEffectsStore';
import { rotateStackHost, stackReport, type StackNode } from '../../canvas-ui/canvas/CanvasStack';
import { installVideoResultHistory } from '../../canvas-ui/canvas/CanvasVideoHistory';
import { installVideoFrameCapture } from '../../canvas-ui/canvas/CanvasVideoFrames';
import { installFrameLayout } from '../../canvas-ui/canvas/CanvasFrameLayout';
import {
  canvasLastModelReport,
  pickCanvasModel,
  rememberLastModel,
  resetCanvasLastModel,
} from '../../canvas-ui/canvas/CanvasLastModel';
import {
  assertOutpaintSource,
  buildOutpaintPlan,
  defaultOutpaintRatio,
  OUTPAINT_MAX_SIDE,
  outpaintGeometry,
  outpaintModelName,
  outpaintRatios,
  outpaintReport,
  outpaintSourceSize,
  resolveOutpaintModel,
  type OutpaintGeometry,
  type OutpaintOptions,
  type OutpaintPlan,
  type OutpaintSource,
} from '../../canvas-ui/canvas/CanvasOutpaint';
import {
  importProjectArchiveViaPicker,
  projectArchiveReport,
  type ProjectArchiveRestoreReceipt,
} from '../../canvas-ui/canvas/CanvasProjectArchive';
import { installCanvasKnife } from './knife';

interface Installer {
  name: string;
  install: () => unknown;
}

/**
 * ComfyUI 状态胶囊要 client 实例；`installLocalRuntimeClient` 只是把 client 挂到全局
 * （同一个契约，装几次都一样），这里优先复用已挂上去的那份。
 */
function installComfyUiStatusPanel(): { dispose: () => void } {
  const client = window.__FISHERAI_LOCAL_RUNTIME__ ?? installLocalRuntimeClient();
  return { dispose: installComfyLogPanel(client) };
}

/**
 * 画布右侧对话面板的**模型清单**（v1.9）。
 *
 * 上游面板的模型下拉不是自己拉列表，而是读 `window.__FISHERAI_AGENT_MODEL_AVAILABILITY__`
 * 这个桥（`installAgentModelAvailability` 惰装，**已经有了就直接用现成的**）：
 * 候选 = 桥的 `filter(内置 TEXT_MODELS 目录)`。上游那个桥把「闭源服务里配置过的文本模型」
 * 与目录求交集 —— DSH 版没有那套闭源服务账号，交集必然是空的，于是面板会「一个模型都选不到、
 * 发送按钮永远禁用」。
 *
 * 所以这里**先一步**把桥装上，内容换成 DSH 自己的模型目录（host 的 /chat/models）：
 * 选中的 id 形状 `provider/model`，host 收到后对这条画布对话的 DSH 会话调 selectModel。
 * 这既让下拉里是真的能用的模型，也让「切换模型」真的生效，而不是摆设。
 */
function installDshAgentModelBridge(): { dispose: () => void } {
  const holder = window as unknown as {
    __FISHERAI_AGENT_MODEL_AVAILABILITY__?: AgentModelAvailabilityBridge;
  };
  // 已经有一份就别覆盖：宁可让上游那份工作（真配过闭源服务时它是对的），也不要打架
  if (holder.__FISHERAI_AGENT_MODEL_AVAILABILITY__) return { dispose: () => undefined };

  type PanelModel = {
    id: string;
    label: string;
    vision: 'supported' | 'unsupported' | 'unknown';
    advancedParams: never[];
  };
  let models: PanelModel[] = [];
  let state: 'loading' | 'ready' | 'error' = 'loading';
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[aifisher-canvas] 模型清单订阅者出错', error);
      }
    }
  };
  const bridge: AgentModelAvailabilityBridge = {
    // 面板拿这个当「可选模型」的最终清单，所以直接返回我们这份（忽略它传进来的目录）
    filter: ((candidates: unknown) =>
      (models as unknown[]).length ? (models as unknown[]) : candidates) as AgentModelAvailabilityBridge['filter'],
    emptyLabel: () =>
      state === 'loading' ? '正在读取模型…' : state === 'error' ? '读取失败，点击重试' : '没有可用模型',
    openConnection() {
      void bridge.refresh().catch(() => undefined);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      state = 'loading';
      try {
        const response = await fetch('/api/aifisher/canvas/chat/models', { cache: 'no-store' });
        const body = (await response.json().catch(() => null)) as
          | { models?: Array<{ id?: unknown; label?: unknown }>; error?: string }
          | null;
        if (!response.ok) throw new Error(body?.error || `模型清单读取失败（${response.status}）`);
        models = (Array.isArray(body?.models) ? body.models : [])
          .filter((item) => item && typeof item.id === 'string' && item.id)
          .map((item) => ({
            id: String(item.id),
            label: typeof item.label === 'string' && item.label ? item.label : String(item.id),
            // DSH 目录不告诉我们某个模型是否吃图片参考，如实报 unknown（面板会显示一句提示）
            vision: 'unknown' as const,
            advancedParams: [] as never[],
          }));
        state = models.length ? 'ready' : 'error';
      } catch (error) {
        models = [];
        state = 'error';
        console.error('[aifisher-canvas] 读取 DSH 模型清单失败', error);
      } finally {
        emit();
      }
    },
  };
  holder.__FISHERAI_AGENT_MODEL_AVAILABILITY__ = bridge;
  void bridge.refresh().catch(() => undefined);
  return {
    dispose() {
      if (holder.__FISHERAI_AGENT_MODEL_AVAILABILITY__ === bridge) {
        delete holder.__FISHERAI_AGENT_MODEL_AVAILABILITY__;
      }
    },
  };
}

/**
 * 自配 OpenAI 通道（v1.11，2026-10-16 用户原话「OpenAI通道我希望可以配置好几个，
 * 并且可以选择多条单独模型」）。
 *
 * 两件事：
 *   ① **模型注册表**：拉一次 `/cloud-channels`，把用户勾选的模型**原地追加**进 vendor 的四个目录数组
 *      （见 src/canvas-ui/canvas/CloudChannelModels.ts），并装好画布下拉白名单要读的全局名字集合。
 *      必须在画布组件读目录之前发起 —— 这里是异步的，靠「注入对象每渲染重建 + 打开下拉时重算候选」
 *      兜住时序：晚到的模型在用户下一次打开模型下拉时就出现了（不必刷新页面）。
 *   ② **设置面板挂载点**：注册 `__FISHERAI_MOUNT_CLOUD_CHANNELS__`，vendor 补丁 3.8h 在
 *      「设置 → 闭源服务」页挂好后调它，把多通道管理面板塞进那一页。
 */
function installCloudChannelSupport(): { dispose: () => void } {
  void refreshChannelModelRegistry().catch(() => undefined);
  return { dispose: registerCloudChannelPanel() };
}

/**
 * 画布互动效果开关（v1.27，2026-10-17 用户原话「现在画布与鼠标没有互动效果，在设置里做一个开关」）。
 *
 * 两件事：
 *   ① 把设置页「画布外观」里的开关面板挂载点注册成全局
 *      `__FISHERAI_MOUNT_CANVAS_EFFECTS__`，vendor 补丁（scripts/vendor-aifisher.mjs 的
 *      CANVAS_EFFECTS_PANEL_PATCHES）在那一页挂好后调它。
 *   ② 注册排查/脚本用的 `__FISHERAI_CANVAS_EFFECTS__`（get/set/toggle/report）——
 *      真机上「开关点了没反应」时可以先读 report，browser-check 也靠它验「关掉之后不再画」。
 *
 * 设置本体与网格层的联动都不在这里：store 在 src/canvas-ui/canvas/CanvasEffectsStore.ts，
 * 网格层（src/client/canvas/canvasGrid.ts）自己订阅它 —— 谁先挂都能同步。
 */
interface CanvasEffectsHolder {
  __FISHERAI_CANVAS_EFFECTS__?: {
    get(): ReturnType<typeof canvasEffects>;
    set(key: CanvasEffectKey, value: boolean): void;
    toggle(key: CanvasEffectKey): boolean;
    report(): ReturnType<typeof canvasEffectsReport>;
  };
}

function installCanvasEffectsSupport(): { dispose: () => void } {
  const disposePanel = registerCanvasEffectsPanel();
  const holder = globalThis as unknown as CanvasEffectsHolder;
  holder.__FISHERAI_CANVAS_EFFECTS__ = {
    get: () => canvasEffects(),
    set: (key, value) => setCanvasEffect(key, value),
    toggle: (key) => toggleCanvasEffect(key),
    report: () => canvasEffectsReport(),
  };
  return {
    dispose() {
      disposePanel();
      delete holder.__FISHERAI_CANVAS_EFFECTS__;
    },
  };
}

/**
 * 「项目数据目录」设置面板的挂载点（v1.43，用户原话「设置里添加项目自定义缓存目录」）。
 *
 * 面板与数据面都在 `src/canvas-ui/canvas/CanvasDataDir*.ts`；vendor 补丁（3.8s）在
 * 「设置 → 存储」分区挂好宿主 div 之后调 `__FISHERAI_MOUNT_DATA_DIR__(host)`。
 * 这里只负责注册那个全局 + 一个排查入口（`__FISHERAI_CANVAS_DATA_DIR__`）。
 *
 * 真正改目录的是 host（写指针，重启生效）—— 前端不碰文件系统。
 */
function installCanvasDataDirSupport(): { dispose: () => void } {
  return { dispose: registerCanvasDataDirPanel() };
}

/**
 * 旧版设置对话框里那几块面板的**页内挂载点**（v1.85）。
 *
 * 背景：用户 2026-10-31「移除设置里的旧版设置」——vendor 那个「设置」对话框
 * （个人设置 / 画布外观 / 开源服务 / 闭源服务 / 存储 / 关于）从界面上去掉，
 * 但里面这几块面板只存在于那个对话框里，直接删掉会让配置没地方改。
 * 所以把 vendor 自己的 mount 函数借过来，改成由页面层设置页给宿主 div：
 *
 *   `__FISHERAI_MOUNT_SOURCE_SETTINGS__`        闭源服务（AIFISHER API / RH / 直连 / 即梦）
 *   `__FISHERAI_MOUNT_LOCAL_RUNTIME_SETTINGS__` 开源服务（本机 ComfyUI：目录 / 启动 / 扩展 / 日志）
 *   `__FISHERAI_MOUNT_DOWNLOAD_SETTINGS__`      下载目录与「每次询问保存位置」
 *   `__FISHERAI_MOUNT_UPDATE_SETTINGS__`        关于 / 检查更新
 *
 * 这几块都是**原生 DOM** mount（不是 vendor React 组件），所以塞进我们自己的页面不会
 * 踩两份 React 的 #130；样式沿用 vendor 的类与 --af-* 令牌，放在页面的 .afs-host 里。
 * 云通道面板（CloudChannelPanel）本来就走全局挂载点，不需要这里再包一层。
 */
interface SettingsMountHolder {
  __FISHERAI_MOUNT_SOURCE_SETTINGS__?: (host: HTMLElement) => (() => void) | null;
  __FISHERAI_MOUNT_LOCAL_RUNTIME_SETTINGS__?: (host: HTMLElement) => (() => void) | null;
  __FISHERAI_MOUNT_DOWNLOAD_SETTINGS__?: (host: HTMLElement) => (() => void) | null;
  __FISHERAI_MOUNT_UPDATE_SETTINGS__?: (host: HTMLElement) => (() => void) | null;
}

/** 挂不上的面板返回 null（页面显示「不可用」），不让它把整页设置带崩。 */
function guardedMount(name: string, mount: (host: HTMLElement) => (() => void) | void) {
  return (host: HTMLElement): (() => void) | null => {
    try {
      const dispose = mount(host);
      return typeof dispose === 'function' ? dispose : null;
    } catch (error) {
      console.error(`[aifisher-canvas] 挂载设置面板失败：${name}`, error);
      return null;
    }
  };
}

function installCanvasSettingsHosts(): { dispose: () => void } {
  const holder = globalThis as unknown as SettingsMountHolder;
  holder.__FISHERAI_MOUNT_SOURCE_SETTINGS__ = guardedMount('闭源服务', (host) =>
    mountSourceSettings(host, createSourceSettingsClient()),
  );
  holder.__FISHERAI_MOUNT_LOCAL_RUNTIME_SETTINGS__ = guardedMount('开源服务', (host) =>
    mountLocalRuntimeSettings(
      host,
      window.__FISHERAI_LOCAL_RUNTIME__ ?? createLocalRuntimeClient(),
    ),
  );
  holder.__FISHERAI_MOUNT_DOWNLOAD_SETTINGS__ = guardedMount('下载目录', (host) =>
    mountMediaDownloadSettings(host, installMediaDownloadFileName()),
  );
  holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__ = guardedMount('关于/更新', (host) =>
    mountLocalUpdateSettings(host),
  );
  return {
    dispose() {
      delete holder.__FISHERAI_MOUNT_SOURCE_SETTINGS__;
      delete holder.__FISHERAI_MOUNT_LOCAL_RUNTIME_SETTINGS__;
      delete holder.__FISHERAI_MOUNT_DOWNLOAD_SETTINGS__;
      delete holder.__FISHERAI_MOUNT_UPDATE_SETTINGS__;
    },
  };
}

/**
 * 「个人资料」的读写桥（v1.85，随旧设置对话框一起搬进设置页）。
 *
 * 昵称与头像都是 vendor 的本地偏好：头像走 `__FISHERAI_LOCAL_PROFILE__`（装配层已装），
 * 昵称在偏好存储的 `fisherai-collab-user` 里。这里只暴露读/写，存储键与 vendor 的
 * `useLocalUser` 保持一致（vendor 没导出这个常量，所以这里抄了一份，见 localUser.ts）。
 *
 * 注意：vendor 的 useLocalUser 是**组件内的 useState**，不会订阅存储 —— 改完昵称要等
 * 下次画布挂载才在协作头像上用新名字（设置页会照实写这句提示，不假装即时生效）。
 */
const LOCAL_USER_KEY = 'fisherai-collab-user';

interface LocalUserBridge {
  __FISHERAI_LOCAL_USER__?: {
    get(): { id: string; no: string; name: string };
    setName(value: string): { id: string; no: string; name: string };
  };
}

function installLocalUserBridge(): { dispose: () => void } {
  const holder = window as unknown as LocalUserBridge;
  const bridge: NonNullable<LocalUserBridge['__FISHERAI_LOCAL_USER__']> = {
    get: () => readLocalUser(),
    setName(value: string) {
      const name = String(value ?? '').slice(0, 64);
      const next = { ...readLocalUser(), name };
      try {
        preferenceStorage().setItem(LOCAL_USER_KEY, JSON.stringify(next));
      } catch (error) {
        console.error('[aifisher-canvas] 保存昵称失败', error);
      }
      return next;
    },
  };
  holder.__FISHERAI_LOCAL_USER__ = bridge;
  return {
    dispose() {
      if (holder.__FISHERAI_LOCAL_USER__ === bridge) delete holder.__FISHERAI_LOCAL_USER__;
    },
  };
}

/**
 * 叠图「切换」（v1.37，用户原话「给这种折叠起来的图添加一个切换按钮」）。
 *
 * 算法在 `src/canvas-ui/canvas/CanvasStack.ts`（纯函数），这里只把它注册成全局，
 * 因为**真正够得着画布 nodes 的只有 vendor 的 canvasApplication**（补丁 3.8o 里那个
 * `__FISHERAI_CANVAS_STACK__.rotate` 会在点击时读这个全局）。两份 React / 两个模块实例
 * 之间只能靠 window 上的桥，所以这里用 `window` 而不是 `globalThis`（jsdom 里两者不同体，
 * 桥的读写必须落在同一个对象上，否则回归里点按钮会「静默无效」）。
 */
interface CanvasStackHolder {
  __FISHERAI_STACK_ROTATE__?: (node: StackNode, step?: number) => StackNode;
  __FISHERAI_STACK_REPORT__?: (node: StackNode) => Record<string, unknown>;
}

function installCanvasStackSupport(): { dispose: () => void } {
  const holder = window as unknown as CanvasStackHolder;
  const rotate = (node: StackNode, step?: number) => rotateStackHost(node, step ?? 1);
  holder.__FISHERAI_STACK_ROTATE__ = rotate;
  holder.__FISHERAI_STACK_REPORT__ = (node: StackNode) => stackReport(node);
  return {
    dispose() {
      if (holder.__FISHERAI_STACK_ROTATE__ === rotate) delete holder.__FISHERAI_STACK_ROTATE__;
      delete holder.__FISHERAI_STACK_REPORT__;
    },
  };
}

/**
 * 「扩图」（v1.38 引入，v1.39 改成「先出一张扩图画面，再接图像生成节点」）。
 *
 * 用户原话（v1.39，附参考图：「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」）。
 *
 * 三条分工（改它之前先读一遍）：
 *   ① **算法**在 `src/canvas-ui/canvas/CanvasOutpaint.ts`（纯函数：九宫格落点 / 画布几何 /
 *      提示词 / 模型选择 / 两张节点的字段）。回归直接验那一份；
 *   ② 这里负责**画像素**：`prepare()` 把原图真的画进一张更大的画布（透明 = 待补的新画面），
 *      导出 PNG dataURL，再算出两张节点的字段；
 *   ③ vendor 补丁 3.8p 的 `__FISHERAI_CANVAS_OUTPAINT__.create()` 调 `prepare()`，
 *      把 dataURL 交给 host 的「dataURL 落盘」接口存进素材库，然后建两张节点
 *      （只有 canvasApplication 够得着 setNodes）。
 *
 * 顺带注册 `__FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__` —— 「角度 / 全景图」那两个草稿
 * 以前写死在 `imageAngleDraft.imageToolModel`（上游目录里的 Relay 低价版），
 * 现在也改成跟用户自己的通道走（同一个选择口径，不再各写一份）。
 *
 * ⚠️ 模型必须**调用时**再解析（不能在这里算一次存下来）：通道注册表是异步拉的
 *    （`refreshChannelModelRegistry`），画布挂载那一刻可能还是空的。
 */
interface ImageToolModelSummary {
  name: string;
  ratios: string[];
  defaultRatio: string;
  channelModel: boolean;
}

/** `preview()` 的返回：几何 + 「这两个数是不是原图真实像素」（面板据此决定写不写像素数）。 */
export interface OutpaintPreview extends OutpaintGeometry {
  exact: boolean;
}

/** `prepare()` 的返回：画好的扩图画面（dataURL）+ 几何 + 两张节点的字段。 */
export interface OutpaintPrepared {
  dataUrl: string;
  geometry: OutpaintGeometry;
  plan: OutpaintPlan;
}

interface OutpaintHolder {
  __FISHERAI_OUTPAINT__?: {
    model(): ImageToolModelSummary | null;
    preview(source: OutpaintSource, options?: OutpaintOptions): OutpaintPreview;
    prepare(source: OutpaintSource, options?: OutpaintOptions): Promise<OutpaintPrepared>;
    report(): Record<string, unknown>;
  };
  __FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__?: () => ImageToolModelSummary | null;
}

/** 画布读图最多等多久（真机上素材库是本地回环，秒开；超时就走缩略图兜底）。 */
const OUTPAINT_IMAGE_TIMEOUT_MS = 9000;

/**
 * 载入一张图。浏览器直接解码（同源素材库最省事），失败/跨域就换 host 的缩略图接口：
 * 那条是**同源**的（`/api/aifisher/canvas/media/thumbnail`），远程直链也能读
 * （见 v1.32 的 `parseMediaUrlRef`：带 `?t=` 缓存戳的素材 URL 一样认）。
 */
function loadOutpaintImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const ImageConstructor = (window as unknown as { Image?: typeof Image }).Image;
    if (typeof ImageConstructor !== 'function') return resolve(null);
    let settled = false;
    const finish = (value: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let image: HTMLImageElement;
    try {
      image = new ImageConstructor();
    } catch {
      return resolve(null);
    }
    image.crossOrigin = 'anonymous';
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    try {
      image.src = url;
    } catch {
      finish(null);
    }
    // jsdom / 断网时 onload/onerror 都不来，别让面板永远「正在生成…」。
    window.setTimeout?.(() => finish(null), OUTPAINT_IMAGE_TIMEOUT_MS);
  });
}

function outpaintThumbnailUrl(url: string): string {
  return `/api/aifisher/canvas/media/thumbnail?url=${encodeURIComponent(url)}&max=${OUTPAINT_MAX_SIDE}`;
}

/**
 * 把原图画进「扩图画面」。
 *
 * 为什么留白是**透明**而不是灰块：参考图里那块斜纹就是透明（画布/预览的棋盘格），
 * 而且图生图端点收到的是「原图 + 待补区域」，透明区不会被当成画面内容（灰块会被当成天空）。
 * 原图一个像素都不重采样（除非整体超过 4096，那时画布与图一起等比缩）。
 */
async function composeOutpaintImage(
  sourceUrl: unknown,
  ratio: string,
  anchor: string | undefined,
): Promise<{ dataUrl: string; geometry: OutpaintGeometry }> {
  const url = typeof sourceUrl === 'string' ? sourceUrl : '';
  if (!url) throw new Error('这张图片还没有结果，先等它生成完成。');
  const image = (await loadOutpaintImage(url)) ?? (await loadOutpaintImage(outpaintThumbnailUrl(url)));
  if (!image) {
    throw new Error(
      '读不到这张图片的像素（可能不在素材库、或直链跨域被拦）。先把图片下载到素材库再扩图。',
    );
  }
  const naturalWidth = Number(image.naturalWidth) || Number(image.width) || 0;
  const naturalHeight = Number(image.naturalHeight) || Number(image.height) || 0;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error('读不到这张图片的尺寸，无法生成扩图画面。');
  const geometry = outpaintGeometry({
    width: naturalWidth,
    height: naturalHeight,
    ratio,
    anchor,
  });
  const canvas = document.createElement('canvas');
  canvas.width = geometry.width;
  canvas.height = geometry.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持 2D 画布，无法生成扩图画面。');
  context.clearRect(0, 0, geometry.width, geometry.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, geometry.offsetX, geometry.offsetY, geometry.imageWidth, geometry.imageHeight);
  const dataUrl = canvas.toDataURL('image/png');
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('扩图画面导出失败（画布没有给出 PNG）。');
  }
  return { dataUrl, geometry };
}

function summarizeImageToolModel(): ImageToolModelSummary | null {
  const model = resolveOutpaintModel();
  const name = outpaintModelName(model);
  if (!name) return null;
  return {
    name,
    ratios: outpaintRatios(model),
    defaultRatio: defaultOutpaintRatio(model),
    channelModel: typeof model?.cloudChannelId === 'string',
  };
}

/** 这次扩图用哪个比例：用户选的在模型支持表里就用，否则退回默认（16:9 优先）。 */
function resolveOutpaintRatio(options?: OutpaintOptions): string {
  const model = resolveOutpaintModel();
  const ratios = outpaintRatios(model);
  const wanted = String(options?.ratio ?? '');
  return wanted && ratios.includes(wanted) ? wanted : defaultOutpaintRatio(model);
}

function installCanvasOutpaintSupport(): { dispose: () => void } {
  const holder = window as unknown as OutpaintHolder;
  const bridge = {
    model: summarizeImageToolModel,
    preview(source: OutpaintSource, options?: OutpaintOptions): OutpaintPreview {
      const size = outpaintSourceSize(source);
      const geometry = outpaintGeometry({
        width: size.width,
        height: size.height,
        ratio: resolveOutpaintRatio(options),
        anchor: options?.anchor,
      });
      return { ...geometry, exact: size.exact };
    },
    async prepare(source: OutpaintSource, options?: OutpaintOptions): Promise<OutpaintPrepared> {
      assertOutpaintSource(source);
      const model = resolveOutpaintModel();
      if (!outpaintModelName(model)) {
        throw new Error('没有可用的图像模型：请先在「设置 → 闭源服务」里配一条通道并勾选图像模型。');
      }
      const ratio = resolveOutpaintRatio(options);
      const composed = await composeOutpaintImage(source.resultUrl, ratio, options?.anchor);
      const plan = buildOutpaintPlan(source, { ...(options ?? {}), ratio }, composed.geometry);
      return { dataUrl: composed.dataUrl, geometry: composed.geometry, plan };
    },
    report: outpaintReport,
  };
  holder.__FISHERAI_OUTPAINT__ = bridge;
  holder.__FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__ = summarizeImageToolModel;
  return {
    dispose() {
      if (holder.__FISHERAI_OUTPAINT__ === bridge) delete holder.__FISHERAI_OUTPAINT__;
      delete holder.__FISHERAI_RESOLVE_IMAGE_TOOL_MODEL__;
    },
  };
}

/**
 * 「新建节点默认用上一次的模型」（v1.40，用户原话「我刚建完一个节点后需要我再次调整模型，
 * 可不可以改成新的节点会默认使用上一次生成任务所使用的模型」）。
 *
 * 记忆与算法在 `src/canvas-ui/canvas/CanvasLastModel.ts`（纯逻辑，回归直接验那一份）。
 * 这里只把它注册成 vendor 能读到的两个回调 —— 建节点（createCanvasNode）、换模型
 * （updateCanvasNode）、发起生成（handleGenerate）三处都在 **vendor 半**，与 src/canvas-ui
 * 是两个模块实例，只能靠 window 上的桥（与 `__FISHERAI_STACK_ROTATE__` 同一套做法）：
 *
 *   __FISHERAI_LAST_MODEL__(kind, names)  建节点时问「上次这个 kind 用的哪个模型」，
 *                                         只返回**还留在目录里**的名字，否则空串；
 *   __FISHERAI_REMEMBER_MODEL__(kind, name)  换模型 / 发起生成时记账。
 *
 * 另外挂 `__FISHERAI_CANVAS_LAST_MODEL__`（report/pick/remember/reset 四件），
 * 给回归与真机检查用：真机上「记忆里到底是什么、为什么没生效」靠它一眼看清。
 *
 * ⚠️ 必须同时写 `window` 与 `globalThis`：浏览器里两者是同一个对象，jsdom 里不是；
 *    而 vendor 补丁读的是 globalThis、回归脚本读的是 window（踩过，见 CanvasStack 那条注释）。
 */
interface CanvasLastModelHolder {
  __FISHERAI_LAST_MODEL__?: (kind: string, names: string[]) => string;
  __FISHERAI_REMEMBER_MODEL__?: (kind: string, name: string) => void;
  __FISHERAI_CANVAS_LAST_MODEL__?: {
    report(): ReturnType<typeof canvasLastModelReport>;
    pick(kind: string, names: string[]): string;
    remember(kind: string, name: string): string;
    reset(): void;
  };
}

function installCanvasLastModelSupport(): { dispose: () => void } {
  const pick = (kind: string, names: string[]) =>
    pickCanvasModel(kind, Array.isArray(names) ? names.map((name) => String(name)) : []);
  const remember = (kind: string, name: string) => rememberLastModel(kind, name);
  const diagnostics = {
    report: canvasLastModelReport,
    pick,
    remember,
    reset: resetCanvasLastModel,
  };
  const holders = [
    window as unknown as CanvasLastModelHolder,
    globalThis as unknown as CanvasLastModelHolder,
  ].filter((holder, index, all) => all.indexOf(holder) === index);
  for (const holder of holders) {
    holder.__FISHERAI_LAST_MODEL__ = pick;
    holder.__FISHERAI_REMEMBER_MODEL__ = remember;
    holder.__FISHERAI_CANVAS_LAST_MODEL__ = diagnostics;
  }
  return {
    dispose() {
      for (const holder of holders) {
        if (holder.__FISHERAI_LAST_MODEL__ === pick) delete holder.__FISHERAI_LAST_MODEL__;
        if (holder.__FISHERAI_REMEMBER_MODEL__ === remember) delete holder.__FISHERAI_REMEMBER_MODEL__;
        if (holder.__FISHERAI_CANVAS_LAST_MODEL__ === diagnostics) {
          delete holder.__FISHERAI_CANVAS_LAST_MODEL__;
        }
      }
    },
  };
}

/**
 * 「项目归档」（导出 / 导入）的全局桥（v1.42）。
 *
 * 用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。
 *
 * 面板与数据面都在 `src/canvas-ui/canvas/CanvasProjectArchive*`；但**项目看板头部那个
 * 「导入项目」按钮**是 vendor 半（`navigation/projectDashboardChrome.ts` 用 DOM 注入，
 * 见 vendor 补丁 3.8r）—— 那里拿不到 src/canvas-ui 的模块，只能靠 window 桥：
 *
 *   __FISHERAI_PROJECT_ARCHIVE__.importFromPicker()  选文件 → restore → 打开新项目 → toast
 *   __FISHERAI_PROJECT_ARCHIVE__.report()            排查读数（info/saves/imports/lastError）
 *
 * 另外挂 `fisherai:project-import` 事件：以后再有别的入口要「导入一份备份」，
 * 派发事件就行，不必知道桥叫什么名字。
 *
 * ⚠️ 必须同时写 `window` 与 `globalThis`（jsdom 里不是同一个对象；见 CanvasStack 那段）。
 */
interface ProjectArchiveHolder {
  __FISHERAI_PROJECT_ARCHIVE__?: {
    importFromPicker(options?: { open?: boolean }): void;
    report(): Record<string, unknown>;
  };
}

function installProjectArchiveSupport(): { dispose: () => void } {
  const bridge: NonNullable<ProjectArchiveHolder['__FISHERAI_PROJECT_ARCHIVE__']> = {
    importFromPicker: (options?: { open?: boolean }) =>
      importProjectArchiveViaPicker({
        ...(options ?? {}),
        onDone: (receipt: ProjectArchiveRestoreReceipt) => {
          // 看板视图里没有面板可放提示条：toast 由 CanvasProjectArchive 自己弹
          void receipt;
        },
      }),
    report: projectArchiveReport,
  };
  const holders = [
    window as unknown as ProjectArchiveHolder,
    globalThis as unknown as ProjectArchiveHolder,
  ].filter((holder, index, all) => all.indexOf(holder) === index);
  for (const holder of holders) holder.__FISHERAI_PROJECT_ARCHIVE__ = bridge;
  const onImportRequest = () => bridge.importFromPicker();
  window.addEventListener('fisherai:project-import', onImportRequest);
  return {
    dispose() {
      window.removeEventListener('fisherai:project-import', onImportRequest);
      for (const holder of holders) {
        if (holder.__FISHERAI_PROJECT_ARCHIVE__ === bridge) delete holder.__FISHERAI_PROJECT_ARCHIVE__;
      }
    },
  };
}

/**
 * v1.64：视频生成历史。
 *
 * 图片节点天生就留着一串历史结果（`resultUrls` + 头部「历史 N」），视频节点以前每生成一次
 * 就把上一条覆盖掉。算法在 `src/canvas-ui/canvas/CanvasVideoHistory.ts`，这里只把那套纯函数
 * 挂成全局桥 —— vendor 侧（`canvasGeneration.ts` / `generationRecovery.ts` /
 * `canvasVideoPlayer.tsx`）是构建期从上游整树复制的，不能 import 插件实现，只能走桥。
 */
function installCanvasVideoHistorySupport(): { dispose: () => void } {
  return installVideoResultHistory();
}

/**
 * v1.66：视频截帧（首帧 / 尾帧 / 两张）+ 截帧结果落位。
 *
 * 取帧算法在 `src/canvas-ui/canvas/CanvasVideoFrames.ts`（尾帧兜底、尺寸上限、单帧），
 * 落位在 `CanvasFrameLayout.ts`（贴视频右侧、避让已有节点）。vendor 侧只认这两个桥：
 *   · `__FISHERAI_VIDEO_FRAMES__`  —— 播放器菜单点下去时取帧；
 *   · `__FISHERAI_FRAME_LAYOUT__`  —— `canvasMediaOperations.snapshot()` 问新节点该放哪儿。
 * 桥不在时两处都退回上游行为（一次性首尾帧 / 固定 +400），不影响老路径。
 */
function installCanvasVideoFrameSupport(): { dispose: () => void } {
  const frames = installVideoFrameCapture();
  const layout = installFrameLayout();
  return {
    dispose() {
      layout.dispose();
      frames.dispose();
    },
  };
}

/**
 * v1.70：调色节点（Color Grade）→ 全屏合成器。
 * 编辑器/引擎在 src/client/canvas/compositor/；vendor 节点卡只认 window.__FISHERAI_COMPOSITOR__，
 * 写回走节点自己的 onUpdate（resultUrl + compositorGraph），不需要新协议。
 */
function installCanvasCompositorSupport(): { dispose: () => void } {
  return installCompositorBridge();
}

/** 顺序按上游 main.ts 的先后关系保留（外观/会话要早于画布组件读取它们）。 */
const INSTALLERS: Installer[] = [
  { name: 'installStableCanvasNavigation', install: installStableCanvasNavigation },
  { name: 'installStableCanvasClipboard', install: installStableCanvasClipboard },
  { name: 'installStableCanvasConnections', install: installStableCanvasConnections },
  { name: 'installStableCanvasContextActions', install: installStableCanvasContextActions },
  { name: 'installStableCanvasEditing', install: installStableCanvasEditing },
  { name: 'installStableCanvasGroups', install: installStableCanvasGroups },
  { name: 'installStableCanvasLayout', install: installStableCanvasLayout },
  { name: 'installStableCanvasSelection', install: installStableCanvasSelection },
  { name: 'installWorkflowPresetComposition', install: installWorkflowPresetComposition },
  { name: 'installCanvasAppearance', install: installCanvasAppearance },
  { name: 'installCanvasSession', install: installCanvasSession },
  { name: 'installCanvasAutoSave', install: installCanvasAutoSave },
  { name: 'installMediaNodeSizing', install: installMediaNodeSizing },
  { name: 'installStableDesignSystem', install: () => installStableDesignSystem().observe() },
  // ---- v1.81：界面缩放（chrome 整体 80–150%）与生成中噪波圆点阵（方案 C 皮肤配套）----
  { name: 'installCanvasUiScale', install: installCanvasUiScale },
  { name: 'installCanvasGenerationDots', install: installCanvasGenerationDots },
  // ---- UI 补全（v1.1）：上游 main.ts 里单独一行的那些 ----
  { name: 'installProjectDashboardChrome', install: installProjectDashboardChrome },
  { name: 'installNodeFramework', install: installNodeFramework },
  { name: 'installImageModeAdapter', install: installImageModeAdapter },
  { name: 'installVideoModeAdapter', install: installVideoModeAdapter },
  { name: 'installMidjourneyReferenceAdapter', install: installMidjourneyReferenceAdapter },
  { name: 'installImageResultHistory', install: installImageResultHistory },
  // ---- v1.64：视频生成历史（合并 / 「设为主视频」换位 / 头部「历史 N」文案）----
  //     纯函数在 src/canvas-ui/canvas/CanvasVideoHistory.ts，这里只挂桥
  { name: 'installVideoResultHistory', install: installCanvasVideoHistorySupport },
  // ---- v1.66：视频截帧（首帧 / 尾帧 / 两张）与截帧落位 ----
  //     取帧在 CanvasVideoFrames.ts、落位在 CanvasFrameLayout.ts，这里挂两个桥
  { name: 'installVideoFrameCapture', install: installCanvasVideoFrameSupport },
  { name: 'installGenerationScheduler', install: installGenerationScheduler },
  { name: 'installStableVideoPlayback', install: installStableVideoPlayback },
  { name: 'installMediaEditing', install: installMediaEditing },
  { name: 'installMiniMaxH3CanvasAdapter', install: installMiniMaxH3CanvasAdapter },
  { name: 'installMiniMaxPromptScroll', install: installMiniMaxPromptScroll },
  { name: 'installPromptPresets', install: installPromptPresets },
  { name: 'installPromptExpand', install: installPromptExpand },
  { name: 'installLocalProfile', install: installLocalProfile },
  // ---- UI 补全（v1.2）：host 侧早已就绪、前端漏装的那几块 ----
  { name: 'installMediaDownloadFileName', install: installMediaDownloadFileName },
  { name: 'installPromptAssistant', install: installPromptAssistant },
  { name: 'installLocalRuntimeClient', install: installLocalRuntimeClient },
  { name: 'installComfyLogPanel', install: installComfyUiStatusPanel },
  // ---- v1.9：画布右侧对话面板的大脑在 DSH 那边，这里只补它缺的两个前端前提 ----
  //     installDshAgentModelBridge  模型下拉的内容（面板读的那个全局桥；不装则一个模型都选不到）
  { name: 'installDshAgentModelBridge', install: installDshAgentModelBridge },
  // ---- v1.11：自配 OpenAI 通道（多通道 + 每通道多模型）----
  //     installCloudChannelSupport  模型注册表（画布目录 + 下拉白名单）+ 设置页里的管理面板挂载点
  { name: 'installCloudChannelSupport', install: installCloudChannelSupport },
  // ---- v1.27：画布互动效果开关（设置 → 画布外观 → 画布互动）----
  { name: 'installCanvasEffectsSupport', install: installCanvasEffectsSupport },
  // ---- v1.37：多选折叠成一叠后的「切换」（在不展开的前提下翻看叠里的每一张）----
  { name: 'installCanvasStackSupport', install: installCanvasStackSupport },
  // ---- v1.38：扩图（工具条点一下 → 落一个空图片节点 + 填好提示词，不直接生图）----
  { name: 'installCanvasOutpaintSupport', install: installCanvasOutpaintSupport },
  // ---- v1.40：新节点默认用「上一次生成任务那个模型」（换模型/发起生成时记账）----
  { name: 'installCanvasLastModelSupport', install: installCanvasLastModelSupport },
  // ---- v1.42：项目归档（导出/导入）的 window 桥 —— 项目看板头部的「导入项目」按钮靠它 ----
  { name: 'installProjectArchiveSupport', install: installProjectArchiveSupport },
  // ---- v1.43：设置 → 存储 → 项目数据目录（缓存目录可自定义，重启 DSH 生效）----
  { name: 'installCanvasDataDirSupport', install: installCanvasDataDirSupport },
  // ---- v1.85：旧版设置对话框里的面板改由页面层设置页给宿主（闭源/开源服务、下载目录、关于）+ 个人资料桥 ----
  { name: 'installCanvasSettingsHosts', install: installCanvasSettingsHosts },
  { name: 'installLocalUserBridge', install: installLocalUserBridge },
  // ---- v1.49：切刀（Ctrl + 右键拖拽，划过的连线断开）----
  //     手势/预览在 src/client/canvas/knife.ts；断开由 vendor 补丁 3.8t 的桥落地
  { name: 'installCanvasKnife', install: installCanvasKnife },
  // ---- v1.70：调色节点（Color Grade）→ 全屏合成器（Shift+A 加效果、Shift+点击接预览）----
  { name: 'installCanvasCompositor', install: installCanvasCompositorSupport },
  // ---- v1.87：拖入 .md / .txt → 文本节点（Markdown 在本机转富文档，不再走 host 拉纯文本）----
  { name: 'installCanvasTextFileDrop', install: installCanvasTextFileDrop },
  // ---- v1.89：文本节点全屏预览（只读，入口在节点头部的按钮条里）----
  { name: 'installCanvasTextPreview', install: installCanvasTextPreview },
];

/** 已装成功的模块名（诊断用）。 */
const installedNames: string[] = [];
let installedOnce = false;
/** 当前有几个画布实例在依赖这份装配（多实例时只撤销最后一次）。 */
let consumers = 0;
const disposers: Array<() => void> = [];

function disposeAdapter(adapter: unknown): (() => void) | null {
  if (!adapter || typeof adapter !== 'object') return null;
  const candidate =
    (adapter as { dispose?: unknown }).dispose ?? (adapter as { uninstall?: unknown }).uninstall;
  return typeof candidate === 'function' ? (candidate as () => void).bind(adapter) : null;
}

/**
 * 安装画布所需的全局能力。可重复调用（只有第一次真的装）。
 * 返回撤销函数：卸载画布时把这次安装的成果撤回。
 */
export function installCanvasBootstrap(): () => void {
  consumers += 1;
  if (!installedOnce) {
    installedOnce = true;
    // 本地工作流清单（目录式自定义工作流）要在建节点之前到位：画布新建 ComfyUI 节点时
    // 用的是 workflowTemplates[0]，清单里的自定义工作流会被推到最前面（见
    // scripts/patches/aifisher/…/videoWorkflows.ts）。拉失败只记日志，画布照常能用内置节点。
    void ensureLocalWorkflows();
    for (const { name, install } of INSTALLERS) {
      try {
        const dispose = disposeAdapter(install());
        if (dispose) disposers.push(dispose);
        installedNames.push(name);
      } catch (error) {
        // 单个模块装不上不应该拦住画布渲染 —— 记录后继续
        console.error(`[aifisher-canvas] 装配 ${name} 失败`, error);
      }
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers -= 1;
    // 多画布实例共用一份全局装配：只有最后一个消费者离开时才撤销
    if (consumers > 0) return;
    consumers = 0;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 卸载阶段忽略单个撤销失败 */
      }
    }
    installedNames.length = 0;
    installedOnce = false;
  };
}

/** 给诊断/UI 用：装了哪些模块。 */
export function bootstrapInstallerNames(): string[] {
  return [...installedNames];
}
