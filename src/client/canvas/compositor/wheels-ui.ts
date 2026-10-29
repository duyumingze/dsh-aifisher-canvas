/**
 * 四轮调色的节点内 UI（照 Blender 4 Color Balance 节点，用户 2026-10-29 给的参照图）。
 *
 * 每个轮子的结构（和参照图一一对应）：
 *   暗部 ↺ / 色轮（色相环 + 十字准星 + 白点 + 外圈亮度环）
 *   [0.00][0.00][0.00][0.00]（亮度 + R/G/B）
 *   四条彩色细滑轨（白 / R / G / B）
 *   一条带刻度的亮度长条
 *
 * 交互：
 *   · 盘内拖动 = 色度（拖动不改平均亮度，三个通道此消彼长）
 *   · 盘外圈上下拖 = 亮度（三通道同时加减）
 *   · 数字框可直接输入；细滑轨 / 长条可拖（双击复位）
 *   · 标题右边 ↺ = 整个轮子回中性
 *
 * 为什么单独一层：editor.ts 已经 2600 行，色轮的画布绘制与指针手势自成一块；
 * 这里只依赖 graph 的节点参数与 wheels.ts 的纯数学，不起引擎、不碰求值。
 */

import { paramsOf, type CompositorNode } from './graph';
import {
  WHEEL_CHROMA,
  WHEEL_RANGES,
  clampWheelValue,
  formatWheelValue,
  wheelChannelKeys,
  wheelChannels,
  wheelDotFromRgb,
  wheelLevel,
  wheelLevelFraction,
  wheelRgbFromDot,
  type WheelRangeSpec,
} from './wheels';

/** 四轮调色卡片比普通节点宽得多：四个轮子横排（方案 C 的稿面是 792）。 */
export const WHEEL_NODE_WIDTH = 792;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 色轮覆盖层的逻辑尺寸（CSS px）；盘面是 CSS 梯度，指针坐标按 rect 折算回这一套。 */
const WHEEL_SIZE = 112;
const CENTER = WHEEL_SIZE / 2;
const DISC_RADIUS = 38;
const RING_RADIUS = 47;
/** 白点离盘心的最大距离（留一点边，别贴到盘边）。 */
const DOT_LIMIT = DISC_RADIUS * 0.86;
/** 外圈拖动：整段量程对应 220px 的上下位移。 */
const RING_DRAG_RANGE_PX = 220;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** 合成事件（回归里手搓的 PointerEvent）没有真实 pointerId，捕获失败不该打断拖拽。 */
function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // 没有真实指针的合成事件 / jsdom：继续用手指自己派发的 move 事件
  }
}

/**
 * 外圈亮度弧：从正下方（6 点）顺时针扫过。
 *
 * 整段量程只占半圈（180°）：参照图里亮度 0 / 1 / 25 的中性位置都是
 * 「6 点 → 3 点」这四分之一圈左右的灰色弧，扫满 360° 会糊成一圈白环。
 */
function ringArcPath(fraction: number): string {
  if (fraction <= 0.001) return '';
  const sweep = fraction * 180;
  const steps = Math.max(3, Math.ceil(sweep / 6));
  const points: string[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = ((180 + (sweep * index) / steps) * Math.PI) / 180;
    const x = CENTER - RING_RADIUS * Math.sin(angle);
    const y = CENTER - RING_RADIUS * Math.cos(angle);
    points.push(`${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join(' ');
}

type ChannelKey = 'master' | 'R' | 'G' | 'B';
const CHANNEL_ORDER: Array<'R' | 'G' | 'B'> = ['R', 'G', 'B'];

interface ChannelField {
  channel: ChannelKey;
  input: HTMLInputElement;
}

interface MiniSlider {
  channel: ChannelKey;
  element: HTMLElement;
  fill: HTMLElement;
}

function createWheelBlock(
  spec: WheelRangeSpec,
  node: CompositorNode,
  setParam: (key: string, value: number) => void,
): HTMLElement {
  const keys = wheelChannelKeys(spec);
  const showMaster = spec.key !== 'offset';

  const block = document.createElement('div');
  block.className = 'cg-wheel-block';
  block.dataset.range = spec.key;

  // ---- 标题：准星图标 + 名字 + 复位
  const head = document.createElement('div');
  head.className = 'cg-wheel-head';
  const mark = document.createElement('span');
  mark.className = 'cg-wheel-mark';
  mark.title = '色轮';
  const name = document.createElement('span');
  name.className = 'cg-wheel-name';
  name.textContent = spec.label;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'cg-wheel-reset cg-wheel-control';
  reset.textContent = '↺';
  reset.title = `${spec.label}：恢复中性（${formatWheelValue(spec.neutral)}）`;
  head.append(mark, name, reset);

  // ---- 色轮（CSS 梯度盘面 + SVG 覆盖层：亮度弧 / 白点）
  const disc = document.createElement('div');
  disc.className = 'cg-wheel-disc';
  // 盘面不再是 canvas：色相是 conic-gradient、明度是 radial-gradient，
  // 所以节点缩放到 300% 也只是按矢量重画（canvas 会被拉伸成一块糊的位图）。
  const wheel = document.createElement('div');
  wheel.className = 'cg-wheel cg-wheel-control';
  wheel.dataset.range = spec.key;
  wheel.title = '盘内拖动 = 色偏（不改亮度）· 盘外圈上下拖 = 亮度';
  wheel.setAttribute('role', 'slider');
  wheel.setAttribute('aria-label', `${spec.label}色轮`);

  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.setAttribute('class', 'cg-wheel-overlay');
  overlay.setAttribute('viewBox', `0 0 ${WHEEL_SIZE} ${WHEEL_SIZE}`);
  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('class', 'cg-wheel-arc');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke-linecap', 'round');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'cg-wheel-dot');
  dot.setAttribute('r', '3.6');
  dot.setAttribute('cx', String(CENTER));
  dot.setAttribute('cy', String(CENTER));
  overlay.append(arc, dot);
  disc.append(wheel, overlay);

  // ---- 数字行：亮度 + R/G/B（偏移只有 R/G/B）
  const values = document.createElement('div');
  values.className = 'cg-wheel-values';
  if (!showMaster) values.classList.add('cg-wheel-values-3');
  const fields: ChannelField[] = [];
  const makeField = (channel: ChannelKey): void => {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'cg-wheel-value cg-wheel-control';
    input.step = '0.01';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.dataset.range = spec.key;
    input.dataset.channel = channel;
    input.title =
      channel === 'master'
        ? `${spec.label}亮度：三通道同时加减`
        : `${spec.label} ${channel} 通道：直接输入`;
    values.append(input);
    fields.push({ channel, input });
  };
  if (showMaster) makeField('master');
  for (const channel of CHANNEL_ORDER) makeField(channel);

  // ---- 细滑轨（白 / R / G / B；偏移三条）
  const minis = document.createElement('div');
  minis.className = 'cg-wheel-minis';
  if (!showMaster) minis.classList.add('cg-wheel-minis-3');
  const miniStrips: MiniSlider[] = [];
  const makeMini = (channel: ChannelKey): void => {
    const strip = document.createElement('div');
    strip.className = `cg-wheel-mini cg-wheel-control cg-wheel-mini-${channel}`;
    strip.dataset.range = spec.key;
    strip.dataset.channel = channel;
    strip.title = `${spec.label}${channel === 'master' ? '亮度' : ` ${channel}`}（拖动 · 双击复位）`;
    const fill = document.createElement('span');
    fill.className = 'cg-wheel-mini-fill';
    strip.append(fill);
    minis.append(strip);
    miniStrips.push({ channel, element: strip, fill });
  };
  if (showMaster) makeMini('master');
  for (const channel of CHANNEL_ORDER) makeMini(channel);

  // ---- 亮度长条（参照图最下面那条带刻度的小条）
  const bar = document.createElement('div');
  bar.className = 'cg-wheel-bar cg-wheel-control';
  bar.dataset.range = spec.key;
  bar.title = `${spec.label}亮度（拖动 · 双击复位）`;
  const barFill = document.createElement('span');
  barFill.className = 'cg-wheel-bar-fill';
  const barKnob = document.createElement('span');
  barKnob.className = 'cg-wheel-bar-knob';
  bar.append(barFill, barKnob);

  block.append(head, disc, values, minis, bar);

  // ---- 读写参数 --------------------------------------------------------
  const currentChannels = (): [number, number, number] => wheelChannels(spec, paramsOf(node));

  const writeChannels = (channels: readonly [number, number, number]): void => {
    keys.forEach((key, index) => {
      setParam(key, Number(clampWheelValue(spec, channels[index]).toFixed(4)));
    });
  };

  /** 只改平均亮度：三通道同时加减（保留色偏），越界的通道单独钳。 */
  const writeLevel = (level: number): void => {
    const channels = currentChannels();
    const delta = clampWheelValue(spec, level) - wheelLevel(channels);
    writeChannels([
      clampWheelValue(spec, channels[0] + delta),
      clampWheelValue(spec, channels[1] + delta),
      clampWheelValue(spec, channels[2] + delta),
    ]);
    paint();
  };

  const paint = (): void => {
    const channels = currentChannels();
    const level = wheelLevel(channels);
    const dotPosition = wheelDotFromRgb(channels);
    dot.setAttribute('cx', (CENTER + dotPosition.x * DOT_LIMIT).toFixed(2));
    dot.setAttribute('cy', (CENTER - dotPosition.y * DOT_LIMIT).toFixed(2));
    arc.setAttribute('d', ringArcPath(wheelLevelFraction(spec, level)));
    for (const field of fields) {
      const value =
        field.channel === 'master' ? level : channels[CHANNEL_ORDER.indexOf(field.channel)];
      field.input.value = formatWheelValue(value);
    }
    for (const strip of miniStrips) {
      const value =
        strip.channel === 'master' ? level : channels[CHANNEL_ORDER.indexOf(strip.channel)];
      strip.fill.style.width = `${(wheelLevelFraction(spec, value) * 100).toFixed(2)}%`;
    }
    const levelPercent = (wheelLevelFraction(spec, level) * 100).toFixed(2);
    barFill.style.width = `${levelPercent}%`;
    barKnob.style.left = `${levelPercent}%`;
  };

  // ---- 盘内 / 盘外圈拖动 -----------------------------------------------
  /** 指针 → 盘面逻辑坐标（合成器会整体缩放，所以按 rect 比例折算回 112）。 */
  const localPoint = (
    element: HTMLElement,
    clientX: number,
    clientY: number,
  ): { x: number; y: number } => {
    const rect = element.getBoundingClientRect();
    const width = rect.width || WHEEL_SIZE;
    const height = rect.height || WHEEL_SIZE;
    return {
      x: ((clientX - rect.left) / width) * WHEEL_SIZE,
      y: ((clientY - rect.top) / height) * WHEEL_SIZE,
    };
  };

  const dragDotTo = (clientX: number, clientY: number): void => {
    const point = localPoint(wheel, clientX, clientY);
    let x = (point.x - CENTER) / DOT_LIMIT;
    let y = -(point.y - CENTER) / DOT_LIMIT;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    const level = wheelLevel(currentChannels());
    writeChannels(wheelRgbFromDot(x, y, level));
    paint();
  };

  let wheelDrag: { mode: 'dot' | 'ring'; startY: number; startLevel: number } | null = null;
  wheel.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const point = localPoint(wheel, event.clientX, event.clientY);
    const magnitude = Math.hypot(point.x - CENTER, point.y - CENTER);
    if (magnitude <= DISC_RADIUS + 5) {
      wheelDrag = { mode: 'dot', startY: event.clientY, startLevel: wheelLevel(currentChannels()) };
      dragDotTo(event.clientX, event.clientY);
    } else {
      wheelDrag = {
        mode: 'ring',
        startY: event.clientY,
        startLevel: wheelLevel(currentChannels()),
      };
    }
    capturePointer(wheel, event.pointerId);
  });

  const onPointerMove = (event: PointerEvent): void => {
    if (!wheelDrag) return;
    if (wheelDrag.mode === 'ring') {
      const span = spec.max - spec.min;
      const scale = (event.shiftKey || event.altKey ? 0.15 : 1) * (span / RING_DRAG_RANGE_PX);
      writeLevel(wheelDrag.startLevel - (event.clientY - wheelDrag.startY) * scale);
    } else {
      dragDotTo(event.clientX, event.clientY);
    }
  };
  const onPointerUp = (): void => {
    wheelDrag = null;
  };
  wheel.addEventListener('pointermove', onPointerMove);
  wheel.addEventListener('pointerup', onPointerUp);
  wheel.addEventListener('pointercancel', onPointerUp);
  wheel.addEventListener('lostpointercapture', onPointerUp);

  // ---- 数字框 ----------------------------------------------------------
  for (const field of fields) {
    field.input.addEventListener('pointerdown', (event) => event.stopPropagation());
    field.input.addEventListener('focus', () => field.input.select());
    field.input.addEventListener('change', () => {
      const text = field.input.value.trim();
      const parsed = text ? Number(text) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        paint();
        return;
      }
      if (field.channel === 'master') {
        writeLevel(parsed);
      } else {
        const channels = currentChannels();
        channels[CHANNEL_ORDER.indexOf(field.channel)] = clampWheelValue(spec, parsed);
        writeChannels(channels);
        paint();
      }
    });
    field.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      field.input.blur();
    });
  }

  // ---- 细滑轨：拖动设绝对值，双击回中性 --------------------------------
  for (const strip of miniStrips) {
    let dragging = false;
    const apply = (clientX: number): void => {
      const rect = strip.element.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const value = spec.min + fraction * (spec.max - spec.min);
      if (strip.channel === 'master') {
        writeLevel(value);
        return;
      }
      const channels = currentChannels();
      channels[CHANNEL_ORDER.indexOf(strip.channel)] = clampWheelValue(spec, value);
      writeChannels(channels);
      paint();
    };
    strip.element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      capturePointer(strip.element, event.pointerId);
      apply(event.clientX);
    });
    strip.element.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      apply(event.clientX);
    });
    const stop = (): void => {
      dragging = false;
    };
    strip.element.addEventListener('pointerup', stop);
    strip.element.addEventListener('pointercancel', stop);
    strip.element.addEventListener('lostpointercapture', stop);
    strip.element.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      const channels = currentChannels();
      if (strip.channel === 'master') {
        writeLevel(spec.neutral);
        return;
      }
      channels[CHANNEL_ORDER.indexOf(strip.channel)] = spec.neutral;
      writeChannels(channels);
      paint();
    });
  }

  // ---- 亮度长条 --------------------------------------------------------
  {
    let dragging = false;
    const apply = (clientX: number): void => {
      const rect = bar.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      writeLevel(spec.min + fraction * (spec.max - spec.min));
    };
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      capturePointer(bar, event.pointerId);
      apply(event.clientX);
    });
    bar.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      apply(event.clientX);
    });
    const stop = (): void => {
      dragging = false;
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('lostpointercapture', stop);
    bar.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      writeLevel(spec.neutral);
    });
  }

  // ---- 复位 ------------------------------------------------------------
  reset.addEventListener('pointerdown', (event) => event.stopPropagation());
  reset.addEventListener('click', (event) => {
    event.stopPropagation();
    writeChannels([spec.neutral, spec.neutral, spec.neutral]);
    paint();
  });

  paint();
  return block;
}

/** 节点体内的四轮横排容器。 */
export function renderColorWheels(
  node: CompositorNode,
  setParam: (key: string, value: number) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cg-wheels';
  for (const spec of WHEEL_RANGES) row.append(createWheelBlock(spec, node, setParam));
  return row;
}

/** 回归用：四轮在界面上的中性数字（暗部/中灰 0.00、亮部 1.00、偏移 25.00）。 */
export function wheelNeutralLabels(): Array<{ key: string; label: string; neutral: string }> {
  return WHEEL_RANGES.map((spec) => ({
    key: spec.key,
    label: spec.label,
    neutral: formatWheelValue(spec.neutral),
  }));
}

/** 回归用：色轮的关键几何/色度常量（与绘制、拖动保持一致）。 */
export function wheelUiMetrics(): {
  dotLimit: number;
  discRadius: number;
  ringRadius: number;
  chroma: number;
} {
  return {
    dotLimit: DOT_LIMIT,
    discRadius: DISC_RADIUS,
    ringRadius: RING_RADIUS,
    chroma: WHEEL_CHROMA,
  };
}


