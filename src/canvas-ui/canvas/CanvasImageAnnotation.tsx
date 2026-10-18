/**
 * 图片标注槽位（`dependencies.Annotation`，v1.26 换成 shadcn nova 版）。
 *
 * 上游 `canvasApplication.tsx` 用这个槽位渲染「节点工具条 → 标注」打开的标注器，
 * props 是 `{ node, projectId, initialMask, saveLabel, onSave, onClose }`：
 *
 *   - `onSave(id, dataURL, { width, height })` 走 `useCanvasImageEditSave`
 *     → `POST /api/aifisher/canvas/assets/images` 落盘 → 在源图右侧新建节点；
 *   - `saveLabel` 默认「保存」，studio 里传入「应用编辑」时不走这里（studio 直接用自己的舞台）。
 *
 * 真正的外观与交互都在 `ImageAnnotationStage.tsx`（studio 的蒙版/笔刷也复用它），
 * 这里只把 vendor 的 props 摊平成舞台的参数 —— 于是「标注」和「图片编辑→蒙版/笔刷」
 * 是同一套 UI，不会出现两套手感。
 *
 * 结构契约：`role="dialog"` + `data-fisherai-image-workbench="annotation"`；
 * 独立入口会显示「标准 / 遮罩」切换（`data-fisherai-annotation-mask`）。
 */
import * as ReactTypes from 'react';
import { ImageAnnotationStageView } from './ImageAnnotationStage';

type Runtime = Pick<typeof ReactTypes, 'createElement'>;

export interface AnnotationSlotProps {
  initialMask?: boolean;
  saveLabel?: string;
  node?: { id: string; resultUrl?: string; title?: string };
  projectId?: string;
  onSave(
    id: string,
    data: string,
    dimensions: { width: number; height: number },
  ): Promise<unknown> | unknown;
  onClose(): void;
}

export function CanvasImageAnnotation(react: Runtime, props: AnnotationSlotProps) {
  const h = react.createElement;
  return h(ImageAnnotationStageView, {
    node: props.node,
    initialMask: props.initialMask,
    saveLabel: props.saveLabel ?? '保存',
    title: props.initialMask ? '标注 · 蒙版' : '标注图片',
    // 独立入口：允许在标注器里直接切换「标准 / 遮罩」（上游同款能力）
    maskToggle: true,
    onSave: props.onSave,
    onClose: props.onClose,
  });
}

CanvasImageAnnotation.displayName = 'CanvasImageAnnotationShadcn';
