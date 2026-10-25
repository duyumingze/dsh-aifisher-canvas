/**
 * 真机验收：画布里换会话 / 新建会话，主面板必须留在画布（v1.62）。
 *
 * 注意：本脚本会**改动当前会话** —— 先切到「优化v10提示词使动画流畅」，再点「＋」回到一个空白会话。
 * 不创建新会话（命中工作区已有的空白就复用），但跑之前请知道它会换掉当前会话。
 *
 * 背景：用户 2026-10-21 原话「我在画布想要新开一个对话的时候它会退出画布，能不能想个方法能快速切换」。
 * 根因是 DSH 的导航语义（侧边栏新会话/点会话 → replaceMain(…,'reveal') → selectPanel(null)），
 * 插件在会话栏里做等价切换：uiWorkspace.openSession + 同一 tick 把面板切回画布。
 *
 * 本脚本在**正在跑的** DSH 页面里真的点一次「＋ 新建会话」和一次会话行，断言：
 *   1. 动作前后画布外壳/画布区一直在（没有退出画布）；
 *   2. 新建后会话栏标题变成「新会话」（确实切到了新会话）；
 *   3. 从会话列表里点回原会话，标题回到原标题，画布还在。
 *
 * 用法：node .dsh-tmp/verify-live-session-switch.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:1278';
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9455);
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => existsSync(candidate));
if (!CHROME) throw new Error('没找到 Chrome / Edge');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const profile = mkdtempSync(join(tmpdir(), 'dsh-live-switch-'));
const chrome = spawn(
  CHROME,
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
  return new Promise((resolveConnect, rejectConnect) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
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
      } else if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded') {
        events.push(message);
      }
    });
    ws.addEventListener('error', rejectConnect);
    ws.addEventListener('open', () =>
      resolveConnect({
        events,
        send(method, params = {}) {
          return new Promise((resolveCall, rejectCall) => {
            const callId = ++id;
            pending.set(callId, (message) =>
              message.error ? rejectCall(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolveCall(message.result),
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
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate 失败');
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
    return last;
  };

  // 关掉首访模态框（同 verify-live-dock 的理由：它会盖住整个应用）
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dismissed = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .find((node) => node.getBoundingClientRect().width > 0);
      if (!dialog) return null;
      const buttons = [...dialog.querySelectorAll('button')];
      const primary = buttons.find((button) => String(button.className).includes('_primary_')) ?? buttons[buttons.length - 1];
      primary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return (primary?.innerText || '').trim();
    })()`);
    if (!dismissed) break;
    lines.push(`  关掉启动模态框：「${dismissed}」`);
    await sleep(500);
  }

  await waitFor('Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))', 45000);
  const opened = await evaluate(`(() => {
    const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
    if (!icon) return false;
    (icon.closest('button, [role="button"], a, li') ?? icon).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  check('侧边栏「无限画布」入口可点', opened === true);

  const shellReady = await waitFor('Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"] [data-dsh-aifisher-chat=\\"dock\\"]"))', 45000);
  check('画布外壳 + 会话栏挂上了', Boolean(shellReady));
  await sleep(2500);

  const state = () =>
    evaluate(`(() => {
      const trigger = document.querySelector('[data-dsh-aifisher-chat="session-menu-trigger"]');
      const canvasArea = document.querySelector('[data-dsh-aifisher-canvas="canvas-area"]');
      const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
      const menu = document.querySelector('[data-dsh-aifisher-chat="session-menu"]');
      return {
        dock: Boolean(dock),
        sessionId: dock?.getAttribute('data-dsh-aifisher-session') ?? null,
        title: (trigger?.innerText || '').trim(),
        triggerDisabled: trigger?.disabled === true,
        canvas: Boolean(canvasArea) && canvasArea.getBoundingClientRect().width > 100,
        conversation: Boolean(document.querySelector('[data-dsh-aifisher-chat="body"] [data-conversation-content]')),
        menu: Boolean(menu),
        menuText: (menu?.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
        error: (document.querySelector('[data-dsh-aifisher-chat="session-error"]')?.innerText || '').trim(),
        exitButton: Boolean(document.querySelector('[data-dsh-aifisher-exit]')),
        rows: [...document.querySelectorAll('[data-dsh-aifisher-chat="session-row"]')].map((node) => ({
          id: node.getAttribute('data-session-id'),
          title: (node.innerText || '').trim(),
          current: node.getAttribute('data-current') === 'true',
        })),
      };
    })()`);

  const click = (selector) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);

  /** 行 innerText 是「标题 + 换行 + 时间」，去掉末尾时间再比对。 */
  const cleanTitle = (text) => String(text).replace(/\s+\d{1,2}(:\d{2}|\/\d{1,2})$/, '').trim();
  const rowsMatch = (rows, title) => rows.some((row) => cleanTitle(row.title) === title);

  const before = await state();
  check('会话栏头部有切换触发器 + 「新建会话」按钮', before.dock && !before.triggerDisabled && (await evaluate('Boolean(document.querySelector(\'[data-dsh-aifisher-chat="session-new"]\'))')));
  check('切换触发器显示当前会话标题', Boolean(before.title), before.title);
  check('画布区在场', before.canvas);
  check('原生会话正文在场', before.conversation);
  check('画布面板有退出按钮（layout 服务解析成功）', before.exitButton === true);
  const initialSession = before.sessionId;
  check('会话栏标出了当前会话 id（排障/回归钩子）', Boolean(initialSession), String(initialSession));

  // ---- 1) 换到一个标题唯一的普通会话：必须留在画布 ----
  check('点标题打开会话列表', (await click('[data-dsh-aifisher-chat="session-menu-trigger"]')) === true);
  await sleep(500);
  const menuState = await state();
  check('会话列表弹出来了', menuState.menu && menuState.rows.length > 0, `${menuState.rows.length} 行`);
  check('列表里当前会话被标出', menuState.rows.some((row) => row.current && row.id === initialSession), JSON.stringify(menuState.rows.filter((row) => row.current)));

  const distinctRow = menuState.rows.find((row) => cleanTitle(row.title) === '优化v10提示词使动画流畅' && row.id !== initialSession);
  const picked = distinctRow
    ? await evaluate(`(() => {
        const row = document.querySelector('[data-dsh-aifisher-chat="session-row"][data-session-id="' + ${JSON.stringify(distinctRow.id)} + '"]');
        if (!row) return false;
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`)
    : false;
  check('点另一个会话那一行', picked === true, distinctRow?.id ?? '(没找到唯一标题的会话)');
  await sleep(3500);
  const afterSwitch = await state();
  check('切换后仍在画布（画布外壳/画布区没有消失）', afterSwitch.canvas && afterSwitch.dock, `canvas=${afterSwitch.canvas} dock=${afterSwitch.dock}`);
  check('切换后会话栏真的换到了那一行', afterSwitch.sessionId === distinctRow?.id, `${afterSwitch.sessionId} vs ${distinctRow?.id}`);
  check('切换后标题跟着变', cleanTitle(afterSwitch.title) === '优化v10提示词使动画流畅', afterSwitch.title);

  // ---- 2) ＋ 新建会话：必须留在画布，且切到一个空白会话 ----
  check('点「＋ 新建会话」', (await click('[data-dsh-aifisher-chat="session-new"]')) === true);
  await sleep(4000);
  const afterCreate = await state();
  lines.push(`  诊断（新建后）：${JSON.stringify(afterCreate).slice(0, 700)}`);
  check('新建后仍在画布（画布外壳/画布区没有消失）', afterCreate.canvas && afterCreate.dock, `canvas=${afterCreate.canvas} dock=${afterCreate.dock}`);
  check('新建后会话栏切到了另一个会话', afterCreate.sessionId !== distinctRow?.id && Boolean(afterCreate.sessionId), `${distinctRow?.id} -> ${afterCreate.sessionId}`);
  check('新建后标题显示「新会话」（空白会话不再显示工作区目录名）', afterCreate.title === '新会话', afterCreate.title);
  check('新会话的原生输入区在场', afterCreate.conversation);

  lines.push('');
  lines.push(`SUMMARY pass=${lines.filter((line) => line.startsWith('PASS')).length} fail=${failures}`);
  const consoleTail = (page?.events ?? [])
    .slice(-40)
    .map((event) => {
      const text = event.params?.args?.map((arg) => arg.value ?? arg.description ?? '').join(' ') ?? event.params?.entry?.text ?? '';
      return String(text).slice(0, 240);
    })
    .filter(Boolean);
  const dbg = consoleTail.filter((line) => line.includes('[dbg]') || line.includes('aifisher-canvas] 画布内'));
  if (dbg.length) lines.push(`调试：\n  ${dbg.join('\n  ')}`);
  if (consoleTail.length) lines.push(`控制台尾：\n  ${consoleTail.slice(-10).join('\n  ')}`);
  console.log(lines.join('\n'));
} finally {
  try {
    page?.close();
  } catch {
    /* ignore */
  }
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome 还占着就下次再清 */
  }
}

process.exit(failures === 0 ? 0 : 1);
