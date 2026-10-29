import type { CanvasComponent } from '../app/canvasComponentType';
import type * as ReactTypes from 'react';
import {
  drawComposite,
  initialCompositeScene,
  type CompositeLayer,
  type LayerTransform,
} from '../dialogs/compositeScene';
type Runtime = Pick<typeof ReactTypes, 'createElement' | 'useRef' | 'useState' | 'useEffect'>;
interface ConnectedImage {
  id: string;
  url?: string;
  title?: string;
}
interface NodeData {
  id: string;
  title?: string;
  compositeLayout?: Record<string, Partial<LayerTransform>>;
}
interface Components {
  Frame: CanvasComponent;
  Header: CanvasComponent;
  Empty: CanvasComponent;
}
interface Props extends Record<string, unknown> {
  data: NodeData;
  selected?: boolean;
  connectedImageNodes?: ConnectedImage[];
  onOpenCompare?: (payload: {
    leftUrl: string;
    rightUrl: string;
    leftLabel: string;
    rightLabel: string;
    title: string;
  }) => void;
  onOpenComposite?: (payload: {
    nodeId: string;
    layers: { nodeId: string; url: string; title?: string }[];
    layout: Record<string, Partial<LayerTransform>>;
  }) => void;
}
const imagesOf = (nodes: ConnectedImage[] | undefined, limit: number) =>
  (nodes || [])
    .filter(
      (node) => node.url && !['text-node-placeholder', 'audio-node-placeholder'].includes(node.url),
    )
    .slice(0, limit);
function frameProps(props: Props) {
  return {
    data: props.data,
    selected: props.selected,
    onNodePointerDown: props.onNodePointerDown,
    onContextMenu: props.onContextMenu,
    onConnectorDown: props.onConnectorDown,
    isHoveredForConnection: props.isHoveredForConnection,
    isInvalidHover: props.isInvalidHover,
    onMouseEnter: props.onMouseEnter,
    onMouseLeave: props.onMouseLeave,
    isResizing: props.isResizing ?? false,
    isDragging: props.isDragging ?? false,
    onResizeStart: props.onResizeStart,
    zoom: props.zoom,
  };
}
function headerProps(props: Props) {
  return {
    data: props.data,
    selected: props.selected,
    onUpdate: props.onUpdate,
  };
}
export function CanvasCompareNode(
  React: Runtime,
  props: Props,
  { Frame, Header, Empty }: Components,
) {
  const [position, setPosition] = React.useState(50),
    surface = React.useRef<HTMLDivElement>(null);
  const [left, right] = imagesOf(props.connectedImageNodes, 2),
    ready = !!(left?.url && right?.url);
  return (
    <Frame {...frameProps(props)}>
      <Header {...headerProps(props)} />
      <div
        ref={surface}
        data-fisherai-original-media="true"
        style={{ containerType: 'inline-size' }}
        className={
          'relative w-full h-full rounded-lg overflow-hidden bg-[var(--af-surface)] ' +
          (ready ? 'cursor-zoom-in' : 'cursor-default')
        }
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (left?.url && right?.url)
            props.onOpenCompare?.({
              leftUrl: left.url,
              rightUrl: right.url,
              leftLabel: left.title || 'A',
              rightLabel: right.title || 'B',
              title: props.data.title || '图片对比',
            });
        }}
        onMouseMove={(event) => {
          const bounds = surface.current?.getBoundingClientRect();
          if (ready && bounds && bounds.width > 0)
            setPosition(
              Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100)),
            );
        }}
      >
        {ready ? (
          <div
            data-af-media-chrome
            className="absolute inset-0 rounded-lg overflow-hidden bg-[var(--af-media-bg)] shadow-xl pointer-events-none"
          >
            <img
              src={right!.url}
              alt="对比图 B"
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
            <div
              className="absolute left-0 top-0 h-full overflow-hidden border-r border-black/50"
              style={{ width: `${position}%` }}
            >
              <img
                src={left!.url}
                alt="对比图 A"
                className="absolute left-0 top-0 h-full object-cover"
                style={{ width: '100cqw', maxWidth: 'none' }}
                draggable={false}
              />
            </div>
          </div>
        ) : left?.url ? (
          <div
            data-af-media-chrome
            className="absolute inset-0 rounded-lg overflow-hidden bg-[var(--af-media-bg)] shadow-xl"
          >
            <img
              src={left.url}
              alt="图片对比预览"
              className="w-full h-full object-cover pointer-events-none"
              draggable={false}
            />
          </div>
        ) : (
          <div className="w-full h-full bg-[var(--af-surface)] flex items-center justify-center">
            <div className="text-[var(--af-text-muted)]">
              <Empty size={40} />
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}
export function CanvasCompositeNode(
  React: Runtime,
  props: Props,
  { Frame, Header, Empty }: Components,
) {
  const canvas = React.useRef<HTMLCanvasElement>(null),
    [layers, setLayers] = React.useState<CompositeLayer[]>([]);
  const images = imagesOf(props.connectedImageNodes, 10);
  const signature = JSON.stringify(
    images.map((node) => ({ nodeId: node.id, url: node.url, title: node.title })),
  );
  React.useEffect(() => {
    let active = true;
    setLayers([]);
    const requests: { image: HTMLImageElement; cancel(): void }[] = [];
    const sources = JSON.parse(signature) as { nodeId: string; url: string; title?: string }[];
    const pending = sources.map(
      (source) =>
        new Promise<CompositeLayer | null>((resolve) => {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          requests.push({ image, cancel: () => resolve(null) });
          image.onload = () =>
            resolve(
              image.naturalWidth && image.naturalHeight
                ? { ...source, image, width: image.naturalWidth, height: image.naturalHeight }
                : null,
            );
          image.onerror = () => resolve(null);
          image.src = source.url;
        }),
    );
    void Promise.all(pending).then((results) => {
      if (active) setLayers(results.filter((layer): layer is CompositeLayer => !!layer));
    });
    return () => {
      active = false;
      requests.forEach(({ image, cancel }) => {
        image.onload = null;
        image.onerror = null;
        cancel();
      });
    };
  }, [signature]);
  React.useEffect(() => {
    const element = canvas.current,
      context = element?.getContext('2d');
    if (!element || !context) return;
    const width = Math.max(1, ...layers.map((layer) => layer.width)),
      height = Math.max(1, ...layers.map((layer) => layer.height)),
      scale = Math.min(252 / width, 252 / height);
    element.width = Math.round(width * scale);
    element.height = Math.round(height * scale);
    context.save();
    context.scale(scale, scale);
    drawComposite(context, layers, initialCompositeScene(layers, props.data.compositeLayout));
    context.restore();
  }, [layers, props.data.compositeLayout]);
  return (
    <Frame {...frameProps(props)}>
      <Header {...headerProps(props)} />
      <div
        className={
          'relative w-full h-full rounded-lg overflow-hidden bg-[var(--af-surface)] ' +
          (images.length ? 'cursor-zoom-in' : 'cursor-default')
        }
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (images.length)
            props.onOpenComposite?.({
              nodeId: props.data.id,
              layers: images.map((node) => ({
                nodeId: node.id,
                url: node.url!,
                title: node.title,
              })),
              layout: props.data.compositeLayout || {},
            });
        }}
      >
        {images.length ? (
          <div
            data-af-media-chrome
            className="absolute inset-0 rounded-lg overflow-hidden bg-[var(--af-media-bg)] shadow-xl"
          >
            <canvas
              ref={canvas}
              className="w-full h-full object-contain pointer-events-none"
              aria-label="合成预览"
            />
          </div>
        ) : (
          <div className="w-full h-full bg-[var(--af-surface)] flex items-center justify-center">
            <div className="text-[var(--af-text-muted)]">
              <Empty size={40} />
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

/**
 * 调色节点（dsh-aifisher-canvas v1.70）——「打开合成器」入口。
 * 合成器本体在 src/client/canvas/compositor/，这里只递上游图片和写回口。
 */
export function CanvasColorGradeNode(
  React: Runtime,
  props: Props,
  { Frame, Header, Empty }: Components,
) {
  const images = imagesOf(props.connectedImageNodes, 10);
  const data = props.data as NodeData & {
    resultUrl?: string;
    projectId?: string;
    compositorGraph?: Record<string, unknown>;
  };
  const resultUrl = typeof data.resultUrl === 'string' ? data.resultUrl : '';
  const open = (event: { stopPropagation(): void }) => {
    event.stopPropagation();
    const bridge = (window as unknown as {
      __FISHERAI_COMPOSITOR__?: { open?: (options: Record<string, unknown>) => void };
    }).__FISHERAI_COMPOSITOR__;
    if (!bridge?.open) return;
    bridge.open({
      nodeId: data.id,
      projectId: data.projectId,
      title: data.title,
      images: images.map((node) => ({ nodeId: node.id, url: node.url, title: node.title })),
      graph: data.compositorGraph,
      onSave: ({ resultUrl: nextUrl, graph }: { resultUrl: string; graph: unknown }) => {
        // dsh-aifisher-canvas v1.73：用户「退出调色节点时应该会在调色节点后添加调整好的图像」。
        // 优先走主画布的 __FISHERAI_CANVAS_GRADE_RESULT__.place：一次 setNodes 里回写调色节点、
        // 在它右边新建一张 Upload Image 并连起来；桥不在（旧页面）才退回 v1.70 的只写回。
        const grade = (window as unknown as {
          __FISHERAI_CANVAS_GRADE_RESULT__?: {
            place(input: Record<string, unknown>): { ok: boolean; error?: string };
          };
        }).__FISHERAI_CANVAS_GRADE_RESULT__;
        const placed = grade?.place?.({
          sourceId: data.id,
          url: nextUrl,
          graph,
          title: '调色结果',
        });
        if (!placed?.ok) {
          const update = props.onUpdate as
            | ((id: string, patch: Record<string, unknown>) => void)
            | undefined;
          update?.(data.id, { resultUrl: nextUrl, compositorGraph: graph, status: 'success' });
        }
      },
    });
  };
  return React.createElement(
    Frame,
    frameProps(props),
    React.createElement(Header, headerProps(props)),
    React.createElement(
      'div',
      {
        className:
          'relative w-full h-full rounded-lg overflow-hidden bg-[var(--af-surface)] ' +
          (images.length ? 'cursor-pointer' : 'cursor-default'),
        onDoubleClick: open,
      },
      resultUrl
        ? React.createElement(
            'div',
            {
              'data-af-media-chrome': 'true',
              className:
                'absolute inset-0 rounded-lg overflow-hidden bg-[var(--af-media-bg)] shadow-xl',
            },
            React.createElement('img', {
              src: resultUrl,
              alt: '调色结果',
              className: 'w-full h-full object-cover pointer-events-none',
              draggable: false,
            }),
          )
        : React.createElement(
            'div',
            { className: 'w-full h-full bg-[var(--af-surface)] flex flex-col items-center justify-center gap-2' },
            React.createElement(
              'div',
              { className: 'text-[var(--af-text-muted)]' },
              React.createElement(Empty, { size: 40 }),
            ),
            React.createElement(
              'div',
              { className: 'text-[10px] text-[var(--af-text-muted)]' },
              images.length ? '双击打开合成器' : '把图像连进来',
            ),
          ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-fisherai-open-compositor': 'true',
          className:
            'absolute right-2 top-2 z-10 h-7 px-2 rounded-md text-[10px] font-bold bg-black/55 text-white hover:bg-black/75 backdrop-blur-sm',
          onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(),
          onClick: open,
        },
        '合成器',
      ),
    ),
  );
}

/**
 * 转接节点（dsh-aifisher-canvas v1.71）—— Shift+右键划过的同源连线收进这里。
 * 形态是一个 34×34 的小圆点（Blender Reroute 那种），圆里直接显示上游缩略图；
 * 它不生成图：canvasSceneData 会把 Junction 父节点解析成更上游那张图，
 * 所以下游拿到的参考图与直连完全一致。
 */
export function CanvasJunctionNode(
  React: Runtime,
  props: Props,
  { Frame }: Components,
) {
  const [upstream] = imagesOf(props.connectedImageNodes, 1);
  const url = upstream?.url || '';
  const active = props.selected === true || props.isHoveredForConnection === true;
  return React.createElement(
    Frame,
    { ...frameProps(props), isBareCard: true },
    React.createElement(
      'div',
      {
        title: '转接点：一路进、多路出，只整理连线走向',
        'data-fisherai-junction': 'true',
        style: {
          position: 'relative',
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          border: '2px solid ' + (active ? '#60a5fa' : 'var(--af-border-control)'),
          background: 'var(--af-surface-raised)',
          boxShadow: active ? '0 0 0 3px rgba(96,165,250,.28)' : '0 2px 8px rgba(0,0,0,.45)',
          overflow: 'hidden',
          boxSizing: 'border-box',
        },
      },
      url
        ? React.createElement('img', {
            src: url,
            alt: '转接上游',
            draggable: false,
            className: 'w-full h-full object-cover pointer-events-none',
          })
        : React.createElement('span', {
            style: {
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: '8px',
              height: '8px',
              marginLeft: '-4px',
              marginTop: '-4px',
              borderRadius: '50%',
              background: 'var(--af-text-muted)',
            },
          }),
    ),
  );
}
