/**
 * 设置页（v1.84，设计稿 A「左导航 + 表单」+ 外观分组用 B 的实时预览）。
 *
 * 用户 2026-10-30 原话：「无限画布ui设计要包含设置页、图像编辑页、扩图页的等」；
 * 2026-10-31 拍板三件事：
 *   ① 侧栏「设置」直接开这一页；
 *   ② 设计稿里只有一项真实现的（主题另两款、生成中 V1/V3、动效 G1/G3、并发生成数）
 *      **置灰 + 挂「设计稿」标签**，页面不撒谎；
 *   ③ 旧版设置对话框（个人设置 / 画布外观 / 开源服务 / 闭源服务 / 存储 / 关于）
 *      **整块移除**，里面还在用的面板搬进这一页 —— 开源服务 / 闭源服务在「服务与通道」，
 *      下载目录与项目数据目录在「项目与数据」，个人资料与检查更新在「高级与关于」。
 *
 * 所以这一页的每一行都能说出「改完立刻生效」的理由 —— 数据来源见 ./CanvasSettings.ts 表头。
 * 那些搬进来的面板是 vendor 的原生 DOM mount（`__FISHERAI_MOUNT_*__`），不是 React 组件：
 * 页面只给宿主 div，挂载/卸载在下面的 effect 里做（见 SETTINGS_HOSTS）。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）——产物里 React 有两份副本。
 * ⚠️ 结构契约（回归依赖）：`data-fisherai-settings-section="appearance|generation|services|data|other"`、
 * `data-fisherai-settings-nav`、`data-fisherai-settings-scale`、`data-fisherai-settings-theme`、
 * `data-fisherai-settings-grid-glow`、`data-fisherai-settings-background`、
 * `data-fisherai-settings-host="<id>"`、`data-fisherai-settings-profile`、
 * `data-fisherai-settings-reset`。
 */
import * as ReactTypes from 'react';
import { createElement } from '@/lib/react';
import {
  Database as DatabaseIcon,
  FolderOpen as FolderOpenIcon,
  Image as ImageIcon,
  Info as InfoIcon,
  Minus as MinusIcon,
  Palette as PaletteIcon,
  Plug as PlugIcon,
  Plus as PlusIcon,
  RefreshCw as RefreshCwIcon,
  Settings as SettingsIcon,
  Trash2 as Trash2Icon,
  Upload as UploadIcon,
  Wand2 as Wand2Icon,
} from 'lucide-react';

import { CanvasPageShellView } from './CanvasPageShell';
import {
  closeCanvasPage,
  currentCanvasPage,
  openCanvasPage,
  subscribeCanvasPage,
  type CanvasPageRequest,
} from './CanvasPagesStore';
import {
  CANVAS_UI_VERSION,
  clearBackground,
  copyText,
  fetchBackground,
  fetchComfyStatus,
  fetchDataDir,
  fetchDownloadSettings,
  openDownloadDirectory,
  uploadBackground,
  type BackgroundInfo,
  type ComfyStatus,
  type DataDirInfo,
  type DownloadSettings,
} from './CanvasSettings';
import {
  UI_SCALE_STEPS,
  currentUiScale,
  resetUiScale,
  setUiScale,
  stepUiScale,
  subscribeUiScale,
} from '../../client/canvas/uiScale';
import {
  canvasEffects,
  resetCanvasEffects,
  setCanvasEffect,
  subscribeCanvasEffects,
} from './CanvasEffectsStore';
import { lastModelFor, resetCanvasLastModel } from './CanvasLastModel';
import { requestComfyWorkflowConfig } from './ComfyWorkflowConfigStore';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useSyncExternalStore'
  | 'useRef'
>;

type SectionId = 'appearance' | 'generation' | 'services' | 'data' | 'other';

/**
 * 从旧版设置对话框搬过来的面板（v1.85）。
 *
 * 每一条 = 页面里的一个宿主 div（`data-fisherai-settings-host="<id>"`）+ 装配层注册的
 * 全局 mount 名。挂载在页面打开时做一次，关掉时按返回的 disposer 卸载；云通道面板的
 * mount 不返回 disposer（它自己 `panel.remove()` 的机会只有宿主被删时），所以每次挂之前
 * 先 `replaceChildren()` 清掉上一次的残留。
 */
const SETTINGS_HOSTS: ReadonlyArray<{ id: string; mountName: string; label: string }> = Object.freeze([
  { id: 'local-service', mountName: '__FISHERAI_MOUNT_LOCAL_RUNTIME_SETTINGS__', label: '开源服务（本机 ComfyUI）' },
  { id: 'source', mountName: '__FISHERAI_MOUNT_SOURCE_SETTINGS__', label: '闭源服务（云端来源）' },
  { id: 'channels', mountName: '__FISHERAI_MOUNT_CLOUD_CHANNELS__', label: '自定义通道（OpenAI / 魔搭 / FisherAI）' },
  { id: 'data-dir', mountName: '__FISHERAI_MOUNT_DATA_DIR__', label: '项目数据目录' },
  { id: 'downloads', mountName: '__FISHERAI_MOUNT_DOWNLOAD_SETTINGS__', label: '下载目录' },
  { id: 'update', mountName: '__FISHERAI_MOUNT_UPDATE_SETTINGS__', label: '检查更新' },
]);

interface MountHolder {
  [key: string]: unknown;
}

/** 挂上全部宿主面板，返回卸载函数。 */
function mountSettingsHosts(): () => void {
  // ⚠️ 用 globalThis 读挂载点：装配层（bootstrap）与云通道/数据目录面板都注册在
  //    globalThis 上；jsdom 里 window 与 globalThis 是**两个对象**，照 window 读的桥
  //    在回归里永远是 undefined（v1.39 踩过同一个坑）。
  const holder = globalThis as unknown as MountHolder;
  const disposers: Array<() => void> = [];
  for (const { id, mountName } of SETTINGS_HOSTS) {
    const host = document.querySelector<HTMLElement>(`[data-fisherai-settings-host="${id}"]`);
    const mount = holder[mountName];
    if (!host || typeof mount !== 'function') continue;
    // 上一次的残留（云通道面板没有 disposer）：先清掉，避免重复叠一份。
    host.replaceChildren();
    try {
      const dispose = (mount as (element: HTMLElement) => unknown)(host);
      if (typeof dispose === 'function') disposers.push(dispose as () => void);
    } catch (error) {
      console.error(`[aifisher-canvas] 设置页挂载失败：${id}`, error);
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 单个面板卸载失败不该挡住别的 */
      }
    }
  };
}

interface LocalUserBridgeLike {
  get(): { id: string; no: string; name: string };
  setName(value: string): { id: string; no: string; name: string };
}

interface LocalProfileBridgeLike {
  getAvatar(): string;
  setAvatarFile(file: File, options?: { signal?: AbortSignal }): Promise<string>;
  clearAvatar(): void;
}

/** 六档在滑杆上的位置（设计稿按档位比例定位，不是均匀分布）。 */
const SCALE_STOPS = [0, 14.3, 28.6, 42.9, 64.3, 100];

const NAV: Array<{ id: SectionId; label: string; icon: unknown; group: string }> = [
  { id: 'appearance', label: '外观与主题', icon: PaletteIcon, group: '偏好' },
  { id: 'generation', label: '生成', icon: Wand2Icon, group: '工作' },
  { id: 'services', label: '服务与通道', icon: PlugIcon, group: '工作' },
  { id: 'data', label: '项目与数据', icon: DatabaseIcon, group: '工作' },
  { id: 'other', label: '高级 / 关于', icon: InfoIcon, group: '其他' },
];

function stopIndex(value: number): number {
  const index = UI_SCALE_STEPS.indexOf(value as (typeof UI_SCALE_STEPS)[number]);
  return index >= 0 ? index : 2;
}

export interface CanvasSettingsPageProps {
  /** 回归可传一份固定页面状态；不传就订阅全局 store（真机路径）。 */
  page?: CanvasPageRequest | null;
}

export function CanvasSettingsPage(react: Runtime, props: CanvasSettingsPageProps = {}) {
  const h = createElement(react);
  const storePage = react.useSyncExternalStore(
    subscribeCanvasPage,
    currentCanvasPage,
    currentCanvasPage,
  );
  const page = props.page === undefined ? storePage : props.page;
  const open = page?.id === 'settings';
  const pageKey = page?.key ?? 0;

  const scale = react.useSyncExternalStore(subscribeUiScale, currentUiScale, currentUiScale);
  const effects = react.useSyncExternalStore(subscribeCanvasEffects, canvasEffects, canvasEffects);

  const [comfy, setComfy] = react.useState<ComfyStatus | null>(null);
  const [dataDir, setDataDir] = react.useState<DataDirInfo | null>(null);
  const [downloads, setDownloads] = react.useState<DownloadSettings | null>(null);
  const [background, setBackground] = react.useState<BackgroundInfo | null>(null);
  const [keyword, setKeyword] = react.useState('');
  const [activeSection, setActiveSection] = react.useState<SectionId>('appearance');
  const [toast, setToast] = react.useState('');
  const [savedTick, setSavedTick] = react.useState(0);
  const [busy, setBusy] = react.useState('');
  const [lastModels, setLastModels] = react.useState({ image: '', video: '' });
  const [profileName, setProfileName] = react.useState('');
  const [avatarUrl, setAvatarUrl] = react.useState('');
  const toastTimer = react.useRef<number | null>(null);

  const say = react.useCallback((message: string) => {
    setToast(message);
    setSavedTick(Date.now());
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }, []);

  const reload = react.useCallback(async () => {
    const [nextComfy, nextDir, nextDownloads, nextBackground] = await Promise.all([
      fetchComfyStatus(),
      fetchDataDir(),
      fetchDownloadSettings(),
      fetchBackground(),
    ]);
    setComfy(nextComfy);
    setDataDir(nextDir);
    setDownloads(nextDownloads);
    setBackground(nextBackground);
    setLastModels({ image: lastModelFor('image'), video: lastModelFor('video') });
  }, []);

  react.useEffect(() => {
    if (!open) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageKey]);

  /**
   * 旧对话框搬过来的面板（v1.85）：打开这一页才挂，关掉就卸。
   *
   * 为什么手动 querySelector 而不是 ref 回调：页面会因为 toast / 搜索每次都重渲，
   * ref 回调每次都是新函数 → React 会先调旧 ref(null) 再调新 ref(el)，面板会被反复重挂，
   * 输入框直接丢焦点。这里只在「打开」和「重开」时挂一次。
   */
  react.useEffect(() => {
    if (!open) return;
    return mountSettingsHosts();
  }, [open, pageKey]);

  /** 个人资料（昵称 / 头像）：从装配层注册的两个桥上读。 */
  react.useEffect(() => {
    if (!open) return;
    const user = (window as unknown as { __FISHERAI_LOCAL_USER__?: LocalUserBridgeLike })
      .__FISHERAI_LOCAL_USER__;
    setProfileName(user?.get().name ?? '');
    const profile = (window as unknown as { __FISHERAI_LOCAL_PROFILE__?: LocalProfileBridgeLike })
      .__FISHERAI_LOCAL_PROFILE__;
    setAvatarUrl(profile?.getAvatar() ?? '');
  }, [open, pageKey]);

  /** 从 vendor 那条「打开设置」事件过来时，落在它想看的那个分区（现在只有 services）。 */
  react.useEffect(() => {
    if (!open) return;
    const target = page?.section;
    if (!target) return;
    const section = document.querySelector<HTMLElement>(
      `[data-fisherai-settings-section="${target}"]`,
    );
    if (!section) return;
    setActiveSection(target as SectionId);
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' });
  }, [open, pageKey, page?.section]);

  react.useEffect(() => {
    if (!toast) return;
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [toast]);

  const visible = react.useCallback(
    (title: string, hint = '') => {
      const text = keyword.trim().toLowerCase();
      if (!text) return true;
      return `${title} ${hint}`.toLowerCase().includes(text);
    },
    [keyword],
  );

  /** 滚到某个宿主面板（数据目录 / 下载目录那两行「管理」用它）。 */
  const gotoHost = react.useCallback((id: string) => {
    const host = document.querySelector<HTMLElement>(`[data-fisherai-settings-host="${id}"]`);
    if (host && typeof host.scrollIntoView === 'function') {
      host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, []);

  const onScale = react.useCallback(
    (value: number) => {
      setUiScale(value);
      say(`界面缩放 ${Math.round(value * 100)}%`);
    },
    [say],
  );

  const onStepScale = react.useCallback((dir: 1 | -1) => {
    stepUiScale(dir);
  }, []);

  const onGlow = react.useCallback(() => {
    const next = !effects.pointerGlow;
    setCanvasEffect('pointerGlow', next);
    say(next ? '光标辉光已开' : '光标辉光已关（底纹保持静态）');
  }, [effects.pointerGlow, say]);

  const onPickBackground = react.useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(input);
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        setBusy('background');
        void uploadBackground(file)
          .then((image) => {
            setBackground(image);
            say(`背景图已换成 ${image.width} × ${image.height}`);
          })
          .catch((failure: unknown) => say(failure instanceof Error ? failure.message : String(failure)))
          .finally(() => setBusy(''));
      },
      { once: true },
    );
    input.click();
  }, [say]);

  const onClearBackground = react.useCallback(() => {
    setBusy('background');
    void clearBackground()
      .then(() => {
        setBackground(null);
        say('背景图已清除，回到点阵底');
      })
      .catch((failure: unknown) => say(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(''));
  }, [say]);

  const onReset = react.useCallback(() => {
    resetUiScale();
    resetCanvasEffects();
    say('界面缩放与画布互动已恢复默认（背景图与目录不受影响）');
  }, [say]);

  const onClearLastModel = react.useCallback(() => {
    resetCanvasLastModel();
    setLastModels({ image: '', video: '' });
    say('已忘掉「上次用的模型」，新节点回到目录里第一个');
  }, [say]);

  /** 昵称：每次输入就落盘（与 vendor 原来的写法一致），离开输入框时给一句回执。 */
  const onName = react.useCallback((value: string) => {
    setProfileName(value);
    const user = (window as unknown as { __FISHERAI_LOCAL_USER__?: LocalUserBridgeLike })
      .__FISHERAI_LOCAL_USER__;
    user?.setName(value);
  }, []);

  const onPickAvatar = react.useCallback(() => {
    const profile = (window as unknown as { __FISHERAI_LOCAL_PROFILE__?: LocalProfileBridgeLike })
      .__FISHERAI_LOCAL_PROFILE__;
    if (!profile) {
      say('头像不可用：画布还没装配好（刷新一次画布）');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(input);
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        void profile
          .setAvatarFile(file)
          .then((dataUrl) => {
            setAvatarUrl(dataUrl);
            say('头像已更新');
          })
          .catch((failure: unknown) =>
            say(failure instanceof Error ? failure.message : String(failure)),
          );
      },
      { once: true },
    );
    input.click();
  }, [say]);

  const onClearAvatar = react.useCallback(() => {
    const profile = (window as unknown as { __FISHERAI_LOCAL_PROFILE__?: LocalProfileBridgeLike })
      .__FISHERAI_LOCAL_PROFILE__;
    profile?.clearAvatar();
    setAvatarUrl('');
    say('已恢复默认头像');
  }, [say]);

  if (!open) return null;

  const index = stopIndex(scale);
  const percent = SCALE_STOPS[index];

  /* ------------------------------- 左导航 ------------------------------- */

  const groups = ['偏好', '工作', '其他'];
  const nav = h(
    'aside',
    { className: 'afs-nav', 'aria-label': '设置导航' },
    h(
      'label',
      { className: 'afg-search' },
      h(SettingsIcon, { style: { width: 14, height: 14 } }),
      h('input', {
        type: 'search',
        value: keyword,
        placeholder: '搜索设置项',
        'aria-label': '搜索设置项',
        'data-fisherai-settings-search': 'true',
        onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setKeyword(event.target.value),
      }),
    ),
    ...groups.map((group) =>
      h(
        'div',
        { key: group, className: 'afs-nav-group' },
        h('div', { className: 'afs-nav-label' }, group),
        ...NAV.filter((item) => item.group === group).map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              'data-fisherai-settings-nav': item.id,
              'aria-current': activeSection === item.id ? 'true' : undefined,
              className: activeSection === item.id ? 'afs-nav-item afg-on' : 'afs-nav-item',
              onClick: () => {
                setKeyword('');
                setActiveSection(item.id);
                const section = document.querySelector(
                  `[data-fisherai-settings-section="${item.id}"]`,
                );
                if (section && typeof section.scrollIntoView === 'function') {
                  section.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }
              },
            },
            h(item.icon as ReactTypes.ComponentType, {}),
            item.label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'afs-nav-foot' },
      h(
        'div',
        { className: 'afs-ver' },
        h('span', { className: 'afg-mono' }, `v${CANVAS_UI_VERSION}`),
        h('span', { className: 'afg-mint afg-f11' }, '本地构建'),
      ),
      h(
        'button',
        { type: 'button', className: 'afg-btn afg-ghost afg-sm', onClick: () => void reload() },
        h(RefreshCwIcon, {}),
        '重新读取',
      ),
    ),
  );

  /* ------------------------------- 01 外观 ------------------------------- */

  const themeRow = visible('主题皮肤', '玻璃面板 精密仪器 暗房') &&
    h(
      'div',
      { className: 'afs-row', key: 'theme' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '主题皮肤'),
        h('div', { className: 'afs-row-h' }, '玻璃面板是当前画布与调色面板的默认皮肤；另两款只在设计稿里'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'button',
          {
            type: 'button',
            'data-fisherai-settings-theme': 'glass',
            'aria-pressed': true,
            className: 'afs-theme-opt afg-on',
            onClick: () => say('玻璃面板已经是当前皮肤'),
          },
          h(
            'span',
            { className: 'afs-sw' },
            h('i', { style: { background: '#5eead4' } }),
            h('i', { style: { background: '#8b7cf6' } }),
            h('i', { style: { background: '#cfd8e3' } }),
          ),
          '玻璃面板',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-fisherai-settings-theme': 'precision',
            disabled: true,
            title: '设计稿已备（精密仪器），还没接到皮肤令牌上',
            className: 'afs-theme-opt',
          },
          h(
            'span',
            { className: 'afs-sw' },
            h('i', { style: { background: '#9fb3c8' } }),
            h('i', { style: { background: '#e2e8ef' } }),
            h('i', { style: { background: '#47607a' } }),
          ),
          '精密仪器',
          h('span', { className: 'afs-draft' }, '设计稿'),
        ),
        h(
          'button',
          {
            type: 'button',
            'data-fisherai-settings-theme': 'darkroom',
            disabled: true,
            title: '设计稿已备（暗房），还没接到皮肤令牌上',
            className: 'afs-theme-opt',
          },
          h(
            'span',
            { className: 'afs-sw' },
            h('i', { style: { background: '#e8b25a' } }),
            h('i', { style: { background: '#a24b3a' } }),
            h('i', { style: { background: '#2a2320' } }),
          ),
          '暗房',
          h('span', { className: 'afs-draft' }, '设计稿'),
        ),
      ),
    );

  // 外观分组用设计稿 B 的「左选项 + 右实时预览」：挑皮肤时能直接看到节点长什么样。
  const themePreview = visible('主题皮肤预览', '节点 端口 连线 缩放') &&
    h(
      'div',
      { className: 'afs-rows', key: 'theme-preview', style: { marginTop: 8 } },
      h(
        'div',
        { className: 'afs-theme-body' },
        h(
          'div',
          { className: 'afs-theme-list' },
          ...([
            ['glass', '玻璃面板', '#5eead4', '#8b7cf6', '#cfd8e3', true, '默认'],
            ['precision', '精密仪器', '#9fb3c8', '#e2e8ef', '#47607a', false, ''],
            ['darkroom', '暗房', '#e8b25a', '#a24b3a', '#2a2320', false, ''],
          ] as Array<[string, string, string, string, string, boolean, string]>).map(
            ([id, label, c1, c2, c3, on, note]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  disabled: !on,
                  'data-fisherai-settings-theme-preview': id,
                  className: on ? 'afs-topt afg-on' : 'afs-topt',
                },
                h(
                  'span',
                  { className: 'afs-sw' },
                  h('i', { style: { background: c1 } }),
                  h('i', { style: { background: c2 } }),
                  h('i', { style: { background: c3 } }),
                ),
                h(
                  'span',
                  { className: 'afs-tt' },
                  label,
                  note ? h('i', {}, note) : null,
                  on ? null : h('span', { className: 'afs-draft' }, '设计稿'),
                ),
                h('span', { className: 'afs-radio' }),
              ),
          ),
          h(
            'div',
            { className: 'afg-f11 afg-dim', style: { lineHeight: 1.6, padding: '2px 2px 0' } },
            '三种皮肤共用布局与尺寸，只换颜色、材质与光感。目前只有玻璃面板接到了真实令牌上。',
          ),
        ),
        h(
          'div',
          { className: 'afs-tcanvas', 'data-fisherai-settings-theme-canvas': 'glass' },
          h('div', { className: 'afs-gridlayer' }),
          h(
            'div',
            { className: 'afs-tn', style: { left: 34, top: 22, width: 150 } },
            h(
              'div',
              { className: 'afs-tn-head' },
              h('i', { className: 'afs-tn-dot' }),
              h('span', { className: 'afs-tn-t' }, '图片 · 生成节点'),
            ),
            h('div', { className: 'afs-tn-body', style: { height: 82 } }),
          ),
          h('div', { className: 'afs-link', style: { left: 184, top: 60, width: 76 } }),
          h(
            'div',
            { className: 'afs-tn', style: { left: 258, top: 36, width: 112 } },
            h(
              'div',
              { className: 'afs-tn-head' },
              h('i', { className: 'afs-tn-dot', style: { background: '#8b7cf6' } }),
              h('span', { className: 'afs-tn-t' }, '文本'),
            ),
            h('div', {
              className: 'afs-tn-body',
              style: { height: 34, background: 'linear-gradient(120deg,#20242c,#1a1d24)' },
            }),
          ),
          h('div', { className: 'afs-link', style: { left: 370, top: 62, width: 88 } }),
          h(
            'div',
            { className: 'afs-tn', style: { left: 458, top: 30, width: 126 } },
            h(
              'div',
              { className: 'afs-tn-head' },
              h('i', { className: 'afs-tn-dot', style: { background: '#f5c26b' } }),
              h('span', { className: 'afs-tn-t' }, '视频'),
            ),
            h('div', {
              className: 'afs-tn-body',
              style: { height: 44, background: 'linear-gradient(120deg,#2b2419,#241a1a)' },
            }),
          ),
          h('span', { className: 'afs-tn-port', style: { left: 181, top: 57 } }),
          h('span', { className: 'afs-tn-port', style: { left: 255, top: 57 } }),
          h('span', { className: 'afs-tn-port', style: { left: 367, top: 59 } }),
          h('span', { className: 'afs-tn-port', style: { left: 455, top: 59 } }),
          h('span', { className: 'afs-tagline' }, '玻璃面板 · 节点 340×500 · 端口 12'),
          h('span', { className: 'afs-zp' }, h('span', { className: 'afg-mono' }, '100%')),
        ),
      ),
    );

  const scaleTicks = h(
    'div',
    { className: 'afs-ticks' },
    ...UI_SCALE_STEPS.map((step, i) =>
      h(
        'span',
        {
          key: step,
          style: { left: `${SCALE_STOPS[i]}%` },
          className: i === index ? 'afg-on' : '',
          onClick: () => onScale(step),
        },
        String(Math.round(step * 100)),
      ),
    ),
  );

  const scaleRow = visible('界面缩放', '顶栏 工具条 弹层 80 90 100 110 125 150') &&
    h(
      'div',
      { className: 'afs-row', key: 'scale' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '界面缩放'),
        h(
          'div',
          { className: 'afs-row-h' },
          '顶栏、工具条、弹层一起放大或缩小；画布内容不受影响（Ctrl + = / − / 0）',
        ),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-scale', 'data-fisherai-settings-scale': Math.round(scale * 100) },
          h(
            'button',
            {
              type: 'button',
              className: 'afg-iconbtn',
              style: { width: 26, height: 26 },
              'aria-label': '缩小界面',
              disabled: index <= 0,
              onClick: () => onStepScale(-1),
            },
            h(MinusIcon, {}),
          ),
          h(
            'div',
            { className: 'afs-scale-wrap' },
            h(
              'div',
              { className: 'afg-slider', role: 'slider', 'aria-valuenow': Math.round(scale * 100) },
              h('div', { className: 'afg-track' }, h('div', { className: 'afg-fill', style: { width: `${percent}%` } })),
              h('div', { className: 'afg-knob', style: { left: `${percent}%` } }),
            ),
            scaleTicks,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'afg-iconbtn',
              style: { width: 26, height: 26 },
              'aria-label': '放大界面',
              disabled: index >= UI_SCALE_STEPS.length - 1,
              onClick: () => onStepScale(1),
            },
            h(PlusIcon, {}),
          ),
          h('span', { className: 'afs-scale-val' }, `${Math.round(scale * 100)}%`),
        ),
      ),
    );

  const gridRow = visible('画布网格', '点阵 光标辉光 脉冲 共鸣') &&
    h(
      'div',
      { className: 'afs-row', key: 'grid' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '画布网格'),
        h('div', { className: 'afs-row-h' }, '点阵是底；光标辉光跟着指针亮一圈（B/C 两款还在设计稿里）'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-opts' },
          h('button', { type: 'button', className: 'afs-opt afg-on', disabled: true, title: '点阵是常驻底纹，没有开关' }, '静态点阵'),
          h(
            'button',
            {
              type: 'button',
              'data-fisherai-settings-grid-glow': effects.pointerGlow ? 'on' : 'off',
              'aria-pressed': effects.pointerGlow,
              className: effects.pointerGlow ? 'afs-opt afg-on' : 'afs-opt',
              onClick: onGlow,
            },
            '光标辉光',
            effects.pointerGlow ? h('span', { className: 'afs-rec' }, '开启') : null,
          ),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'A 脉冲', h('span', { className: 'afs-draft' }, '设计稿')),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'C 共鸣', h('span', { className: 'afs-draft' }, '设计稿')),
        ),
      ),
    );

  const backgroundRow = visible('画布背景图', '替换点阵底色 JPG PNG WebP') &&
    h(
      'div',
      { className: 'afs-row', key: 'background', 'data-fisherai-settings-background': background ? 'set' : 'empty' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '画布背景图'),
        h('div', { className: 'afs-row-h' }, '替换点阵底色，支持 JPG / PNG / WebP，不超过 20 MB'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-bgthumb' },
          background
            ? h('img', { src: background.url, alt: '', draggable: false })
            : h(ImageIcon, {}),
        ),
        background
          ? h(
              'span',
              { className: 'afg-f11 afg-dim afg-mono' },
              `${background.width} × ${background.height}`,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'afg-btn afg-sm',
            disabled: busy === 'background',
            onClick: onPickBackground,
          },
          busy === 'background' ? '处理中…' : background ? '更换' : '选择图片',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'afg-btn afg-sm afg-ghost',
            disabled: !background || busy === 'background',
            onClick: onClearBackground,
          },
          '清除',
        ),
      ),
    );

  const appearanceSection = h(
    'section',
    { className: 'afs-sect', 'data-fisherai-settings-section': 'appearance' },
    h(
      'div',
      { className: 'afg-sect-head' },
      h('span', { className: 'afs-idx afg-mono' }, '01'),
      h('h2', {}, '外观与主题'),
      h('span', { className: 'afg-hint' }, '与调色合成器共用一套皮肤'),
    ),
    h('div', { className: 'afs-rows' }, themeRow, scaleRow, gridRow, backgroundRow),
    themePreview,
  );

  /* ------------------------------- 02 生成 ------------------------------- */

  const comfyRow = visible('本地 ComfyUI', '地址 连接 工作流 模型') &&
    h(
      'div',
      { className: 'afs-row', key: 'comfy' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '本地 ComfyUI'),
        h(
          'div',
          { className: 'afs-row-h' },
          '图片与视频走本机队列；本插件只读它的状态，不托管进程（用绘世启动器自己启）',
        ),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        comfy?.online
          ? h('span', { className: 'afg-tag afg-mint', style: { height: 24 } }, h('span', { className: 'afg-dot' }), '已连接')
          : h(
              'span',
              { className: 'afg-tag', style: { height: 24 } },
              h('span', { className: 'afg-dot afg-a' }),
              comfy?.error ? '读不到状态' : '未连接',
            ),
        h(
          'span',
          { className: 'afg-input afg-mono', style: { width: 200 } },
          comfy?.address || 'http://127.0.0.1:8188',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'afg-btn afg-sm',
            onClick: () => {
              setComfy(null);
              void fetchComfyStatus().then(setComfy);
            },
          },
          '刷新',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'afg-btn afg-sm afg-ghost',
            'data-fisherai-settings-workflow-config': 'true',
            onClick: () => {
              // ComfyUI 工作流配置是画布自己的浮层（不是旧设置对话框里的一块）：
              // v1.85 之前这里打开旧对话框，现在直接开那张浮层。
              requestComfyWorkflowConfig();
              say('已打开工作流配置');
            },
          },
          '工作流配置',
        ),
      ),
    );

  const lastModelRow = visible('新建节点默认模型', '跟随上次使用 图像 视频') &&
    h(
      'div',
      { className: 'afs-row', key: 'default-model' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '新建节点默认模型'),
        h('div', { className: 'afs-row-h' }, '新建节点跟随「上一次用过的模型」（v1.40 的机制）；节点上仍可单独换'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'span',
          { className: 'afg-tag afg-violet' },
          h(ImageIcon, { style: { width: 13, height: 13 } }),
          lastModels.image || '目录第一个',
        ),
        h(
          'span',
          { className: 'afg-tag afg-amber' },
          h(Wand2Icon, { style: { width: 13, height: 13 } }),
          lastModels.video || '目录第一个',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'afg-btn afg-sm afg-ghost',
            disabled: !lastModels.image && !lastModels.video,
            onClick: onClearLastModel,
          },
          '忘记',
        ),
      ),
    );

  const concurrencyRow = visible('并发生成数', '显存 同时生成') &&
    h(
      'div',
      { className: 'afs-row', key: 'concurrency' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '并发生成数'),
        h('div', { className: 'afs-row-h' }, '受显存限制；当前版本按节点逐个排队，还没有并发队列'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-stepper', 'aria-disabled': true, title: '设计稿：还没有并发队列' },
          h('button', { type: 'button', disabled: true }, h(MinusIcon, {})),
          h('span', { className: 'afs-v' }, '1'),
          h('button', { type: 'button', disabled: true }, h(PlusIcon, {})),
        ),
        h('span', { className: 'afs-draft' }, '设计稿'),
      ),
    );

  const runningStyleRow = visible('生成中显示', 'V1 显影 V2 仪表 V3 浮动') &&
    h(
      'div',
      { className: 'afs-row', key: 'running' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '生成中显示'),
        h('div', { className: 'afs-row-h' }, '只作用于生成中节点的内容区；当前版是 V2 仪表 + 噪波点阵'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-opts' },
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'V1 显影', h('span', { className: 'afs-draft' }, '设计稿')),
          h('button', { type: 'button', className: 'afs-opt afg-on', disabled: true }, 'V2 仪表', h('span', { className: 'afs-rec' }, '当前')),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'V3 浮动', h('span', { className: 'afs-draft' }, '设计稿')),
        ),
      ),
    );

  const motionRow = visible('生成中动效', 'G1 扫描 G2 波纹 G3 流场 N1 噪波') &&
    h(
      'div',
      { className: 'afs-row', key: 'motion' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '生成中动效'),
        h('div', { className: 'afs-row-h' }, '噪波点阵：一部分点亮、一部分不亮，随机不呼吸（2026-10-30 定稿）'),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h(
          'div',
          { className: 'afs-opts' },
          h('button', { type: 'button', className: 'afs-opt afg-on', disabled: true }, 'N1 噪波', h('span', { className: 'afs-rec' }, '当前')),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'G1 扫描', h('span', { className: 'afs-draft' }, '设计稿')),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'G2 波纹', h('span', { className: 'afs-draft' }, '设计稿')),
          h('button', { type: 'button', className: 'afs-opt', disabled: true }, 'G3 流场', h('span', { className: 'afs-draft' }, '设计稿')),
          h('button', { type: 'button', className: 'afs-opt afg-off', disabled: true }, '关', h('span', { className: 'afs-draft' }, '设计稿')),
        ),
      ),
    );

  const generationSection = h(
    'section',
    { className: 'afs-sect', 'data-fisherai-settings-section': 'generation' },
    h(
      'div',
      { className: 'afg-sect-head' },
      h('span', { className: 'afs-idx afg-mono' }, '02'),
      h('h2', {}, '生成'),
      h('span', { className: 'afg-hint' }, '新任务跟随这里的默认值，节点上仍可单独覆盖'),
    ),
    h('div', { className: 'afs-rows' }, comfyRow, lastModelRow, concurrencyRow, runningStyleRow, motionRow),
  );

  /* ------------------------------- 04 项目与数据 ------------------------------- */

  const pathRow = (
    key: string,
    title: string,
    hint: string,
    value: string,
    icon: unknown,
    actions: unknown[],
    title2?: string,
  ) =>
    visible(title, hint) &&
    h(
      'div',
      { className: 'afs-row', key },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, title, title2 ? h('span', { className: 'afs-draft' }, title2) : null),
        h('div', { className: 'afs-row-h' }, hint),
      ),
      h(
        'div',
        { className: 'afs-row-ctl' },
        h('span', { className: 'afs-path', title: value }, icon, h('span', { className: 'afg-ellip' }, value || '—')),
        ...actions,
      ),
    );

  const dataSection = h(
    'section',
    { className: 'afs-sect', 'data-fisherai-settings-section': 'data' },
    h(
      'div',
      { className: 'afg-sect-head' },
      h('span', { className: 'afs-idx afg-mono' }, '04'),
      h('h2', {}, '项目与数据'),
      h('span', { className: 'afg-hint' }, '存档与导出都写在本机；目录在下方「目录管理」里改'),
    ),
    h(
      'div',
      { className: 'afs-rows' },
      pathRow(
        'datadir',
        '项目数据目录',
        `节点、图片、视频与项目档保存在这里${dataDir?.overridden ? '（已自定义）' : '（默认位置）'}`,
        dataDir?.pending || '',
        h(FolderOpenIcon, {}),
        [
          h(
            'button',
            {
              key: 'copy',
              type: 'button',
              className: 'afg-btn afg-sm',
              onClick: () => {
                void copyText(dataDir?.pending || '').then((ok) =>
                  say(ok ? '路径已复制' : '复制失败，可以手动选中路径'),
                );
              },
            },
            '复制路径',
          ),
          h(
            'button',
            {
              key: 'advanced',
              type: 'button',
              className: 'afg-btn afg-sm afg-ghost',
              'data-fisherai-settings-goto-host': 'data-dir',
              onClick: () => gotoHost('data-dir'),
            },
            '更换',
          ),
        ],
        dataDir?.restartRequired ? '重启后生效' : undefined,
      ),
      pathRow(
        'downloads',
        '导出目录',
        '项目归档、备份与素材「下载」默认写到这里',
        downloads?.directory || '',
        h(FolderOpenIcon, {}),
        [
          h(
            'button',
            {
              key: 'open',
              type: 'button',
              className: 'afg-btn afg-sm',
              disabled: !downloads?.directory,
              onClick: () => {
                void openDownloadDirectory().then((ok) =>
                  say(ok ? '已在资源管理器打开' : '打开失败（本机没有可用的文件管理器）'),
                );
              },
            },
            '打开',
          ),
          h(
            'button',
            {
              key: 'advanced',
              type: 'button',
              className: 'afg-btn afg-sm afg-ghost',
              'data-fisherai-settings-goto-host': 'downloads',
              onClick: () => gotoHost('downloads'),
            },
            '更换',
          ),
        ],
        downloads?.customDirectory ? '自定义' : undefined,
      ),
      visible('自动保存', '拖动 连线 改参数 落盘 Ctrl S') &&
        h(
          'div',
          { className: 'afs-row', key: 'autosave' },
          h(
            'div',
            { className: 'afs-row-main' },
            h('div', { className: 'afs-row-t' }, '自动保存'),
            h('div', { className: 'afs-row-h' }, '拖动、连线、改参数后自动落盘；关掉只能手动 Ctrl + S（当前版本常开）'),
          ),
          h(
            'div',
            { className: 'afs-row-ctl' },
            h('span', { className: 'afg-f11 afg-dim' }, '由画布自动保存接管'),
            h('span', { className: 'afg-switch afg-on', 'aria-disabled': true, role: 'switch', 'aria-checked': true }),
          ),
        ),
      /**
       * 目录管理（v1.85）：旧版设置「存储」里的两块面板搬到页内 —— 下载目录（含「每次询问」）
       * 与项目数据目录（写指针、重启生效）。两个都是 vendor 的原生 mount，宿主 div 给它们。
       */
      h(
        'div',
        { className: 'afs-host-block', key: 'dir-hosts' },
        h(
          'div',
          { className: 'afs-host-head' },
          h(
            'div',
            { className: 'afs-row-main' },
            h('div', { className: 'afs-row-t' }, '目录管理'),
            h(
              'div',
              { className: 'afs-row-h' },
              '下载目录改完立刻生效；项目数据目录写的是指针，重启 DSH 后生效',
            ),
          ),
        ),
        h('div', {
          className: 'afs-host',
          'data-fisherai-settings-host': 'downloads',
        }),
        h('div', {
          className: 'afs-host',
          'data-fisherai-settings-host': 'data-dir',
        }),
      ),
    ),
  );

  /* ------------------------------- 03 服务与通道 ------------------------------- */

  const servicesSection = h(
    'section',
    { className: 'afs-sect', 'data-fisherai-settings-section': 'services' },
    h(
      'div',
      { className: 'afg-sect-head' },
      h('span', { className: 'afs-idx afg-mono' }, '03'),
      h('h2', {}, '服务与通道'),
      h('span', { className: 'afg-hint' }, '开源服务（本机 ComfyUI）与闭源服务（云端来源 / 自定义通道）'),
    ),
    h(
      'div',
      { className: 'afs-rows' },
      /**
       * 开源服务：旧版设置「开源服务」整页（安装目录 / 启动停止 / 扩展 / 日志）。
       * 原来只在 vendor 对话框里，v1.85 搬到这。
       */
      h(
        'div',
        { className: 'afs-host-block', key: 'local-service' },
        h('div', {
          className: 'afs-host',
          'data-fisherai-settings-host': 'local-service',
        }),
      ),
      /**
       * 闭源服务：vendor 的「来源卡片」（AIFISHER API / RH / 厂商直连…）+ 我们自己的
       * 多通道面板（OpenAI / 魔搭 / FisherAI）。两者原来分别挂在旧对话框的「闭源服务」页里。
       */
      h(
        'div',
        { className: 'afs-host-block', key: 'closed-service' },
        h(
          'div',
          { className: 'afs-host-head' },
          h(
            'div',
            { className: 'afs-row-main' },
            h('div', { className: 'afs-row-t' }, '闭源服务'),
            h(
              'div',
              { className: 'afs-row-h' },
              '云端来源与自定义通道；勾中的通道模型会出现在画布节点的模型下拉里',
            ),
          ),
        ),
        h('div', {
          className: 'afs-host',
          'data-fisherai-settings-host': 'source',
        }),
        h('div', {
          className: 'afs-host',
          'data-fisherai-settings-host': 'channels',
        }),
      ),
    ),
  );

  /* ------------------------------- 05 高级 / 关于 ------------------------------- */

  /**
   * 个人资料（v1.85，从旧版设置「个人设置」搬来）。
   *
   * 昵称走 `__FISHERAI_LOCAL_USER__`、头像走 `__FISHERAI_LOCAL_PROFILE__`（都是装配层
   * 注册的 vendor 本地偏好桥）。昵称在 vendor 那边是组件内 state，改完要下次挂载才用到
   * 协作头像上 —— 提示里照实写，不假装即时生效。
   */
  const profileBlock = h(
    'div',
    { className: 'afs-host-block', 'data-fisherai-settings-profile': 'true', key: 'profile' },
    h(
      'div',
      { className: 'afs-host-head' },
      h(
        'div',
        { className: 'afs-row-main' },
        h('div', { className: 'afs-row-t' }, '个人资料'),
        h('div', { className: 'afs-row-h' }, '画布里显示的名字与头像；昵称下次打开画布时用于协作头像'),
      ),
    ),
    h(
      'div',
      { className: 'afs-profile' },
      h(
        'div',
        { className: 'afs-profile-avatar', 'data-fisherai-settings-profile-avatar': 'true' },
        avatarUrl
          ? h('img', { src: avatarUrl, alt: '当前头像' })
          : h('span', {}, (profileName || '协作者').slice(0, 1)),
      ),
      h(
        'div',
        { className: 'afs-profile-fields' },
        h('input', {
          type: 'text',
          value: profileName,
          placeholder: '输入你的显示名称',
          maxLength: 64,
          'aria-label': '用户名称',
          'data-fisherai-settings-profile-name': 'true',
          className: 'afs-input',
          onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
            onName(event.target.value),
          onBlur: () => say('昵称已保存（下次打开画布生效）'),
        }),
        h(
          'div',
          { className: 'afs-profile-actions' },
          h(
            'button',
            { type: 'button', className: 'afg-btn afg-sm', onClick: onPickAvatar },
            h(UploadIcon, {}),
            '上传头像',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'afg-btn afg-sm afg-ghost',
              onClick: onClearAvatar,
              disabled: !avatarUrl,
            },
            h(Trash2Icon, {}),
            '恢复默认',
          ),
          h('span', { className: 'afg-dim afg-f11' }, 'PNG / JPEG / WebP，≤ 2 MB'),
        ),
      ),
    ),
  );

  const otherSection = h(
    'section',
    { className: 'afs-sect', 'data-fisherai-settings-section': 'other' },
    h(
      'div',
      { className: 'afg-sect-head' },
      h('span', { className: 'afs-idx afg-mono' }, '05'),
      h('h2', {}, '高级与关于'),
      h('span', { className: 'afg-hint' }, '个人资料、项目库入口与检查更新'),
    ),
    h(
      'div',
      { className: 'afs-rows' },
      profileBlock,
      visible('项目库', '项目列表 归档 导入导出') &&
        h(
          'div',
          { className: 'afs-row', key: 'projects' },
          h(
            'div',
            { className: 'afs-row-main' },
            h('div', { className: 'afs-row-t' }, '项目库'),
            h('div', { className: 'afs-row-h' }, '所有项目、归档、导出 / 导入与备注'),
          ),
          h(
            'div',
            { className: 'afs-row-ctl' },
            h(
              'button',
              { type: 'button', className: 'afg-btn afg-sm', onClick: () => openCanvasPage('projects') },
              h(DatabaseIcon, {}),
              '打开项目库',
            ),
          ),
        ),
      visible('关于', '版本 构建 更新') &&
        h(
          'div',
          { className: 'afs-row', key: 'about' },
          h(
            'div',
            { className: 'afs-row-main' },
            h('div', { className: 'afs-row-t' }, '关于'),
            h('div', { className: 'afs-row-h' }, '无限画布是 DSH 里的一个本地插件：数据在本机，生成走你自己的 ComfyUI 或云端通道'),
          ),
          h(
            'div',
            { className: 'afs-row-ctl' },
            h('span', { className: 'afg-tag afg-mono' }, `v${CANVAS_UI_VERSION}`),
            h('span', { className: 'afg-tag' }, '玻璃面板'),
          ),
        ),
      // 旧版设置「关于 渡雨鸣泽 画布」里的检查更新面板（vendor 原生 mount）
      h('div', {
        key: 'update-host',
        className: 'afs-host',
        'data-fisherai-settings-host': 'update',
      }),
    ),
  );

  /* ------------------------------- 主体 ------------------------------- */

  const savedLabel = savedTick ? '已自动保存' : '改动即时生效';

  const main = h(
    'main',
    {
      className: 'afs-main afg-scroll',
      /**
       * 滚动时把左导航的高亮跟着走（设计稿里「外观与主题」默认选中）。
       * 只比 section 的 offsetTop 与当前滚动位置，没有 IntersectionObserver —— jsdom 里
       * 那个观察器是空壳，用它能测的只有「点了高亮变」这一件事。
       */
      onScroll: (event: ReactTypes.UIEvent<HTMLElement>) => {
        const element = event.currentTarget;
        const mark = element.scrollTop + 80;
        let next: SectionId = 'appearance';
        const sections = [...element.querySelectorAll<HTMLElement>('[data-fisherai-settings-section]')];
        for (const section of sections) {
          if (section.offsetTop <= mark) {
            const id = section.getAttribute('data-fisherai-settings-section');
            if (id) next = id as SectionId;
          }
        }
        setActiveSection(next);
      },
    },
    h(
      'div',
      { className: 'afs-head' },
      h(
        'div',
        {},
        h('h1', {}, '设置'),
        h(
          'p',
          {},
          '画布的外观与生成行为。改动即时生效，不需要重启，也不会写入项目档案。',
        ),
      ),
      h(
        'div',
        { className: 'afs-head-actions' },
        h(
          'button',
          {
            type: 'button',
            'data-fisherai-settings-reset': 'true',
            className: 'afg-btn afg-sm afg-ghost',
            onClick: onReset,
          },
          h(RefreshCwIcon, {}),
          '恢复默认',
        ),
      ),
    ),
    appearanceSection,
    generationSection,
    servicesSection,
    dataSection,
    otherSection,
    h(
      'div',
      { className: 'afs-foot' },
      '改动即时生效 · ',
      h('span', { className: 'afg-mint' }, '未接入的标了「设计稿」'),
      ' · ',
      h('span', { className: 'afg-mint' }, '恢复默认'),
    ),
  );

  const right = h(
    'div',
    { className: 'afg-center afg-gap8' },
    h(
      'span',
      { className: toast ? 'afs-saved afs-dirty' : 'afs-saved', 'data-fisherai-settings-saved': toast ? 'flash' : 'idle' },
      h('span', { className: toast ? 'afg-dot afg-a' : 'afg-dot' }),
      toast || savedLabel,
    ),
    h('span', { className: 'afg-vdiv', style: { height: 18, margin: '0 4px' } }),
    h(
      'button',
      {
        type: 'button',
        className: 'afg-btn afg-sm afg-ghost',
        onClick: () => {
          closeCanvasPage();
          openCanvasPage('projects');
        },
      },
      h(DatabaseIcon, {}),
      '项目库',
    ),
  );

  // ⚠️ 走 CanvasPageShellView（稳定组件），理由见 CanvasProjectsPage 同一处注释（React #310）。
  return h(CanvasPageShellView, {
    runtime: react,
    id: 'settings',
    title: '设置',
    rootClass: 'afs-root',
    right,
    children: [
      h('div', { className: 'afs-body' }, nav, main),
      toast
        ? h(
            'div',
            {
              role: 'status',
              'data-fisherai-settings-toast': 'true',
              style: {
                position: 'absolute',
                left: '50%',
                bottom: 18,
                transform: 'translateX(-50%)',
                maxWidth: 'min(620px, calc(100% - 48px))',
                padding: '9px 14px',
                borderRadius: 10,
                border: '1px solid var(--afg-line-2)',
                background: 'rgba(23,27,34,.94)',
                color: 'var(--afg-text)',
                fontSize: 12,
                boxShadow: '0 12px 32px rgba(0,0,0,.45)',
                zIndex: 9,
              },
            },
            toast,
          )
        : null,
    ],
  });
}

CanvasSettingsPage.displayName = 'CanvasSettingsPage';
