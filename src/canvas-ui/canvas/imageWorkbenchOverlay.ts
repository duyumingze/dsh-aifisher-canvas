/**
 * 图片工作台的浮层定位（canvas-ui 里所有「整块画布浮层」共用）。
 *
 * 为什么不用 `fixed inset-0`：画布浮层 portal 到 `.af-canvas-mount`，而 DSH 那边
 * 容器链路上可能有 transform / filter（会变成 fixed 的包含块），实测 `inset-0` 量出来
 * 是 1416×808 而不是窗口的 1440×900 —— 于是浮层左侧压住 DSH 侧边栏、右边留一条缝。
 * 这里改成「按画布容器的真实矩形定位」：fixed + 量出来的 left/top/width/height，
 * 于是工作台永远严丝合缝地盖住**画布**（不越到 DSH 的侧边栏上），容器尺寸变化时跟着变。
 *
 * jsdom 里 canvasPortalTarget 的 rect 全是 0 —— 回落到整个视口，回归只验 DOM 结构，
 * 真机几何由 scripts/browser-check.mjs 的 image-editor / image-annotate 场景量。
 */
import type * as ReactTypes from 'react';

import { canvasPortalTarget } from '@/lib/portal';

type Runtime = Pick<typeof ReactTypes, 'useState' | 'useEffect'>;

export interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 量画布容器的矩形；量不到（jsdom / 还没挂载）就用视口。 */
export function canvasOverlayBox(): OverlayBox {
  const target = canvasPortalTarget();
  const rect = target?.getBoundingClientRect();
  if (!rect || rect.width < 2 || rect.height < 2)
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** 跟随画布容器尺寸的浮层矩形（窗口 resize + 容器 ResizeObserver 都会重算）。 */
export function useCanvasOverlayBox(react: Runtime): OverlayBox {
  const [box, setBox] = react.useState<OverlayBox>(() => canvasOverlayBox());
  react.useEffect(() => {
    const measure = () => setBox(canvasOverlayBox());
    measure();
    const target = canvasPortalTarget();
    const observer =
      typeof ResizeObserver !== 'undefined' && target ? new ResizeObserver(measure) : null;
    if (target) observer?.observe(target);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return box;
}
