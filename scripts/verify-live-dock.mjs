/**
 * 真机验收：画布面板右侧的「DSH 原生会话栏」到底渲染出来了没有。
 *
 * 为什么需要它（而不是 jsdom 那套）：本功能的关键假设全都只在**真 DSH 内核**里才成立 ——
 *   1. `main` 是 keyed 槽位，条目声明 children（`aifisher-canvas.chat`, session-maybe）后，
 *      宿主会不会真的按会话作用域给标准 props；
 *   2. `renderFactorySlot('conversation.content', …)` 的 embedded occurrence 在
 *      **主对话面板没有被挂载**（main 显示的是画布）时是否照样活着；
 *   3. 原生会话的正文/composer 是真 DOM 元素（`[data-conversation-content]`、
 *      `[data-conversation-scroll]`、可编辑 composer），jsdom 里验不了。
 *
 * 做法：headless Chrome + CDP（Node 22 自带 WebSocket，不引依赖）打开**正在跑的** DSH 页面，
 * 点侧边栏「无限画布」，然后按 DOM 标记断言 + 截图。
 *
 * 用法：node scripts/verify-live-dock.mjs [baseUrl] [--keep]
 *   默认 baseUrl = http://127.0.0.1:19387 （桌面端）
 *   --keep 不删临时 Chrome 用户目录（排查用）
 *
 * 注意：这是**只读**验收 —— 只点面板、不发送消息、不改画布内容。
 * 若页面需要 cookie/未授权，脚本会把body 片段打出来并如实报 FAIL。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:19387';
const KEEP = process.argv.includes('--keep');
/** --dump：额外打印槽位锚点与控制台（诊断「条目没落地」这类问题用）。 */
const DUMP = process.argv.includes('--dump');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9333);
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
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-dock-'));
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
    /** 控制台/日志事件（诊断模式用：插件注册失败的 console.error 会出现在这里）。 */
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
    ws.addEventListener('error', (error) => rej(error));
    ws.addEventListener('open', () =>
      res({
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
  // 先开一个空白页再装授权 cookie，最后才导航：DSH 的 web 服务现在要求浏览器会话 cookie
  // （第一次访问得带 `dsh web` 打印的 `?token=`，那个令牌只在进程内存里）。
  // 这里用本机自己的签名密钥给自己签一个（见 scripts/lib/dsh-live-auth.mjs），拿不到就如实报 FAIL。
  const created = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  const auth = localAuthCookie({ url: BASE });
  if (auth) {
    await installAuthCookie(page.send, auth);
  } else {
    lines.push('  警告：没有拿到本机授权 cookie（DSH_HOME/.credentials.yaml 里没有 browser-session 密钥）');
  }
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

  const waitFor = async (expression, timeoutMs = 30000, label = expression) => {
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

  /**
   * 关掉首访模态框。
   *
   * 全新浏览器 profile 第一次打开会弹 DSH 自己的「预览版说明」（`role=dialog[aria-modal]` +
   * 全屏 `_mask_`，`z-index:1000`）。它会把整个应用盖住：合成 MouseEvent 能穿透（我们是直接
   * dispatch 的），但 **CDP 的真滚轮事件到不了会话栏** —— 这条曾经让滚动断言假红过一次。
   * 所以像用户一样把它点掉：优先点主按钮，没有就点最后一个按钮。
   */
  const dismissStartupDialogs = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await evaluate(`(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
          .find((node) => node.getBoundingClientRect().width > 0);
        if (!dialog) return null;
        const buttons = [...dialog.querySelectorAll('button')];
        const primary = buttons.find((button) => String(button.className).includes('_primary_')) ?? buttons[buttons.length - 1];
        const label = (primary?.innerText || '').trim();
        const labels = buttons.map((button) => (button.innerText || '').trim()).join('|');
        primary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { label, labels };
      })()`);
      if (!result) return null;
      lines.push(`  关掉启动模态框：「${result.label || '(无按钮)'}」  [${result.labels}]`);
      await sleep(500);
    }
    return true;
  };

  // ---------------------------------------------------------------- 页面能进得来吗
  const title = await waitFor('document.title || null', 30000, 'document.title');
  const booted = await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]") || document.querySelector("aside, .dsw-sidebar, [class*=sidebar]"))',
    45000,
    'boot',
  );
  check('DSH 页面在外部浏览器里能打开', Boolean(title), String(title ?? '(none)'));
  check('界面已经启动（能找到侧边栏/面板入口）', Boolean(booted), String(booted));

  if (!booted) {
    const body = await evaluate('document.body ? document.body.innerText.slice(0, 400) : ""');
    lines.push(`  页面正文片段：${String(body).replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  await dismissStartupDialogs();
  const modalLeft = await evaluate(
    'Boolean([...document.querySelectorAll(\'[role="dialog"][aria-modal="true"]\')].find((node) => node.getBoundingClientRect().width > 0))',
  );
  check('启动模态框已关掉（它会盖住整个应用、让真滚轮事件到不了会话栏）', modalLeft === false, String(modalLeft));

  // ---------------------------------------------------------------- 打开画布面板
  const entryFound = await evaluate('Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))');
  check('侧边栏有「无限画布」入口', Boolean(entryFound));

  if (entryFound) {
    const clicked = await evaluate(`(() => {
      const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
      const clickable = icon.closest('button, [role="button"], a, li') ?? icon;
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    check('点了「无限画布」入口', Boolean(clicked));

    const shell = await waitFor('Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))', 45000, 'shell');
    check('画布面板外壳挂上了（main key=aifisher-canvas 生效）', Boolean(shell));
    await sleep(2500);

    const dock = await evaluate('Boolean(document.querySelector("[data-dsh-aifisher-chat=\\"dock\\"]"))');
    check('右侧会话栏（dock）渲染出来了', Boolean(dock));

    const notice = await evaluate(
      '(document.querySelector("[data-dsh-aifisher-chat=\\"notice\\"]")?.innerText ?? "").slice(0, 120)',
    );
    const sessionId = await evaluate(
      'document.querySelector("[data-conversation-content]")?.getAttribute("data-conversation-session") ?? null',
    );
    const conversationBody = await evaluate('Boolean(document.querySelector("[data-conversation-content]"))');
    const scrollBody = await evaluate('Boolean(document.querySelector("[data-conversation-scroll]"))');
    const composer = await evaluate(
      'Boolean(document.querySelector("[data-conversation-content] [contenteditable=\\"true\\"]") || document.querySelector("[data-slot=\\"conversation.composer\\"]"))',
    );
    const collapse = await evaluate('Boolean(document.querySelector("[data-dsh-aifisher-chat=\\"collapse\\"]"))');
    const suppress = await evaluate(
      'Boolean(document.querySelector(\'style[data-dsh-aifisher-canvas="agent-suppress"]\'))',
    );
    const vendorLauncherVisible = await evaluate(`(() => {
      const el = document.querySelector('[data-fisherai-agent-launcher]');
      if (!el) return 'absent';
      const style = getComputedStyle(el);
      return style.display === 'none' ? 'hidden' : 'visible';
    })()`);

    check('会话栏里是内核的原生会话正文（[data-conversation-content]）', Boolean(conversationBody), `sessionId=${sessionId ?? 'none'}`);
    check('原生会话的滚动正文在位（[data-conversation-scroll]）', Boolean(scrollBody));
    check('原生 composer 在位（可编辑输入区）', Boolean(composer));
    check('会话栏有收起按钮', Boolean(collapse));
    check('vendor 自带对话面板被作用域 CSS 压掉', Boolean(suppress) && vendorLauncherVisible !== 'visible', `launcher=${vendorLauncherVisible}`);
    if (!conversationBody) {
      lines.push(`  dock 提示文案：${String(notice).replace(/\s+/g, ' ')}`);
    }

    // 排布：画布区 + 会话栏并排（会话栏在右）
    const geometry = await evaluate(`(() => {
      const canvasArea = document.querySelector('[data-dsh-aifisher-canvas="canvas-area"]');
      const column = document.querySelector('[data-dsh-aifisher-canvas="chat-column"]');
      if (!canvasArea || !column) return null;
      const a = canvasArea.getBoundingClientRect();
      const b = column.getBoundingClientRect();
      return { canvasWidth: Math.round(a.width), chatWidth: Math.round(b.width), chatLeft: Math.round(b.left), canvasRight: Math.round(a.right) };
    })()`);
    check(
      '画布与会话栏并排（会话栏在画布右侧）',
      Boolean(geometry) && geometry.canvasWidth > 200 && geometry.chatWidth >= 300 && geometry.chatLeft >= geometry.canvasRight - 2,
      JSON.stringify(geometry),
    );

    // ---------------------------------------------------------------- 新对话输入区贴底（v1.41）
    //
    // 用户 2026-10-18 原话：「右侧聊天面板新对话默认会顶头不好看，希望移动到最地下」。
    // 空白会话的内核行为是「正文 View 返回 null」，滚动区里只剩一个 flex:none 的 composerSeat，
    // 所以本栏补了一条 `margin-top:auto`（见 src/client/CanvasChatDock.tsx 的 COMPOSER_BOTTOM_CSS）。
    //
    // jsdom 量不了布局，这里在**真页面**上做 A/B：用正在显示的那条会话的真实 class 搭一个
    // 520px 高的空白会话骨架（只补高度，结构与 class 全是真的），然后
    //   ① 带本栏样式 → 输入区贴底；
    //   ② 临时摘掉 `style[data-dsh-aifisher-canvas="dock-layout"]` → 复现「顶头」（证明是这条规则起作用）；
    //   ③ 再加回去 → 贴底恢复（脚本自己收尾，页面不会缺样式）。
    const dockLayoutSelector = 'style[data-dsh-aifisher-canvas="dock-layout"]';
    const skeleton = await evaluate(`(() => {
      const body = document.querySelector('[data-dsh-aifisher-chat="body"]');
      const real = body?.querySelector('[data-conversation-content]');
      const realScroll = real?.querySelector('[data-conversation-scroll]');
      const realSeat = real?.querySelector('[data-composer-seat]');
      if (!body || !real || !realScroll || !realSeat) return { ok: false, reason: 'dock skeleton missing' };
      document.querySelector('[data-composer-probe]')?.remove();
      const host = document.createElement('div');
      host.setAttribute('data-composer-probe', '1');
      // flex:none 必须内联：本栏那条「> *:has([data-conversation-content])」会把它拉成 flex:1，
      // 内联样式优先级更高，才能让它老老实实占 520px（量的是骨架内部，不跟真会话抢高度）。
      host.style.cssText = 'height:520px;flex:none;min-height:0;display:flex;flex-direction:column;';
      const content = document.createElement('div');
      content.className = real.className;
      content.setAttribute('data-conversation-content', '');
      content.setAttribute('data-content-phase', 'active');
      const scroll = document.createElement('div');
      scroll.className = realScroll.className;
      scroll.setAttribute('data-conversation-scroll', '');
      const seat = document.createElement('div');
      seat.className = realSeat.className;
      seat.setAttribute('data-composer-seat', '');
      seat.setAttribute('data-composer-probe-seat', '');
      seat.innerHTML = '<div style="height:56px"></div>';
      scroll.appendChild(seat);
      content.appendChild(scroll);
      host.appendChild(content);
      body.appendChild(host);
      return { ok: true, contentClass: real.className, scrollClass: realScroll.className, seatClass: realSeat.className };
    })()`);
    const measureComposer = () =>
      evaluate(`(() => {
        const host = document.querySelector('[data-composer-probe]');
        const scroll = host?.querySelector('[data-conversation-scroll]');
        const seat = host?.querySelector('[data-composer-probe-seat]');
        if (!host || !scroll || !seat) return null;
        const h = host.getBoundingClientRect();
        const c = scroll.getBoundingClientRect();
        const s = seat.getBoundingClientRect();
        return {
          hostHeight: Math.round(h.height),
          scrollTop: Math.round(c.top),
          scrollBottom: Math.round(c.bottom),
          seatTop: Math.round(s.top),
          seatBottom: Math.round(s.bottom),
          marginTop: getComputedStyle(seat).marginTop,
        };
      })()`);
    check('能搭出「空白会话」骨架（结构与 class 取自真会话）', skeleton?.ok === true, JSON.stringify(skeleton));
    if (skeleton?.ok) {
      await sleep(350);
      const withRule = await measureComposer();
      check(
        '新对话：输入区贴在会话栏底部（seat 底边 = 滚动区底边，上方留白 ≥ 300px）',
        Boolean(withRule) &&
          Math.abs(withRule.seatBottom - withRule.scrollBottom) <= 2 &&
          withRule.seatTop - withRule.scrollTop >= 300,
        JSON.stringify(withRule),
      );
      const removedCss = await evaluate(`(() => {
        const style = document.querySelector('${dockLayoutSelector}');
        const css = style?.textContent ?? '';
        style?.remove();
        return css;
      })()`);
      await sleep(350);
      const withoutRule = await measureComposer();
      check(
        '对照：摘掉本栏样式后输入区又顶到滚动区顶部（复现用户报的「顶头」）',
        Boolean(withoutRule) && withoutRule.seatTop - withoutRule.scrollTop <= 4,
        JSON.stringify(withoutRule),
      );
      await evaluate(`(() => {
        if (document.querySelector('${dockLayoutSelector}')) return true;
        const style = document.createElement('style');
        style.setAttribute('data-dsh-aifisher-canvas', 'dock-layout');
        style.textContent = ${JSON.stringify(String(removedCss ?? ''))};
        document.head.appendChild(style);
        return true;
      })()`);
      await sleep(350);
      const restored = await measureComposer();
      check(
        '把本栏样式加回去贴底恢复（修的就是这条规则）',
        Boolean(restored) && Math.abs(restored.seatBottom - restored.scrollBottom) <= 2,
        JSON.stringify(restored),
      );
      await evaluate('document.querySelector("[data-composer-probe]")?.remove()');
    }

    // ---------------------------------------------------------------- 会话栏的滚动契约
    //
    // 2026-10-16 用户报障「画布侧边对话区域鼠标滚轮滚不动」修出来的一组断言。根因是
    // dock 的正文容器是 display:block，内核会话的 `.body{flex:1 1 0%}` 失效 → 会话被内容撑高、
    // 内层滚动容器永远不溢出（真机量到塞 3000px 撑杆后 clientHeight 与 scrollHeight 同步长到 3768/3768）。
    // 所以这里钉两条：
    //   A. 滚动容器必须**有界**（高度跟着父级，不被内容撑高）；
    //   B. 内容超过容器时，**真滚轮**必须滚得动（用 CDP 的 Input.dispatchMouseEvent 发真事件）。
    // 之所以塞撑杆：真机上的会话可能很短，内容不足一屏时 sh==ch 是正常的 —— 撑杆把
    // 「有没有溢出」与「滚轮能不能用」解耦，任何长度的会话都能验。
    const SPACER = '[data-wheel-probe-spacer]';
    const dockScroller = '[data-dsh-aifisher-chat="body"] [data-conversation-scroll]';

    const assertDockScroll = async (label) => {
      // 先量一次「**真实**会话里空白会话的输入区」—— 撑杆一插进去就看不到贴底了（内容溢出后
      // auto 外边距解析成 0），所以必须在插撑杆之前量。空白会话的判据：滚动区里只有
      // composerSeat 一个孩子（内核在空白会话里不渲 Views）。
      const realComposer = await evaluate(`(() => {
        const scroller = document.querySelector('${dockScroller}');
        const seat = scroller?.querySelector('[data-composer-seat]');
        if (!scroller || !seat) return null;
        const c = scroller.getBoundingClientRect();
        const s = seat.getBoundingClientRect();
        return {
          // 判据只用「滚动区里有几个孩子」：空白会话内核不渲 Views，只剩 composerSeat 一个。
          blank: scroller.children.length === 1,
          children: scroller.children.length,
          clientHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          scrollTop: Math.round(c.top),
          scrollBottom: Math.round(c.bottom),
          seatTop: Math.round(s.top),
          seatBottom: Math.round(s.bottom),
          marginTop: getComputedStyle(seat).marginTop,
        };
      })()`);
      // 内容不满一屏（没有溢出）时，输入区必须贴底 —— 这正是「新对话一打开」的样子；
      // 正文长到溢出时不判（那时粘底由内核的 sticky 负责，用户滚到哪算哪）。
      const noOverflow =
        Boolean(realComposer) && realComposer.scrollHeight <= realComposer.clientHeight + 2;
      check(
        `${label}：内容不满一屏时**真实的**输入区贴底（seat 底边 = 滚动区底边）`,
        Boolean(realComposer) &&
          (!noOverflow || Math.abs(realComposer.seatBottom - realComposer.scrollBottom) <= 2),
        JSON.stringify(realComposer),
      );
      const added = await evaluate(`(() => {
        const scroller = document.querySelector('${dockScroller}');
        if (!scroller) return false;
        const spacer = document.createElement('div');
        spacer.setAttribute('data-wheel-probe-spacer', '1');
        spacer.style.cssText = 'height:3000px;flex:none;';
        scroller.appendChild(spacer);
        return true;
      })()`);
      if (!added) {
        check(`${label}：找到 dock 的滚动容器`, false);
        return;
      }
      await sleep(250);
      const bounds = await evaluate(`(() => {
        const body = document.querySelector('[data-dsh-aifisher-chat="body"]');
        const scroller = document.querySelector('${dockScroller}');
        const composer = scroller.querySelector('[data-composer-seat]');
        const bodyRect = body.getBoundingClientRect();
        const rect = scroller.getBoundingClientRect();
        return {
          bodyHeight: Math.round(bodyRect.height),
          bodyBottom: Math.round(bodyRect.bottom),
          scrollerHeight: Math.round(rect.height),
          scrollerTop: Math.round(rect.top),
          clientHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
          composerBottom: composer ? Math.round(composer.getBoundingClientRect().bottom) : null,
        };
      })()`);
      check(
        `${label}：内层滚动容器是有界的（撑杆后没有被内容撑高）`,
        Boolean(bounds) && bounds.scrollerHeight <= bounds.bodyHeight + 2 && bounds.scrollHeight > bounds.clientHeight + 1000,
        JSON.stringify(bounds),
      );
      check(
        `${label}：输入区（composer）没被裁掉`,
        Boolean(bounds) && (bounds.composerBottom === null || bounds.composerBottom <= bounds.bodyBottom + 2),
        `composerBottom=${bounds?.composerBottom} bodyBottom=${bounds?.bodyBottom}`,
      );

      await evaluate(`(() => {
        const scroller = document.querySelector('${dockScroller}');
        if (scroller) scroller.scrollTop = 0;
        return true;
      })()`);
      const wheelX = Math.round(
        await evaluate(`(() => {
          const rect = document.querySelector('${dockScroller}').getBoundingClientRect();
          return rect.left + rect.width / 2;
        })()`),
      );
      // 先确认落点真的在会话栏里：有遮挡层（DSH 自己的首访/重连「预览版说明」模态框）
      // 时真滚轮事件到不了滚动容器，这一场就要判成「探针被挡住」而不是「滚不动」。
      // 那个模态框会在客户端重连后再弹一次，所以这里「关掉 → 再验落点」循环几轮。
      let landing = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        landing = await evaluate(`(() => {
          const scroller = document.querySelector('${dockScroller}');
          const hit = document.elementFromPoint(${wheelX}, ${bounds.scrollerTop + 120});
          return {
            inside: Boolean(hit && scroller.contains(hit)),
            hit: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className || '').slice(0, 40) : null,
          };
        })()`);
        if (landing?.inside) break;
        await dismissStartupDialogs();
        await sleep(700);
      }
      check(
        `${label}：滚轮落点在会话栏内（没有被遮挡层盖住）`,
        landing?.inside === true,
        JSON.stringify(landing),
      );
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: wheelX,
        y: bounds.scrollerTop + 120,
        deltaX: 0,
        deltaY: 300,
        button: 'none',
        clickCount: 0,
      });
      await sleep(400);
      const scrolled = await evaluate(`(() => {
        const scroller = document.querySelector('${dockScroller}');
        return scroller ? scroller.scrollTop : null;
      })()`);
      check(`${label}：真滚轮滚得动（scrollTop > 0）`, typeof scrolled === 'number' && scrolled > 0, `scrollTop=${scrolled}`);

      await evaluate(`(() => {
        document.querySelectorAll('${SPACER}').forEach((node) => node.remove());
        return true;
      })()`);
    };

    await assertDockScroll('dock（刚打开）');

    // ---------------------------------------------------------------- 非空会话：真聊天正文
    //
    // 空白会话的 View 本来就返回 null（内核行为：blank 会话渲染 Hero 而不是 transcript），
    // 所以「右栏能渲染真正文」必须在**有内容的会话**上验：侧边栏行是
    // `[data-row-key="session:<id>"]`（工作区行是 `workspace:<id>`），点一行即可切会话。
    const readContentSessionRow = () =>
      evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
        const row = rows.find((candidate) => !/新会话|New chat/i.test(candidate.innerText));
        return row ? row.getAttribute('data-row-key') : null;
      })()`);

    // 侧边栏的会话行只在「所在工作区展开」时才有；面板切换后列表可能还没重排，
    // 所以这里轮询几次，中途最多点一次工作区行尝试展开，再放弃（这时按「没有可切会话」处理）。
    let contentSession = await readContentSessionRow();
    let expandedOnce = false;
    for (let attempt = 0; !contentSession && attempt < 8; attempt += 1) {
      if (!expandedOnce && attempt === 2) {
        expandedOnce = true;
        await evaluate(`(() => {
          const row = document.querySelector('[data-row-key^="workspace:"]');
          if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        })()`);
      }
      await sleep(1000);
      contentSession = await readContentSessionRow();
    }
    if (contentSession) {
      await evaluate(`(() => {
        const row = document.querySelector('[data-row-key="${contentSession}"]');
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await sleep(3500);
      // 注意：在侧边栏点会话会让主区回到 Conversation（DSH 既有行为，activePanelId → null），
      // 所以要**重新点回画布面板**，否则下面量到的 `[data-chat-flow]` 来自主对话区而不是 dock。
      await evaluate(`(() => {
        const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
        (icon.closest('button, [role="button"], a, li') ?? icon).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await waitFor('Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))', 30000, 'shell-again');
      await sleep(3500);

      // 断言一律**限定在 dock 内部**（`[data-dsh-aifisher-chat="body"]`）：全局查询会撞上主对话区。
      const scoped = await evaluate(`(() => {
        const body = document.querySelector('[data-dsh-aifisher-chat="body"]');
        return {
          hasBody: Boolean(body),
          view: Boolean(body?.querySelector('[data-slot="conversation.view"]')),
          flow: Boolean(body?.querySelector('[data-chat-flow]')),
          nodes: body ? body.querySelectorAll('[data-chat-flow-key]').length : 0,
          session: body?.querySelector('[data-conversation-content]')?.getAttribute('data-conversation-session') ?? null,
        };
      })()`);
      check(
        '切到有内容的会话后，dock 内部渲染出真聊天正文（conversation.view + data-chat-flow 节点）',
        Boolean(scoped?.hasBody && scoped.view && scoped.flow && scoped.nodes > 0),
        JSON.stringify(scoped),
      );
      // 有正文（而且正文比一屏长）时再验一次滚动契约：这一场才是用户报障的真实场景。
      await assertDockScroll('dock（有正文时）');
    } else {
      lines.push('  说明：这个实例里没有「有内容的会话」可切，跳过真正文断言（空白会话不渲染 transcript 是内核行为）');
    }

    lines.push('');
    lines.push(`  几何：${JSON.stringify(geometry)}`);
    lines.push(`  会话 id：${sessionId ?? '(未选中会话)'}`);

    if (DUMP) {
      const slots = await evaluate(
        '[...document.querySelectorAll("[data-slot]")].map((e) => `${e.getAttribute("data-slot")}#${e.children.length}`).join(", ")',
      );
      const chatAnchor = await evaluate(
        'document.querySelector(\'[data-slot="aifisher-canvas.chat"]\')?.outerHTML.slice(0, 300) ?? "(no anchor)"',
      );
      const deadCells = await evaluate(
        '[...document.querySelectorAll("[data-slot-error]")].map((e) => e.getAttribute("data-slot-error")).join(", ")',
      );
      const scrollHtml = await evaluate(
        'document.querySelector("[data-conversation-scroll]")?.innerHTML.replace(/\\s+/g, " ").slice(0, 400) ?? "(no scroll body)"',
      );
      /** 侧边栏里「会话行」用什么 data 属性标注（要程序化选一个会话时用）。 */
      const sidebarHints = await evaluate(`(() => {
        const seen = new Set();
        const out = [];
        for (const el of document.querySelectorAll('[data-slot="sidebar.workspaces"] *')) {
          for (const attribute of el.attributes) {
            if (!attribute.name.startsWith('data-') || seen.has(attribute.name)) continue;
            seen.add(attribute.name);
            out.push(attribute.name + ' @ ' + el.tagName + '.' + String(el.className || '').slice(0, 30));
          }
        }
        return out.slice(0, 24).join(' | ');
      })()`);
      const consoleLines = page.events
        .map((event) => {
          if (event.method === 'Runtime.consoleAPICalled') {
            const args = (event.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
            return `[console.${event.params.type}] ${args}`;
          }
          return `[log.${event.params.entry?.level}] ${event.params.entry?.text ?? ''}`;
        })
        .filter((line) => line.trim().length > 0);
      lines.push('');
      lines.push('  ── 诊断 ──');
      lines.push(`  slot 锚点：#${String(slots).slice(0, 900)}`);
      lines.push(`  aifisher-canvas.chat 锚点：${String(chatAnchor).replace(/\s+/g, ' ').slice(0, 300)}`);
      lines.push(`  死格子（data-slot-error）：${String(deadCells) || '(none)'}`);
      lines.push(`  会话正文区：${String(scrollHtml).slice(0, 300)}`);
      lines.push(`  侧边栏会话行属性：${String(sidebarHints).slice(0, 400)}`);
      lines.push(`  控制台（末 25 条）：`);
      for (const line of consoleLines.slice(-25)) lines.push(`    ${line.slice(0, 300)}`);
    }

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const shotPath = join(SHOTS, 'dock-live.png');
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    lines.push(`  截图：${shotPath}`);
  }
} catch (error) {
  check('真机验收脚本跑通', false, error.message);
} finally {
  page?.close();
  try {
    chrome.kill();
  } catch {
    /* 已经退了 */
  }
  if (!KEEP) {
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  }
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
