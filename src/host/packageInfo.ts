/**
 * 包的元信息（安装目录 / 版本号 / GitHub 仓库）—— host 半唯一的读取口。
 *
 * 为什么单独一个文件（v1.98）：
 *   - `staticAssets.ts` 早就在解析包根目录（源码布局与产物布局深度不同，不能写死相对路径）；
 *   - 「检查更新」还要读 version 与 package.json 里的 repository 地址。
 * 两处各写一份「上溯找 package.json」迟早会漂（v1.97.3 的版本号事故就是手抄一份造成的），
 * 所以把解析收在这里，staticAssets 与 updateRouter 都从这里拿。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 解析包根目录。
 *
 * 不能写死相对深度：源码在 src/host/staticAssets.ts（上溯两级到包根），
 * 但产物是 lib/index.js（只上溯一级），同一份代码两种布局。
 * 所以先用包自引用解析 package.json（package.json 已导出 ./package.json），
 * 失败再逐级上溯找 public/creative-presets。
 */
export function resolvePackageRoot(): string {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve('dsh-aifisher-canvas/package.json'));
  } catch {
    // 落到下面的目录探测
  }
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(dir, 'public', 'creative-presets'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fileURLToPath(new URL('..', import.meta.url));
}

export interface PackageInfo {
  /** 安装目录的绝对路径。 */
  root: string;
  name: string;
  version: string;
  /** `owner/repo`；package.json 里没有可解析的 GitHub 地址就是空串。 */
  repo: string;
  /** package.json 的 homepage（发布/仓库页链接的兜底）。 */
  homepage: string;
  /** 安装目录里有没有 `.git` —— 决定「怎么更新」给的是 git 还是重装。 */
  localGit: boolean;
}

/**
 * 从各种写法的仓库地址里取 `owner/repo`：
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   owner/repo
 */
export function parseGitHubRepo(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return text;
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(text);
  if (!match) return '';
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`;
}

let cached: PackageInfo | null = null;

/** 读一次缓存住：package.json 在进程生命周期里不会变（升级要重启/刷新）。 */
export function readPackageInfo(): PackageInfo {
  if (cached) return cached;
  const root = resolvePackageRoot();
  const fallback: PackageInfo = {
    root,
    name: 'dsh-aifisher-canvas',
    version: '0.0.0',
    repo: '',
    homepage: '',
    localGit: existsSync(resolve(root, '.git')),
  };
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
      homepage?: unknown;
      repository?: unknown;
    };
    const repository =
      typeof pkg.repository === 'string'
        ? pkg.repository
        : (pkg.repository as { url?: unknown } | undefined)?.url;
    cached = {
      ...fallback,
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : fallback.name,
      version: typeof pkg.version === 'string' && pkg.version ? pkg.version : fallback.version,
      repo: parseGitHubRepo(repository),
      homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
    };
  } catch {
    cached = fallback;
  }
  return cached;
}
