/**
 * `jsxImportSource` 目标：把画布内 shadcn 组件的 JSX 收拢到同一份 React 上。
 *
 * 背景见 ./react.ts：产物里有两份 React，混用会让 React 19 抛 #130。
 * tsconfig 的 `jsxImportSource` 只对 `src/canvas-ui/**` 生效（host 半与 client 半
 * 仍走标准 `react/jsx-runtime`，那边没有双 React 问题），实现方式是 tsdown 的
 * `jsx.importSource` 选项 —— 见 tsdown.config.ts 的说明。
 *
 * 这个文件只是类型占位：真实运行时的 jsx/jsxs/Fragment 由打包器注入的
 * `@/lib/react` 提供（`h` 工厂）。之所以还要存在，是因为编辑器/类型检查
 * 需要一个可解析的模块路径。
 */
export { h as jsx, h as jsxs, h as jsxDEV } from './react';
export { Fragment } from 'react';
