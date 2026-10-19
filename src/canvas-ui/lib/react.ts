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

/**
 * 画布组件的「宽松元素工厂」——只在类型层放宽 props，运行时仍是传入的那份
 * `react.createElement`（组件签名里的注入 React）。
 *
 * 为什么需要它：
 *   1. 画布组件大量用 `data-fisherai-*` 身份属性当回归/真机选择器（结构契约见
 *      docs/canvas-ui-shadcn.md），但 React 的组件 props 类型不认任意 `data-*` 键，
 *      `react.createElement(Button, { 'data-…': '…' })` 会被 TS2769 拒绝；
 *   2. `react.createElement(Component, props)` 对「带默认值的可选参数组件」推不出
 *      P（TS 会推成 `{}`），props 里每个字段都变成多余属性。
 * 这里只放行「运行时合法、类型上多余」的 props，不改运行时。
 */
export type CanvasCreateElement = (
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
) => ReactRuntime.ReactElement;

/** 组件签名里注入的 React 只需要一个 createElement（各文件都收窄成 Pick<typeof React, …>）。 */
export type CanvasRuntimeLike = { createElement: unknown };

export function createElement(react: CanvasRuntimeLike): CanvasCreateElement {
  return react.createElement as unknown as CanvasCreateElement;
}
