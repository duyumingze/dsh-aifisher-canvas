/**
 * 「检查更新」（v1.98）—— host 侧的数据面。
 *
 * 用户 2026-11-13 原话，两句决定了它长什么样：
 *   ① **「获取更新功能做一些」** —— 设置页「高级与关于」原来挂的是 vendor 的更新面板，
 *      它只认 AIFISHER **桌面端**的桥（`desktopBridge().update`），DSH 里永远是空白；
 *   ② **「做简单一点，检查更新，如果有新版本然后用户确认更新的话就新开对话把更新对话
 *      输入进去等用户点发送」** —— 所以这里**不**下载、不替换文件、不重启，只做两件事：
 *      查有没有新版；把「更新步骤」写成一段能直接交给画布助手的话（`prompt`）。
 *
 *   GET /api/aifisher/canvas/update/status         查一次（10 分钟内存缓存）
 *   GET /api/aifisher/canvas/update/status?force=1  强制重查
 *
 * 返回（HTTP 一律 200，成败看 `ok`：前端只需要一种分支）：
 *   { ok, current, latest, behind, upToDate, releaseUrl, publishedAt, prompt,
 *     repo, checkedAt, cached, error?, hint? }
 *
 * 数据来源：GitHub REST（无 token 限 60 次/时，够用；有 Release 用 Release，
 * 没有就退回 tags 比版本号）。
 *   - `DSH_AIFISHER_UPDATE_API`   覆盖 API 根（国内网络打不开 api.github.com 时指向镜像）
 *   - `DSH_AIFISHER_UPDATE_REPO`  覆盖仓库 slug（默认从 package.json 的 repository 解析）
 *   - `DSH_AIFISHER_UPDATE_TOKEN` 私有仓库才需要（不会下发到前端）
 *
 * 费用/副作用：只有一次公开 API 的 GET，不花钱、不写盘、不动安装目录。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http/httpUtil';
import { readPackageInfo, type PackageInfo } from '../packageInfo';

/** 缓存时长：设置页每打开一次都会查一遍，10 分钟足够新，也不会把 60 次/时用光。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 单次请求上限：GitHub 被墙时 TCP 会一直等，6 秒后必须放人。 */
const FETCH_TIMEOUT_MS = 6000;

const DEFAULT_API = 'https://api.github.com';

export interface UpdateStatus {
  ok: boolean;
  current: string;
  latest: string | null;
  behind: boolean;
  upToDate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  /**
   * 交给画布助手的更新指令（有新版本时非空）。
   * 界面点「更新」= 新开一条对话、把它填进输入框，由用户按发送 —— 这里只负责写好这段话。
   */
  prompt: string;
  repo: string;
  checkedAt: number;
  cached: boolean;
  error?: string;
  hint?: string;
}

interface CachedCheck {
  at: number;
  result: UpdateStatus;
}

let cache: CachedCheck | null = null;

/** `v1.97.3` / `1.97.3-beta.2` → [1,97,3]；解析不出来返回 null（不参与比较）。 */
export function parseVersion(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** a>b → 1，a<b → -1，相等（或无法比较）→ 0。 */
export function compareVersions(a: unknown, b: unknown): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function apiBase(): string {
  const raw = process.env.DSH_AIFISHER_UPDATE_API?.trim();
  if (!raw) return DEFAULT_API;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_API;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_API;
  }
}

function repoSlug(info: PackageInfo): string {
  const override = process.env.DSH_AIFISHER_UPDATE_REPO?.trim();
  return override || info.repo;
}

function releasePageUrl(repo: string): string {
  return repo ? `https://github.com/${repo}/releases` : 'https://github.com';
}

/**
 * 更新指令：写得像「用户对助手说的话」，因为**它就是要被用户按发送的那句话**。
 * 安装形态（git 目录 / 复制安装）两种做法都写在第一步里，助手自己看目录再选。
 */
function upgradePrompt(input: {
  info: PackageInfo;
  repo: string;
  current: string;
  latest: string;
}): string {
  const { info, repo, current, latest } = input;
  const repoUrl = repo ? `https://github.com/${repo}` : '（仓库地址见 package.json）';
  return [
    `帮我把 dsh-aifisher-canvas 从 v${current} 更新到 v${latest}。`,
    '',
    `1. 先看 ${info.root} 是不是 git 目录：是就在那里 \`git pull --ff-only\`；不是就按 DSH 的插件更新流程处理 —— 「设置 → 插件 → 添加插件」，粘 ${repoUrl} 重装。`,
    '2. 跑 `node scripts/typecheck.mjs`，然后 `pnpm build`（缺依赖先 `pnpm install`）。',
    `3. 如果正在跑的安装目录不是 ${info.root}，把 lib/ 和这次改到的源码同步过去，再跑 \`node scripts/verify-live-canvas-bundle.mjs\` 确认服务端下发的产物与磁盘一致（lib/index.js 变了要重启 DSH）。`,
    '4. 完成后告诉我改了哪些文件、要不要重启。',
  ].join('\n');
}

/** GitHub GET；非 2xx 返回 null（404 = 没发布，不当成网络故障）。 */
async function getJson(url: string): Promise<unknown | null> {
  const token = process.env.DSH_AIFISHER_UPDATE_TOKEN?.trim();
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': `dsh-aifisher-canvas/${readPackageInfo().version}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    // 403 一般是限流（带上剩余额度，方便用户判断为什么忽然查不到）
    if (response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      throw new Error(
        `GitHub 拒绝了这次查询（403，可能是未登录限流：剩余 ${remaining ?? '未知'} 次/时）`,
      );
    }
    return null;
  }
  return (await response.json()) as unknown;
}

interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string | null;
}

async function fetchLatest(api: string, repo: string): Promise<LatestRelease | null> {
  // ① Releases（带发布时间与发布页）：优先取稳定版，全是预发布就取最新的那条
  const releases = await getJson(`${api}/repos/${repo}/releases?per_page=10`);
  if (Array.isArray(releases)) {
    const usable = releases.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { tag_name?: unknown }).tag_name === 'string',
    );
    const stable = usable.filter((item) => item.draft !== true);
    const pick = stable.find((item) => item.prerelease !== true) ?? stable[0];
    if (pick) {
      const tag = String(pick.tag_name);
      return {
        version: tag.replace(/^v/i, ''),
        url:
          typeof pick.html_url === 'string' && pick.html_url
            ? pick.html_url
            : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
        publishedAt:
          typeof pick.published_at === 'string'
            ? pick.published_at
            : typeof pick.created_at === 'string'
              ? pick.created_at
              : null,
      };
    }
  }

  // ② 没发 Release 就退回 tags（只有版本号）
  const tags = await getJson(`${api}/repos/${repo}/tags?per_page=100`);
  if (Array.isArray(tags)) {
    const names = tags
      .map((item) =>
        item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined,
      )
      .filter((name): name is string => typeof name === 'string' && Boolean(parseVersion(name)));
    if (names.length) {
      names.sort((left, right) => compareVersions(right, left));
      return {
        version: names[0].replace(/^v/i, ''),
        url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(names[0])}`,
        publishedAt: null,
      };
    }
  }
  return null;
}

async function check(force: boolean): Promise<UpdateStatus> {
  const info = readPackageInfo();
  const repo = repoSlug(info);
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.result, cached: true };
  }

  const base: UpdateStatus = {
    ok: false,
    current: info.version,
    latest: null,
    behind: false,
    upToDate: false,
    releaseUrl: null,
    publishedAt: null,
    prompt: '',
    repo,
    checkedAt: now,
    cached: false,
  };

  if (!repo) {
    return {
      ...base,
      error: 'package.json 里读不到 GitHub 仓库地址，无法检查更新。',
      hint: '可以设 DSH_AIFISHER_UPDATE_REPO=owner/repo 指定仓库。',
    };
  }

  const api = apiBase();
  try {
    const found = await fetchLatest(api, repo);
    if (!found) {
      return {
        ...base,
        error: '仓库还没有发布 Release / Tag，或这个 API 看不到它。',
        hint: `可以直接打开 ${releasePageUrl(repo)} 看有没有新版。`,
      };
    }
    const behind = compareVersions(found.version, info.version) > 0;
    const result: UpdateStatus = {
      ...base,
      ok: true,
      latest: found.version,
      behind,
      upToDate: !behind,
      releaseUrl: found.url,
      publishedAt: found.publishedAt,
      prompt: behind
        ? upgradePrompt({ info, repo, current: info.version, latest: found.version })
        : '',
    };
    cache = { at: now, result };
    return result;
  } catch (error) {
    return {
      ...base,
      error:
        error instanceof Error && error.name === 'TimeoutError'
          ? `查询 GitHub 超时（${FETCH_TIMEOUT_MS / 1000} 秒）`
          : error instanceof Error
            ? error.message
            : String(error),
      hint: `网络不通时可以设 DSH_AIFISHER_UPDATE_API 指向 GitHub API 镜像，或直接打开 ${releasePageUrl(repo)}。`,
    };
  }
}

/** `/status` 里报一行「检查更新」的状态，排查「点了没反应」时先看这里。 */
export function updateDiagnostics(): Record<string, unknown> {
  const info = readPackageInfo();
  return {
    current: info.version,
    repo: repoSlug(info),
    api: apiBase(),
    localGit: info.localGit,
    lastCheckedAt: cache?.at ?? null,
  };
}

/**
 * 处理 `/api/aifisher/canvas/update/*`。已处理返回 true（调用方直接 return），
 * 不认识的子路径返回 false → 落到 restRouter 的 NOT_PORTED。
 */
export async function handleUpdateApi(input: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  parts: string[];
}): Promise<boolean> {
  const { req, res, url, parts } = input;
  if (parts[0] !== 'update') return false;
  if (parts[1] !== 'status' || parts.length !== 2) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
  sendJson(res, 200, await check(force));
  return true;
}
