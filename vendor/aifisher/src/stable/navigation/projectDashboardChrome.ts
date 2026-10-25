const STYLE_ID = 'fisherai-project-dashboard-chrome';
const DASHBOARD_SELECTOR = '[data-fisherai-project-dashboard="true"]';
const RESOURCE_LINKS_SELECTOR = '[data-fisherai-resource-links="true"]';
const SETTINGS_BUTTON_SELECTOR = '[data-fisherai-dashboard-settings="true"]';
// dsh-aifisher-canvas（v1.42）：项目看板头部的「导入项目」按钮（幂等 reconcile 用）
const IMPORT_PROJECT_SELECTOR = '[data-fisherai-project-import="true"]';
const PROJECT_COVER_IMAGE = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)(?:[?#]|$)/iu;

// dsh-aifisher-canvas 覆盖（v1.15，用户原话「移除这两个功能」）：
// 上游在项目看板头部注入两个**站外**入口 —— AIFISHER「API 与服务」(api.work-fisher.com)、
// Work-Fisher「教程与案例」(B 站教学主页)。本插件没有 AIFISHER 的服务/账号体系
// （账号 v1.3 已整体移除），教学主页也不是画布功能，两块一起去掉。
const resources: ReadonlyArray<{
  href: string;
  label: string;
  description: string;
  accessibleLabel: string;
  image: string;
  imageClassName: string;
}> = [];

let stopDashboardObservation: (() => void) | null = null;

function installStyleSheet() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ${DASHBOARD_SELECTOR} {
      /* dsh-aifisher-canvas 覆盖：面板内没有「视口高」这回事，100dvh 会顶出容器 */
      height: 100%;
      min-height: 0 !important;
      overflow: hidden;
    }

    ${DASHBOARD_SELECTOR} > div:first-child {
      flex: 0 0 auto;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"] {
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      scrollbar-color: var(--af-scrollbar) var(--af-surface);
      scrollbar-width: thin;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar {
      width: 10px;
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar-track {
      background: var(--af-input);
    }

    ${DASHBOARD_SELECTOR} > main[data-fisherai-project-scroll="true"]::-webkit-scrollbar-thumb {
      background: var(--af-hover);
      border: 2px solid var(--af-border);
      border-radius: 999px;
    }

    [data-fisherai-project-cover="true"] {
      position: relative;
      background: var(--af-input);
    }

    [data-fisherai-project-cover-state="unavailable"] img {
      display: none !important;
    }

    [data-fisherai-project-cover-state="unavailable"]::after {
      content: '';
      position: absolute;
      inset: 0;
      background: var(--af-input) url('/aifisher-mark-white.svg') center / 34px auto no-repeat;
      opacity: .24;
    }
    html[data-af-theme="light"] [data-fisherai-project-cover-state="unavailable"]::after {
      background-image: url('/aifisher-mark-black.svg');
    }

    ${DASHBOARD_SELECTOR} > div:first-child { height: 64px !important; padding-inline: 32px !important; gap: 20px; border-bottom: 1px solid var(--af-border); }
    ${DASHBOARD_SELECTOR} > main { max-width: 1400px !important; width: 100%; padding: 36px 40px !important; }
    ${DASHBOARD_SELECTOR} > div:first-child h1 { font-size: 16px !important; font-weight: 650; }
    ${DASHBOARD_SELECTOR} > div:first-child > div:last-child { gap: 10px !important; }
    ${DASHBOARD_SELECTOR} > div:first-child button, ${DASHBOARD_SELECTOR} > div:first-child input { min-height: 38px; font-size: 13px; }
    .fisherai-resource-links { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .fisherai-resource-link { display: inline-flex; align-items: center; height: 42px; gap: 9px; padding: 4px 10px 4px 5px; color: var(--af-text); background: var(--af-input); border: 1px solid var(--af-border); border-radius: 10px; text-decoration: none; white-space: nowrap; }
    .fisherai-resource-link:hover { color: var(--af-text); background: var(--af-surface-raised); border-color: var(--af-border-control); }
    .fisherai-resource-link:focus-visible { outline: 2px solid var(--af-focus); outline-offset: 2px; }
    .fisherai-resource-link__portrait { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; overflow: hidden; background: var(--af-input); border: 1px solid var(--af-border); border-radius: 999px; }
    .fisherai-resource-link__mark { width: 18px; height: 22px; object-fit: contain; }
    .fisherai-resource-link__avatar { width: 100%; height: 100%; object-fit: cover; object-position: 50% 36%; }
    .fisherai-resource-link__copy { display: flex; flex-direction: column; gap: 3px; line-height: 1; }
    .fisherai-resource-link__label { font-size: 13px; font-weight: 650; }
    .fisherai-resource-link__description { color: var(--af-text-secondary); font-size: 12px; }
    .fisherai-dashboard-settings { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 8px 12px; border: 1px solid var(--af-border); border-radius: 8px; background: var(--af-surface-raised); color: var(--af-text); font-size: 13px; cursor: pointer; }
    .fisherai-dashboard-settings svg { width: 16px; height: 16px; }
    .fisherai-dashboard-settings:hover { background: var(--af-surface-raised); }
    @media (min-width: 1051px) and (max-width: 1500px), (max-width: 600px) {
      .fisherai-resource-link { width: 42px; padding: 4px; justify-content: center; }
      .fisherai-resource-link__copy { display: none; }
    }
    @media (max-width: 1050px) {
      ${DASHBOARD_SELECTOR} > div:first-child { flex-wrap: wrap; height: auto !important; min-height: 64px; padding: 14px 20px !important; gap: 12px; }
      ${DASHBOARD_SELECTOR} > div:first-child > div:last-child { width: 100%; flex-wrap: wrap; justify-content: flex-start; }
      ${DASHBOARD_SELECTOR} > main { padding: 24px !important; }
    }

    @media (prefers-reduced-motion: reduce) {
      .fisherai-resource-link,
      .fisherai-dashboard-settings {
        transition: none;
      }
    }
  `;
  document.head.append(style);
}

function createSettingsButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fisherai-dashboard-settings';
  button.dataset.fisheraiDashboardSettings = 'true';
  button.setAttribute('aria-label', '设置');
  button.title = '设置';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);

  const label = document.createElement('span');
  label.className = 'fisherai-dashboard-settings__label';
  label.textContent = '设置';
  button.append(svg, label);
  button.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('fisherai:open-settings'));
  });
  return button;
}

/**
 * dsh-aifisher-canvas（v1.42）：项目看板头部的「导入项目」按钮。
 *
 * 用户 2026-10-18 原话：「在无限画布面板做一个项目导出导入的功能」。导入逻辑在
 * src/canvas-ui（CanvasProjectArchive.ts：选文件 → host restore → 打开新项目 → 弹回执），
 * 这里属于 vendor 半 —— 两个模块实例，所以只通过装配层注册的 window 桥
 * `__FISHERAI_PROJECT_ARCHIVE__.importFromPicker()` 触发；桥还没装好时退回派发
 * `fisherai:project-import` 事件（装配层同样监听它）。
 *
 * 不自己造 file input：导入完的「打开新项目 + 回执提示」都在画布那一侧，
 * 两边各做一半会变成「导入了但看起来什么都没发生」。
 */
function createImportProjectButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fisherai-dashboard-settings';
  button.dataset.fisheraiProjectImport = 'true';
  button.setAttribute('aria-label', '导入项目');
  button.title = '导入项目备份（.fisherai 含素材 / 旧版 .json 文档）';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 4v10M8 8l4-4 4 4M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  const label = document.createElement('span');
  label.className = 'fisherai-dashboard-settings__label';
  label.textContent = '导入项目';
  button.append(svg, label);
  button.addEventListener('click', () => {
    const bridge = (
      window as unknown as {
        __FISHERAI_PROJECT_ARCHIVE__?: {
          importFromPicker?: (options?: { open?: boolean }) => void;
        };
      }
    ).__FISHERAI_PROJECT_ARCHIVE__;
    if (bridge && typeof bridge.importFromPicker === 'function') {
      bridge.importFromPicker();
      return;
    }
    window.dispatchEvent(new CustomEvent('fisherai:project-import'));
  });
  return button;
}

function createResourceLinks() {
  const nav = document.createElement('nav');
  nav.className = 'fisherai-resource-links';
  nav.dataset.fisheraiResourceLinks = 'true';
  nav.setAttribute('aria-label', '渡雨鸣泽 资源入口');

  for (const resource of resources) {
    const link = document.createElement('a');
    link.className = 'fisherai-resource-link';
    link.href = resource.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = `${resource.label} · ${resource.description}`;
    link.setAttribute('aria-label', resource.accessibleLabel);

    const portrait = document.createElement('span');
    portrait.className = 'fisherai-resource-link__portrait';
    portrait.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.className = resource.imageClassName;
    image.src = resource.image;
    image.alt = '';
    portrait.append(image);

    const copy = document.createElement('span');
    copy.className = 'fisherai-resource-link__copy';
    const label = document.createElement('span');
    label.className = 'fisherai-resource-link__label';
    label.textContent = resource.label;
    const description = document.createElement('span');
    description.className = 'fisherai-resource-link__description';
    description.textContent = resource.description;
    copy.append(label, description);
    link.append(portrait, copy);
    nav.append(link);
  }

  return nav;
}

export function projectCoverPreviewUrl(source: string): string | null {
  const value = String(source || '').trim();
  if (!value || value.startsWith('/api/aifisher/canvas/media/thumbnail?')) return value || null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/aifisher/canvas/media/')) {
      return null;
    }
    const localUrl = `${parsed.pathname}${parsed.search}`;
    if (!PROJECT_COVER_IMAGE.test(localUrl)) return null;
    return `/api/aifisher/canvas/media/thumbnail?url=${encodeURIComponent(localUrl)}&max=960`;
  } catch {
    return null;
  }
}

function enhanceProjectCovers(projectMain: HTMLElement) {
  projectMain.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const container = image.parentElement;
    if (!container || image.dataset.fisheraiProjectCover === 'true') return;
    image.dataset.fisheraiProjectCover = 'true';
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    container.dataset.fisheraiProjectCover = 'true';
    const preview = projectCoverPreviewUrl(image.getAttribute('src') || '');
    if (!preview) {
      container.dataset.fisheraiProjectCoverState = 'unavailable';
      return;
    }
    image.src = preview;
    image.addEventListener(
      'error',
      () => {
        container.dataset.fisheraiProjectCoverState = 'unavailable';
      },
      { once: true },
    );
  });
}

function reconcileProjectDashboard() {
  const candidates = document.querySelectorAll<HTMLElement>('div.min-h-screen');
  const dashboard = Array.from(candidates).find((candidate) => {
    const directChildren = Array.from(candidate.children);
    const header = directChildren.find((child) => child.matches('div.h-20'));
    const main = directChildren.find((child) => child.tagName === 'MAIN');
    return Boolean(
      header &&
      main &&
      header.querySelector('img[src*="aifisher-mark"], img[src*="aifisher-logo"]'),
    );
  });
  const header = dashboard
    ? Array.from(dashboard.children).find(
        (child): child is HTMLElement => child instanceof HTMLElement && child.matches('div.h-20'),
      )
    : null;
  if (!header || !dashboard) return;

  dashboard.dataset.fisheraiProjectDashboard = 'true';
  const projectMain = Array.from(dashboard.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.tagName === 'MAIN',
  );
  if (projectMain) {
    projectMain.dataset.fisheraiProjectScroll = 'true';
    enhanceProjectCovers(projectMain);
  }

  const toolbar = header.lastElementChild;
  if (!(toolbar instanceof HTMLElement)) return;
  // dsh-aifisher-canvas 覆盖（v1.15）：站外资源入口不再注入 —— 见文件顶部 resources 的说明。
  // 这里是唯一的注入点，删掉它空 nav 也不会出现在看板头部。
  if (!toolbar.querySelector(SETTINGS_BUTTON_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createSettingsButton(), newProject ?? null);
  }
  // dsh-aifisher-canvas（v1.42）：「导入项目」按钮（在「新建项目」左边、设置按钮右边）。
  // 观察者每次 reconcile 都会跑，所以这里必须按 data 属性幂等判断。
  if (!toolbar.querySelector(IMPORT_PROJECT_SELECTOR)) {
    const newProject = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === '新建项目',
    );
    toolbar.insertBefore(createImportProjectButton(), newProject ?? null);
  }
}

export function installProjectDashboardChrome() {
  installStyleSheet();
  reconcileProjectDashboard();
  if (stopDashboardObservation) return;
  stopDashboardObservation = observeStableEnhancement(reconcileProjectDashboard);
}

export function uninstallProjectDashboardChromeForTests() {
  stopDashboardObservation?.();
  stopDashboardObservation = null;
  document.getElementById(STYLE_ID)?.remove();
  document.querySelectorAll(RESOURCE_LINKS_SELECTOR).forEach((element) => element.remove());
  document.querySelectorAll(SETTINGS_BUTTON_SELECTOR).forEach((element) => element.remove());
  document.querySelectorAll(IMPORT_PROJECT_SELECTOR).forEach((element) => element.remove());
  document.querySelectorAll(DASHBOARD_SELECTOR).forEach((element) => {
    delete (element as HTMLElement).dataset.fisheraiProjectDashboard;
  });
}
import { observeStableEnhancement } from '../lifecycle/enhancementLifecycle';
