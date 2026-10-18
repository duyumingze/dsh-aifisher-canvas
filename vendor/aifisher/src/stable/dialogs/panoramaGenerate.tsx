import * as React from 'react';
import { X, Globe } from 'lucide-react';
import { activateModal } from '../design/modalFocus';
import { ImageToolGenerateButton } from './imageToolGenerateButton';
export function PanoramaGenerate({
  node,
  onClose,
  onGenerate,
}: {
  node: { id: string; resultUrl?: string };
  onClose(): void;
  onGenerate?(id: string): void;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState('');
  React.useEffect(
    () => (root.current ? activateModal(root.current, onClose) : undefined),
    [onClose],
  );
  return (
    <div
      className="af-angle-workspace af-panorama-generate"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <img className="af-angle-source" src={node.resultUrl} alt="全景参考图片" />
      <div
        ref={root}
        className="af-angle-panel"
        role="dialog"
        aria-modal="true"
        aria-label="生成全景图"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header>
          <Globe size={18} />
          <strong>生成全景图</strong>
          <span>从当前图片补全环绕空间</span>
          <button aria-label="关闭全景生成" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <footer>
          <span role="status">
            {error || '会新建一个图片节点（提示词已填、原图已连上），生成由你在节点上点。'}
          </span>
          <ImageToolGenerateButton
            label="创建全景图节点"
            aspectRatio="2:1"
            onClick={() => {
              try {
                if (!onGenerate) throw new Error('请先打开项目。');
                onGenerate(node.id);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : '生成失败');
              }
            }}
          />
        </footer>
      </div>
    </div>
  );
}
