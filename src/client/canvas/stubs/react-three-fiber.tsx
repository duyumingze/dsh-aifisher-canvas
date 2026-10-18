/**
 * `@react-three/fiber` 的替身（见 stubs/three.ts 的说明）。
 *
 * 导出名与 R3F 对齐，方便 AIFISHER 源码原样 import；
 * Canvas 退化成一块占位区，并给出「全景预览未移植」的提示，而不是崩掉整个裁剪面板。
 */
import * as React from 'react';

export interface ThreeCanvasProps {
  children?: React.ReactNode;
  [key: string]: unknown;
}

/** R3F 的 <Canvas> 替身：不渲染 WebGL，只显示说明。 */
export function Canvas(_props: ThreeCanvasProps) {
  return React.createElement(
    'div',
    {
      'data-aifisher-stub': 'r3f-canvas',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        color: '#8b8f98',
        fontSize: 12,
        background: '#0b0c10',
      },
    },
    '全景预览未随插件移植（three.js 已剔除）',
  );
}

/** R3F 的 useThree：返回一份够用的假 state，避免解构即崩。 */
export function useThree(): Record<string, unknown> {
  return {
    gl: {},
    scene: {},
    camera: {},
    size: { width: 0, height: 0 },
    invalidate: () => {},
  };
}

export function useFrame(): void {
  /* 无渲染循环 */
}
