/**
 * PanelExitButton —— DSH 主区域面板的「退出」按钮。
 *
 * 为什么需要它：DSH 的 `main` 是 keyed slot，面板一旦被选中就**整块占住主区域**
 * （对话被换掉）。DSH 自己只提供「在侧边栏点别的面板」这一条隐式退路，
 * 面板内部没有任何返回控件；画布又是撑满全屏的编辑器，用户进来以后
 * 找不到回对话的路。这个按钮就是那条明确的路：调 `ctx.layout.selectPanel(null)`
 * 把主区域切回 Conversation。
 *
 * 位置默认右下角：画布自带一条 `fixed top-0` 的头部（logo/项目菜单/保存状态），
 * 按钮放右上会压住它；右下角在画布里是空的（viewport 控件在左下）。
 *
 * 只用 React.createElement、不写 JSX：client 半的产物只从 DSH 模块表拿 `react`
 * 一个说明符，写 JSX 会额外 require('react/jsx-runtime')（见 README「产物格式」）。
 */
import * as React from 'react';

export interface PanelExitButtonProps {
  /** 按钮文字，例如「退出画布」。 */
  label: string;
  /** 悬停提示，默认与 label 相同。 */
  title?: string;
  /** 点击行为；缺省（宿主没给 layout 服务）时按钮不渲染。 */
  onExit?: () => void;
  /** 面板内的贴边位置。 */
  placement?: 'bottom-right' | 'bottom-left' | 'top-right';
  /** 便于回归测试定位：data-dsh-aifisher-exit=<id>。 */
  id?: string;
}

const PLACEMENT: Record<
  NonNullable<PanelExitButtonProps['placement']>,
  React.CSSProperties
> = {
  'bottom-right': { right: 20, bottom: 20 },
  'bottom-left': { left: 20, bottom: 20 },
  'top-right': { right: 20, top: 20 },
};

/** 左箭头（回对话）。 */
function ArrowLeftIcon() {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 14,
      height: 14,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    React.createElement('path', { d: 'M8.5 3.5 4 8l4.5 4.5' }),
    React.createElement('path', { d: 'M4 8h8' }),
  );
}

export function PanelExitButton({
  label,
  title,
  onExit,
  placement = 'bottom-right',
  id,
}: PanelExitButtonProps) {
  const [hover, setHover] = React.useState(false);
  if (typeof onExit !== 'function') return null;

  return React.createElement(
    'button',
    {
      type: 'button',
      'data-dsh-aifisher-exit': id ?? 'panel',
      'aria-label': title ?? label,
      title: title ?? label,
      onClick: onExit,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onFocus: () => setHover(true),
      onBlur: () => setHover(false),
      style: {
        position: 'absolute',
        ...PLACEMENT[placement],
        // 画布的浮层是 z-50（头部/缩放控件），这里要盖在它们之上；
        // 画布自己的对话框是 z-[100] 以上，仍然盖住本按钮（这是想要的层级）。
        zIndex: 60,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 12px',
        borderRadius: 999,
        border: `1px solid ${hover ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)'}`,
        background: hover ? 'rgba(38,41,50,0.95)' : 'rgba(20,22,28,0.82)',
        color: hover ? '#f4f6fa' : '#d6dae2',
        font: '13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei UI", sans-serif',
        cursor: 'pointer',
        backdropFilter: 'blur(6px)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
        transition: 'background 120ms, border-color 120ms, color 120ms',
      },
    },
    ArrowLeftIcon(),
    React.createElement('span', null, label),
  );
}
