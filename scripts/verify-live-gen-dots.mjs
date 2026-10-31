/**
 * 真机验收：生成中「噪波圆点阵」是不是真的在动、重启后会不会冻住（v1.88）。
 *
 * 为什么不用登录/生成来验收：跑一次生成要花钱（费用授权只在画布 UI 里按），
 * 所以这里往真实画布挂一个**假遮罩**（class 与 data 属性照抄 vendor 的 GenerationWaiting），
 * 遮罩挂上后插点阵的是插件自己的 bootstrap（installCanvasGenerationDots），
 * 验的仍然是线上产物里的那套代码与 skin.ts 的 CSS。
 *
 * 两件事：
 *   ① 400ms 内圆点的 r / fill-opacity 必须真的在变 —— 用户 2026-11-01 报「现在它是一张静帧」；
 *   ② 遮罩摘掉（上一轮生成结束、rAF 停）再挂回来，必须立刻恢复动画 ——
 *      回归 ensureLoop 没清 lastPaint、`time - lastPaint` 一直为负而冻住整轮生成时间的 bug。
 *
 * 用法：node scripts/verify-live-gen-dots.mjs [baseUrl] [--keep]
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9343);
const SHOTS = process.env.DSH_SHOTS_DIR ?? join(ROOT, '.dsh-tmp', 'shots');

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
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-dots-'));
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

  await waitFor('document.title || null', 30000);
  await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]"))',
    45000,
  );

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

  // 进画布
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
  // 项目库详情页上有一个「打开画布」按钮（v1.86 之后不再靠点卡片进画布）；
  // 老布局没有那个按钮时退回「点一张带时间的项目卡片」。
  const enterCanvas = `(() => {
    if (document.querySelector('[aria-label="画布缩放"]')) return 'already';
    const button = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => /打开画布|打开项目|继续编辑|进入画布/.test(String(el.textContent || '').trim()));
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'button';
    }
    const scope = document.querySelector('[data-fisherai-project-dashboard="true"]') ?? document;
    const candidates = [...scope.querySelectorAll('.cursor-pointer')];
    const card = candidates.find((node) => /编辑于|刚刚|分钟前|小时前|天前/.test(String(node.innerText || '')));
    const target = card ?? candidates.find((node) => node.tagName === 'TR') ?? null;
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return target ? 'card' : 'none';
  })()`;
  if (!zoomReady) lines.push(`  进画布：${await evaluate(enterCanvas)}`);
  let canvasView = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 20000);
  for (let attempt = 0; attempt < 2 && !canvasView; attempt += 1) {
    lines.push(`  进画布重试：${await evaluate(enterCanvas)}`);
    canvasView = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 20000);
  }
  check('已经进入画布视图', Boolean(canvasView));
  await sleep(1500);

  /** 挂一个假生成遮罩：DOM 结构照抄 vendor 的 GenerationWaiting（含 ring / strong / operation / small）。 */
  const mountOverlay = `(() => {
    const mount = document.querySelector('.af-canvas-mount');
    if (!mount) return false;
    document.getElementById('af-fake-gen')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'af-fake-gen';
    overlay.setAttribute('data-fisherai-regeneration-overlay', 'true');
    overlay.className = 'af-generation-waiting';
    overlay.style.cssText = 'position:fixed;left:560px;top:170px;width:340px;height:466px;border-radius:14px;';
    overlay.innerHTML = '<span class="af-generation-waiting-ring"></span><strong>正在生成</strong>'
      + '<span class="af-generation-waiting-operation">图片生成</span><small>完成后自动显示结果</small>';
    mount.append(overlay);
    return true;
  })()`;

  const removeOverlay = `(() => { document.getElementById('af-fake-gen')?.remove(); return true; })()`;

  /** 读全部圆点的 r / 透明度，用来判断「有没有在动」。 */
  const sample = `(() => {
    const circles = [...document.querySelectorAll('#af-fake-gen .af-gen-dots circle')];
    return {
      count: circles.length,
      bright: circles.filter((circle) => Number(circle.getAttribute('fill-opacity')) > 0.25).length,
      values: circles.map((circle) => circle.getAttribute('r') + '|' + circle.getAttribute('fill-opacity')),
    };
  })()`;

  const shotOverlay = async (name) => {
    const clip = await evaluate(`(() => {
      const el = document.getElementById('af-fake-gen');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 };
    })()`);
    if (!clip) return;
    const result = await page.send('Page.captureScreenshot', { format: 'png', clip });
    const path = join(SHOTS, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    lines.push(`  截图：${path}`);
  };

  await evaluate(mountOverlay);
  const mounted = await waitFor('Boolean(document.querySelector("#af-fake-gen .af-gen-dots circle"))', 8000);
  check('真机里遮罩上挂出了噪波点阵层', Boolean(mounted));

  const firstDots = await evaluate(sample);
  check('点阵规模与设计稿一致（340×466 ≈ 391 个圆点）', firstDots?.count === 391, String(firstDots?.count));
  check('亮团只占一部分（不是整层呼吸 / 不是满屏全亮）',
    firstDots?.bright > 10 && firstDots?.bright < firstDots.count * 0.5,
    `${firstDots?.bright}/${firstDots?.count}`);
  await shotOverlay('live-生成中点阵-帧1');

  await sleep(700);
  const secondDots = await evaluate(sample);
  const moved = (secondDots?.values ?? []).filter((value, index) => value !== firstDots?.values?.[index]).length;
  check('点阵真的在动：700ms 内过半圆点的 r / 透明度都变了（不是一张静帧）',
    moved > firstDots.count * 0.5,
    `${moved}/${firstDots?.count}`);
  await shotOverlay('live-生成中点阵-帧2');

  // 上一轮生成结束 → 下一轮开始：遮罩摘掉（rAF 停）、再挂一个新的
  await evaluate(removeOverlay);
  await sleep(400);
  await evaluate(mountOverlay);
  await waitFor('Boolean(document.querySelector("#af-fake-gen .af-gen-dots circle"))', 8000);
  const restartA = await evaluate(sample);
  await sleep(700);
  const restartB = await evaluate(sample);
  const resumed = (restartB?.values ?? []).filter((value, index) => value !== restartA?.values?.[index]).length;
  check('停一轮再挂回来立刻恢复动画（不沿用上一轮的时间冻住整轮生成）',
    resumed > restartA.count * 0.5,
    `${resumed}/${restartA?.count}`);
  await shotOverlay('live-生成中点阵-帧3');

  await evaluate(removeOverlay);
  const cleaned = await waitFor('!document.getElementById("af-fake-gen")', 4000);
  check('验收结束把假遮罩摘掉，不留痕', Boolean(cleaned));

  const pass = lines.filter((line) => line.startsWith('PASS')).length;
  lines.push('', `SUMMARY pass=${pass} fail=${failures}`);
  console.log(lines.join('\n'));
} catch (error) {
  console.error(`[live-gen-dots] 运行失败：${error instanceof Error ? error.message : String(error)}`);
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
