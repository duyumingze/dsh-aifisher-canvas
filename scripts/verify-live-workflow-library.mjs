/**
 * 真机验收：左侧「工作流节点」面板 + 工作流自定义配图（v1.28）。
 *
 * 用户报障原话（2026-10-17）：
 *   「左侧工作流节点做错了，点击后是在画布右键的样子。工作流节点里放置配置好的 comfui，可以自定义配图」
 *
 * 为什么要有它（jsdom 那条回归不够）：
 *   jsdom 里所有 rect 都是 0、没有真布局，也量不出「点下去弹出的到底是不是右键菜单那一层浮层」；
 *   所以这里用 headless Chrome + CDP（Node 22 自带 WebSocket，不引依赖）打开**正在跑的** DSH 页面，
 *   用真鼠标点侧边栏「无限画布」→ 进画布 → 点左栏「工作流节点」，量三件事：
 *     ① 出现的是**工作流节点面板**（role=dialog / aria-label=工作流节点），而且**没有** role=menu
 *        （用户报的那个 bug 就是这里弹出的右键菜单）；
 *     ② 卡片有真布局（封面区高度 > 0），每张卡片一个配图槽，配过图的显示 <img>；
 *     ③ 配图能存能删：用页面里的 fetch 走一遍真实 POST/GET/DELETE，卡片上的 <img> 跟着换。
 *
 * 只读原则：不往用户画布里加节点（不点卡片），配图测试**只在一份没配过图的工作流上做**，
 * 做完立刻 DELETE 还原。原本就有配图的工作流一律不动。
 *
 * 用法：node scripts/verify-live-workflow-library.mjs [baseUrl] [--keep]
 *   默认 baseUrl = http://127.0.0.1:19387（桌面端）
 *   --keep 不删临时 Chrome 用户目录（排查用）
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:19387';
const KEEP = process.argv.includes('--keep');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9339);
const SHOTS = join(ROOT, '.dsh-tmp', 'shots');
const DOC_SHOTS = join(ROOT, 'docs', 'shots');

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
mkdirSync(DOC_SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-workflow-library-'));
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

/** 极简 CDP 客户端（Node 22 的全局 WebSocket）。 */
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
  else lines.push('  警告：没有拿到本机授权 cookie（DSH_HOME/.credentials.yaml 里没有 browser-session 密钥）');
  await page.send('Page.navigate', { url: BASE });

  const evaluate = async (expression) => {
    const result = await page.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败');
    }
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
    const file = join(SHOTS, name);
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    try {
      copyFileSync(file, join(DOC_SHOTS, name));
    } catch {
      /* docs 目录写不进去不影响验收结论 */
    }
    lines.push(`  截图：${file}`);
    return file;
  };
  const dismissStartupDialogs = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await evaluate(`(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
          .find((node) => node.getBoundingClientRect().width > 0);
        if (!dialog) return null;
        const buttons = [...dialog.querySelectorAll('button')];
        const primary = buttons.find((button) => String(button.className).includes('_primary_')) ?? buttons[buttons.length - 1];
        const label = (primary?.innerText || '').trim();
        primary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { label };
      })()`);
      if (!result) return null;
      lines.push(`  关掉启动模态框：「${result.label || '(无按钮)'}」`);
      await sleep(500);
    }
    return true;
  };

  await waitFor('document.title || null', 30000);
  await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]"))',
    45000,
  );
  await dismissStartupDialogs();
  check(
    '侧边栏有「无限画布」入口',
    Boolean(
      await evaluate(
        'Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))',
      ),
    ),
  );

  // ---------------------------------------------------------------- 打开画布面板 + 进画布视图
  const clickPanelEntry = () =>
    evaluate(`(() => {
      const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
      if (!icon) return false;
      (icon.closest('button, [role="button"], a, li') ?? icon).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
  let shell = null;
  for (let attempt = 0; attempt < 4 && !shell; attempt += 1) {
    await clickPanelEntry();
    shell = await waitFor(
      'Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))',
      attempt === 0 ? 20000 : 12000,
    );
    if (!shell) await sleep(800);
  }
  check('画布面板外壳挂上了', Boolean(shell));
  await sleep(2500);

  const trigger = '[data-dsh-aifisher-canvas="shell"] [data-fisherai-workflow-node-trigger]';
  const triggerReady = await waitFor(`Boolean(document.querySelector('${trigger}'))`, 10000);
  if (!triggerReady) {
    const opened = await evaluate(`(() => {
      const scope = document.querySelector('[data-fisherai-project-dashboard="true"]') ?? document;
      const candidates = [...scope.querySelectorAll('.cursor-pointer')];
      const card = candidates.find((node) => /编辑于|刚刚|分钟前|小时前|天前/.test(String(node.innerText || '')));
      const target = card ?? candidates.find((node) => node.tagName === 'TR') ?? null;
      if (!target) return null;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return String(target.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    })()`);
    lines.push(`  点开项目进画布视图：${opened ? `「${opened}」` : '(没找到项目卡片)'}`);
  }
  const canvasView = await waitFor(`Boolean(document.querySelector('${trigger}'))`, 60000);
  check('已经进入画布视图（左栏「工作流节点」按钮在）', Boolean(canvasView));
  await sleep(600);

  if (canvasView) {
    // ---------------------------------------------------------------- ① 点它弹出的是面板，不是右键菜单
    const before = await evaluate(`(() => ({
      menus: document.querySelectorAll('[role="menu"]').length,
      panels: document.querySelectorAll('[data-fisherai-workflow-node-panel]').length,
    }))()`);
    check('点之前页面上没有工作流节点面板', before?.panels === 0, JSON.stringify(before));

    const clicked = await evaluate(`(() => {
      const button = document.querySelector('${trigger}');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), rect: [Math.round(rect.width), Math.round(rect.height)] };
    })()`);
    lines.push(`  点「工作流节点」按钮：${JSON.stringify(clicked)}`);

    const panelReady = await waitFor(
      'Boolean(document.querySelector(\'[data-fisherai-workflow-node-panel]\'))',
      15000,
    );
    check('真机点「工作流节点」能打开工作流节点面板', Boolean(panelReady));

    // 清单是异步拉的：等它落定（卡片出来 / 空态出来 / 报错出来）再量布局，
    // 否则量到的是「正在读取工作流清单…」那一帧（v1.28 第一次跑真机就踩了，误判成空态）。
    const listed = await waitFor(`(() => {
      const panel = document.querySelector('[data-fisherai-workflow-node-panel]');
      if (!panel) return null;
      const cards = panel.querySelectorAll('[data-fisherai-workflow-node-item]').length;
      const empty = Boolean(panel.querySelector('[data-fisherai-workflow-node-empty]'));
      const error = Boolean(panel.querySelector('[data-fisherai-workflow-node-error]'));
      return cards > 0 || empty || error ? { cards, empty, error } : null;
    })()`, 20000);
    lines.push(`  清单落定：${JSON.stringify(listed ?? null)}`);
    check(
      '工作流清单拉完了（卡片 / 空态 / 报错 三态之一）',
      Boolean(listed),
      JSON.stringify(listed ?? null),
    );
    await sleep(300);

    const layout = await evaluate(`(() => {
      const panel = document.querySelector('[data-fisherai-workflow-node-panel]');
      const cards = [...document.querySelectorAll('[data-fisherai-workflow-node-item]')];
      const first = cards[0];
      const cover = first?.querySelector('[data-fisherai-workflow-node-cover]');
      const coverRect = cover?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      const menu = [...document.querySelectorAll('[role="menu"]')].map((node) =>
        String(node.getAttribute('aria-label') || node.textContent || '').slice(0, 40),
      );
      return {
        panel: panelRect
          ? { w: Math.round(panelRect.width), h: Math.round(panelRect.height), left: Math.round(panelRect.left), top: Math.round(panelRect.top) }
          : null,
        label: panel?.getAttribute('aria-label') ?? null,
        role: panel?.getAttribute('role') ?? null,
        cards: cards.map((node) => ({
          id: node.getAttribute('data-fisherai-workflow-node-item'),
          state: node.getAttribute('data-fisherai-workflow-node-cover-state'),
          coverTag: node.querySelector('[data-fisherai-workflow-node-cover]')?.tagName ?? null,
          coverSrc: node.querySelector('[data-fisherai-workflow-node-cover]')?.getAttribute?.('src') ?? null,
        })),
        coverRect: coverRect ? { w: Math.round(coverRect.width), h: Math.round(coverRect.height) } : null,
        menus: menu,
        empty: Boolean(document.querySelector('[data-fisherai-workflow-node-empty]')),
      };
    })()`);
    check(
      '面板有真实尺寸（不是 0×0 的幽灵浮层）',
      Number(layout?.panel?.w ?? 0) > 300 && Number(layout?.panel?.h ?? 0) > 200,
      JSON.stringify(layout?.panel ?? null),
    );
    check(
      '★ 弹出的不是画布右键菜单（页面上没有任何 role=menu）',
      Array.isArray(layout?.menus) && layout.menus.length === 0,
      JSON.stringify(layout?.menus ?? null),
    );
    check(
      '面板是 role=dialog / aria-label=工作流节点',
      layout?.role === 'dialog' && layout?.label === '工作流节点',
      `${layout?.role} / ${layout?.label}`,
    );
    const cardCount = Array.isArray(layout?.cards) ? layout.cards.length : 0;
    check(
      cardCount
        ? `面板按卡片陈列配置好的工作流（真机 ${cardCount} 张）`
        : '工作流目录为空时面板给出空态（本机还没放工作流）',
      cardCount > 0 ? layout.empty === false : layout.empty === true,
      JSON.stringify(layout?.cards?.slice(0, 4) ?? null),
    );
    if (cardCount) {
      check(
        '卡片封面区有真高度（配图/占位能看见，不是压成一条线）',
        Number(layout?.coverRect?.h ?? 0) >= 40,
        JSON.stringify(layout?.coverRect ?? null),
      );
    }
    const shotA = await shot('workflow-nodes.png');
    lines.push(`  面板截图：${shotA}`);

    // ---------------------------------------------------------------- ② 配图能存能删（只在一份没配图的上面做）
    if (cardCount) {
      const targetCard = (layout.cards.find((entry) => entry.state === 'placeholder') ?? null);
      if (!targetCard) {
        lines.push('  所有工作流都已经配了图，跳过配图上传（不动用户的图）');
        check('配图上传（已配图则跳过）', true, 'skipped: all covered');
      } else {
        const roundTrip = await evaluate(`(async () => {
          const id = ${JSON.stringify(targetCard.id)};
          // 页面里画一张 320×180 的渐变图当配图（真机要看得见）
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          const ctx = canvas.getContext('2d');
          const gradient = ctx.createLinearGradient(0, 0, 320, 180);
          gradient.addColorStop(0, '#1e3a8a');
          gradient.addColorStop(1, '#22d3ee');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, 320, 180);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 26px sans-serif';
          ctx.fillText('AIFISHER', 90, 100);
          const dataUrl = canvas.toDataURL('image/png');
          const post = await fetch('/api/aifisher/canvas/workflow-covers/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl }),
          });
          const posted = await post.json().catch(() => ({}));
          const list = await fetch('/api/aifisher/canvas/workflow-covers').then((r) => r.json()).catch(() => ({}));
          return { status: post.status, posted, listCount: list?.count ?? null, dataUrlBytes: dataUrl.length };
        })()`);
        check(
          '真机上传配图成功（host 收下并落盘）',
          Number(roundTrip?.status) === 200 && roundTrip?.posted?.ok === true,
          `${roundTrip?.status} ${JSON.stringify(roundTrip?.posted ?? null).slice(0, 160)}`,
        );
        // 关掉面板再打开：让卡片重新拉一次清单，看的是「落盘之后的新状态」
        await evaluate(`(() => {
          document.querySelector('[aria-label="关闭工作流节点"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        })()`);
        await sleep(400);
        await evaluate(`(() => {
          document.querySelector('${trigger}')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        })()`);
        const covered = await waitFor(`(() => {
          const card = document.querySelector('[data-fisherai-workflow-node-item="${targetCard.id}"]');
          const img = card?.querySelector('[data-fisherai-workflow-node-cover]');
          return img && img.tagName === 'IMG' ? { src: img.getAttribute('src'), state: card.getAttribute('data-fisherai-workflow-node-cover-state') } : null;
        })()`, 15000);
        check(
          '卡片上的 <img> 指向刚上传的那张图（前端与 host 数据面对上）',
          Boolean(covered) && String(covered?.src ?? '').includes('/workflow-covers/file/'),
          JSON.stringify(covered ?? null),
        );
        const loaded = await evaluate(`(async () => {
          const card = document.querySelector('[data-fisherai-workflow-node-item="${targetCard.id}"]');
          const img = card?.querySelector('[data-fisherai-workflow-node-cover]');
          if (!img) return null;
          if (img.complete) return { w: img.naturalWidth, h: img.naturalHeight };
          await new Promise((done) => { img.onload = done; img.onerror = done; setTimeout(done, 4000); });
          return { w: img.naturalWidth, h: img.naturalHeight };
        })()`);
        check(
          '这张图在浏览器里真的解码出来了（不是 404 的破图）',
          Number(loaded?.w ?? 0) > 0 && Number(loaded?.h ?? 0) > 0,
          JSON.stringify(loaded ?? null),
        );
        const shotB = await shot('workflow-nodes-cover.png');
        lines.push(`  配图后截图：${shotB}`);

        const cleanup = await evaluate(`(async () => {
          const id = ${JSON.stringify(targetCard.id)};
          const del = await fetch('/api/aifisher/canvas/workflow-covers/' + encodeURIComponent(id), { method: 'DELETE' });
          const body = await del.json().catch(() => ({}));
          const list = await fetch('/api/aifisher/canvas/workflow-covers').then((r) => r.json()).catch(() => ({}));
          return { status: del.status, removed: body?.removed ?? null, listCount: list?.count ?? null };
        })()`);
        check(
          '验收结束把配图删掉、还原成原来的样子',
          Number(cleanup?.status) === 200 && cleanup?.listCount === 0,
          JSON.stringify(cleanup ?? null),
        );
      }
    }

    const errors = await evaluate(`(() => {
      const panel = document.querySelector('[data-fisherai-workflow-node-panel]');
      return panel ? String(panel.querySelector('[data-fisherai-workflow-node-error]')?.textContent || '') : '';
    })()`);
    check('面板里没有报错提示条', !String(errors ?? '').trim(), String(errors ?? ''));
  }

  lines.push('');
  const pass = lines.filter((line) => line.startsWith('PASS')).length;
  lines.push(`SUMMARY pass=${pass} fail=${failures}`);
  console.log(lines.join('\n'));
} catch (error) {
  console.log(lines.join('\n'));
  console.error('\nUNCAUGHT', error);
  failures += 1;
} finally {
  if (!KEEP) {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  }
  try {
    page?.close();
  } catch {
    /* already closed */
  }
  chrome.kill();
  process.exit(failures === 0 ? 0 : 1);
}
