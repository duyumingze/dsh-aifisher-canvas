/**
 * 真机验收：无限画布换肤（方案 C）+ 界面缩放（v1.81）。
 *
 * 为什么不用 browser-check：那一套跑在「假 DSH 宿主页」里，验不到**真实 DSH 桌面外壳**下的三件事：
 *   ① 右下角「退出画布」按钮（z 60，right 20 / bottom 20）有没有压住界面缩放胶囊；
 *   ② 顶栏在真实侧边栏/窗口宽度下还贴不贴边（zoom 后 width:100% 是否仍铺满）；
 *   ③ 界面放大后画布内容（#canvas-viewport-content 的 transform）有没有被带着一起缩放。
 *
 * 做法：headless Chrome + CDP 打开**正在跑的** DSH，点侧边栏「无限画布」→ 点项目进画布视图，
 * 先出 100% 的图，点两次「+」到 125% 再出图；结束时把 scale 复位并还原 localStorage。
 *
 * 用法：node scripts/verify-live-skin.mjs [baseUrl] [--keep]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:51140';
const KEEP = process.argv.includes('--keep');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341);
const SHOTS = join(ROOT, '.dsh-tmp', 'shots');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome/Edge，跳过真机验收。');
  process.exit(0);
}

mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-skin-'));
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
      if (response.ok) return await response.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

let page = null;
let restoreScale = null;
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
      await sleep(300);
    }
    return last === null ? false : last;
  };
  const shot = async (name) => {
    const result = await page.send('Page.captureScreenshot', { format: 'png' });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    lines.push(`  截图：${path}`);
  };

  const title = await waitFor('document.title || null', 30000);
  const booted = await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]"))',
    45000,
  );
  check('DSH 页面在外部浏览器里能打开', Boolean(title), String(title ?? '(none)'));
  check('界面已经启动（能看到面板入口）', Boolean(booted), String(booted));

  // 关掉首访模态框（会挡住点击）
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

  const entry = await evaluate('Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))');
  check('侧边栏有「无限画布」入口', Boolean(entry));
  let shell = null;
  for (let attempt = 0; attempt < 4 && !shell; attempt += 1) {
    await evaluate(`(() => {
      const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
      if (!icon) return false;
      (icon.closest('button, [role="button"], a, li') ?? icon).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    shell = await waitFor(
      'Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))',
      attempt === 0 ? 20000 : 12000,
    );
  }
  check('画布面板外壳挂上了', Boolean(shell));
  await sleep(2500);

  const zoomReady = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 6000);
  if (!zoomReady) {
    await evaluate(`(() => {
      const scope = document.querySelector('[data-fisherai-project-dashboard="true"]') ?? document;
      const candidates = [...scope.querySelectorAll('.cursor-pointer')];
      const card = candidates.find((node) => /编辑于|刚刚|分钟前|小时前|天前/.test(String(node.innerText || '')));
      const target = card ?? candidates.find((node) => node.tagName === 'TR') ?? null;
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(target);
    })()`);
  }
  const canvasView = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 60000);
  check('已经进入画布视图', Boolean(canvasView));
  await sleep(1200);

  /** 一次读全：chrome 几何、胶囊、退出按钮、画布 transform、皮肤关键值。 */
  const snapshot = `(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
    const mount = document.querySelector('.af-canvas-mount');
    const header = document.querySelector('.af-canvas-header');
    const root = document.querySelector('.af-canvas-mount > div') ?? document.querySelector('.af-canvas-mount');
    const exit = [...document.querySelectorAll('button, [role="button"]')].find((el) => /退出画布/.test(String(el.getAttribute('aria-label') || el.textContent || '')));
    const capsule = document.querySelector('[data-af-ui-scale]');
    const rail = document.querySelector('[role="toolbar"][aria-label="画布工具"]');
    const dock = document.querySelector('[data-af-zoom-bar]');
    const minimap = document.querySelector('[data-fisherai-minimap]');
    const viewport = document.querySelector('#canvas-viewport-content');
    const card = document.querySelector('#canvas-viewport-content [data-node-id] > div[class~="group/nodecard"] > div[class*="bg-[var(--af-surface)]"]');
    const exitBox = box(exit); const capBox = box(capsule);
    const overlap = exitBox && capBox && !(capBox.r <= exitBox.l || capBox.l >= exitBox.r || capBox.b <= exitBox.t || capBox.t >= exitBox.b);
    return {
      mount: box(mount), header: box(header), rail: box(rail), dock: box(dock), minimap: box(minimap),
      exit: exitBox, capsule: capBox, capsuleOverlapsExit: overlap,
      capsuleText: capsule ? String(capsule.textContent || '').replace(/\\s+/g, ' ').trim() : null,
      scaleAttr: document.documentElement.dataset.afUiPercent ?? null,
      headerZoom: header ? getComputedStyle(header).zoom : null,
      headerBg: header ? getComputedStyle(header).backgroundColor : null,
      railZoom: rail ? getComputedStyle(rail).zoom : null,
      viewportTransform: viewport ? viewport.style.transform : null,
      cardRadius: card ? getComputedStyle(card).borderRadius : null,
      cardBg: card ? getComputedStyle(card).backgroundImage : null,
      canvasVar: mount ? getComputedStyle(mount).getPropertyValue('--af-canvas').trim() : null,
    };
  })()`;

  restoreScale = await evaluate('localStorage.getItem("af.uiScale")');
  const at100 = await evaluate(snapshot);
  await shot('live-皮肤-100');

  check('真机里画布皮肤生效：画布底色 = 设计稿 #0b0d11', at100.canvasVar === '#0b0d11', at100.canvasVar);
  check('真机里顶栏是玻璃条（有实底背景色，不透明）', /rgba?\(/.test(String(at100.headerBg)), String(at100.headerBg));
  check('真机里节点卡片 14 圆角 + 玻璃渐变', at100.cardRadius === '14px' && /linear-gradient/.test(String(at100.cardBg)),
    `radius=${at100.cardRadius} bg=${String(at100.cardBg).slice(0, 48)}`);
  check('真机里右下角有「界面 − 100% +」胶囊', at100.capsuleText?.includes('界面') && at100.capsuleText?.includes('100%'),
    String(at100.capsuleText));
  check('界面缩放胶囊不与 DSH「退出画布」按钮重叠', at100.capsuleOverlapsExit === false,
    JSON.stringify({ exit: at100.exit, capsule: at100.capsule }));

  // 100 → 110 → 125
  const clickScale = async (aria) => {
    const ok = await evaluate(`(() => {
      const button = document.querySelector('[data-af-ui-scale] button[aria-label="${aria}"]');
      if (!button) return false;
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    return ok;
  };
  check('能点「放大界面」', await clickScale('放大界面'));
  check('能再点一次「放大界面」', await clickScale('放大界面'));

  const at125 = await evaluate(snapshot);
  await shot('live-皮肤-125');

  check('界面放大到 125%（chrome 的 zoom 真的生效）', at125.headerZoom === '1.25' && at125.scaleAttr === '125',
    `zoom=${at125.headerZoom} attr=${at125.scaleAttr}`);
  check('顶栏在 125% 下仍正好铺满画布（没有越界压住侧边栏）',
    at125.header.w === at125.mount.w || Math.abs(at125.header.w - at125.mount.w) <= 2,
    `header=${at125.header.w} mount=${at125.mount.w}`);
  check('界面缩放时画布内容不动（viewport transform 与 100% 一致）',
    at125.viewportTransform === at100.viewportTransform,
    `${at100.viewportTransform} → ${at125.viewportTransform}`);
  check('界面缩放时工具条不压到左下小地图（工具条底 < 小地图顶）',
    !at125.minimap || at125.rail.b <= at125.minimap.t + 2,
    `rail.bottom=${at125.rail.b} minimap.top=${at125.minimap?.t}`);
  check('胶囊读数变成 125%', at125.capsuleText?.includes('125%'), String(at125.capsuleText));

  // 复位并把 localStorage 还原成用户原来的值
  await clickScale('界面缩放 125%');
  if (restoreScale !== null) {
    await evaluate(`localStorage.setItem('af.uiScale', ${JSON.stringify(restoreScale)})`);
  } else {
    await evaluate('localStorage.removeItem("af.uiScale")');
  }

  const pass = lines.filter((line) => line.startsWith('PASS')).length;
  lines.push('', `SUMMARY pass=${pass} fail=${failures}`);
  console.log(lines.join('\n'));
} catch (error) {
  console.error(`[live-skin] 运行失败：${error instanceof Error ? error.message : String(error)}`);
  failures += 1;
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
