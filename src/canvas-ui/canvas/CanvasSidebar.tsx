/**
 * 画布左侧节点工具条（shadcn/ui 重设计版）。
 *
 * 替换 vendor 的 `dialogs/canvasSidebar.tsx`。
 * 结构契约（回归依赖，改前先看 docs/canvas-ui-shadcn.md）：
 *   1. 根元素 class 含 `absolute left-4 top-1/2`（scripts/test-panel-exit.mjs 断言）；
 *   2. 「添加节点」按钮的 aria-label 必须是这四个字：browser-check 的
 *      workflow-node 场景就是靠「aria-label 含『添加节点』」找到它并点开菜单的；
 *      它下面另有一个独立的「搜索节点」按钮（`data-fisherai-node-search-trigger`），
 *      两者必须是两个 button，不要合并成一个带下拉箭头的按钮；
 *   3. 各动作按钮保留原 aria-label（资产 / 工作流节点 / ComfyUI 工作流配置 / 历史 / 设置）：
 *      browser-check 的 settings 场景靠「设置」按钮打开设置对话框；
 *      v1.16 起原来的「SKILL 社区」入口换成「ComfyUI 工作流配置」（用户截图要求：
 *      「将 skill 社区替换成 ComfyUI 工作流配置」），点它打开
 *      src/canvas-ui/canvas/ComfyWorkflowConfig.tsx 那个面板；
 *   4. 工具提示仍使用 vendor 的 Tooltip（tippy 实现，上游组件都读同一个全局），
 *      避免与画布已装的那套提示系统并存两套浮层。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数），不要用本文件 import 的那份 ——
 *    产物里 React 有两份副本，用错那分量 React 19 不报错也不渲染（头部/工具条会整块消失）。
 */
import * as ReactTypes from 'react';
import {
  HistoryIcon,
  ImageIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  WorkflowIcon,
} from 'lucide-react';

import { buttonVariants } from '@/ui/button';
import { Separator } from '@/ui/separator';
import { cn } from '@/lib/utils';

type Runtime = Pick<typeof ReactTypes, 'createElement'>;

interface Props {
  onAddClick: ReactTypes.MouseEventHandler;
  onWorkflowsClick: ReactTypes.MouseEventHandler;
  onWorkflowPresetsClick: ReactTypes.MouseEventHandler;
  /** 打开「ComfyUI 工作流配置」面板（v1.16，替换原来的 SKILL 社区入口）。 */
  onWorkflowConfigClick?(): void;
  /**
   * 打开「工作流节点」面板（v1.28）。
   *
   * 用户报障原话：「左侧工作流节点做错了，点击后是在画布右键的样子。工作流节点里放置配置好的
   * comfui，可以自定义配图」—— 这个按钮以前被接到 `onAddClick`（= 画布右键菜单），是错的。
   * 不给这个回调时**不回落**到 onAddClick（那正是那个 bug），宁可点了不动。
   */
  onWorkflowNodesClick?(): void;
  onHistoryClick: ReactTypes.MouseEventHandler;
  onAssetsClick: ReactTypes.MouseEventHandler;
  onSettingsClick?(): void;
  onToolsOpen?(): void;
  /** 打开「搜索节点」面板（Shift+A 的鼠标入口）。 */
  onSearchClick?(): void;
  currentUserName?: string;
  currentUserColor?: string;
}

export function CanvasSidebar(
  react: Runtime,
  props: Props,
  components: {
    Tooltip: ReactTypes.ComponentType<Record<string, unknown>>;
    avatarClass(name: string, size: number): string;
    avatarText(name: string): string;
  },
) {
  const h = react.createElement;
  const Tooltip = components.Tooltip as ReactTypes.ComponentType<Record<string, unknown>>;
  const name = props.currentUserName ?? '协作者';

  const railClass =
    'absolute left-4 top-1/2 z-50 flex -translate-y-1/2 flex-col items-center gap-1 ' +
    'rounded-full border border-border bg-surface-raised/90 p-1.5 shadow-lg backdrop-blur-sm ' +
    'transition-colors duration-300';

  const actionButton = (
    label: string,
    icon: ReactTypes.ReactNode,
    onClick: ReactTypes.MouseEventHandler,
    extra?: Record<string, unknown>,
  ) =>
    h(
      Tooltip,
      { key: label, text: label, position: 'right' },
      h(
        'button',
        {
          type: 'button',
          'aria-label': label,
          onClick,
          className: cn(
            buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
            'rounded-full text-muted-foreground hover:text-foreground',
          ),
          ...extra,
        },
        icon,
      ),
    );

  return h(
    'div',
    { role: 'toolbar', 'aria-label': '画布工具', className: railClass },
    /**
     * 「添加节点」旁边是「搜索节点」（Shift+A 的鼠标入口，打开同一个目录的搜索版）。
     * 单独一个按钮而不是塞进下拉：上游的真机检查靠 aria-label="添加节点" 找按钮并点开菜单，
     * 把菜单箭头塞进那个按钮的容器里会连累这条既有断言。
     */
    h(
      'div',
      { key: 'add', className: 'flex flex-col items-center gap-1' },
      h(
        Tooltip,
        { text: '添加节点', position: 'right' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': '添加节点',
            onClick: props.onAddClick,
            className: cn(
              buttonVariants({ variant: 'default', size: 'icon-lg' }),
              'rounded-full shadow-sm',
            ),
          },
          h(PlusIcon, { key: 'i' }),
        ),
      ),
      h(
        Tooltip,
        { key: 'search', text: '搜索节点 / 工作流（Shift + A）', position: 'right' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': '搜索节点',
            'data-fisherai-node-search-trigger': 'true',
            onClick: () => props.onSearchClick?.(),
            className: cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'rounded-full text-muted-foreground hover:text-foreground',
            ),
          },
          h(SearchIcon, { key: 'i', className: 'size-4' }),
        ),
      ),
    ),
    h(Separator, { key: 'sep', orientation: 'horizontal', className: 'my-1 w-6' }),
    h(
      'div',
      { key: 'actions', className: 'flex flex-col items-center gap-0.5' },
      actionButton('资产', h(ImageIcon, { key: 'i' }), props.onAssetsClick),
      h(
        Tooltip,
        { key: 'workflow-nodes', text: '工作流节点', position: 'right' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': '工作流节点',
            'data-fisherai-workflow-node-trigger': 'true',
            // v1.28：这里以前接 onAddClick（= 画布右键菜单），点出来的是右键菜单的样子；
            // 现在打开「工作流节点」面板（配置好的 ComfyUI 工作流 + 自定义配图）。
            onClick: () => props.onWorkflowNodesClick?.(),
            className: cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'rounded-full text-muted-foreground hover:text-foreground',
            ),
          },
          h(WorkflowIcon, { key: 'i' }),
        ),
      ),
      h(
        Tooltip,
        { key: 'workflow-config', text: 'ComfyUI 工作流配置', position: 'right' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': 'ComfyUI 工作流配置',
            'data-fisherai-workflow-config-trigger': 'true',
            onClick: () => props.onWorkflowConfigClick?.(),
            className: cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              'rounded-full text-muted-foreground hover:text-foreground',
            ),
          },
          h(SlidersHorizontalIcon, { key: 'i' }),
        ),
      ),
      actionButton('历史', h(HistoryIcon, { key: 'i' }), props.onHistoryClick),
      actionButton('设置', h(SettingsIcon, { key: 'i' }), () => {
        props.onToolsOpen?.();
        props.onSettingsClick?.();
      }),
    ),
    h(Separator, { key: 'sep2', orientation: 'horizontal', className: 'my-1 w-6' }),
    h(
      Tooltip,
      { key: 'user', text: `当前用户 ${name}`, position: 'right' },
      h(
        'div',
        {
          'data-fisherai-profile-avatar': 'local',
          className: cn(
            'flex size-8 items-center justify-center rounded-full border border-input',
            'text-xs font-bold text-[var(--af-media-text)]',
            components.avatarClass(name, 32),
          ),
          style: { background: props.currentUserColor ?? '#60a5fa' },
        },
        components.avatarText(name),
      ),
    ),
  );
}

CanvasSidebar.displayName = 'CanvasSidebarShadcn';
