/**
 * 图片编辑工作台（v1.26）的纯逻辑：取图、适配尺寸、裁切导出、标注合成。
 *
 * 这里刻意**不碰 React**，几何与导出全部复用 vendor 的纯函数
 * （`dialogs/imageCropGeometry.ts`、`dialogs/imageAnnotationDrawing.ts`）——
 * 上游那套裁切/标注的像素语义（选区、8 个把手、出口尺寸、遮罩 destination-out）
 * 已经在真机上跑了几百次，重写一份只会引入偏差。
 *
 * 为什么要重做 UI：`docs/canvas-ui-shadcn.md` 第五节列的遗留项 —— 图片编辑/裁剪/标注
 * 这几个对话框一直是上游外观（两套圆角胶囊工具条 + 原生 range + 手写 SVG 图标），
 * 与已经 shadcn 化的头部/工具条/任务队列不是一套视觉语言。
 */
import {
  centeredCrop as vendorCenteredCrop,
  cropHandles as vendorCropHandles,
  cropOutputRects,
  cropRatio as vendorCropRatio,
  createCrop as vendorCreateCrop,
  hitCrop as vendorHitCrop,
  moveCrop as vendorMoveCrop,
  resizeCrop as vendorResizeCrop,
  type CropHandle,
  type CropOutput,
  type CropPoint,
  type CropRect,
  type CropSize,
} from '../../../vendor/aifisher/src/stable/dialogs/imageCropGeometry';
import {
  renderAnnotations,
  type AnnotationStroke,
} from '../../../vendor/aifisher/src/stable/dialogs/imageAnnotationDrawing';
import { resizeLimit } from '../../../vendor/aifisher/src/stable/dialogs/imageResizeGeometry';

export type WorkbenchSize = CropSize;
export type WorkbenchRect = CropRect;
export type WorkbenchPoint = CropPoint;
export type WorkbenchHandle = CropHandle;
export type WorkbenchOutput = CropOutput;
export type AnnotationTool = AnnotationStroke['tool'];
export type { AnnotationStroke, CropOutput, CropRect, CropSize };

/** 选区几何（全部是 vendor 的纯函数，转换单位时不要另写一套）。 */
export const cropGeometry = {
  centeredCrop: vendorCenteredCrop,
  cropHandles: vendorCropHandles,
  cropRatio: vendorCropRatio,
  createCrop: vendorCreateCrop,
  hitCrop: vendorHitCrop,
  moveCrop: vendorMoveCrop,
  resizeCrop: vendorResizeCrop,
};

/** 图片四周留白（与上游裁剪器一致：24px，工作台头部/底栏更高所以给到 28/32）。 */
export const WORKBENCH_MARGIN = 28;

/** 图片在容器里等比居中需要的显示尺寸（不放大到超过容器）。 */
export function fitInside(
  natural: WorkbenchSize,
  box: WorkbenchSize,
  margin = WORKBENCH_MARGIN,
): WorkbenchSize {
  const width = Math.max(1, box.width - margin * 2);
  const height = Math.max(1, box.height - margin * 2);
  if (!natural.width || !natural.height) return { width: 0, height: 0 };
  const factor = Math.min(width / natural.width, height / natural.height);
  return {
    width: Math.max(1, Math.round(natural.width * factor)),
    height: Math.max(1, Math.round(natural.height * factor)),
  };
}

/**
 * 取一张画布图片（`crossOrigin` 与上游一致：素材走同源 /api/aifisher/canvas/media，
 * 但画布也允许外链参考图，标了 anonymous 才不会污染 canvas、toDataURL 才不抛）。
 */
export function loadWorkbenchImage(url: string, timeoutMs = 20000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = window.setTimeout(() => fail('图片加载超时，请关闭后重试。'), timeoutMs);
    image.onload = () => {
      if (settled) return;
      if (!image.naturalWidth || !image.naturalHeight) {
        fail('图片尺寸无效。');
        return;
      }
      const invalid = resizeLimit({ width: image.naturalWidth, height: image.naturalHeight });
      if (invalid) {
        fail(invalid);
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => fail('图片加载失败，请关闭后重新打开。');
    image.src = url;
  });
}

/**
 * 裁切导出：单帧（工作台里的「裁剪」）—— `cropOutputRects` 传空切线与 0 间隙
 * 就等价于上游的单块导出，尺寸严格等于源图像素，不做二次重编码以外的处理。
 */
export function exportCrop(
  image: HTMLImageElement,
  rect: WorkbenchRect,
  display: WorkbenchSize,
  source: WorkbenchSize,
): WorkbenchOutput {
  if (rect.width <= 0 || rect.height <= 0) throw new Error('裁切范围太小，请重新框选。');
  const pieces = cropOutputRects(rect, display, source, [], [], 0, 0);
  const row = pieces.rows[0];
  const column = pieces.columns[0];
  if (!row || !column) throw new Error('裁切范围太小，请重新框选。');
  const canvas = document.createElement('canvas');
  canvas.width = column.size;
  canvas.height = row.size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建裁切图片');
  context.drawImage(
    image,
    column.start,
    row.start,
    column.size,
    row.size,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const data = canvas.toDataURL('image/png');
  if (!data.startsWith('data:image/png')) throw new Error('图片超出当前设备的处理范围。');
  return { data, width: canvas.width, height: canvas.height, row: 0, column: 0 };
}

/**
 * 标注合成：与上游同一套语义 —— 先按源图像素把标注画到 overlay，
 * 再叠到原图上；蒙版模式用 destination-out 把标注区域抠掉。
 */
export function flattenAnnotations(
  image: HTMLImageElement,
  strokes: AnnotationStroke[],
  mask: boolean,
): WorkbenchOutput {
  const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  canvas.width = overlay.width = dimensions.width;
  canvas.height = overlay.height = dimensions.height;
  renderAnnotations(overlay, strokes, dimensions);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建标注图片');
  context.drawImage(image, 0, 0);
  context.globalCompositeOperation = mask ? 'destination-out' : 'source-over';
  context.drawImage(overlay, 0, 0);
  const data = canvas.toDataURL('image/png');
  if (!data.startsWith('data:image/png')) throw new Error('图片超出当前设备的处理范围。');
  return { data, width: dimensions.width, height: dimensions.height, row: 0, column: 0 };
}

/** 「1024 × 768」这种尺寸读数（底栏与状态行共用）。 */
export function sizeLabel(size: WorkbenchSize | null | undefined): string {
  if (!size || !size.width || !size.height) return '—';
  return `${Math.round(size.width)} × ${Math.round(size.height)}`;
}

/** 工作台根容器的公共外观（nova：中性、紧、界面退后）。定位由 imageWorkbenchOverlay 给。 */
export const WORKBENCH_ROOT_CLASS =
  'fixed z-[12000] flex select-none flex-col overflow-hidden bg-[var(--af-canvas)] text-[var(--af-text)]';
export const WORKBENCH_HEADER_CLASS =
  'flex h-12 shrink-0 items-center gap-2 border-b border-border bg-[var(--af-surface)] px-3';
export const WORKBENCH_TOOLBAR_CLASS =
  'flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-[var(--af-surface)] px-3 py-1.5';
export const WORKBENCH_FOOTER_CLASS =
  'flex h-12 shrink-0 items-center gap-2 border-t border-border bg-[var(--af-surface)] px-3';
export const WORKBENCH_STAGE_CLASS =
  'af-wb-stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden';
export const WORKBENCH_LABEL_CLASS = 'text-[11px] text-[var(--af-text-muted)]';
export const WORKBENCH_HINT_CLASS = 'text-[11px] text-[var(--af-text-muted)]';
export const WORKBENCH_DIVIDER_CLASS = 'mx-1 h-5 w-px shrink-0 bg-[var(--af-border)]';
