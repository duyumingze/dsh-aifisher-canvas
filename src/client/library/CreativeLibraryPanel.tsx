/**
 * 素材库面板（client 半）
 *
 * 轻量版：直接读两个 catalog JSON，网格浏览 + 搜索 + 分类 + 复制提示词。
 * 不依赖 lucide-react / AIFISHER 内部节点上下文（DSH ModuleLoader 只放行 react）。
 *
 * 数据源：
 *   creativeCatalog.json  - 风格 / 运镜 / 滤镜（336 条）
 *   mjStyleCatalog.json   - MJ 风格码（493 条）
 *
 * 静态资源（webp）走 /creative-presets/* 和 /mj-styles/*，
 * 由 host 半在 DSH web server 上把插件 public/ 目录挂成静态根。
 *
 * 根容器**必须自己 position:relative + 撑满**（与 CanvasPanel 同样的理由）：
 * main slot 渲染在 ui-layout 的 centerCol 里，centerCol 没有 position，
 * 若这里用 absolute inset:0，最近的可定位祖先是整个 AppFrame → 面板会盖住左侧边栏
 * （面板一打开就没有任何退路）。onExit 则给出显式的「回对话」出口。
 */
import * as React from 'react';

import { PanelExitButton } from '../PanelExitButton';

// @ts-ignore  - resolveJsonModule 在 tsconfig 已开，但 client 构建时走 tsdown 也能处理
import creativeCatalog from './creativeCatalog.json';
// @ts-ignore
import mjStyleCatalog from './mjStyleCatalog.json';

interface CreativePreset {
  id: string;
  kind: 'style' | 'motion' | 'filter';
  category: string;
  name: string;
  description: string;
  prompt: string;
  prefix?: string;
  preview?: string;
  poster?: string;
}

interface MjStyle {
  id: string;
  group: string;
  category: string;
  name: string;
  medium?: string;
  codes?: string;
  parameters?: string;
  prompt: string;
  vibe?: string;
  thumbnail: string;
  preview?: string;
}

const creative = creativeCatalog as CreativePreset[];
const mjStyles = mjStyleCatalog as MjStyle[];

type Tab = 'style' | 'motion' | 'filter' | 'mj';
const TAB_LABELS: Record<Tab, string> = {
  style: '风格',
  motion: '运镜',
  filter: '滤镜',
  mj: 'MJ 风格',
};

const PAGE_SIZE = 48;

function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

export function CreativeLibraryPanel({ onExit }: { onExit?: () => void } = {}) {
  const [tab, setTab] = React.useState<Tab>('style');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<string>('全部');
  const [page, setPage] = React.useState(0);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const debouncedQuery = useDebounced(query.trim().toLowerCase(), 150);

  // 当前 tab 的数据集
  const source: CreativePreset[] | MjStyle[] = tab === 'mj' ? mjStyles : creative;
  const categories = React.useMemo(() => {
    const list = tab === 'mj'
      ? (mjStyles as MjStyle[]).map((s) => s.category)
      : creative.filter((p) => p.kind === tab).map((p) => p.category);
    return ['全部', ...Array.from(new Set(list)).filter(Boolean)];
  }, [tab]);

  const filtered = React.useMemo(() => {
    const base = tab === 'mj' ? mjStyles : creative.filter((p) => p.kind === tab);
    return base.filter((item) => {
      if (category !== '全部' && (item as { category?: string }).category !== category) {
        return false;
      }
      if (!debouncedQuery) return true;
      const text = `${item.name} ${(item as { description?: string }).description ?? ''} ${(item as { prompt?: string }).prompt ?? ''}`.toLowerCase();
      return text.includes(debouncedQuery);
    });
  }, [tab, category, debouncedQuery]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // 切 tab / 分类 / 搜索时重置分页
  React.useEffect(() => {
    setPage(0);
    setSelectedId(null);
  }, [tab, category]);

  const selected = React.useMemo(() => {
    if (!selectedId) return null;
    return filtered.find((item) => item.id === selectedId) ?? null;
  }, [selectedId, filtered]);

  function copyText(text: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  const tabButton = (t: Tab, label: string) =>
    React.createElement(
      'button',
      {
        key: t,
        onClick: () => setTab(t),
        style: {
          padding: '6px 12px',
          background: tab === t ? 'rgba(36,95,214,0.35)' : 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 13,
        },
      },
      label,
    );

  return React.createElement(
    'div',
    {
      'data-dsh-aifisher-library': 'panel',
      style: {
        // 与 CanvasPanel 一致：本层自己做定位容器，否则 absolute 会以 AppFrame 为基准盖住侧边栏
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: '#0e0f13',
        color: '#cfd3dc',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      },
    },
    // 顶部 tab
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 6, padding: '12px 16px 8px', flexWrap: 'wrap' } },
      (Object.keys(TAB_LABELS) as Tab[]).map((t) => tabButton(t, TAB_LABELS[t])),
    ),
    // 搜索 + 分类
    React.createElement(
      'div',
      { style: { display: 'flex', gap: 8, padding: '0 16px 8px', alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement('input', {
        type: 'search',
        placeholder: '搜索名称 / 描述 / 提示词…',
        value: query,
        onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
        style: {
          flex: '1 1 200px',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'inherit',
          borderRadius: 4,
        },
      }),
      React.createElement(
        'select',
        {
          value: category,
          onChange: (e: { target: { value: string } }) => setCategory(e.target.value),
          style: {
            padding: '6px 8px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'inherit',
            borderRadius: 4,
          },
        },
        categories.map((c) => React.createElement('option', { key: c, value: c }, c)),
      ),
      React.createElement(
        'span',
        { style: { fontSize: 12, opacity: 0.6 } },
        `${filtered.length} 条`,
      ),
    ),
    // 网格
    React.createElement(
      'div',
      {
        style: {
          flex: 1,
          overflow: 'auto',
          padding: '4px 16px 16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 10,
          alignContent: 'start',
        },
      },
      pageItems.map((item) => {
        const cover =
          tab === 'mj'
            ? (item as MjStyle).thumbnail
            : ((item as CreativePreset).preview || (item as CreativePreset).poster);
        return React.createElement(
          'button',
          {
            key: item.id,
            onClick: () => setSelectedId(item.id),
            style: {
              background: 'rgba(255,255,255,0.04)',
              border:
                selectedId === item.id
                  ? '1px solid rgba(90,140,255,0.8)'
                  : '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              padding: 6,
              cursor: 'pointer',
              textAlign: 'left',
              color: 'inherit',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          React.createElement('img', {
            src: cover,
            alt: item.name,
            loading: 'lazy',
            style: {
              width: '100%',
              aspectRatio: '4 / 3',
              objectFit: 'cover',
              borderRadius: 4,
              background: '#1a1c22',
              display: 'block',
            },
          }),
          React.createElement(
            'div',
            {
              style: {
                fontSize: 12,
                lineHeight: 1.3,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              },
            },
            item.name,
          ),
        );
      }),
      !pageItems.length &&
        React.createElement(
          'div',
          { style: { gridColumn: '1 / -1', padding: 40, opacity: 0.5, textAlign: 'center' } },
          '没有匹配的预设',
        ),
    ),
    // 分页
    pageCount > 1 &&
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            justifyContent: 'center',
            padding: '0 16px 12px',
            alignItems: 'center',
          },
        },
        React.createElement(
          'button',
          {
            disabled: page === 0,
            onClick: () => setPage((p: number) => Math.max(0, p - 1)),
            style: paginationStyle(),
          },
          '上一页',
        ),
        React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, `${page + 1} / ${pageCount}`),
        React.createElement(
          'button',
          {
            disabled: page >= pageCount - 1,
            onClick: () => setPage((p: number) => Math.min(pageCount - 1, p + 1)),
            style: paginationStyle(),
          },
          '下一页',
        ),
      ),
    // 退出面板（回 DSH 对话）
    React.createElement(PanelExitButton, {
      id: 'library',
      label: '返回对话',
      title: '退出素材库，回到 DSH 对话',
      onExit,
      // 详情抽屉贴右边（宽 360），按钮放左下才不会压住抽屉内容
      placement: 'bottom-left',
    }),
    // 详情抽屉
    selected &&
      React.createElement(
        'div',
        {
          style: {
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 360,
            maxWidth: '90%',
            background: '#15171d',
            borderLeft: '1px solid rgba(255,255,255,0.1)',
            padding: 16,
            overflow: 'auto',
            boxShadow: '-8px 0 24px rgba(0,0,0,0.4)',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
          React.createElement('strong', null, selected.name),
          React.createElement(
            'button',
            {
              onClick: () => setSelectedId(null),
              style: { background: 'transparent', color: 'inherit', border: 'none', fontSize: 18, cursor: 'pointer' },
            },
            '×',
          ),
        ),
        selected.category &&
          React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.6, marginBottom: 8 } },
            selected.category,
          ),
        'medium' in selected && selected.medium &&
          React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } },
            `媒介质感：${selected.medium}`,
          ),
        'vibe' in selected && selected.vibe &&
          React.createElement(
            'div',
            { style: { fontSize: 12, opacity: 0.8, marginBottom: 8, lineHeight: 1.5 } },
            `色调：${selected.vibe}`,
          ),
        React.createElement(DetailBlock, {
          label: '提示词',
          text: (selected as CreativePreset).prompt || (selected as MjStyle).prompt,
        }),
        'codes' in selected && selected.codes &&
          React.createElement(DetailBlock, { label: 'MJ 风格码', text: selected.codes }),
        'parameters' in selected && selected.parameters &&
          React.createElement(DetailBlock, { label: '完整参数', text: selected.parameters }),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' } },
          React.createElement(
            'button',
            {
              onClick: () =>
                copyText((selected as CreativePreset).prompt || (selected as MjStyle).prompt),
              style: primaryBtnStyle(),
            },
            copied ? '已复制 ✓' : '复制提示词',
          ),
          'codes' in selected && selected.codes &&
            React.createElement(
              'button',
              {
                onClick: () => copyText(selected.codes!),
                style: secondaryBtnStyle(),
              },
              '复制风格码',
            ),
        ),
      ),
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return React.createElement(
    'div',
    { style: { marginBottom: 10 } },
    React.createElement('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 4 } }, label),
    React.createElement(
      'pre',
      {
        style: {
          margin: 0,
          padding: 8,
          background: 'rgba(0,0,0,0.3)',
          borderRadius: 4,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 240,
          overflow: 'auto',
        },
      },
      text,
    ),
  );
}

function paginationStyle(): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'inherit',
    cursor: 'pointer',
    borderRadius: 4,
  };
}
function primaryBtnStyle(): React.CSSProperties {
  return {
    padding: '8px 14px',
    background: 'rgba(36,95,214,0.85)',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    borderRadius: 4,
  };
}
function secondaryBtnStyle(): React.CSSProperties {
  return {
    padding: '8px 14px',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.15)',
    color: 'inherit',
    cursor: 'pointer',
    borderRadius: 4,
  };
}
