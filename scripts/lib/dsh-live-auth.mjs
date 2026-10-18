/**
 * 真机验收用的**本机授权 cookie**（只读、只在本机、只给本地无头浏览器）。
 *
 * 背景：DSH 的 web 服务自 v0.2 起对 HTML/静态资源做浏览器会话鉴权 ——
 * 第一次访问必须带 `?token=<进程启动令牌>`，服务端随后回一个用**持久签名密钥**
 * （存在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录里）
 * 签名的 HttpOnly cookie（`dsh-auth-<sha256(authority) 的 base64url>`）。
 * 进程启动令牌只活在那个进程的内存里（`PROCESS_LAUNCH_TOKENS`），外部脚本拿不到；
 * 所以「用真浏览器打开正在跑的 DSH」这条验收路只有在带上 cookie 时才走得通。
 *
 * 本模块做的事：读这台机器自己的 `.credentials.yaml` 里的签名密钥，按内核同一套算法
 * （v1.<base64url(payload)>.<base64url(hmacSha256(secret, body))>）**为自己签发**一个
 * 短期 cookie，交给 headless Chrome 的 CDP `Network.setCookie`。
 *
 * 边界：不写任何文件、不改 DSH 状态、不联网；只读 `$DSH_HOME` 下两个文件
 * （`.credentials.yaml`、`dsh-config-manager/running/*.json` 取端口）。
 * 拿不到密钥/端口时返回 null，调用方应退化成「跳过真机验收」而不是报错。
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDENTIAL_FILE = '.credentials.yaml';
const RUNNING_DIR = 'dsh-config-manager/running';

/** base64url（与内核 encodeBase64Url 一致：+/→-_、去尾部 =）。 */
function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** 从极简 YAML 里抠出 `client-connection/browser-session` 记录的 secret。 */
function readSigningSecret(home) {
  const path = join(home, CREDENTIAL_FILE);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf('client-connection/browser-session:');
  if (at < 0) return null;
  const rest = text.slice(at);
  const match = rest.match(/secret:\s*([A-Za-z0-9_-]{40,})/u);
  if (!match) return null;
  const decoded = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return decoded.byteLength === 32 ? decoded : null;
}

/** 从 config-manager 的运行记录里找端口与 PID（最新的那条优先）。 */
function readRunning(home) {
  const dir = join(home, RUNNING_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  let best = null;
  for (const name of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (typeof record?.port !== 'number') continue;
      if (!best || (record.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = record;
    } catch {
      /* 坏记录跳过 */
    }
  }
  return best;
}

/**
 * 造一个本机授权 cookie。
 *
 * @param options.home - DSH 主目录（缺省 `$DSH_HOME` 或 `~/.dsh`）
 * @param options.url - 目标 URL（缺省 `$DSH_WEB_URL` 或运行记录里的端口）
 * @param options.days - cookie 有效期（天，缺省 1）
 * @returns `{ authority, name, value, expiresAtSeconds, url, source }` 或 null。
 */
export function localAuthCookie(options = {}) {
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const secret = readSigningSecret(home);
  if (!secret) return null;

  const running = readRunning(home);
  const url = options.url ?? process.env.DSH_WEB_URL ?? (running ? `http://127.0.0.1:${running.port}` : null);
  if (!url) return null;

  let authority;
  try {
    authority = new URL(url).host;
  } catch {
    return null;
  }

  const days = options.days ?? 1;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + days * 24 * 60 * 60 * 1000;
  const payload = { version: 1, authority, issuedAt, expiresAt };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = createHmac('sha256', secret).update(body).digest();
  const value = `v1.${body}.${encodeBase64Url(signature)}`;
  const name = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest());

  return {
    authority,
    name,
    value,
    expiresAtSeconds: Math.floor(expiresAt / 1000),
    url,
    source: { home, credentials: join(home, CREDENTIAL_FILE) },
  };
}

/**
 * 在已连上的 CDP 页面里把授权 cookie 装上（必须在导航到目标页之前调用）。
 *
 * @param send - CDP `send(method, params)` 函数
 * @param auth - {@link localAuthCookie} 的返回值
 */
export async function installAuthCookie(send, auth) {
  await send('Network.enable');
  const [hostname] = auth.authority.split(':');
  await send('Network.setCookie', {
    name: auth.name,
    value: auth.value,
    domain: hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure: false,
    expires: auth.expiresAtSeconds,
  });
}
