/**
 * ffmpeg 调用封装（host 半）
 *
 * 本机 ffmpeg 不一定在 PATH 上（这台机器上就只有 ComfyUI 整合包里那一份），
 * 所以探测顺序是：DSH_AIFISHER_FFMPEG 环境变量 → PATH → ComfyUI 整合包里的 imageio_ffmpeg。
 *
 * 为什么不用 ffprobe：imageio_ffmpeg 只带 ffmpeg 一个二进制，本机没有 ffprobe。
 * 时长/分辨率统一从 `ffmpeg -i <file>` 的 stderr 里解析 —— 注意这条命令**总是**以非 0 退出
 * （没有指定输出），所以探测走 tolerateExit，只看输出不看退出码。
 *
 * 参数一律以数组交给 execFile，不拼命令行字符串：素材文件名来自 URL，
 * 拼字符串等于自己打开注入面。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** 跑一次 ffmpeg 的输出（探测用 stderr，取字节用 stdout 的情况目前没有）。 */
export interface FfmpegRunOutput {
  stdout: string;
  stderr: string;
}

/** 从 `ffmpeg -i` 里读出来的媒体信息；读不到的字段为 null。 */
export interface MediaInfo {
  /** 秒；图片/部分流没有 duration 时为 null。 */
  duration: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface FfmpegProbe {
  path: string | null;
  source: string;
  version?: string;
}

export class FfmpegError extends Error {
  readonly code: string;
  readonly stderr: string;
  constructor(message: string, code = 'FFMPEG_FAILED', stderr = '') {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface FfmpegRunner {
  /** 探测到的 ffmpeg 绝对路径；没找到为 null。 */
  readonly path: string | null;
  /** 探测来源（诊断用）：env:DSH_AIFISHER_FFMPEG / PATH / comfyui-imageio-ffmpeg / not-found。 */
  readonly source: string;
  /** 跑一次 ffmpeg，非 0 退出抛 FfmpegError（stderr 带进错误信息）。 */
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<void>;
  /** 探测信息（诊断端点用）。version 要在启动那次异步探测完成后才有。 */
  probe(): FfmpegProbe;
  /** 拿完整输出；退出码非 0 时抛错。 */
  capture(args: readonly string[], options?: { timeoutMs?: number }): Promise<FfmpegRunOutput>;
  /** 这个 build 里有没有某个编解码器（读 `-encoders`，结果缓存）。 */
  hasEncoder(name: string): Promise<boolean>;
  /** 解析一个媒体文件的时长/分辨率/流类型。 */
  info(inputPath: string): Promise<MediaInfo>;
}

/** 时长上限：一次 ffmpeg 任务最多跑多久（裁剪长视频要留够时间）。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * ComfyUI 整合包里的 imageio_ffmpeg 二进制（本机真实存在的那一份）。
 * 版本号会跟着升级变，所以按目录扫描 `ffmpeg*.exe` 兜底，而不是写死文件名。
 * 整合包根目录可用 DSH_AIFISHER_COMFY_ROOT 覆盖。
 */
const COMFY_ROOTS = (
  process.env.DSH_AIFISHER_COMFY_ROOT
    ? [process.env.DSH_AIFISHER_COMFY_ROOT]
    : // 候选根目录：本机把整合包从 E: 挪到 G: 过，所以两个都试（顺序 = 优先 G:）
      ['G:\\ComfyUI-aki-v3.2-duyumingze', 'E:\\ComfyUI-aki-v3.2-duyumingze']
).filter(Boolean);

/** `DSH_AIFISHER_FFMPEG=off` 用来显式关掉媒体加工（回 503），便于排障与测试。 */
const DISABLED_VALUES = new Set(['off', 'none', 'disabled', '0', 'false']);

function fromComfyBundle(): string | null {
  for (const root of COMFY_ROOTS) {
    const binaries = join(root, 'python', 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries');
    try {
      const names = readdirSync(binaries);
      const hit = names
        .filter((name) => /^ffmpeg.*\.exe$/i.test(name))
        .sort()
        // 取版本号最大的那个（名字里有 v7.1 这类版本串）
        .pop();
      if (hit) return join(binaries, hit);
    } catch {
      /* 换下一个候选根目录 */
    }
  }
  return null;
}

function fromPath(): string | null {
  const raw = process.env.PATH ?? '';
  // Windows 上 ffmpeg 是 .exe（不实现 .cmd 垫片：本项目不用 shell 拼命令）
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* 不可读的 PATH 项直接跳过 */
      }
    }
  }
  return null;
}

function resolveBinary(): { path: string | null; source: string; notice?: string } {
  const override = process.env.DSH_AIFISHER_FFMPEG?.trim();
  if (override) {
    if (DISABLED_VALUES.has(override.toLowerCase())) {
      return { path: null, source: 'disabled', notice: 'DSH_AIFISHER_FFMPEG 被显式关闭' };
    }
    if (existsSync(override)) return { path: override, source: 'env:DSH_AIFISHER_FFMPEG' };
    // 指了个不存在的路径：说出来，但继续按后续顺序找，别把整个功能卡死
    console.warn(`[aifisher-canvas][media] DSH_AIFISHER_FFMPEG 指向的文件不存在，继续按 PATH/ComfyUI 探测：${override}`);
  }
  const onPath = fromPath();
  if (onPath) return { path: onPath, source: 'PATH' };
  const bundled = fromComfyBundle();
  if (bundled) return { path: bundled, source: 'comfyui-imageio-ffmpeg' };
  return { path: null, source: 'not-found' };
}

/** 从 `ffmpeg -i` 的 stderr 里抠出时长/分辨率/流类型。 */
function parseMediaInfo(text: string): MediaInfo {
  const durationMatch = /Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/.exec(text);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : null;

  const lines = text.split(/\r?\n/).filter((line) => /Stream #\d+:\d+/.test(line));
  const videoLine = lines.find((line) => /:\s*Video:/.test(line));
  const audioLine = lines.find((line) => /:\s*Audio:/.test(line));

  let width: number | null = null;
  let height: number | null = null;
  if (videoLine) {
    // 分辨率写作 ", 320x240"，前面还有 avc1 / 0x31637661 这类含 x 的十六进制标记，
    // 所以锚定在逗号+空格之后，避免把 0x31637661 当成尺寸。
    const sizeMatch = /,\s*(\d{2,5})x(\d{2,5})(?=[\s,\[])/.exec(videoLine);
    if (sizeMatch) {
      width = Number(sizeMatch[1]);
      height = Number(sizeMatch[2]);
    }
  }

  return {
    duration: duration !== null && Number.isFinite(duration) ? duration : null,
    width,
    height,
    hasVideo: Boolean(videoLine),
    hasAudio: Boolean(audioLine),
  };
}

export function createFfmpegRunner(): FfmpegRunner {
  const resolved = resolveBinary();
  const state = {
    path: resolved.path,
    source: resolved.source,
    version: undefined as string | undefined,
  };
  let encodersPromise: Promise<Set<string>> | null = null;

  function execOnce(args: readonly string[], timeoutMs: number, tolerateExit: boolean): Promise<FfmpegRunOutput> {
    const binary = state.path;
    if (!binary) {
      return Promise.reject(
        new FfmpegError(
          '本机没有可用的 ffmpeg：视频抽帧/裁剪与缩略图需要它（可用 DSH_AIFISHER_FFMPEG 指定路径）',
          'FFMPEG_UNAVAILABLE',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        [...args],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');
          if (!error) {
            resolve({ stdout: out, stderr: err });
            return;
          }
          const killed = Boolean((error as { killed?: boolean }).killed);
          if (tolerateExit && !killed) {
            resolve({ stdout: out, stderr: err });
            return;
          }
          if (killed) {
            reject(new FfmpegError(`ffmpeg 执行超时（${Math.round(timeoutMs / 1000)}s）`, 'FFMPEG_TIMEOUT', err));
            return;
          }
          const code = String((error as { code?: unknown }).code ?? '');
          if (code === 'ENOENT') {
            reject(new FfmpegError(`找不到 ffmpeg 可执行文件：${binary}`, 'FFMPEG_UNAVAILABLE', err));
            return;
          }
          // 错误信息只留尾部：ffmpeg 的报错都在最后几行，前面的横幅没有诊断价值
          reject(new FfmpegError(`ffmpeg 执行失败：${err.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)}`, 'FFMPEG_FAILED', err));
        },
      );
    });
  }

  async function detectVersion(): Promise<string | undefined> {
    if (!state.path || state.version) return state.version;
    try {
      const { stdout, stderr } = await execOnce(['-hide_banner', '-version'], 8_000, true);
      const match = /ffmpeg version (\S+)/.exec(`${stdout}\n${stderr}`);
      if (match) state.version = match[1];
    } catch {
      /* 版本号只是诊断信息，拿不到不影响功能 */
    }
    return state.version;
  }

  function encoders(): Promise<Set<string>> {
    if (!encodersPromise) {
      encodersPromise = (async () => {
        const found = new Set<string>();
        if (!state.path) return found;
        try {
          const { stdout } = await execOnce(['-hide_banner', '-encoders'], 15_000, false);
          for (const line of stdout.split(/\r?\n/)) {
            const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
            if (match) found.add(match[1]);
          }
        } catch {
          /* 探测失败就当没有：调用方有兜底编码器 */
        }
        return found;
      })();
    }
    return encodersPromise;
  }

  // 启动诊断：一行，让用户在 DSH 控制台立刻知道媒体加工能不能用
  void (async () => {
    if (!state.path) {
      console.warn(
        `[aifisher-canvas][media] 未找到 ffmpeg（${resolved.notice ?? resolved.source}）：抽帧/裁剪/缩略图端点将回 503 FFMPEG_UNAVAILABLE（可用 DSH_AIFISHER_FFMPEG 指定路径）`,
      );
      return;
    }
    const version = await detectVersion();
    console.log(
      `[aifisher-canvas][media] ffmpeg${version ? ` ${version}` : ''} 可用：${state.path}（来源：${state.source}）`,
    );
  })();

  return {
    get path() {
      return state.path;
    },
    get source() {
      return state.source;
    },
    async run(args, options) {
      await execOnce(args, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, false);
    },
    capture(args, options) {
      return execOnce(args, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, false);
    },
    probe: () => ({
      path: state.path,
      source: state.source,
      ...(state.version ? { version: state.version } : {}),
    }),
    hasEncoder: async (name) => (await encoders()).has(name),
    async info(inputPath) {
      // `ffmpeg -i <file>` 必定非 0 退出，所以这里 tolerateExit
      const { stderr } = await execOnce(['-hide_banner', '-i', inputPath], PROBE_TIMEOUT_MS, true);
      const info = parseMediaInfo(stderr);
      if (!info.hasVideo && !info.hasAudio) {
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
        throw new FfmpegError(`无法识别的媒体文件：${tail || inputPath}`, 'MEDIA_PROBE_FAILED', stderr);
      }
      return info;
    },
  };
}
