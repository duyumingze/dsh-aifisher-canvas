/**
 * 画布内 shadcn/ui 组件共用的 React 实例。
 *
 * 为什么需要这个文件（重要，踩过）：
 *   插件产物里存在**两份 React**：vendor 画布包（AIFISHER 自带那份）与
 *   src/canvas-ui 里 shadcn 组件 import 的这份。两份的 hooks 分发器互不相通，
 *   一旦某组件用「自己那份」createElement 造元素、却被「另一份」渲染器渲染，
 *   React 19 会抛 #130（element type is invalid）或干脆什么都不渲染。
 *
 * 所以画布内的 shadcn 组件统一通过下面的 `h` 造元素；JSX 也走它（打包器被配置成
 * `jsxImportSource = @/lib/react`，见 tsdown.config.ts 与 tsconfig.json 的说明）。
 * 装配层在渲染前用 `useCanvasReact()` 登记「正在渲染画布的那份 React」。
 */
import * as ReactRuntime from 'react';

export type CanvasReact = typeof ReactRuntime;

let active: CanvasReact | null = null;

/** 画布装配层在渲染前登记：把渲染器认的那份 React 交进来。 */
export function useCanvasReact(runtime: CanvasReact): void {
  active = runtime;
}

/**
 * 元素工厂：JSX 的 jsx/jsxs 与手写 createElement 都走它。
 * props 里可能带 children（JSX 的 jsxs 会把 children 放进 props），
 * 而 createElement 的第三参数才是 children —— 这里统一成 createElement 的形式。
 */
export function h(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) {
  const runtime = (active ?? ReactRuntime) as CanvasReact;
  const { children: propChildren, ...rest } = (props ?? {}) as Record<string, unknown> & {
    children?: unknown;
  };
  const create = runtime.createElement as unknown as (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;
  if (children.length > 0) return create(type, rest, ...children);
  if (propChildren !== undefined) return create(type, rest, propChildren);
  return create(type, rest);
}

export const jsx = h;
export const jsxs = h;
export const jsxDEV = h;
export { ReactRuntime as React };
