/**
 * 画布数据目录（v1.43）—— 「设置 → 存储 → 项目数据目录」可自定义。
 *
 * 用户 2026-10-18 原话：「设置里添加项目自定义缓存目录」。
 *
 * 在此之前，插件的全部数据都固定落在 `$DSH_HOME/storages/dsh-aifisher-canvas/`
 * （canvas.json / media/ / library.json / workflows/ / downloads/ / 通道表 / 密钥…）。
 * 想把它放到别的盘（C 盘紧张、数据盘更快、多实例分开）只能整目录搬 + 改环境变量，界面上没有入口。
 *
 * 做法（**指针文件 + 重启生效**，不搞运行时热切换）：
 *
 *   1. 指针文件固定在**默认目录**里：`<默认数据目录>/data-dir.json` = `{directory, savedAt}`。
 *      放在默认目录里的理由：它必须「搬走数据之后还找得到」，而默认目录永远由 $DSH_HOME 算得出来；
 *      反过来把指针放进目标目录就自指了（换个目录就读不到自己）。
 *   2. `resolveDataDir()` = 指针指向的目录（且必须在磁盘上存在）→ 否则默认目录。
 *   3. 改目录当下的进程**不会**立刻换（canvas.json 已经读进内存、素材库根目录也已经定下），
 *      所以接口一律回 `restartRequired: true`，界面上也只会写「重启 DSH 生效」——
 *      绝不假装已经切了（这是 v1.31「假成功」那类坑）。
 *   4. 可选「把现有数据复制到新目录」（默认勾上）：纯复制、不删旧目录，出问题随时切回来。
 *
 * 为什么不做「运行时热切换」：所有 store 都在 apply() 里按目录构造（canvas.json 读进内存、
 * mediaStore 定了 rootDir、工作流目录缓存、通道表…），热切换要么逐个重建、要么到处漏；
 * 而换目录本来就是低频操作，重启一次代价可接受，且语义清楚。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 指针文件名（放在默认数据目录里）。 */
export const DATA_DIR_POINTER_FILE = 'data-dir.json';

export interface DataDirPointer {
  directory: string;
  savedAt: string;
}

export function dshHome(): string {
  return (
    process.env.DSH_HOME?.trim() || process.env.DSH_HOME_DIR?.trim() || join(homedir(), '.dsh')
  );
}

/** 默认数据目录：`$DSH_HOME/storages/dsh-aifisher-canvas`（插件一直以来用的那一个）。 */
export function defaultDataDir(): string {
  return join(dshHome(), 'storages', 'dsh-aifisher-canvas');
}

/** 指针文件路径（永远在默认目录里，见文件头第 1 条）。 */
export function dataDirPointerPath(): string {
  return join(defaultDataDir(), DATA_DIR_POINTER_FILE);
}

/** 读指针；没有/坏了/指向不存在的目录都当「没设过」。 */
export function readDataDirPointer(): DataDirPointer | null {
  const file = dataDirPointerPath();
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DataDirPointer>;
    const directory = typeof parsed.directory === 'string' ? parsed.directory.trim() : '';
    if (!directory || !isAbsolute(directory)) return null;
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
    return {
      directory: resolve(directory),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * 当前进程**应该**用的数据目录。
 *
 * ⚠️ 这是「现在生效的那一个」：各 store 在 apply() 里各取一次，所以进程启动之后
 * 再改指针也不会影响已经构造好的 store（这正是要重启的原因）。
 */
export function resolveDataDir(): string {
  return readDataDirPointer()?.directory ?? defaultDataDir();
}

/** 写指针（原子写）。 */
export function writeDataDirPointer(directory: string): DataDirPointer {
  const pointer: DataDirPointer = { directory: resolve(directory), savedAt: new Date().toISOString() };
  mkdirSync(defaultDataDir(), { recursive: true });
  const file = dataDirPointerPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return pointer;
}

/** 删指针（回到默认目录）。返回是否真的删了。 */
export function clearDataDirPointer(): boolean {
  const file = dataDirPointerPath();
  if (!existsSync(file)) return false;
  // 先改名再删：直接删失败会留下半个状态，改名成可辨认的残骸更稳（手改过指针时还能找回来）
  const tombstone = `${file}.deleted-${Date.now()}`;
  renameSync(file, tombstone);
  try {
    unlinkSync(tombstone);
  } catch {
    /* 删不掉就留着，不影响解析（只认 data-dir.json 这个名字） */
  }
  return true;
}

/** 一个路径是不是在另一个路径里面（含自己）。用 relative 判，跨盘会回绝对路径，天然不误判。 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export type DataDirTargetResult =
  | { ok: true; directory: string }
  | { ok: false; code: string; error: string };

/**
 * 校验用户填的目标目录。
 *
 * 规则（每一条都有具体理由，别删）：
 *   - 必须是**绝对路径**（相对路径会被 resolve 成 cwd，等于没校验）；
 *   - 不能和默认/当前目录互为父子（把数据目录放到自己的 media/ 里，越用越乱）；
 *   - 不能是个文件（Windows 上 `D:\data.txt` 这种很容易手滑）；
 *   - 不存在就建（只建一层之外用 recursive：数据目录本来就可能多级）。
 */
export function validateDataDirTarget(raw: unknown, activeDir: string): DataDirTargetResult {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, code: 'DATA_DIR_EMPTY', error: '请填一个目录的绝对路径。' };
  if (!isAbsolute(value)) {
    return {
      ok: false,
      code: 'DATA_DIR_NOT_ABSOLUTE',
      error: '数据目录必须是绝对路径（例如 D:\\DSH数据\\canvas）。',
    };
  }
  const directory = resolve(value);
  if (existsSync(directory) && !statSync(directory).isDirectory()) {
    return { ok: false, code: 'DATA_DIR_IS_FILE', error: '这个路径是一个文件，不是目录。' };
  }
  for (const [label, other] of [
    ['当前数据目录', activeDir],
    ['默认数据目录', defaultDataDir()],
  ] as const) {
    if (directory === resolve(other)) {
      return {
        ok: false,
        code: 'DATA_DIR_SAME',
        error: `这个路径就是${label}本身，不需要改（想回默认就点「恢复默认」）。`,
      };
    }
    if (isInside(directory, other) || isInside(other, directory)) {
      return {
        ok: false,
        code: 'DATA_DIR_NESTED',
        error: `新目录不能和${label}互为父子目录（会互相套住）。`,
      };
    }
  }
  return { ok: true, directory };
}

export interface DataDirStatus {
  /** 这个进程现在实际在用的目录 */
  active: string;
  /** 指针指向的目录 = 重启后会用的那个 */
  pending: string;
  default: string;
  overridden: boolean;
  /** active ≠ pending：已经改过、等重启 */
  restartRequired: boolean;
  pointerFile: string;
  activeExists: boolean;
  pendingExists: boolean;
  canvasFile: string;
  mediaDir: string;
}

/** 面板要展示的读数（`GET /data-dir` 与 `/status` 共用）。 */
export function dataDirStatus(activeDir: string): DataDirStatus {
  const active = resolve(activeDir);
  const pending = resolveDataDir();
  const pointer = readDataDirPointer();
  return {
    active,
    pending,
    default: defaultDataDir(),
    overridden: pointer !== null,
    restartRequired: active !== pending,
    pointerFile: dataDirPointerPath(),
    activeExists: existsSync(active),
    pendingExists: existsSync(pending),
    canvasFile: join(pending, 'canvas.json'),
    mediaDir: join(pending, 'media'),
  };
}

export interface DataDirMigrationResult {
  copiedFiles: number;
  copiedBytes: number;
  skipped: string[];
}

/**
 * 把现有数据**复制**到新目录（不删旧的）。
 *
 * 跳过指针文件本身（它属于默认目录）与 `.tmp`/`.part` 半截文件；
 * `force: false` 保证已经存在的同名文件不被覆盖（用户点两次也不会把新目录里的东西盖掉）。
 */
export function copyDataDir(from: string, to: string): DataDirMigrationResult {
  const result: DataDirMigrationResult = { copiedFiles: 0, copiedBytes: 0, skipped: [] };
  if (resolve(from) === resolve(to)) return result;
  if (!existsSync(from)) return result;
  mkdirSync(to, { recursive: true });
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(from, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}${sep}${entry.name}` : entry.name;
      if (entry.name === DATA_DIR_POINTER_FILE) continue;
      if (/\.(tmp|part)$/i.test(entry.name)) continue;
      if (entry.isDirectory()) {
        mkdirSync(join(to, next), { recursive: true });
        walk(next);
        continue;
      }
      const target = join(to, next);
      if (existsSync(target)) {
        result.skipped.push(next);
        continue;
      }
      cpSync(join(from, next), target, { force: false });
      try {
        result.copiedBytes += statSync(target).size;
      } catch {
        /* 统计失败不影响复制结果 */
      }
      result.copiedFiles += 1;
    }
  };
  walk('');
  return result;
}
