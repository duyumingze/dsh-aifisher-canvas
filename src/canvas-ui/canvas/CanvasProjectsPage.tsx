/**
 * 项目库（v1.84，设计稿 A「卡片墙」+ 视图切换即 B「列表 + 详情」）。
 *
 * 用户 2026-10-30 拍板：「项目库默认卡片墙 A、视图切换即列表 B」，并且这一屏是四屏里
 * 最缺的一块（以前只有顶栏「← 项目库」和「项目归档」弹层，没有一个能看全所有项目的地方）。
 *
 * 这一屏只做三件事：
 *   1. 把**真实的**项目列出来（`/api/aifisher/canvas/projects`：节点数、图/视频数、
 *      素材字节、缩略图、最近生成、用过的模型、进行中任务数）；
 *   2. 让用户在这里**打开 / 新建 / 重命名 / 收藏 / 复制 / 归档 / 导出 / 导入**项目；
 *   3. 打开项目走 v1.42 就有的 `openProjectById`（派发 `fisherai:open-project`，
 *      画布里的 vendor 补丁接住它切项目），所以**不用刷新 DSH 页面**。
 *
 * 与设计稿的差异（都因为「不用假数据」）：
 *   - hero 里的任务进度条换成「进行中 N 个任务」——host 只给计数，不给假百分比；
 *   - 左栏「本地存储 4.2 / 20 GB」换成真实占用（磁盘总量不是插件能知道的）；
 *   - 卡片/列表里的封面、最近生成全部来自真实素材，没有封面就画渐变占位。
 *
 * ⚠️ hooks 必须用注入进来的 React（第一个参数）——产物里 React 有两份副本。
 * ⚠️ 结构契约（回归依赖）：`data-fisherai-project-card` + `data-project-id`、
 * `data-fisherai-projects-view="cards|list"`、`data-fisherai-projects-search`、
 * `data-fisherai-project-new`、`data-fisherai-project-open`、`data-fisherai-project-drawer`。
 */
import * as ReactTypes from 'react';
import { createElement, type CanvasCreateElement } from '@/lib/react';
import {
  Archive as ArchiveIcon,
  Check as CheckIcon,
  Clock as ClockIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  FolderOpen as FolderOpenIcon,
  Image as ImageIcon,
  LayoutGrid as LayoutGridIcon,
  List as ListIcon,
  MoreHorizontal as MoreHorizontalIcon,
  Play as PlayIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Star as StarIcon,
  Trash2 as Trash2Icon,
} from 'lucide-react';

import { CanvasPageShellView } from './CanvasPageShell';
import {
  closeCanvasPage,
  currentCanvasPage,
  openCanvasPage,
  subscribeCanvasPage,
  type CanvasPageRequest,
} from './CanvasPagesStore';
import {
  createProject,
  deleteProject,
  duplicateProject,
  fetchProjects,
  formatBytes,
  projectCanvasText,
  projectContentText,
  projectScaleText,
  relativeTime,
  setProjectFavorite,
  setProjectNote,
  setProjectStatus,
  type ProjectCard,
  type ProjectsPayload,
} from './CanvasProjects';
import {
  importProjectArchiveViaPicker,
  openProjectById,
  saveProjectArchiveToDirectory,
} from './CanvasProjectArchive';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'useState'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useSyncExternalStore'
  | 'useRef'
>;

type View = 'cards' | 'list';
type Facet = 'all' | 'recent' | 'favorite' | 'archived';
type KindFilter = 'all' | 'image' | 'video' | 'text';

const FACETS: Array<{ id: Facet; label: string; icon: unknown }> = [
  { id: 'all', label: '全部项目', icon: LayoutGridIcon },
  { id: 'recent', label: '最近编辑', icon: ClockIcon },
  { id: 'favorite', label: '收藏', icon: StarIcon },
  { id: 'archived', label: '已归档', icon: ArchiveIcon },
];

const KIND_FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'text', label: '文本' },
];

function matches(project: ProjectCard, facet: Facet, kind: KindFilter, keyword: string): boolean {
  if (facet === 'archived' && project.status !== 'archived') return false;
  if (facet !== 'archived' && project.status === 'archived') return false;
  if (facet === 'favorite' && !project.favorite) return false;
  if (facet === 'recent') {
    const updated = Date.parse(project.updatedAt);
    if (!Number.isFinite(updated) || Date.now() - updated > 7 * 24 * 60 * 60 * 1000) return false;
  }
  if (kind !== 'all') {
    if (kind === 'image' && !project.imageCount) return false;
    if (kind === 'video' && !project.videoCount) return false;
    if (kind === 'text' && !project.nodeTypes.text) return false;
  }
  const text = keyword.trim().toLowerCase();
  if (!text) return true;
  return `${project.title} ${project.note}`.toLowerCase().includes(text);
}

/** 封面图（没有就画渐变占位，不留白块）。 */
function coverOf(h: CanvasCreateElement, project: ProjectCard) {
  return h(
    'div',
    { className: 'afp-card-cover' },
    project.thumbUrl
      ? h('img', { src: project.thumbUrl, alt: '', draggable: false, loading: 'lazy' })
      : h('div', { className: 'afp-cover-fallback' }),
  );
}

function badgesOf(h: CanvasCreateElement, project: ProjectCard) {
  const badges: unknown[] = [];
  if (project.status === 'archived') {
    badges.push(h('span', { key: 'archived', className: 'afg-tag' }, '已归档'));
  } else if (project.running > 0) {
    badges.push(
      h(
        'span',
        { key: 'running', className: 'afg-tag afg-mint' },
        h('span', { className: 'afg-dot' }),
        `${project.running} 任务`,
      ),
    );
  }
  if (project.favorite) {
    badges.push(h('span', { key: 'fav', className: 'afg-tag afg-violet' }, '收藏'));
  }
  if (!badges.length) return null;
  return h('div', { className: 'afp-badges' }, ...badges);
}

export interface CanvasProjectsPageProps {
  /** 回归可传一份固定页面状态；不传就订阅全局 store（真机路径）。 */
  page?: CanvasPageRequest | null;
}

export function CanvasProjectsPage(react: Runtime, props: CanvasProjectsPageProps = {}) {
  const h = createElement(react);
  const storePage = react.useSyncExternalStore(
    subscribeCanvasPage,
    currentCanvasPage,
    currentCanvasPage,
  );
  const page = props.page === undefined ? storePage : props.page;
  const open = page?.id === 'projects';
  const pageKey = page?.key ?? 0;

  const [payload, setPayload] = react.useState<ProjectsPayload | null>(null);
  const [loading, setLoading] = react.useState(false);
  const [error, setError] = react.useState('');
  const [toast, setToast] = react.useState('');
  const [view, setView] = react.useState<View>('cards');
  const [facet, setFacet] = react.useState<Facet>('all');
  const [kind, setKind] = react.useState<KindFilter>('all');
  const [keyword, setKeyword] = react.useState('');
  const [selected, setSelected] = react.useState('');
  const [renaming, setRenaming] = react.useState('');
  const [renameValue, setRenameValue] = react.useState('');
  const [noteDraft, setNoteDraft] = react.useState<string | null>(null);
  const [busy, setBusy] = react.useState('');
  const toastTimer = react.useRef<number | null>(null);

  const say = react.useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3600);
  }, []);

  const reload = react.useCallback(
    async (options: { quiet?: boolean } = {}) => {
      if (!options.quiet) setLoading(true);
      try {
        const next = await fetchProjects();
        setPayload(next);
        setError('');
        setSelected((current) =>
          next.projects.some((project) => project.id === current) ? current : '',
        );
        return next;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 每次打开重新拉一遍（用户可能刚在画布里改过，也可能刚导入了一个项目）。
  react.useEffect(() => {
    if (!open) return;
    // 每次「重新打开」都回到默认视图：上次停在列表 / 某个筛选条件不该漏到这一次
    // （数据是新的，保留旧筛选容易让人以为项目丢了）。
    setView('cards');
    setFacet('all');
    setKind('all');
    setKeyword('');
    setSelected('');
    setRenaming('');
    setNoteDraft(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageKey]);

  react.useEffect(() => {
    if (!toast) return;
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, [toast]);

  const projects = payload?.projects ?? [];
  const visible = react.useMemo(
    () => projects.filter((project) => matches(project, facet, kind, keyword)),
    [projects, facet, kind, keyword],
  );
  const hero = react.useMemo(() => {
    const active = projects.filter((project) => project.status !== 'archived');
    const sorted = [...active].sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
    return sorted[0] ?? null;
  }, [projects]);
  const focused = react.useMemo(
    () => projects.find((project) => project.id === selected) ?? hero ?? null,
    [projects, selected, hero],
  );

  const counts = react.useMemo(
    () => ({
      all: projects.filter((project) => project.status !== 'archived').length,
      recent: projects.filter((project) => matches(project, 'recent', 'all', '')).length,
      favorite: projects.filter((project) => project.status !== 'archived' && project.favorite).length,
      archived: projects.filter((project) => project.status === 'archived').length,
    }),
    [projects],
  );

  /**
   * 「点一次就进画布」（v1.86）。
   *
   * 用户 2026-10-31：「打开无限画布后要点击两次才能进入画布，第一次点击好像才正式
   * 激活项目管理器」——第一次点「打开画布」时，项目库会自己关掉又弹回来。
   *
   * 根因是**关得太早**：点下去只派发 `fisherai:open-project`，vendor 还要走一次
   * `loadProject`（网络 + reset）才把 view 从 dashboard 切成 canvas。这中间页面层先
   * `closeCanvasPage()`，而首屏看门（homePage 的 ensureHome）看到「底下还是旧看板 +
   * 页面层一屏都没开」，就判定「用户回到了项目库」，立刻又 `openCanvasPage('projects')`
   * —— 项目库于是整块重挂一遍（列表重拉、视图归位），画布在它下面悄悄起来了。
   * 用户看到的就是「第一下只是把项目管理器重新激活了一下」，还得再点一下（第二次时
   * `#canvas-background` 已经在，关掉就不会再弹回来）。
   *
   * 修法：**等 vendor 的画布底盘 `#canvas-background` 真的出现再关**。等不到就留着
   * 这一屏并给一句提示（加载失败时用户还能原地重试，而不是掉进旧看板）。
   * 判断依据与 `canDismiss` 同一条，别再造第二个信号。
   */
  const enterTimer = react.useRef<number | null>(null);
  react.useEffect(
    () => () => {
      if (enterTimer.current !== null) window.clearTimeout(enterTimer.current);
    },
    [],
  );

  const enterCanvasWhenReady = react.useCallback(
    function enterCanvasWhenReady() {
      if (enterTimer.current !== null) {
        window.clearTimeout(enterTimer.current);
        enterTimer.current = null;
      }
      const deadline = Date.now() + 6000;
      const tick = () => {
        enterTimer.current = null;
        // 页面层已经切到别处 / 被关掉：不要再补一刀 close。
        if (currentCanvasPage()?.id !== 'projects') return;
        let canvasView = false;
        try {
          canvasView = Boolean(document.getElementById('canvas-background'));
        } catch {
          canvasView = false;
        }
        if (canvasView) {
          closeCanvasPage();
          return;
        }
        if (Date.now() >= deadline) {
          say('画布还没起来。稍等一下再点「打开画布」；一直起不来就刷新页面。');
          return;
        }
        enterTimer.current = window.setTimeout(tick, 60);
      };
      tick();
    },
    [say],
  );

  const openProject = react.useCallback(
    (project: ProjectCard) => {
      if (!openProjectById(project.id)) {
        say('打不开这个项目：画布没接住打开事件，刷新一下页面再试。');
        return;
      }
      enterCanvasWhenReady();
    },
    [enterCanvasWhenReady, say],
  );

  const run = react.useCallback(
    async (label: string, action: () => Promise<void>) => {
      if (busy) return;
      setBusy(label);
      try {
        await action();
      } catch (failure) {
        say(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy('');
      }
    },
    [busy, say],
  );

  const onNewProject = react.useCallback(() => {
    void run('create', async () => {
      const created = await createProject();
      // 新建项目也是「派发事件 → vendor loadProject → setView('canvas')」这条异步路，
      // 和打开已有项目一样要等画布底盘起来再关（否则同样会被首屏看门弹回来）。
      if (!openProjectById(created.id)) {
        say('新项目建好了，但画布没接住打开事件，刷新一下页面再点「打开」。');
        return;
      }
      enterCanvasWhenReady();
    });
  }, [enterCanvasWhenReady, run, say]);

  const onArchiveToggle = react.useCallback(
    (project: ProjectCard) => {
      void run('archive', async () => {
        const next = project.status === 'archived' ? 'active' : 'archived';
        await setProjectStatus(project.id, next);
        await reload({ quiet: true });
        say(next === 'archived' ? `「${project.title}」已归档` : `「${project.title}」已取消归档`);
      });
    },
    [run, reload, say],
  );

  const onFavorite = react.useCallback(
    (project: ProjectCard) => {
      void run('favorite', async () => {
        await setProjectFavorite(project.id, !project.favorite);
        await reload({ quiet: true });
      });
    },
    [run, reload],
  );

  const onDuplicate = react.useCallback(
    (project: ProjectCard) => {
      void run('duplicate', async () => {
        const copy = await duplicateProject(project.id);
        await reload({ quiet: true });
        say(`已复制成「${copy.title}」`);
      });
    },
    [run, reload, say],
  );

  const onDelete = react.useCallback(
    (project: ProjectCard) => {
      void run('delete', async () => {
        await deleteProject(project.id);
        await reload({ quiet: true });
        say(`「${project.title}」已删除（素材进了回收站）`);
      });
    },
    [run, reload, say],
  );

  const onExport = react.useCallback(
    (project: ProjectCard) => {
      void run('export', async () => {
        const result = await saveProjectArchiveToDirectory(project.id);
        say(`已导出到 ${result.path}`);
      });
    },
    [run, say],
  );

  const onImport = react.useCallback(() => {
    importProjectArchiveViaPicker({
      // 导入完不要自动打开项目：用户是在项目库里挑，不是「导入即进去」
      open: false,
      onDone: (receipt) => {
        say(`已导入「${receipt.title ?? '新项目'}」`);
        void reload({ quiet: true });
      },
      onError: (failure) => say(`导入失败：${failure.message}`),
    });
  }, [reload, say]);

  const onRenameCommit = react.useCallback(() => {
    const target = projects.find((project) => project.id === renaming);
    const title = renameValue.trim();
    if (!target || !title || title === target.title) {
      setRenaming('');
      return;
    }
    void run('rename', async () => {
      await fetch(`/api/aifisher/canvas/workflows/${encodeURIComponent(target.id)}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      setRenaming('');
      await reload({ quiet: true });
      say('已重命名');
    });
  }, [projects, renaming, renameValue, run, reload, say]);

  const onNoteCommit = react.useCallback(() => {
    const target = focused;
    if (!target || noteDraft === null) return;
    void run('note', async () => {
      await setProjectNote(target.id, noteDraft);
      setNoteDraft(null);
      await reload({ quiet: true });
      say('备注已保存');
    });
  }, [focused, noteDraft, run, reload, say]);

  if (!open) return null;

  /**
   * 能不能关掉这一屏（v1.85）。
   *
   * `#canvas-background` 是 vendor 画布视图的底盘：有它 = 底下是一个真的开着的项目；
   * 没有它 = 底下是 vendor 那张旧「项目看板」（v1.80 的显示全部/设置/导入项目/新建项目）。
   * 后者对用户来说就是「打开画布」的首屏，关掉它只会把旧界面翻出来 —— 所以这时不给关。
   * 退出整个画布仍走 DSH 右下角那个「退出画布」按钮。
   */
  const canDismiss = (() => {
    try {
      return Boolean(document.getElementById('canvas-background'));
    } catch {
      return true;
    }
  })();

  /* ----------------------------- 顶栏 ----------------------------- */

  const search = h(
    'label',
    { className: 'afg-search' },
    h(SearchIcon, {}),
    h('input', {
      type: 'search',
      value: keyword,
      placeholder: '搜索项目名称 / 备注',
      'aria-label': '搜索项目',
      'data-fisherai-projects-search': 'true',
      onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setKeyword(event.target.value),
    }),
    h('span', { className: 'afg-kbd' }, 'Ctrl'),
    h('span', { className: 'afg-kbd' }, 'K'),
  );

  const viewSwitch = h(
    'div',
    { className: 'afg-seg', role: 'tablist', 'data-fisherai-projects-view': view },
    h(
      'button',
      {
        type: 'button',
        'aria-label': '卡片视图',
        'aria-pressed': view === 'cards',
        className: view === 'cards' ? 'afg-on' : '',
        onClick: () => setView('cards'),
      },
      h(LayoutGridIcon, {}),
    ),
    h(
      'button',
      {
        type: 'button',
        'aria-label': '列表视图',
        'aria-pressed': view === 'list',
        className: view === 'list' ? 'afg-on' : '',
        onClick: () => setView('list'),
      },
      h(ListIcon, {}),
    ),
  );

  const topRight = [
    viewSwitch,
    h('span', { key: 'sep', className: 'afg-vdiv', style: { height: 20 } }),
    h(
      'button',
      {
        key: 'new',
        type: 'button',
        'data-fisherai-project-new': 'true',
        className: 'afg-btn afg-primary',
        disabled: busy === 'create',
        onClick: onNewProject,
      },
      h(PlusIcon, {}),
      busy === 'create' ? '正在新建…' : '新建项目',
    ),
    h(
      'button',
      {
        key: 'settings',
        type: 'button',
        'aria-label': '设置',
        title: '设置',
        'data-fisherai-projects-settings': 'true',
        className: 'afg-iconbtn',
        onClick: () => openCanvasPage('settings'),
      },
      h(SettingsIcon, {}),
    ),
  ];

  /* ----------------------------- 左栏 ----------------------------- */

  const storage = payload?.storage ?? null;
  const storagePercent = storage && storage.totalBytes > 0
    ? Math.min(100, Math.max(2, Math.round((storage.mediaBytes / storage.totalBytes) * 100)))
    : 0;

  const side = h(
    'aside',
    { className: 'afp-side', 'aria-label': '项目筛选' },
    h(
      'div',
      { className: 'afp-side-group' },
      h('div', { className: 'afp-side-label' }, '视图'),
      ...FACETS.map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            'data-fisherai-projects-facet': item.id,
            className: facet === item.id ? 'afp-side-item afg-on' : 'afp-side-item',
            'aria-pressed': facet === item.id,
            onClick: () => setFacet(item.id),
          },
          h(item.icon as ReactTypes.ComponentType, {}),
          item.label,
          h('span', { className: 'afp-n' }, String(counts[item.id])),
        ),
      ),
    ),
    h(
      'div',
      { className: 'afp-side-group' },
      h('div', { className: 'afp-side-label' }, '筛选'),
      h(
        'div',
        { className: 'afp-side-chips' },
        ...KIND_FILTERS.map((item) =>
          h(
            'span',
            {
              key: item.id,
              role: 'button',
              tabIndex: 0,
              'data-fisherai-projects-kind': item.id,
              className: kind === item.id ? 'afg-chip afg-on' : 'afg-chip',
              'aria-pressed': kind === item.id,
              onClick: () => setKind(item.id),
              onKeyDown: (event: ReactTypes.KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') setKind(item.id);
              },
            },
            item.label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'afp-side-foot' },
      h(
        'div',
        { className: 'afp-storage' },
        h(
          'div',
          { className: 'afp-storage-top' },
          h('span', { className: 'afg-dim' }, '本地占用'),
          h('span', { className: 'afg-mono' }, formatBytes(storage?.totalBytes ?? 0)),
        ),
        h(
          'div',
          { className: 'afp-storage-bar' },
          h('i', { style: { width: `${storagePercent}%` } }),
        ),
        h(
          'div',
          { className: 'afp-storage-sub afg-dim afg-f11' },
          `素材 ${formatBytes(storage?.mediaBytes ?? 0)} · 文档 ${formatBytes(storage?.documentBytes ?? 0)}`,
        ),
      ),
      h(
        'button',
        { type: 'button', className: 'afg-btn afg-ghost afg-sm', onClick: onImport },
        h(DownloadIcon, {}),
        '导入项目',
      ),
    ),
  );

  /* ----------------------------- 卡片墙 ----------------------------- */

  const cardActions = (project: ProjectCard) => {
    const icon = (label: string, node: unknown, onClick: () => void) =>
      h(
        'button',
        {
          type: 'button',
          'aria-label': label,
          title: label,
          className: 'afp-ha',
          onClick: (event: ReactTypes.MouseEvent) => {
            event.stopPropagation();
            onClick();
          },
        },
        node,
      );
    return h(
      'div',
      { className: 'afp-hover-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'afp-ha afp-primary',
          'data-fisherai-project-open': project.id,
          onClick: (event: ReactTypes.MouseEvent) => {
            event.stopPropagation();
            openProject(project);
          },
        },
        '打开',
      ),
      icon('收藏', h(StarIcon, { fill: project.favorite ? 'currentColor' : 'none' }), () =>
        onFavorite(project),
      ),
      icon('导出', h(DownloadIcon, {}), () => onExport(project)),
      icon(
        project.status === 'archived' ? '取消归档' : '移到归档',
        h(ArchiveIcon, {}),
        () => onArchiveToggle(project),
      ),
    );
  };

  const gridCard = (project: ProjectCard) =>
    h(
      'article',
      {
        key: project.id,
        className: [
          'afp-card',
          project.status === 'archived' ? 'afp-archived' : '',
          selected === project.id ? 'afp-selected' : '',
        ]
          .filter(Boolean)
          .join(' '),
        'data-fisherai-project-card': project.id,
        'data-project-id': project.id,
        tabIndex: 0,
        role: 'button',
        'aria-label': `项目 ${project.title}`,
        onClick: () => setSelected(project.id),
        onDoubleClick: () => openProject(project),
        onKeyDown: (event: ReactTypes.KeyboardEvent) => {
          if (event.key === 'Enter') openProject(project);
        },
      },
      coverOf(h, project),
      badgesOf(h, project),
      cardActions(project),
      h(
        'div',
        { className: 'afp-card-meta' },
        h('div', { className: 'afp-card-name' }, project.title),
        h('div', { className: 'afp-card-sub' }, projectScaleText(project)),
        h('div', { className: 'afp-card-time' }, relativeTime(project.updatedAt)),
      ),
    );

  const newCard = h(
    'button',
    { type: 'button', className: 'afp-card afp-new', onClick: onNewProject },
    h('span', { className: 'afp-new-plus' }, h(PlusIcon, {})),
    h('span', { className: 'afp-new-t' }, '新建项目'),
    h('span', { className: 'afp-new-s afg-dim afg-f11' }, '空白画布，或从备份导入'),
  );

  const heroBlock = hero
    ? h(
        'section',
        { className: 'afp-hero', 'data-fisherai-projects-hero': hero.id },
        h(
          'div',
          { className: 'afp-hero-cover' },
          hero.thumbUrl
            ? h('img', { src: hero.thumbUrl, alt: '', draggable: false })
            : h('div', { className: 'afp-cover-fallback' }),
          h(
            'span',
            { className: 'afp-hero-badge' },
            h('span', { className: 'afg-dot' }),
            '继续编辑',
          ),
        ),
        h(
          'div',
          { className: 'afp-hero-info' },
          h(
            'div',
            { className: 'afp-hero-eyebrow' },
            h('span', { className: 'afg-tag afg-mint' }, hero.status === 'archived' ? '已归档' : '进行中'),
            h(
              'span',
              { className: 'afg-dim afg-f11' },
              `最后编辑 ${relativeTime(hero.updatedAt)}${hero.running ? ` · ${hero.running} 个任务运行中` : ''}`,
            ),
          ),
          h('h1', {}, hero.title),
          h('p', { className: 'afp-hero-sub' }, projectScaleText(hero)),
          h(
            'div',
            { className: 'afp-hero-actions' },
            h(
              'button',
              { type: 'button', className: 'afg-btn afg-primary', onClick: () => openProject(hero) },
              h(PlayIcon, {}),
              '打开画布',
              h('span', { className: 'afg-kbd' }, '↵'),
            ),
            h(
              'button',
              { type: 'button', className: 'afg-btn', onClick: () => onExport(hero) },
              h(ArchiveIcon, {}),
              '导出备份',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'afg-iconbtn',
                'aria-label': '收藏这个项目',
                title: hero.favorite ? '取消收藏' : '收藏',
                onClick: () => onFavorite(hero),
              },
              h(StarIcon, { fill: hero.favorite ? 'currentColor' : 'none' }),
            ),
          ),
          h(
            'div',
            { className: 'afp-hero-meta' },
            h('span', { className: 'afg-tag' }, '本地 ComfyUI'),
            ...hero.models.slice(0, 2).map((model) =>
              h('span', { key: model, className: 'afg-tag afg-violet' }, model),
            ),
            h(
              'span',
              { className: 'afg-dim afg-f11 afg-mono' },
              `画布 ${projectCanvasText(hero)}`,
            ),
          ),
        ),
        h(
          'div',
          { className: 'afp-hero-recent' },
          h('div', { className: 'afg-dim afg-f11' }, '最近生成'),
          h(
            'div',
            { className: 'afp-thumbs' },
            ...hero.recent.slice(0, 3).map((url) =>
              h('div', { key: url, className: 'afp-thumb' }, h('img', { src: url, alt: '', draggable: false })),
            ),
            hero.imageCount > 3
              ? h(
                  'div',
                  { className: 'afp-thumb afp-more' },
                  h('span', { className: 'afg-mono' }, `+${hero.imageCount - 3}`),
                )
              : hero.recent.length === 0
                ? h('div', { className: 'afp-thumb afp-more' }, h('span', {}, '暂无'))
                : null,
          ),
          h('div', { className: 'afp-hr-sep' }),
          h('div', { className: 'afg-dim afg-f11' }, '任务'),
          h(
            'div',
            { className: 'afp-tasks' },
            hero.running > 0
              ? h(
                  'div',
                  { className: 'afp-trow' },
                  h(ImageIcon, { style: { width: 13, height: 13 }, className: 'afg-violet' }),
                  h('span', { className: 'afg-f11 afg-dim2 afg-ellip afg-grow' }, '生成中'),
                  h('span', { className: 'afg-f11 afg-mono afg-mint' }, `${hero.running} 个`),
                )
              : h(
                  'div',
                  { className: 'afp-trow' },
                  h(CheckIcon, { style: { width: 13, height: 13 }, className: 'afg-dim' }),
                  h('span', { className: 'afg-f11 afg-dim2 afg-ellip afg-grow' }, '没有进行中的任务'),
                ),
          ),
        ),
      )
    : null;

  const cardsMain = h(
    'main',
    { className: 'afp-main afg-scroll' },
    heroBlock,
    h(
      'div',
      { className: 'afp-list-head' },
      h(
        'div',
        { className: 'afg-sect-head' },
        h('h2', {}, facet === 'archived' ? '已归档' : '全部项目'),
        h('span', { className: 'afg-hint' }, '按修改时间排序'),
      ),
      h(
        'div',
        { className: 'afg-center afg-gap8' },
        h(
          'button',
          { type: 'button', className: 'afg-chip', onClick: () => void reload() },
          h(ClockIcon, { style: { width: 13, height: 13 } }),
          loading ? '刷新中…' : '最近修改',
        ),
      ),
    ),
    error ? h('div', { className: 'afp-foot afg-alert' }, error) : null,
    visible.length === 0 && !loading
      ? h(
          'div',
          { className: 'afg-empty' },
          h('div', {}, facet === 'archived' ? '还没有归档的项目。' : '这个筛选条件下没有项目。'),
          keyword ? h('div', { className: 'afg-f11' }, `搜索词：${keyword}`) : null,
        )
      : null,
    h(
      'div',
      { className: 'afp-grid' },
      ...visible.filter((project) => project.status !== 'archived').map(gridCard),
      newCard,
    ),
    h(
      'div',
      { className: 'afp-foot' },
      `已显示 ${visible.length} 个项目`,
      counts.archived ? ` · ${counts.archived} 个已归档项目` : '',
      loading ? ' · 正在刷新…' : '',
    ),
  );

  /* ----------------------------- 列表视图 ----------------------------- */

  const renameInput = (project: ProjectCard) =>
    h('input', {
      className: 'afp-rename',
      value: renameValue,
      autoFocus: true,
      'aria-label': '项目名称',
      onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setRenameValue(event.target.value),
      onBlur: onRenameCommit,
      onKeyDown: (event: ReactTypes.KeyboardEvent) => {
        if (event.key === 'Enter') onRenameCommit();
        if (event.key === 'Escape') setRenaming('');
      },
      onClick: (event: ReactTypes.MouseEvent) => event.stopPropagation(),
    });

  const listRow = (project: ProjectCard) =>
    h(
      'div',
      {
        key: project.id,
        className: [
          'afp-tr',
          project.status === 'archived' ? 'afp-archived' : '',
          focused?.id === project.id ? 'afg-on' : '',
        ]
          .filter(Boolean)
          .join(' '),
        role: 'button',
        tabIndex: 0,
        'data-fisherai-project-row': project.id,
        'data-project-id': project.id,
        style: project.status === 'archived' ? { opacity: 0.62 } : undefined,
        onClick: () => setSelected(project.id),
        onDoubleClick: () => openProject(project),
        onKeyDown: (event: ReactTypes.KeyboardEvent) => {
          if (event.key === 'Enter') openProject(project);
        },
      },
      h(
        'div',
        { className: 'afp-pcell' },
        h(
          'span',
          { className: 'afp-pthumb' },
          project.thumbUrl
            ? h('img', { src: project.thumbUrl, alt: '', draggable: false, loading: 'lazy' })
            : h('span', { className: 'afp-cover-fallback' }),
        ),
        h(
          'span',
          { className: 'afp-txt' },
          renaming === project.id
            ? renameInput(project)
            : h('span', { className: 'afp-t' }, project.title),
          h(
            'span',
            { className: 'afp-s' },
            project.status === 'archived'
              ? '已归档'
              : project.running
                ? `${project.running} 个任务运行中`
                : `${project.groupCount ? `${project.groupCount} 个分组 · ` : ''}${relativeTime(project.updatedAt)}`,
          ),
        ),
      ),
      h('span', { className: 'afp-cell-num' }, String(project.nodeCount)),
      h('span', { className: 'afp-cell-dim' }, projectContentText(project)),
      h('span', { className: 'afp-cell-dim' }, relativeTime(project.updatedAt)),
      h('span', { className: 'afp-cell-dim' }, formatBytes(project.mediaBytes)),
      h(
        'span',
        { className: 'afp-row-actions' },
        h(
          'button',
          {
            type: 'button',
            'aria-label': '更多',
            className: 'afg-iconbtn',
            onClick: (event: ReactTypes.MouseEvent) => {
              event.stopPropagation();
              setSelected(project.id);
              setView('list');
            },
          },
          h(MoreHorizontalIcon, {}),
        ),
      ),
    );

  const groups = [
    { title: '本周', items: [] as ProjectCard[] },
    { title: '更早', items: [] as ProjectCard[] },
    { title: '已归档', items: [] as ProjectCard[] },
  ];
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  for (const project of visible) {
    if (project.status === 'archived') groups[2].items.push(project);
    else if (Date.now() - (Date.parse(project.updatedAt) || 0) <= weekMs) groups[0].items.push(project);
    else groups[1].items.push(project);
  }

  const listMain = h(
    'main',
    { className: 'afp-list-main' },
    h(
      'div',
      { className: 'afp-list-head2' },
      h(
        'div',
        { className: 'afg-sect-head' },
        h('h2', {}, '全部项目'),
        h(
          'span',
          { className: 'afg-hint' },
          `${projects.length} 个 · 已用 ${formatBytes(storage?.totalBytes ?? 0)}`,
        ),
      ),
      h(
        'div',
        { className: 'afg-center afg-gap8' },
        h(
          'button',
          { type: 'button', className: 'afg-chip', onClick: () => void reload() },
          h(ClockIcon, { style: { width: 13, height: 13 } }),
          loading ? '刷新中…' : '修改时间',
        ),
      ),
    ),
    h(
      'div',
      { className: 'afp-table afg-scroll', style: { flex: '1 1 auto', minHeight: 0 } },
      h(
        'div',
        { className: 'afp-tr afp-th' },
        h('span', {}, '项目'),
        h('span', {}, '节点'),
        h('span', {}, '内容'),
        h('span', {}, '最近修改'),
        h('span', {}, '大小'),
        h('span', {}),
      ),
      ...groups.flatMap((group) =>
        group.items.length
          ? [h('div', { key: `g-${group.title}`, className: 'afp-tgroup' }, group.title), ...group.items.map(listRow)]
          : [],
      ),
      error ? h('div', { className: 'afp-foot afg-alert' }, error) : null,
      visible.length === 0 && !loading
        ? h('div', { className: 'afg-empty' }, '这个筛选条件下没有项目。')
        : null,
    ),
  );

  const drawer = focused
    ? h(
        'aside',
        { className: 'afp-drawer', 'aria-label': '项目详情', 'data-fisherai-project-drawer': focused.id },
        h(
          'div',
          { className: 'afp-drawer-head' },
          h(
            'div',
            { className: 'afg-center afg-gap8' },
            h(FolderOpenIcon, { style: { width: 14, height: 14 }, className: 'afg-dim' }),
            h('span', { className: 'afg-f12 afg-w600' }, '项目详情'),
          ),
          h(
            'div',
            { className: 'afg-center afg-gap4' },
            h(
              'button',
              {
                type: 'button',
                'aria-label': '收藏',
                className: 'afg-iconbtn',
                onClick: () => onFavorite(focused),
              },
              h(StarIcon, { fill: focused.favorite ? 'currentColor' : 'none' }),
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '关闭详情',
                className: 'afg-iconbtn',
                onClick: () => setSelected(''),
              },
              h(MoreHorizontalIcon, {}),
            ),
          ),
        ),
        h(
          'div',
          { className: 'afp-drawer-cover' },
          focused.thumbUrl
            ? h('img', { src: focused.thumbUrl, alt: '', draggable: false })
            : h('div', { className: 'afp-cover-fallback' }),
          h(
            'span',
            { className: focused.status === 'archived' ? 'afg-tag' : 'afg-tag afg-mint' },
            focused.status === 'archived' ? '已归档' : '进行中',
          ),
        ),
        h(
          'div',
          { className: 'afp-drawer-title' },
          h('h2', {}, focused.title),
          h(
            'span',
            { className: 'afp-sub' },
            `最后修改 ${relativeTime(focused.updatedAt)}${focused.models[0] ? ` · ${focused.models[0]}` : ''}`,
          ),
        ),
        h(
          'div',
          { className: 'afp-metagrid' },
          h('div', { className: 'afp-metacell' }, h('span', { className: 'afp-k' }, '节点'), h('span', { className: 'afp-v' }, String(focused.nodeCount))),
          h('div', { className: 'afp-metacell' }, h('span', { className: 'afp-k' }, '画布'), h('span', { className: 'afp-v' }, projectCanvasText(focused))),
          h(
            'div',
            { className: 'afp-metacell' },
            h('span', { className: 'afp-k' }, '图像 / 视频'),
            h('span', { className: 'afp-v' }, `${focused.imageCount} / ${focused.videoCount}`),
          ),
          h('div', { className: 'afp-metacell' }, h('span', { className: 'afp-k' }, '占用'), h('span', { className: 'afp-v' }, formatBytes(focused.mediaBytes))),
        ),
        h(
          'div',
          { className: 'afp-drawer-sect' },
          h(
            'div',
            { className: 'afg-center', style: { justifyContent: 'space-between' } },
            h('span', { className: 'afg-f11 afg-w600 afg-dim2' }, '最近生成'),
            h('span', { className: 'afg-f11 afg-dim' }, `全部 ${focused.imageCount} 张`),
          ),
          h(
            'div',
            { className: 'afp-drawer-thumbs' },
            ...focused.recent.slice(0, 3).map((url) =>
              h('div', { key: url, className: 'afp-thumb' }, h('img', { src: url, alt: '', draggable: false })),
            ),
            focused.imageCount > 3
              ? h('div', { className: 'afp-thumb afp-more' }, h('span', { className: 'afg-mono' }, `+${focused.imageCount - 3}`))
              : null,
          ),
        ),
        focused.models.length
          ? h(
              'div',
              { className: 'afp-drawer-sect' },
              h(
                'div',
                { className: 'afg-center', style: { justifyContent: 'space-between' } },
                h('span', { className: 'afg-f11 afg-w600 afg-dim2' }, '使用中的模型'),
              ),
              h(
                'div',
                { className: 'afg-center afg-gap6', style: { flexWrap: 'wrap' } },
                ...focused.models.slice(0, 5).map((model, index) =>
                  h('span', { key: model, className: index === 0 ? 'afg-tag afg-violet' : 'afg-tag' }, model),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'afp-drawer-sect' },
          h(
            'div',
            { className: 'afg-center', style: { justifyContent: 'space-between' } },
            h('span', { className: 'afg-f11 afg-w600 afg-dim2' }, '项目备注'),
            h(
              'button',
              {
                type: 'button',
                className: 'afg-iconbtn',
                style: { width: 22, height: 22 },
                'aria-label': noteDraft === null ? '编辑备注' : '保存备注',
                title: noteDraft === null ? '编辑备注' : '保存备注',
                onClick: () => {
                  if (noteDraft === null) setNoteDraft(focused.note);
                  else onNoteCommit();
                },
              },
              noteDraft === null ? h(CopyIcon, {}) : h(CheckIcon, {}),
            ),
          ),
          noteDraft === null
            ? h('div', { className: 'afp-note' }, focused.note || '还没有备注。点右上角记一笔。')
            : h('textarea', {
                className: 'afp-note-edit',
                value: noteDraft,
                'aria-label': '项目备注',
                onChange: (event: ReactTypes.ChangeEvent<HTMLTextAreaElement>) =>
                  setNoteDraft(event.target.value),
                onKeyDown: (event: ReactTypes.KeyboardEvent) => {
                  if (event.key === 'Escape') setNoteDraft(null);
                },
              }),
        ),
        h(
          'div',
          { className: 'afp-drawer-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'afg-btn afg-primary',
              style: { height: 34 },
              'data-fisherai-project-open': focused.id,
              onClick: () => openProject(focused),
            },
            h(PlayIcon, {}),
            '打开画布',
            h('span', { className: 'afg-kbd' }, '↵'),
          ),
          h(
            'div',
            { className: 'afp-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'afg-btn',
                onClick: () => {
                  setRenaming(focused.id);
                  setRenameValue(focused.title);
                },
              },
              h(CopyIcon, {}),
              '重命名',
            ),
            h(
              'button',
              { type: 'button', className: 'afg-btn', onClick: () => onExport(focused) },
              h(DownloadIcon, {}),
              '导出备份',
            ),
          ),
          h(
            'div',
            { className: 'afp-row' },
            h(
              'button',
              { type: 'button', className: 'afg-btn', onClick: () => onDuplicate(focused) },
              h(CopyIcon, {}),
              '复制项目',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'afg-btn',
                style: { color: 'var(--afg-text-3)' },
                onClick: () => onArchiveToggle(focused),
              },
              h(ArchiveIcon, {}),
              focused.status === 'archived' ? '取消归档' : '移到归档',
            ),
          ),
          h(
            'div',
            { className: 'afp-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'afg-btn',
                style: { color: 'var(--afg-danger)' },
                onClick: () => onDelete(focused),
              },
              h(Trash2Icon, {}),
              '删除项目',
            ),
          ),
          h('div', { className: 'afp-drawer-hint' }, '双击打开 · 卡片悬停出动作 · Esc 关闭'),
        ),
      )
    : null;

  const body =
    view === 'cards'
      ? h('div', { className: 'afp-body' }, side, cardsMain)
      : h('div', { className: 'afp-body' }, side, listMain, drawer);

  const toastNode = toast
    ? h(
        'div',
        {
          role: 'status',
          'data-fisherai-projects-toast': 'true',
          style: {
            position: 'absolute',
            left: '50%',
            bottom: 18,
            transform: 'translateX(-50%)',
            maxWidth: 'min(620px, calc(100% - 48px))',
            padding: '9px 14px',
            borderRadius: 10,
            border: '1px solid var(--afg-line-2)',
            background: 'rgba(23,27,34,.94)',
            color: 'var(--afg-text)',
            fontSize: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,.45)',
            zIndex: 9,
          },
        },
        toast,
      )
    : null;

  // ⚠️ 走 CanvasPageShellView（稳定组件）：外壳带了 hooks，页面「没打开时 return null」
  // 若直接调就能让 hooks 数量在两次渲染之间变化 → React #310 把整块画布打崩。
  return h(CanvasPageShellView, {
    runtime: react,
    id: 'projects',
    title: '项目库',
    count: String(projects.length),
    dismissible: canDismiss,
    rootClass: 'afp-root',
    center: search,
    right: topRight,
    children: [body, toastNode],
  });
}

CanvasProjectsPage.displayName = 'CanvasProjectsPage';
