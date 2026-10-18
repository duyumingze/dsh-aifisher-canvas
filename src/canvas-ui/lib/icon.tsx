/**
 * shadcn 组件里的图标适配。
 *
 * shadcn 的约定是图标带 `data-icon`（按钮/菜单项靠它算内边距与尺寸），
 * 但 vendor 注入进来的是 **lucide 组件**（约定的 props 是 size/className/strokeWidth），
 * 而 lucide 的 props 类型里没有 `data-icon` —— 直接 createElement 会在类型上报错。
 * 这里把图标工厂收敛成一个「props 走宽松类型」的函数，运行时把 data-icon 忠实透传。
 */
import * as React from 'react';

export type CanvasIconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
  /** shadcn 约定：图标在 Button / DropdownMenuItem 里的位置。 */
  'data-icon'?: 'inline-start' | 'inline-end';
  key?: React.Key;
};

/** 渲染一个图标元素（带 shadcn 的 data-icon 约定）。 */
export function iconNode(Icon: unknown, props: CanvasIconProps = {}) {
  return React.createElement(Icon as React.ComponentType<Record<string, unknown>>, props);
}
