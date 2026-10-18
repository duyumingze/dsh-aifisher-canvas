/**
 * CanvasPanel —— 主区域「无限画布」面板（DSH main slot 的组件）。
 *
 * 这一层是**薄壳**：只负责
 *   1. 渲染一个撑满主区域的容器；
 *   2. 打开时动态加载画布应用产物（lib/canvas/canvas-app.js）；
 *   3. 在容器里 mountCanvas，卸载时 dispose，加载失败给出可读的错误。
 *
 * 真正的画布是 AIFISHER 源码（vendor/aifisher）在**它自己的 React 19 root** 里跑的，
 * 与 DSH 这份 React 18 完全隔离（见 src/client/canvas/mount.tsx 的说明）。
 *
 * onExit：主区域被本面板占住之后，画布内部没有「回 DSH 对话」的出口
 * （画布自己的「退出项目」只回到项目列表）。所以由 DSH 这一层挂一个退出按钮，
 * 行为在 apply.ts 里收敛成 ctx.layout.selectPanel(null)。
 */
import * as React from 'react';

import {
  loadCanvasAppModule,
  type CanvasAppHandle,
} from './canvas-app-loader';
import { PanelExitButton } from './PanelExitButton';

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export interface CanvasPanelProps {
  /** 退出画布（回 DSH 对话）；由 apply.ts 接 ctx.layout.selectPanel(null)。 */
  onExit?: () => void;
}

export function CanvasPanel({ onExit }: CanvasPanelProps = {}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const handleRef = React.useRef<CanvasAppHandle | null>(null);
  const [status, setStatus] = React.useState<Status>({ kind: 'loading' });

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let handle: CanvasAppHandle | null = null;

    loadCanvasAppModule()
      .then((mod) => {
        if (disposed) return;
        handle = mod.mountCanvas(container);
        handleRef.current = handle;
        setStatus({ kind: 'ready' });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[aifisher-canvas] 画布应用加载失败', error);
        setStatus({ kind: 'error', message });
      });

    return () => {
      disposed = true;
      handleRef.current = null;
      try {
        handle?.dispose();
      } catch (error) {
        console.error('[aifisher-canvas] 画布卸载失败', error);
      }
    };
  }, []);

  return React.createElement(
    'div',
    {
      'data-dsh-aifisher-canvas': 'panel',
      /**
       * 这里必须**自己**是定位容器（position:relative），不能直接 absolute inset:0：
       * DSH 的 main slot 渲染在 ui-layout 的 centerCol 里，而 centerCol 本身没有 position，
       * 最近的可定位祖先是整个 AppFrame（position:relative）。若在本层用 absolute，
       * 画布会以整个框架为基准定位 → 盖住左侧边栏。
       */
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: '#0e0f13',
      },
    },
    React.createElement('div', {
      ref: containerRef,
      className: 'af-canvas-mount',
      'data-dsh-aifisher-canvas': 'mount',
      style: { position: 'absolute', inset: 0 },
    }),
    React.createElement(PanelExitButton, {
      id: 'canvas',
      label: '退出画布',
      // 画布自动保存（改动后约 1.2s 落库），所以退出不需要先点「保存退出」
      title: '退出画布，回到 DSH 对话（画布会自动保存）',
      onExit,
      placement: 'bottom-right',
    }),
    status.kind === 'loading'
      ? React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#8b8f98',
              font: '13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              pointerEvents: 'none',
            },
          },
          '正在加载画布…',
        )
      : null,
    status.kind === 'error'
      ? React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              color: '#f2b8b5',
              font: '13px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              textAlign: 'center',
            },
          },
          React.createElement('strong', null, '画布应用加载失败'),
          React.createElement('code', { style: { color: '#cfd3dc' } }, status.message),
          React.createElement(
            'span',
            { style: { color: '#8b8f98' } },
            '确认已执行 pnpm build（产物 lib/canvas/canvas-app.js），然后刷新页面。',
          ),
        )
      : null,
  );
}
