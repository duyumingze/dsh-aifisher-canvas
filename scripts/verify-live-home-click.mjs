/**
 * 真机验收：打开画布后「点一次就进项目」（v1.86）。
 *
 * 为什么不能只靠 jsdom：这条缺陷是**时序**的 —— 点「打开画布」→ 项目库关闭 →
 * vendor 的 `loadProject` 还要过一次 HTTP → 首屏看门在这中间把项目库重开。
 * jsdom 里网络是微任务级的，不加人为延迟永远撞不上；真浏览器的真实延迟才作数。
 *
 * 做法：headless Chrome + CDP（Node 22 自带 WebSocket，不引依赖）打开**正在跑的** DSH，
 * 用**真鼠标事件**点侧边栏「无限画布」，等首屏项目库出来，再真点一次 hero 的
 * 「打开画布」，同时每 20ms 采样「项目库在不在 / 画布底盘在不在 / 项目库实例 token」。
 *
 * 判据（都是用户能感知的）：
 *   ① 点一次就进画布：项目库消失、`#canvas-background` 出现、`[aria-label="画布缩放"]` 在；
 *   ② 项目库没有被重开：实例 token 只有 1 个、resource timing 里 `/canvas/projects` 没有多拉一次；
 *   ③ 全程没有「项目库不在 && 画布没起」的帧（那就是「第一下只是重新激活了项目管理器」）。
 *
 * 会打开一个真实项目（只读：不点生成、不改节点）；用的是临时浏览器配置，不影响你的会话。
 *
 * 用法：node scripts/verify-live-home-click.mjs [baseUrl] [--keep]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:61220';
const KEEP = process.argv.includes('--keep');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9361);
const SHOTS = join(process.env.TEMP ?? tmpdir(), 'dsh-live-home-click');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};
const say = (line) => lines.push(`  ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome/Edge，跳过真机验收。');
  process.exit(0);
}

mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-home-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const settle = pending.get(message.id);
        pending.delete(message.id);
        settle(message);
      }
    });
    ws.addEventListener('error', (error) => rej(error));
    ws.addEventListener('open', () =>
      res({
        send(method, params = {}) {
          return new Promise((resolveCall, rejectCall) => {
            const callId = ++id;
            pending.set(callId, (message) =>
              message.error
                ? rejectCall(new Error(`${method}: ${JSON.stringify(message.error)}`))
                : resolveCall(message.result),
            );
            ws.send(JSON.stringify({ id: callId, method, params }));
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* 已经关了 */
          }
        },
      }),
    );
  });
}

async function devtoolsReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) return response.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

let page = null;
try {
  await devtoolsReady();
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const auth = localAuthCookie({ url: BASE });
  if (auth) await installAuthCookie(page.send, auth);
  await page.send('Page.navigate', { url: BASE });

  const evaluate = async (expression) => {
    const result = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败');
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) {
        last = `err: ${error.message}`;
      }
      await sleep(200);
    }
    return last === null ? false : last;
  };
  const shot = async (name) => {
    const result = await page.send('Page.captureScreenshot', { format: 'png' });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    say(`截图：${path}`);
  };
  /** 真鼠标：移到目标中心 → 按下 → 抬起（等于用户点一下）。 */
  const realClick = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(60);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(60);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  };

  const title = await waitFor('document.title || null', 30000);
  await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]"))',
    45000,
  );
  check('DSH 页面在外部浏览器里能打开', Boolean(title), String(title ?? '(none)'));

  // 关掉首访模态框（会挡住点击）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const closed = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .find((node) => node.getBoundingClientRect().width > 0);
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll('button')];
      const primary = buttons.find((button) => String(button.className).includes('_primary_')) ?? buttons[buttons.length - 1];
      primary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    if (!closed) break;
    await sleep(500);
  }

  // ---- 1) 点侧边栏「无限画布」（真鼠标） ----
  const entry = await evaluate(`(() => {
    const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
    if (!icon) return null;
    const target = icon.closest('button, [role="button"], a, li') ?? icon;
    const rect = target.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  check('侧边栏有「无限画布」入口', Boolean(entry));
  if (!entry) throw new Error('没有「无限画布」入口');
  await realClick(entry.x, entry.y);

  const pageReady = await waitFor(
    `Boolean(document.querySelector('[data-fisherai-page="projects"]'))`,
    30000,
  );
  check('打开画布 = 项目库首屏', Boolean(pageReady));
  check(
    '项目库压住 vendor 旧看板（首屏不露旧界面）',
    Boolean(await evaluate(`Boolean(document.querySelector('[data-fisherai-project-dashboard="true"]'))`)),
  );

  // 等卡片墙拉到真实项目（/projects 回来之前没有「打开画布」主按钮）。
  const targetPoint = await waitFor(
    `(() => {
      const textOf = (el) => String(el.textContent ?? '').replace(/\\s+/g, '');
      const buttons = [...document.querySelectorAll('[data-fisherai-page="projects"] button')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const style = getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) >= 0.05;
        });
      const pick = buttons.find((el) => textOf(el).includes('打开画布')) ?? null;
      if (!pick) return null;
      const rect = pick.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), label: textOf(pick).slice(0, 12) };
    })()`,
    20000,
  );
  check('首屏项目库上有「打开画布」主按钮', Boolean(targetPoint), String(targetPoint?.label ?? ''));

  if (targetPoint) {
    // 采样：项目库在不在 / 画布底盘在不在 / 项目库实例 token（重开 = 新实例）。
    await evaluate(`(() => {
      window.__HOME_TIMELINE__ = [];
      window.__HOME_PAGE_TOKEN__ = 0;
      const tick = () => {
        const node = document.querySelector('[data-fisherai-page="projects"]');
        let token = null;
        if (node) {
          if (!node.dataset.homeProbeToken) node.dataset.homeProbeToken = String(++window.__HOME_PAGE_TOKEN__);
          token = node.dataset.homeProbeToken;
        }
        window.__HOME_TIMELINE__.push({
          t: Math.round(performance.now()),
          page: Boolean(node),
          token,
          canvas: Boolean(document.getElementById('canvas-background')),
          dashboard: Boolean(document.querySelector('[data-fisherai-project-dashboard="true"]')),
        });
        if (window.__HOME_TIMELINE__.length > 800) window.__HOME_TIMELINE__.shift();
      };
      window.__HOME_SAMPLER__ = setInterval(tick, 20);
      tick();
      return true;
    })()`);
    // 起点：这一屏拉过一次 /projects（重开才会再拉一次）。
    const projectListLoadsBefore = await evaluate(`performance.getEntriesByType('resource')
      .filter((entry) => /\\/api\\/aifisher\\/canvas\\/projects(\\?|$)/.test(entry.name)).length`);

    await realClick(targetPoint.x, targetPoint.y);
    await sleep(700);
    await shot('01-after-one-click');
    await sleep(2600);
    await shot('02-three-seconds-later');

    const state = await evaluate(`(() => {
      const timeline = window.__HOME_TIMELINE__ ?? [];
      const tokens = [...new Set(timeline.map((item) => item.token).filter(Boolean))];
      const gapFrames = timeline.filter((item) => !item.page && !item.canvas).length;
      const projectListLoads = performance.getEntriesByType('resource')
        .filter((entry) => /\\/api\\/aifisher\\/canvas\\/projects(\\?|$)/.test(entry.name)).length;
      clearInterval(window.__HOME_SAMPLER__);
      return {
        canvas: Boolean(document.getElementById('canvas-background')),
        zoom: Boolean(document.querySelector('[aria-label="画布缩放"]')),
        page: Boolean(document.querySelector('[data-fisherai-page="projects"]')),
        tokens,
        gapFrames,
        samples: timeline.length,
        projectListLoads,
      };
    })()`);

    check('点一次「打开画布」就进了画布（项目库消失）', state.page === false);
    check('画布底盘与缩放条都在（真的进了项目）', state.canvas === true && state.zoom === true,
      `canvas=${state.canvas} zoom=${state.zoom}`);
    check('项目库没有被重开（只挂过一份）', state.tokens.length === 1, `tokens=${state.tokens.join(',') || 'none'}`);
    check(
      '项目库没有被重开（没有多拉一次 /projects）',
      state.projectListLoads === projectListLoadsBefore,
      `${projectListLoadsBefore} → ${state.projectListLoads}`,
    );
    check(
      '全程没有「项目库不在 && 画布没起」的帧',
      state.gapFrames === 0,
      `${state.gapFrames} / ${state.samples} 帧`,
    );
  }

  const pass = lines.filter((line) => line.startsWith('PASS')).length;
  lines.push('', `SUMMARY pass=${pass} fail=${failures}`);
  console.log(lines.join('\n'));
} catch (error) {
  failures += 1;
  console.error(`[live-home] 运行失败：${error instanceof Error ? error.message : String(error)}`);
  console.log(lines.join('\n'));
} finally {
  try {
    page?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  if (!KEEP) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Windows 句柄未释放 */
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}
