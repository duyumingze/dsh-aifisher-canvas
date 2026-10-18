/**
 * 画布头部栏（shadcn/ui 重设计版）。
 *
 * 替换 vendor 的 `dialogs/canvasHeader.tsx`（vendor 一个字没改，靠装配层换绑定，
 * 见 docs/canvas-ui-shadcn.md）。这里用 `React.createElement` 而不是 JSX：
 * 与上游一致的构造器注入风格，且不依赖打包器的 jsx runtime 传递。
 *
 * 必须保持的结构契约（有回归/真机检查依赖）：
 *   1. 根元素 class 含 `af-canvas-header`，且是 `absolute top-0 left-0`：
 *      browser-check 用它量「头部没有越界压住 DSH 侧边栏」。
 *   2. `[data-fisherai-account-center-slot="true"]` 必须是头部右侧工具条的直接子元素：
 *      ComfyUI 状态胶囊回落到这个槽位停靠（vendor 的 comfyLogPanel.ts:333）。
 *   3. 保存/退出/重命名行为完整保留（Ctrl+S、保存后退出、错误提示）。
 *   4. （v1.36）`[data-fisherai-comfyui-slot="true"]` 是头部**左侧**工具条的直接子元素：
 *      ComfyUI 状态胶囊优先停靠到这里（用户 2026-10-17 原话「把右上角的 comfui 待启动
 *      移动到左边」），vendor 侧由 scripts/vendor-aifisher.mjs 的 3.8n 补丁认这个槽位。
 *   5. （v1.36）`z-50` + 不透明底色是**必须的**：vendor 的 Scene（`#canvas-background`，
 *      不透明底）在 DOM 里排在头部后面，头部没有 z-index 时会被整块盖住 —— 真机表现是
 *      「logo/项目名/保存状态全看不见、也点不到」，只剩自带 z-index 的 ComfyUI 胶囊浮着。
 *      browser-check 用 `headerOnTop`（elementFromPoint 命中头部）钉住这一条。
 *
 * ⚠️ 一条踩过的坑：**hook 必须用注入进来的那一份 React**（函数第一个参数），
 *    不能用本文件 `import * as React from 'react'` 的那份。产物里 React 有两份副本
 *    （vendor 画面包一份、ui 组件一份），hooks 分发器各管各的；用错那份，
 *    React 19 既不报错也不渲染 —— 表现成「头部/工具条整块消失，页面一言不发」。
 *    从 `react` 的 import 只留类型（React.RefObject / React.MouseEvent 这类）。
 */
import * as ReactTypes from 'react';
import { ArchiveIcon, ArrowLeftIcon, FolderOpenIcon, LogOutIcon, SaveIcon } from 'lucide-react';

import { Badge } from '@/ui/badge';
import { Button, buttonVariants } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Kbd } from '@/ui/kbd';
import { Spinner } from '@/ui/spinner';
import { iconNode } from '@/lib/icon';
import { cn } from '@/lib/utils';
import { requestCanvasProjectArchive } from './CanvasProjectArchiveStore';

/** 注入进来的 React 运行时（vendor 的 bind 会把 React 作为第一个参数传进来）。 */
type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useRef'
  | 'useLayoutEffect'
  | 'useEffect'
  | 'Fragment'
>;

/** 注入进来的图标（vendor 的 bind 把依赖工厂返回的对象作为第三个参数传进来）。 */
interface HeaderIcons {
  SaveIcon?: unknown;
  ImportIcon?: unknown;
  BackIcon?: unknown;
}

interface Props {
  canvasTitle: string;
  isEditingTitle: boolean;
  editingTitleValue: string;
  canvasTitleInputRef: ReactTypes.RefObject<HTMLInputElement | null>;
  setCanvasTitle(value: string): void;
  setIsEditingTitle(value: boolean): void;
  setEditingTitleValue(value: string): void;
  onSave(): Promise<{ unchanged?: boolean } | null | undefined>;
  onBack?(): unknown;
  /** @deprecated v1.42 起「导入 / 导出」统一走「项目归档」面板，这个 prop 不再使用。 */
  onImportProjectJson?(): void;
  documentEpoch?: number;
  hasUnsavedChanges: boolean;
  lastAutoSaveTime?: number | null;
  lastSavedBy?: string;
  lastSavedRevision?: number | null;
  isChatOpen?: boolean;
  chatPanelWidth?: number;
}

/** 头部根 class：字符串里保留 `af-canvas-header absolute top-0 left-0`（真机断言用）。 */
const HEADER_CLASS =
  'af-canvas-header absolute top-0 left-0 z-50 flex h-12 items-center justify-between gap-3 ' +
  'border-b border-border bg-[var(--af-surface)] pl-2 text-foreground ' +
  'pointer-events-none transition-[width] duration-300';

/**
 * 头部右侧给「任务队列」面板留出的位置。
 *
 * 任务队列（v1.36 起）贴在画布**右上角** `top:8/right:12`，而头部是 48px 高的一条，
 * 于是面板会盖住头部右端 —— 保存状态徽标正好在那儿。面板自己按开合状态往画布容器上
 * 写 `--fisherai-task-queue-inset`（展开 306px / 收起成窄轨 44px），这里把徽标让出来。
 * 变量没写（不再是画布视图 / 面板没挂）时就是 0，等于原来的 `pr-3`。
 */
const HEADER_RIGHT_INSET = 'calc(12px + var(--fisherai-task-queue-inset, 0px))';

export function CanvasHeader(react: Runtime, props: Props, icons: HeaderIcons) {
  const h = react.createElement;
  const {
    canvasTitle,
    isEditingTitle,
    editingTitleValue,
    canvasTitleInputRef,
    setCanvasTitle,
    setIsEditingTitle,
    setEditingTitleValue,
    hasUnsavedChanges,
    lastSavedBy = '用户-',
    lastSavedRevision = null,
    isChatOpen = false,
    chatPanelWidth = 400,
  } = props;
  const [menuOpen, setMenuOpen] = react.useState(false);
  const [saving, setSaving] = react.useState(false);
  const [error, setError] = react.useState('');
  const live = react.useRef(props);
  live.current = props;
  const savingNow = react.useRef(false);
  const lifetime = react.useRef(0);
  const titleFinished = react.useRef(false);

  const commitTitle = () => {
    if (titleFinished.current) return;
    titleFinished.current = true;
    const value = editingTitleValue.trim();
    if (value) setCanvasTitle(value);
    else setEditingTitleValue(canvasTitle);
    setIsEditingTitle(false);
  };
  const titleKeyDown = (event: ReactTypes.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTitle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleFinished.current = true;
      setEditingTitleValue(canvasTitle);
      setIsEditingTitle(false);
    }
  };
  const startRename = () => {
    titleFinished.current = false;
    setEditingTitleValue(canvasTitle);
    setIsEditingTitle(true);
  };
  const save = async (exit = false) => {
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    setError('');
    const owner = lifetime.current;
    try {
      const result = await live.current.onSave();
      if (owner !== lifetime.current) return;
      if (exit) {
        const titleDraft =
          live.current.isEditingTitle &&
          live.current.editingTitleValue.trim() !== live.current.canvasTitle;
        if (!result || result.unchanged === false || titleDraft) {
          setError('还有编辑尚未保存，请保存后再退出');
          return;
        }
        live.current.onBack?.();
      }
    } catch (cause) {
      if (owner === lifetime.current)
        setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      if (owner === lifetime.current) {
        savingNow.current = false;
        setSaving(false);
      }
    }
  };

  // 上游靠 documentEpoch 重置「新建/切换项目」后的瞬时状态，行为保持不变。
  react.useLayoutEffect(() => {
    const owner = ++lifetime.current;
    savingNow.current = false;
    setSaving(false);
    titleFinished.current = false;
    setMenuOpen(false);
    setError('');
    return () => {
      lifetime.current = owner + 1;
    };
  }, [props.documentEpoch]);

  const status = (() => {
    if (saving)
      return h(
        Badge,
        { variant: 'secondary', className: 'gap-1 font-normal' },
        h(Spinner, { className: 'size-3' }),
        '保存中',
      );
    if (hasUnsavedChanges)
      return h(
        Badge,
        { variant: 'outline', className: 'font-normal text-[var(--af-warning)]' },
        '未保存',
      );
    if (props.lastAutoSaveTime)
      return h(
        Badge,
        { variant: 'outline', className: 'gap-1.5 font-normal text-muted-foreground' },
        h('span', { className: 'size-1.5 rounded-full bg-[var(--af-success)]' }),
        new Date(props.lastAutoSaveTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        h(
          'span',
          { className: 'text-muted-foreground/70' },
          `${lastSavedBy}${lastSavedRevision != null ? ` · r${lastSavedRevision}` : ''}`,
        ),
      );
    return h(
      Badge,
      { variant: 'outline', className: 'font-normal text-muted-foreground' },
      '尚未保存',
    );
  })();

  const left = h(
    'div',
    { className: 'pointer-events-auto flex min-w-0 items-center gap-2' },
    /**
     * 「返回项目库」按钮（v1.36）。
     *
     * 用户 2026-10-17 原话：「在画布左上角添加返回项目库按钮」。以前回项目列表只有
     * 品牌图下拉里的「退出项目」，而那个下拉在真机上整块被画布盖住（见文件头第 5 条），
     * 等于没有出口。所以这里放一个**一直可见**的按钮，不走下拉。
     */
    h(
      Button,
      {
        key: 'back-to-library',
        type: 'button',
        variant: 'ghost',
        size: 'xs',
        'aria-label': '返回项目库',
        'data-fisherai-back-to-library': 'true',
        title: '返回项目库（回到项目列表）',
        onClick: () => live.current.onBack?.(),
        className:
          'h-8 shrink-0 gap-1 pl-1.5 pr-2 text-xs font-medium text-muted-foreground ' +
          'hover:text-foreground',
      },
      h(ArrowLeftIcon, { key: 'i', className: 'size-3.5' }),
      h('span', { key: 'label' }, '项目库'),
    ),
    /**
     * 「项目归档」按钮（v1.42）。
     *
     * 用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。
     * 导出/导入是有状态的动作（要显示规模、落盘路径、导入回执），所以入口不直接动作、
     * 只是打开面板（`CanvasProjectArchive`，挂在 Controls 槽位）。
     * 图标按钮放在「项目库」右边：与项目本身相关的两个动作挨着，且不会挤到右侧
     * 保存状态（那边要给任务队列让位，见 HEADER_RIGHT_INSET）。
     */
    h(
      Button,
      {
        key: 'project-archive',
        type: 'button',
        variant: 'ghost',
        size: 'icon-sm',
        'aria-label': '项目归档',
        'data-fisherai-project-archive-trigger': 'true',
        title: '项目归档：导出 / 导入这个项目',
        onClick: () => requestCanvasProjectArchive(),
        className: 'size-8 shrink-0 text-muted-foreground hover:text-foreground',
      },
      h(ArchiveIcon, { className: 'size-4' }),
    ),
    h(
      DropdownMenu,
      { open: menuOpen, onOpenChange: setMenuOpen },
      h(DropdownMenuTrigger, {
        'aria-label': '项目菜单',
        className: cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'shrink-0 [&_img]:size-6 [&_img]:object-contain',
        ),
        children: h('img', { src: '/aifisher-mark-white.svg', alt: 'AIFISHER 画布 Logo' }),
      }),
      h(
        DropdownMenuContent,
        { align: 'start', className: 'w-52' },
        h(
          DropdownMenuItem,
          { disabled: saving, onSelect: () => void save(true) },
          iconNode(icons.SaveIcon, { 'data-icon': 'inline-start' }),
          '保存退出',
        ),
        h(
          DropdownMenuItem,
          { disabled: saving, onSelect: () => void save() },
          iconNode(icons.SaveIcon, { 'data-icon': 'inline-start' }),
          h('span', { className: 'flex-1' }, '保存'),
          h(Kbd, null, 'Ctrl S'),
        ),
        h(DropdownMenuSeparator, null),
        h(
          DropdownMenuItem,
          { onSelect: () => requestCanvasProjectArchive() },
          iconNode(icons.ImportIcon, { 'data-icon': 'inline-start' }),
          /**
           * v1.42：原来这一项是「导入项目 JSON」（直接弹 vendor 的隐藏 file input）。
           * 现在统一收到面板里 —— 导入/导出本来就该并排（导入完要知道导进来了什么，
           * 导出要知道存到哪），一个直接的 file input 把这些都吞掉了。
           * 面板也认旧版 `.json` 文档（host 侧的兼容读入），所以没丢能力。
           */
          '项目归档（导出 / 导入）',
        ),
        h(
          DropdownMenuItem,
          { onSelect: () => live.current.onBack?.() },
          iconNode(icons.BackIcon, { 'data-icon': 'inline-start' }),
          '退出项目',
        ),
      ),
    ),
    isEditingTitle
      ? h(Input, {
          ref: canvasTitleInputRef,
          type: 'text',
          value: editingTitleValue,
          onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
            setEditingTitleValue(event.target.value),
          onBlur: commitTitle,
          'aria-label': '项目名称',
          onKeyDown: titleKeyDown,
          className:
            'h-7 w-48 border-transparent bg-transparent px-1.5 text-[13px] font-semibold text-foreground shadow-none focus-visible:border-input',
        })
      : h(
          'button',
          {
            type: 'button',
            onClick: startRename,
            title: '点击重命名',
            className:
              'max-w-[42vw] truncate rounded-sm px-1.5 py-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
          },
          canvasTitle,
        ),
    /**
     * ComfyUI 状态胶囊的**左侧**停靠槽位（v1.36）。
     *
     * 用户原话「把右上角的 comfui 待启动移动到左边」：胶囊以前停靠在右侧工具条，
     * 和保存状态挤在同一角；现在挪到项目名右边。槽位本身必须是头部左侧工具条的
     * **直接子元素** —— vendor 的 comfyLogPanel（3.8n 补丁）会 `slot.append(host)`。
     * 它是一个空 div，胶囊没挂上来时宽度为 0，不影响布局。
     */
    h('div', {
      key: 'comfyui-slot',
      'data-fisherai-comfyui-slot': 'true',
      className: 'shrink-0 items-center',
      /**
       * display 读变量而不是写死 flex：画布很窄时（< 680px）任务队列会写 `none`
       * 把胶囊收起来，否则左边这组会钻到右上角的面板底下（见 CanvasTaskQueue 的宽度测量）。
       */
      style: { display: 'var(--fisherai-comfy-slot-display, flex)' },
    }),
  );

  const right = h(
    'div',
    { className: 'pointer-events-auto flex items-center gap-2' },
    // 账号插槽仍是**右侧**工具条的直接子元素（结构契约，回归脚本钉着）；
    // v1.36 起 ComfyUI 胶囊优先停到左侧槽位，这里只在左侧槽位缺失时兜底。
    h('div', { 'data-fisherai-account-center-slot': 'true' }),
    status,
  );

  return h(
    'div',
    {
      className: HEADER_CLASS,
      style: {
        width: isChatOpen ? `calc(100% - ${chatPanelWidth}px)` : '100%',
        // 任务队列贴在右上角时把保存状态让出来（见 HEADER_RIGHT_INSET 的说明）。
        paddingRight: HEADER_RIGHT_INSET,
      },
    },
    left,
    right,
    error
      ? h(
          'div',
          {
            role: 'alert',
            className:
              'pointer-events-none absolute left-3 top-[52px] z-[210] rounded-md border border-destructive bg-popover px-3 py-1.5 text-xs text-destructive shadow-md',
          },
          error,
        )
      : null,
  );
}

/** 排查/调试用名字（React DevTools 与错误里显示它）。 */
CanvasHeader.displayName = 'CanvasHeaderShadcn';
