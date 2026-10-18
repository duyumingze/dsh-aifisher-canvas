/**
 * DSH 技能目录（host 半）——画布侧「能看到哪些技能、能不能读到正文」的唯一实现。
 *
 * 两个消费方共用它：
 *   - HTTP：`GET /api/aifisher/skills`（列表）/ `GET /api/aifisher/skills/:name`（正文）
 *   - Agent 工具：`canvas_control` 的 `skills` / `skillLoad` 两个动作
 *
 * ## 为什么要自己扫目录，而不是只问 `ctx.skills`
 *
 * 2026-10-18 真机取证：画布侧技能目录**只回 4 条 bundled 技能**
 * （diagnose-windows-sandbox-acl / office-docx / office-pptx / office-xlsx），
 * `$DSH_HOME/skills` 下用户自己的 10 条（image-prompt-generator、blender-…）
 * 一条都看不到、`skillLoad` 直接 404。
 *
 * 根因（与 dsh-skill-picker 的判断一致，见其 host 半注释）：
 * **文件系统技能 provider 挂在 agent 作用域**（标准预设的常驻挂载），
 * 插件 host 上下文里的 `ctx.skills.list()` 只能看到 global 层 —— 也就是 bundled 那几个；
 * 用户层（`~/.dsh/skills`）与项目层（`<cwd>/.dsh/skills`）都在 agent 作用域里，
 * host 侧问不到。
 *
 * 所以这里**按官方 provider 的同一套根自己扫**（优先级低→高，高者覆盖同名）：
 *
 *   用户 `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`）  rank 500
 *   用户 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）             rank 400
 *   项目 `<cwd>/.agents/skills`                                rank 200
 *   项目 `<cwd>/.dsh/skills`                                   rank 100
 *
 * 扫出来的条目直接带**完整正文**（`skillLoad` 就是读这个文件），
 * bundled 那几个继续走 `ctx.skills` —— 两层按名字合并，同名以扫到的为准。
 *
 * 与 dsh-skill-picker 的三条对齐（照抄它的口径，不要各写一套）：
 *   ① `SKILL.md` 首部 `---` frontmatter 的扁平子集（name/description/when-to-use…）；
 *   ② 旧式 invocation 键（`disableModelInvocation`/`modelInvocable`/`userInvocable`）
 *      会被官方 provider 整条拒绝 → 这里也不列；
 *   ③ `user-invocable: false` 不列（人类面上看不见），`SKILL.disabled.md` 视为关闭 → 不列
 *      （关闭的技能加载不了，列出来只会变成一个静默无效的 `/名字` 手势）。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import type { WebServerLike } from '../http/httpUtil';
import { rejectCrossOrigin, sendJson } from '../http/httpUtil';

/** 调用方视角的 ctx.skills（只列我们用到的方法，字段对齐 SkillRegistry）。 */
export interface DshSkillsService {
  list(options?: {
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<DshSkillSummary[]>;
  get(
    name: string,
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<DshSkillDefinition | undefined>;
}

interface DshSkillInvocation {
  modelInvocable?: boolean;
  userInvocable?: boolean;
}

interface DshSkillSummary {
  name: string;
  description: string;
  whenToUse?: string;
  invocation?: DshSkillInvocation;
  source?: string;
  provider?: string;
  path?: string;
  resourceBase?: unknown;
}

interface DshSkillDefinition extends DshSkillSummary {
  content: string;
  metadata?: Record<string, unknown>;
}

/** 技能目录里的一条（host 侧统一形状；`content` 只在 get 时有）。 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  whenToUse: string;
  /** 'project' | 'user' | 'bundled' */
  source: string;
  provider: string;
  modelInvocable: boolean;
  userInvocable: boolean;
  path: string | null;
  /** 技能所在根（'dsh' | 'agents' | undefined=非文件系统）。 */
  root?: string;
  content?: string;
}

export interface SkillsCatalog {
  list(cwd?: string): Promise<SkillCatalogEntry[]>;
  get(name: string, cwd?: string): Promise<SkillCatalogEntry | undefined>;
  /** 排障读数（真机上「列表怎么是空的」时分得清没扫到 / 扫到没通过过滤）。 */
  report(): Record<string, unknown>;
}

export interface SkillsCatalogOptions {
  /** ctx.skills（bundled/global 层）。没装 dsh-skill 时为 undefined。 */
  skills?: DshSkillsService;
  /** 项目层要扫的目录（画布会话的工作目录）。缺省 = 只扫用户层。 */
  cwd?: () => string | undefined;
  /** 环境变量来源（回归注入假 DSH_HOME / DSH_AGENTS_HOME 用）。 */
  env?: NodeJS.ProcessEnv;
}

/** 旧式 invocation 键：官方 provider 见到就整条拒绝，所以这里也不列。 */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];

const ENTRY_FILE = 'SKILL.md';
const DISABLED_FILE = 'SKILL.disabled.md';

/** 一个技能名合法时的形状（与路由正则一致）。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

/** SKILL.md 的 frontmatter 块（没有就 undefined）。 */
function frontmatterBlock(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match === null ? undefined : match[1];
}

/** frontmatter 的扁平 YAML 子集（与 dsh-skill-picker 的实现保持一致）。 */
function parseFrontmatter(content: string): Record<string, string> {
  const block = frontmatterBlock(content);
  if (block === undefined) return {};
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (value !== '') out[kv[1]] = value;
  }
  return out;
}

/** frontmatter 里有没有这个键（`parseFrontmatter` 会丢掉空值，所以要单独判在不在）。 */
function hasFrontmatterKey(content: string, key: string): boolean {
  const block = frontmatterBlock(content);
  if (block === undefined) return false;
  return block.split(/\r?\n/).some((line) => {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    return kv !== null && kv[1] === key;
  });
}

/** YAML 布尔（含 yes/no/on/off/1/0）；键不存在 → undefined。 */
function frontmatterBoolean(meta: Record<string, string>, key: string): boolean | undefined {
  const value = meta[key];
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return undefined;
  }
}

/** 一条技能能不能出现在目录里（旧键 / user-invocable:false 都不列）。 */
function isListable(meta: Record<string, string>, content: string): boolean {
  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (hasFrontmatterKey(content, legacy)) return false;
  }
  return frontmatterBoolean(meta, 'user-invocable') !== false;
}

interface ScanRoot {
  dir: string;
  source: 'project' | 'user';
  root: 'dsh' | 'agents';
}

/** 官方 provider 的那四个根（低优先级在前，后来的同名覆盖前面的）。 */
function scanRoots(cwd: string | undefined, env: NodeJS.ProcessEnv): ScanRoot[] {
  const home = env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
  const agentsHome = env.DSH_AGENTS_HOME?.trim() || path.join(homedir(), '.agents');
  const roots: ScanRoot[] = [
    { dir: path.join(agentsHome, 'skills'), source: 'user', root: 'agents' },
    { dir: path.join(home, 'skills'), source: 'user', root: 'dsh' },
  ];
  if (typeof cwd === 'string' && cwd.trim() !== '' && path.isAbsolute(cwd)) {
    roots.push({ dir: path.join(cwd, '.agents', 'skills'), source: 'project', root: 'agents' });
    roots.push({ dir: path.join(cwd, '.dsh', 'skills'), source: 'project', root: 'dsh' });
  }
  return roots;
}

/** 扫一个根目录进 map（目录不存在 = 空操作；软链跟随）。 */
async function scanRootInto(map: Map<string, SkillCatalogEntry>, root: ScanRoot): Promise<number> {
  let entries;
  try {
    entries = await readdir(root.dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const skillDir = path.join(root.dir, entry.name);
    // Dirent 对软链给的是 isSymbolicLink()，所以这里用 stat 再确认一次（跟随软链，
    // 与官方 provider 的 isDirectoryEntry 同口径：技能可以住在 junction 后面）。
    let real;
    try {
      real = await stat(skillDir);
    } catch {
      continue;
    }
    if (!real.isDirectory()) continue;
    let content: string;
    try {
      content = await readFile(path.join(skillDir, ENTRY_FILE), 'utf8');
    } catch {
      // SKILL.disabled.md = 关闭的技能：加载不了，枚举面不列（列了只会变成一个静默无效的手势）。
      continue;
    }
    const meta = parseFrontmatter(content);
    const name = meta.name ?? entry.name;
    if (!NAME_RE.test(name)) continue;
    if (!isListable(meta, content)) continue;
    map.set(name, {
      name,
      description: meta.description ?? '',
      whenToUse: meta['when-to-use'] ?? meta.whenToUse ?? '',
      source: root.source,
      provider: 'dsh-skill-filesystem',
      modelInvocable: true,
      userInvocable: true,
      path: skillDir,
      root: root.root,
      content,
    });
    count += 1;
  }
  return count;
}

/** 把 ctx.skills 的一条拍平成目录形状（invocation 两级形状都兼容）。 */
function fromService(s: DshSkillSummary, content?: string): SkillCatalogEntry {
  return {
    name: s.name,
    description: s.description ?? '',
    whenToUse: s.whenToUse ?? '',
    source: s.source ?? 'bundled',
    provider: s.provider ?? 'dsh-skill',
    modelInvocable: s.invocation?.modelInvocable ?? true,
    userInvocable: s.invocation?.userInvocable ?? true,
    path: s.path ?? null,
    ...(content === undefined ? {} : { content }),
  };
}

/**
 * 建一份技能目录。
 *
 * `list`：文件系统扫出来的（项目 > 用户）+ `ctx.skills` 里剩下的（bundled），按名合并。
 * `get`：先在扫出来的里面找（正文就是磁盘上的 SKILL.md），找不到才问 `ctx.skills`。
 */
export function createSkillsCatalog(options: SkillsCatalogOptions): SkillsCatalog {
  const env = options.env ?? process.env;
  const service = options.skills;
  const defaultCwd = options.cwd;
  let scans = 0;
  let scannedEntries = 0;
  let serviceEntries = 0;

  const resolveCwd = (override?: string): string | undefined => {
    if (typeof override === 'string' && path.isAbsolute(override)) return override;
    try {
      return defaultCwd?.();
    } catch {
      return undefined;
    }
  };

  async function scan(cwd: string | undefined): Promise<Map<string, SkillCatalogEntry>> {
    const map = new Map<string, SkillCatalogEntry>();
    for (const root of scanRoots(cwd, env)) {
      scannedEntries += await scanRootInto(map, root);
    }
    scans += 1;
    return map;
  }

  return {
    async list(cwdOverride) {
      const cwd = resolveCwd(cwdOverride);
      const map = await scan(cwd);
      // bundled/global 层挂在扫描结果后面：同名时以扫到的（用户自己的）为准。
      if (service && typeof service.list === 'function') {
        try {
          const list = await service.list({ cwd });
          for (const item of list) {
            serviceEntries += 1;
            if (!item?.name || map.has(item.name)) continue;
            map.set(item.name, fromService(item));
          }
        } catch {
          /* bundled 层挂掉不影响用户层：画布侧技能目录照样能用 */
        }
      }
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async get(name, cwdOverride) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return undefined;
      const cwd = resolveCwd(cwdOverride);
      const map = await scan(cwd);
      const scanned = map.get(name);
      if (scanned) return scanned;
      if (service && typeof service.get === 'function') {
        try {
          const def = await service.get(name, { cwd });
          if (def) return fromService(def, def.content);
        } catch {
          /* 与 list 一致：bundled 层出错当没找到 */
        }
      }
      return undefined;
    },

    report() {
      const cwd = resolveCwd();
      return {
        scans,
        scannedEntries,
        serviceEntries,
        roots: scanRoots(cwd, env).map((root) => `${root.source}:${root.root}:${root.dir}`),
        cwd: cwd ?? null,
      };
    },
  };
}

/** 给前端的精简摘要（与 v1.x 的画布 UI 契约一致，多的字段不影响旧消费方）。 */
function publicSummary(entry: SkillCatalogEntry) {
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse ?? '',
    source: entry.source,
    provider: entry.provider,
    modelInvocable: entry.modelInvocable,
    userInvocable: entry.userInvocable,
    path: entry.path ?? null,
  };
}

async function handleSkills(
  req: IncomingMessage,
  res: ServerResponse,
  catalog: SkillsCatalog,
): Promise<void> {
  // 同源围栏（裸挂 webServer、无 DSH cookie 鉴权的路由都要自己挡跨站写操作）
  if (rejectCrossOrigin(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://x');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  // 项目层技能要扫哪里：画布 UI/工具可以带 ?cwd=<绝对路径>（会话的工作目录）。
  // 不传就只有用户层（与「不知道会话工作目录就别乱猜」一个意思）。
  const cwdParam = url.searchParams.get('cwd') ?? undefined;

  // GET /api/aifisher/skills
  if (pathname === '/api/aifisher/skills' && method === 'GET') {
    try {
      const list = await catalog.list(cwdParam);
      sendJson(res, 200, { skills: list.map(publicSummary) });
    } catch (e) {
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : '技能列表读取失败',
        code: 'SKILLS_LIST_FAILED',
      });
    }
    return;
  }

  // GET /api/aifisher/skills/:name
  const match = /^\/api\/aifisher\/skills\/([a-z0-9][a-z0-9-]{0,62})$/i.exec(pathname);
  if (match && method === 'GET') {
    const name = match[1].toLowerCase();
    try {
      const entry = await catalog.get(name, cwdParam);
      if (!entry) {
        sendJson(res, 404, { error: 'skill not found', name });
        return;
      }
      sendJson(res, 200, {
        skill: {
          ...publicSummary(entry),
          content: entry.content ?? '',
          resourceBase: null,
        },
      });
    } catch (e) {
      sendJson(res, 502, {
        error: e instanceof Error ? e.message : '技能正文读取失败',
        code: 'SKILL_GET_FAILED',
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'unknown skills route', path: pathname });
}

/** 把技能目录路由挂到 webServer（`/api/aifisher/skills`）。返回 disposer。 */
export function attachSkillsRoutes(
  webServer: WebServerLike,
  catalog: SkillsCatalog,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: '/api/aifisher/skills',
    handler: (req, res) => handleSkills(req, res, catalog),
  });
}