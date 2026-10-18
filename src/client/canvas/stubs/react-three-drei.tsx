/**
 * `@react-three/drei` 的替身（见 stubs/three.ts 的说明）。
 */
import * as React from 'react';

/** useTexture：原版返回 THREE.Texture，这里返回空对象，调用方只在 3D 场景里用它。 */
export function useTexture(): Record<string, unknown> {
  return {};
}

/** OrbitControls：空组件。 */
export function OrbitControls(): null {
  return null;
}

/** Sphere：空组件。 */
export function Sphere(): null {
  return null;
}

/** 有些 drei 版本会被按命名空间使用，这里给个兜底导出。 */
export const dreiStub = {
  useTexture,
  OrbitControls,
  Sphere,
  default: React.Fragment,
};
