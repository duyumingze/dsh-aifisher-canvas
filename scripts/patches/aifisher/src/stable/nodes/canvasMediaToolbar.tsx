/**
 * 节点媒体工具条（**整文件覆盖**，dsh-aifisher-canvas v1.38 起）。
 *
 * 为什么整份覆盖而不是打一行正则：这一版拿掉了上游的「AI 高清放大 · SeedVR2」整块交互
 * （按钮 + 状态查询 + 弹窗 + 直接生图），又加进了「扩图」的完整面板（目标比例 / 原图位置 /
 * 延展内容 / 预览 / 两张节点的创建）。三处都在同一个组件的 JSX 里交叉，用字符串补丁拼只会变成
 * 一团没人敢改的东西 —— 见 scripts/vendor-aifisher.mjs 3.9 段「整文件覆盖」的规矩。
 *
 * 用户原话（2026-10-17 v1.38，附一张工具条截图，指着 HD 按钮）：
 *   「把这个功能移除，替换成扩图功能；还有一点，这里的功能点击生成后模型走的是之前的通道。
 *    做一个调整，点击生成后不直接生图，先输出一个空的图像生成节点，填好提示词，
 *    由我来点击最后的生成」。
 *
 * 用户原话（2026-10-17 v1.39，附两张参考图：一张是带「目标比例 / 原图位置 / 延展内容」的
 * 扩图面板，一张是画布上「原图 → 扩图画面 → 扩图 · 21:9」的节点链）：
 *   「图像扩图参考以上参考图，先输出一张图，再接入图像生成节点」。
 *
 * 落法（改它之前先读）：
 *   ① **HD / AI 高清放大整块删掉**：它把图上传到 RunningHub、写死 `SeedVr2ImageProvider`，
 *      本插件没有这条后端（也没有 RH 的 Key），点了只会失败或者替用户走一条他不认识的通道。
 *   ② **扩图按钮**在原来的位置（尺寸右边）：点开面板，选「目标比例 + 原图位置（九宫格）+
 *      延展内容」，再点「生成扩图画面」。它调
 *      `window.__FISHERAI_CANVAS_OUTPAINT__.create(id, options)`（vendor 补丁 3.8p 的桥）：
 *      · 先把原图画成一张更大的「扩图画面」（留白 = 待补的新画面，透明），存进素材库并落成节点；
 *      · 再建一个**空**的图像生成节点，参考图 = 那张扩图画面，提示词 / 模型已填好，
 *        生成按钮在节点上，用户自己点。
 *   ③ 面板里的模型读数、比例候选、预览几何都来自 `window.__FISHERAI_OUTPAINT__`
 *      （装配层注册，见 src/client/canvas/bootstrap.ts）；解析不到就明说「先去配一条通道」，
 *      不要给一个点下去必然 501 的模型。
 *   ④ 预览是纯 CSS 摆位（`preview()` 给的百分比），不额外解码图片 —— 真机每帧重渲染都便宜。
 *
 * 注意：这个文件是覆盖文件，**不要**再在这里 import CSS，也不要指望上游的下一次改动会同步过来
 * （上游一改这个组件，构建时的 3.9 段覆盖仍会以本文件为准，行为差异要自己核）。
 */
import type * as ReactTypes from 'react';
import { installMediaDownloadFileName } from '../media/mediaDownloadFileName';
import { Grid2X2, Globe, Box, Scaling } from 'lucide-react';
type Runtime = Pick<typeof ReactTypes, 'createElement' | 'Fragment' | 'useState' | 'useEffect'>;
interface MediaNode {
  id: string;
  type: string;
  resultUrl?: string;
  networkUrl?: string;
  projectId?: string;
  title?: string;
  [key: string]: unknown;
}
interface Props {
  data: MediaNode;
  selected?: boolean;
  showControls?: boolean;
  isDragging?: boolean;
  zoom: number;
  projectId?: string;
  onUpdate(id: string, patch: Partial<MediaNode>): void;
  onExpand?(url: string): void;
  onSaveAsset?(id: string): void;
  onAnnotate?(id: string): void;
  onCrop?(id: string, mode?: 'editor' | 'grid' | 'panorama' | 'angle' | 'panorama-generate'): void;
  onResizeImage?(id: string): void;
  fileInputRef?: ReactTypes.RefObject<HTMLInputElement | null>;
}
type Icon = ReactTypes.ComponentType<{ size: number; strokeWidth: number }>;
interface Components {
  Tooltip: ReactTypes.ComponentType<{ text: string; children: ReactTypes.ReactNode }>;
  annotate: Icon;
  crop: Icon;
  resize: Icon;
  replace: Icon;
  saveAsset: Icon;
  download: Icon;
  expand: Icon;
}
/** 节点工具条上「扩图」用到的两个全局桥（装配层 + vendor 补丁各注册一半）。 */
interface OutpaintModelSummary {
  name: string;
  ratios: string[];
  defaultRatio: string;
  channelModel: boolean;
}
/** 扩图画面预览的几何（数字单位跟源图比例同一套，只用来算百分比）。 */
interface OutpaintPreview {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  offsetX: number;
  offsetY: number;
  /** true = 这几个数是原图真实像素（面板上可以照实写）；false = 只是比例。 */
  exact: boolean;
}
interface OutpaintBridge {
  model(): OutpaintModelSummary | null;
  preview?(
    source: Record<string, unknown>,
    options?: { ratio?: string; anchor?: string },
  ): OutpaintPreview | null;
}
interface OutpaintCreateBridge {
  create(
    sourceId: string,
    options?: { ratio?: string; anchor?: string; content?: string },
  ): Promise<{
    ok: boolean;
    id?: string;
    compositeId?: string;
    url?: string;
    prompt?: string;
    model?: string;
    error?: string;
  }>;
}
/**
 * 原图位置（九宫格，行优先）。与 `src/canvas-ui/canvas/CanvasOutpaint.ts` 的
 * OUTPAINT_ANCHORS 一一对应 —— 这里只放 label/hint（面板要文案），落点算法在装配层。
 */
const ANCHORS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'top-left', label: '左上', hint: '原图贴左上角，向右下方延展' },
  { value: 'top', label: '上', hint: '原图贴上边，向左右与下方延展' },
  { value: 'top-right', label: '右上', hint: '原图贴右上角，向左下方延展' },
  { value: 'left', label: '左', hint: '原图贴左边，向右延展' },
  { value: 'center', label: '居中', hint: '原图居中，四周一起延展' },
  { value: 'right', label: '右', hint: '原图贴右边，向左延展' },
  { value: 'bottom-left', label: '左下', hint: '原图贴左下角，向右上方延展' },
  { value: 'bottom', label: '下', hint: '原图贴下边，向左右与上方延展' },
  { value: 'bottom-right', label: '右下', hint: '原图贴右下角，向左上方延展' },
];
const chipClass = (active: boolean) =>
  'rounded-md border px-1.5 py-1 text-[11px] transition-colors ' +
  (active
    ? 'border-[var(--af-info)] bg-[var(--af-info-bg)] text-[var(--af-text)]'
    : 'border-[var(--af-border-control)] text-[var(--af-text-secondary)] hover:bg-[var(--af-selected)] hover:text-[var(--af-text)]');
const buttonClass =
  'p-1.5 text-[var(--af-text-secondary)] hover:bg-[var(--af-selected)] hover:text-[var(--af-text)] rounded-full transition-colors';
const imageTypes = new Set(['Image', 'Upload Image']),
  videoTypes = new Set(['Video', 'Upload Video']),
  audioTypes = new Set(['Audio', 'Upload Audio']);
export function CanvasMediaToolbar(React: Runtime, props: Props, components: Components) {
  const [panoramaOpen, setPanoramaOpen] = React.useState(false);
  const [outpaintOpen, setOutpaintOpen] = React.useState(false);
  const [outpaintAnchor, setOutpaintAnchor] = React.useState('center');
  const [outpaintRatio, setOutpaintRatio] = React.useState('');
  const [outpaintContent, setOutpaintContent] = React.useState('');
  const [outpaintError, setOutpaintError] = React.useState('');
  const [outpaintBusy, setOutpaintBusy] = React.useState(false);
  const canOutpaint = Boolean(
    props.selected && props.showControls && imageTypes.has(props.data.type) && props.data.resultUrl,
  );
  // ⚠️ 桥一律读写 **window**，不要用 globalThis：真机上两者同一个对象，但 jsdom
  //    （回归用它）里是两个 —— 装配层写的是 window，读 globalThis 会永远拿不到桥。
  const outpaintBridge =
    (window as unknown as { __FISHERAI_OUTPAINT__?: OutpaintBridge }).__FISHERAI_OUTPAINT__;
  const outpaintModel = canOutpaint && outpaintOpen ? (outpaintBridge?.model() ?? null) : null;
  React.useEffect(() => {
    setOutpaintOpen(false);
    setPanoramaOpen(false);
    setOutpaintError('');
    setOutpaintBusy(false);
  }, [props.data.id, props.selected]);
  const { data: node, selected, showControls, isDragging, zoom, fileInputRef } = props;
  const { Tooltip } = components;
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const download = (event: ReactTypes.MouseEvent<HTMLButtonElement>) => {
    stop(event);
    if (!node.resultUrl) return;
    let extension = '';
    try {
      extension =
        new URL(node.resultUrl, window.location.origin).pathname
          .match(/\.([a-z0-9]+)$/i)?.[1]
          .toLowerCase() || '';
    } catch {
      /* Data URLs use the media type below. */
    }
    extension ||= videoTypes.has(node.type) ? 'mp4' : audioTypes.has(node.type) ? 'mp3' : 'png';
    void installMediaDownloadFileName().download(
      node,
      node.resultUrl,
      extension,
      event.currentTarget,
    );
  };
  if (!selected || !showControls || isDragging || (!node.resultUrl && node.type !== 'Upload Video'))
    return null;
  const action = (
    label: string,
    Icon: Icon,
    onClick: ReactTypes.MouseEventHandler<HTMLButtonElement>,
  ) => (
    <Tooltip text={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        onPointerDown={stop}
        className={buttonClass}
      >
        <Icon size={14} strokeWidth={2.5} />
      </button>
    </Tooltip>
  );
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const ratios = outpaintModel?.ratios ?? [];
  const activeRatio =
    outpaintRatio && ratios.includes(outpaintRatio)
      ? outpaintRatio
      : (outpaintModel?.defaultRatio ?? ratios[0] ?? '');
  // 预览几何由装配层算（与真正落盘的那张图同一套公式）—— 面板只负责摆位置。
  const preview =
    outpaintOpen && typeof outpaintBridge?.preview === 'function'
      ? outpaintBridge.preview(node as unknown as Record<string, unknown>, {
          ratio: activeRatio,
          anchor: outpaintAnchor,
        })
      : null;
  const onlyImage = imageTypes.has(node.type) && Boolean(node.resultUrl);
  const createOutpaintNodes = async () => {
    if (outpaintBusy) return;
    const bridge = (window as unknown as {
      __FISHERAI_CANVAS_OUTPAINT__?: OutpaintCreateBridge;
    }).__FISHERAI_CANVAS_OUTPAINT__;
    if (!bridge || typeof bridge.create !== 'function') {
      setOutpaintError('扩图模块还没装配好，刷新页面后重试。');
      return;
    }
    setOutpaintBusy(true);
    setOutpaintError('');
    try {
      const result = await bridge.create(node.id, {
        anchor: outpaintAnchor,
        ratio: activeRatio,
        content: outpaintContent,
      });
      if (!result || !result.ok) {
        setOutpaintError((result && result.error) || '生成扩图画面失败。');
        return;
      }
      // 建好就收起面板：新节点（生成节点）已经被选中，提示词与生成按钮都在它身上。
      setOutpaintOpen(false);
    } catch (error) {
      setOutpaintError(error instanceof Error ? error.message : '生成扩图画面失败。');
    } finally {
      setOutpaintBusy(false);
    }
  };
  return (
    <div
      data-fisherai-media-toolbar="true"
      onPointerDown={stop}
      onClick={stop}
      onKeyDown={stop}
      className="absolute bottom-[calc(100%+28px)] left-0 right-0 flex justify-center transition-opacity z-20 animate-in fade-in slide-in-from-bottom-1 duration-200"
      style={{
        transform: `scale(${Math.max(safeZoom, 0.8) / safeZoom})`,
        transformOrigin: 'bottom center',
        // 节点卡片里的 composer 浮层是 z-[100]（同一条节点栈里），扩图面板比它大、
        // 会压到它上面去 —— 这里必须盖过 100，否则面板下半截（目标比例/延展内容/按钮）
        // 会被 composer 挡住（v1.39 真机截图取证发现：面板只露出上半截）。
        zIndex: 110,
      }}
    >
      <div className="flex items-center gap-2 px-2 py-1 bg-[var(--af-input)] rounded-full border border-[var(--af-border-control)] shadow-xl backdrop-blur-md">
        {imageTypes.has(node.type) && node.resultUrl && (
          <React.Fragment>
            {action('标注', components.annotate, () => props.onAnnotate?.(node.id))}
            {action('图片编辑', components.crop, () => props.onCrop?.(node.id, 'editor'))}
            {action('宫格裁剪', Grid2X2, () => props.onCrop?.(node.id, 'grid'))}
            <div
              className="relative"
              onKeyDown={(event) => {
                if (event.key === 'Escape') setPanoramaOpen(false);
              }}
            >
              {action('全景图', Globe, () => setPanoramaOpen(!panoramaOpen))}
              {panoramaOpen && (
                <div
                  role="menu"
                  aria-label="全景图"
                  className="absolute top-full mt-3 left-1/2 -translate-x-1/2 w-40 p-2 rounded-xl border border-[var(--af-border-control)] bg-[var(--af-input)] shadow-xl"
                >
                  {(
                    [
                      ['panorama-generate', '生成全景图'],
                      ['panorama', '进入全景'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      role="menuitem"
                      className="block w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-[var(--af-selected)] text-[var(--af-text)]"
                      onClick={() => {
                        setPanoramaOpen(false);
                        props.onCrop?.(node.id, mode);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {action('角度', Box, () => props.onCrop?.(node.id, 'angle'))}
            {action('尺寸', components.resize, () => props.onResizeImage?.(node.id))}
            {/* v1.38 起：扩图（替换掉原位置的 HD / AI 高清放大）；v1.39 起先出扩图画面再接生成节点 */}
            {onlyImage && (
              <div
                className="relative"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOutpaintOpen(false);
                    event.stopPropagation();
                  }
                }}
              >
                <Tooltip text="扩图（先出扩图画面，再接图像生成节点）">
                  <button
                    type="button"
                    aria-label="扩图"
                    data-fisherai-outpaint-trigger="true"
                    aria-expanded={outpaintOpen}
                    onPointerDown={stop}
                    onClick={() => {
                      setOutpaintError('');
                      setOutpaintOpen(!outpaintOpen);
                    }}
                    className={buttonClass}
                  >
                    <Scaling size={14} strokeWidth={2.5} />
                  </button>
                </Tooltip>
                {outpaintOpen && (
                  <div
                    role="dialog"
                    aria-label="扩图"
                    data-fisherai-outpaint-panel="true"
                    data-fisherai-outpaint-model={outpaintModel?.name ?? ''}
                    onPointerDown={stop}
                    className="absolute top-full left-1/2 -translate-x-1/2 mt-3 w-[520px] max-w-[calc(100vw-40px)] rounded-xl border border-[var(--af-border-control)] bg-[var(--af-input)] text-[var(--af-text)] shadow-xl z-30 animate-in fade-in duration-200 motion-reduce:animate-none"
                  >
                    <div className="flex items-start gap-2 px-4 pt-3">
                      <Scaling size={16} strokeWidth={2.5} />
                      <div className="min-w-0 flex-1">
                        <strong className="text-xs">扩图</strong>
                        <p className="text-[11px] leading-5 text-[var(--af-text-secondary)]">
                          把画面向外延展到新的比例，原图内容保持不变
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="关闭扩图"
                        onClick={() => setOutpaintOpen(false)}
                        className={buttonClass}
                      >
                        ×
                      </button>
                    </div>
                    <div className="flex gap-4 px-4 pb-2 pt-3">
                      <div className="w-[184px] shrink-0">
                        <div
                          data-fisherai-outpaint-preview="true"
                          data-fisherai-outpaint-preview-size={
                            preview ? `${preview.width}x${preview.height}` : ''
                          }
                          className="relative w-full overflow-hidden rounded-lg border border-[var(--af-border-control)]"
                          style={{
                            aspectRatio: preview
                              ? `${Math.max(1, preview.width)} / ${Math.max(1, preview.height)}`
                              : '16 / 9',
                            backgroundImage:
                              'repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 6px, rgba(255,255,255,0.015) 6px 12px)',
                          }}
                        >
                          {preview && node.resultUrl ? (
                            <img
                              data-fisherai-outpaint-preview-image="true"
                              src={node.resultUrl}
                              alt="原图在扩图画面里的位置"
                              style={{
                                position: 'absolute',
                                left: `${(preview.offsetX / Math.max(1, preview.width)) * 100}%`,
                                top: `${(preview.offsetY / Math.max(1, preview.height)) * 100}%`,
                                width: `${(preview.imageWidth / Math.max(1, preview.width)) * 100}%`,
                                height: `${(preview.imageHeight / Math.max(1, preview.height)) * 100}%`,
                                objectFit: 'cover',
                                border: '1px dashed var(--af-text-muted)',
                              }}
                            />
                          ) : null}
                        </div>
                        <p
                          data-fisherai-outpaint-preview-caption="true"
                          className="mt-1.5 text-[10px] leading-4 text-[var(--af-text-muted)]"
                        >
                          {preview
                            ? preview.exact
                              ? `扩图画面 ${preview.width} × ${preview.height}`
                              : `目标画幅 ${activeRatio || '—'}`
                            : '正在读取原图尺寸…'}
                        </p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-semibold text-[var(--af-text-muted)]">
                          目标比例
                        </div>
                        {ratios.length > 0 ? (
                          <div className="mt-1 grid grid-cols-5 gap-1">
                            {ratios.map((ratio) => (
                              <button
                                key={ratio}
                                type="button"
                                data-fisherai-outpaint-ratio={ratio}
                                aria-pressed={activeRatio === ratio}
                                onClick={() => setOutpaintRatio(ratio)}
                                className={chipClass(activeRatio === ratio)}
                              >
                                {ratio}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p
                            data-fisherai-outpaint-status="empty"
                            className="mt-1 text-[11px] leading-5 text-[var(--af-danger)]"
                          >
                            没有可用的图像模型：先去「设置 → 闭源服务」配一条通道并勾选图像模型。
                          </p>
                        )}
                        <div className="mt-2 text-[10px] font-semibold text-[var(--af-text-muted)]">
                          原图位置
                        </div>
                        <div className="mt-1 grid w-[106px] grid-cols-3 gap-1">
                          {ANCHORS.map((item) => (
                            <button
                              key={item.value}
                              type="button"
                              title={item.hint}
                              aria-label={`原图位置 ${item.label}`}
                              data-fisherai-outpaint-anchor={item.value}
                              aria-pressed={outpaintAnchor === item.value}
                              onClick={() => setOutpaintAnchor(item.value)}
                              className={
                                'flex h-6 items-center justify-center rounded border transition-colors ' +
                                (outpaintAnchor === item.value
                                  ? 'border-[var(--af-info)] bg-[var(--af-info-bg)]'
                                  : 'border-[var(--af-border-control)] hover:bg-[var(--af-selected)]')
                              }
                            >
                              <span
                                className="block h-[7px] w-[7px] rounded-[1px]"
                                style={{
                                  background:
                                    outpaintAnchor === item.value
                                      ? 'var(--af-primary)'
                                      : 'var(--af-text-secondary)',
                                }}
                              />
                            </button>
                          ))}
                        </div>
                        <div className="mt-2 text-[10px] font-semibold text-[var(--af-text-muted)]">
                          延展内容（可空）
                        </div>
                        <textarea
                          data-fisherai-outpaint-content="true"
                          aria-label="延展内容"
                          rows={2}
                          value={outpaintContent}
                          onChange={(event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
                            setOutpaintContent(event.target.value)
                          }
                          placeholder="例如：两侧延伸出更多沙滩和海面"
                          className="mt-1 w-full resize-none rounded-lg border border-[var(--af-border-control)] bg-[var(--af-surface)] px-2 py-1.5 text-[11px] leading-4 text-[var(--af-text)] outline-none"
                        />
                      </div>
                    </div>
                    {outpaintError ? (
                      <p
                        role="alert"
                        data-fisherai-outpaint-status="error"
                        className="px-4 pb-1 text-[11px] leading-5 text-[var(--af-danger)]"
                      >
                        {outpaintError}
                      </p>
                    ) : null}
                    <div className="mt-1 flex items-end justify-between gap-3 border-t border-[var(--af-border-control)] px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10px] leading-4 text-[var(--af-text-muted)]">
                          <span>模型</span>
                          <span
                            data-fisherai-outpaint-model-name="true"
                            className="ml-1 font-mono text-[var(--af-text-secondary)]"
                            title={outpaintModel?.name ?? ''}
                          >
                            {outpaintModel?.name ?? '—'}
                          </span>
                          {outpaintModel?.channelModel ? (
                            <span className="ml-1 rounded border border-[var(--af-border-control)] px-1">
                              你的通道
                            </span>
                          ) : null}
                        </p>
                        <p className="text-[10px] leading-4 text-[var(--af-text-muted)]">
                          先出扩图画面，再接一个图像生成节点；生成由你点。
                        </p>
                      </div>
                      <button
                        type="button"
                        data-fisherai-outpaint-create="true"
                        aria-label="生成扩图画面"
                        disabled={outpaintBusy || !outpaintModel || ratios.length === 0}
                        onClick={createOutpaintNodes}
                        className="shrink-0 rounded-lg bg-[var(--af-primary)] px-3 py-2 text-sm font-semibold text-[var(--af-on-primary)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {outpaintBusy ? '正在生成扩图画面…' : '生成扩图画面'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="w-px h-3 bg-[var(--af-selected)] mx-0.5" />
          </React.Fragment>
        )}
        {node.type.startsWith('Upload ') &&
          fileInputRef &&
          action('替换素材', components.replace, () => fileInputRef.current?.click())}
        {(imageTypes.has(node.type) || videoTypes.has(node.type) || audioTypes.has(node.type)) &&
          node.resultUrl &&
          !node.uploadPending &&
          props.onSaveAsset &&
          action('保存到资产', components.saveAsset, () => props.onSaveAsset?.(node.id))}
        {node.resultUrl && action('下载', components.download, download)}
        {node.resultUrl &&
          !audioTypes.has(node.type) &&
          action('全屏查看', components.expand, () => props.onExpand?.(node.resultUrl!))}
      </div>
    </div>
  );
}
