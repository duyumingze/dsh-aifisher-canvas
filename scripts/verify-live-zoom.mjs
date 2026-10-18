/**
 * 真机验收：画布左下缩放条里的**缩放滑杆**（滑轮）到底能不能拖。
 *
 * 为什么需要它（而不是 jsdom 那套 test-canvas-shadcn-ui）：
 *   jsdom 里能验的只有「滑杆渲染出来了（data-slot=slider）」；而「拖一下画布缩放变了没有」
 *   必须靠**真指针事件**。用户报障原话（2026-10-17，附一张放大到滑杆的截图）：
 *   「这里的滑轮用不了」—— 也就是拖滑杆没用。
 *
 * 契约（本脚本钉死的三条）：
 *   1. **跟手**：把滑杆 thumb 拖到轨道某个位置，百分比读数必须等于该位置的刻度值
 *      （轨道 5%..500% 线性映射），而不是"一动就到 500%"；
 *   2. **单调**：往右拖百分比变大、往左变小；
 *   3. **一致**：界面上写的 `NN%` 必须等于画布 `#canvas-viewport-content` 的真 transform scale。
 *   另外验证「点百分比按钮回 100%」与「聚焦 thumb 按方向键 ±5%」。
 *
 * 做法：headless Chrome + CDP（Node 22 自带 WebSocket，不引依赖）打开**正在跑的** DSH 页面，
 * 点侧边栏「无限画布」，再用 `Input.dispatchMouseEvent` 发真鼠标按下/移动/抬起去拖 thumb。
 *
 * 用法：node scripts/verify-live-zoom.mjs [baseUrl] [--keep]
 *   默认 baseUrl = http://127.0.0.1:19387 （桌面端）
 *   --keep 不删临时 Chrome 用户目录（排查用）
 *
 * 注意：这是**只读**验收 —— 只拖滑杆、点 100% 按钮，不改画布内容（缩放本身会写 canvas.json，
 * 但缩放是每个会话本来就随时在变的状态，不是内容）。
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
const DUMP = process.argv.includes('--dump');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9337);
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
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-zoom-'));
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

/** 轨道刻度：与 vendor 的 sliderViewport（0.05..5）一一对应。 */
const ZOOM_MIN_PERCENT = 5;
const ZOOM_MAX_PERCENT = 500;
/** 轨道位置比例 → 刻度值（百分比）。 */
const percentAt = (fraction) =>
  Math.round(ZOOM_MIN_PERCENT + (ZOOM_MAX_PERCENT - ZOOM_MIN_PERCENT) * fraction);

let page = null;
try {
  await devtoolsReady();
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

  /** 关掉 DSH 自己的首访模态框（它会盖住应用，真鼠标事件到不了滑杆）。 */
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

  const title = await waitFor('document.title || null', 30000);
  const booted = await waitFor(
    'Boolean(document.querySelector("[data-slot=\\"root\\"]") || document.querySelector("[data-dsh-panel-entry]"))',
    45000,
  );
  check('DSH 页面在外部浏览器里能打开', Boolean(title), String(title ?? '(none)'));
  check('界面已经启动（能看到面板入口）', Boolean(booted), String(booted));
  await dismissStartupDialogs();

  // ---------------------------------------------------------------- 打开画布面板
  const entryFound = await evaluate('Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))');
  check('侧边栏有「无限画布」入口', Boolean(entryFound));
  let zoomFound = false;

  if (entryFound) {
    /**
     * 点侧边栏「无限画布」。
     *
     * ⚠️ 只点一次不可靠（实测偶发：页面刚 hydrate 时点下去没有激活面板，主区还停在会话 Hero
     * 「探索未至之境」，`[data-dsh-aifisher-canvas]` 一个都查不到）。所以这里「点 → 等面板出现」
     * 循环三轮，每轮先确认面板锚点在不在，不在就再点一次。
     */
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
      if (!shell) {
        lines.push(`  第 ${attempt + 1} 次点「无限画布」没激活面板，重试`);
        await sleep(800);
      }
    }
    check('画布面板外壳挂上了', Boolean(shell));
    await sleep(2500);

    // ---------------------------------------------------------------- 从项目看板进画布视图
    //
    // 面板刚打开时 `view === 'dashboard'`（项目看板），缩放条只在 `view === 'canvas'` 才有。
    // 点项目卡片 / 表格行进入画布视图 —— 卡片是 `div.cursor-pointer`、表格是 `tr.cursor-pointer`，
    // 两种都试（「新建项目」那个方块也是 cursor-pointer，用「编辑于」把它排除掉）。
    const zoomReady = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 6000);
    if (!zoomReady) {
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
    const canvasView = await waitFor('Boolean(document.querySelector(\'[aria-label="画布缩放"]\'))', 60000);
    check('已经进入画布视图（缩放条出现在左下）', Boolean(canvasView));
    await sleep(800);

    // ---------------------------------------------------------------- 定位缩控件
    //
    // 读三条真几何：轨道（Radix 把轨道铺满 root 的可拖区）、thumb、百分比读数。
    // 百分比直接从缩放条文本里取（缩放条里唯一的文本就是 `NN%`）。
    const readZoom = () =>
      evaluate(`(() => {
        const bar = document.querySelector('[data-dsh-aifisher-canvas="shell"] [aria-label="画布缩放"]')?.parentElement;
        const root = document.querySelector('[data-dsh-aifisher-canvas="shell"] [aria-label="画布缩放"]');
        if (!bar || !root) return null;
        const label = String(bar.textContent || '').match(/(\\d+)\\s*%/);
        const thumb = root.querySelector('[data-slot="slider-thumb"]');
        const track = root.querySelector('[data-slot="slider-track"]');
        const layer = document.querySelector('[data-dsh-aifisher-canvas="shell"] #canvas-viewport-content');
        const scale = layer
          ? Number((String(layer.style.transform || '').match(/scale\\(([-\\d.]+)\\)/) || [])[1])
          : null;
        const trackRect = track?.getBoundingClientRect();
        const thumbRect = thumb?.getBoundingClientRect();
        return {
          percent: label ? Number(label[1]) : null,
          text: bar.textContent,
          scale: Number.isFinite(scale) ? scale : null,
          track: trackRect
            ? { left: Math.round(trackRect.left), right: Math.round(trackRect.right), width: Math.round(trackRect.width), top: Math.round(trackRect.top), height: Math.round(trackRect.height) }
            : null,
          thumb: thumbRect
            ? { center: Math.round(thumbRect.left + thumbRect.width / 2), top: Math.round(thumbRect.top + thumbRect.height / 2), width: Math.round(thumbRect.width) }
            : null,
        };
      })()`);

    const initial = await readZoom();
    zoomFound = Boolean(initial?.track && initial?.thumb && initial?.percent !== null);
    check('缩放条里的滑杆（aria-label=画布缩放）与 thumb 都在', zoomFound, JSON.stringify(initial?.thumb ?? null));
    if (!zoomFound) {
      const diagnosis = await evaluate(`(() => {
        const attrs = [...new Set([...document.querySelectorAll('[data-dsh-aifisher-canvas]')]
          .map((node) => node.getAttribute('data-dsh-aifisher-canvas')))];
        const sliderRoots = [...document.querySelectorAll('[data-slot="slider"]')].map((node) => ({
          aria: node.getAttribute('aria-label'),
          text: String(node.parentElement?.textContent || '').slice(0, 40),
          rect: (() => { const r = node.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
        }));
        const percentish = [...document.querySelectorAll('button')]
          .filter((node) => /^\\s*\\d+\\s*%\\s*$/.test(String(node.textContent || '')))
          .map((node) => ({ text: String(node.textContent).trim(), title: node.getAttribute('title') }));
        const canvasMount = document.querySelector('.af-canvas-mount');
        return { attrs, sliderRoots, percentish, mount: Boolean(canvasMount) };
      })()`);
      lines.push(`  诊断：${JSON.stringify(diagnosis)}`);
      const body = await evaluate('document.body.innerText.slice(0, 300)');
      lines.push(`  正文片段：${String(body).replace(/\s+/g, ' ')}`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = join(SHOTS, 'zoom-missing.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      lines.push(`  截图：${shotPath}`);
    }

    if (zoomFound) {
      lines.push(`  初始：${initial.percent}%  transform scale=${initial.scale}  轨道 ${JSON.stringify(initial.track)}  thumb ${JSON.stringify(initial.thumb)}`);

      /** 用 CDP 发真鼠标，把 thumb 从当前位置拖到轨道 `fraction` 处。 */
      const dragThumbTo = async (fraction, label) => {
        const before = await readZoom();
        const targetX = Math.round(before.track.left + before.track.width * fraction);
        const y = before.thumb.top;
        await page.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: before.thumb.center,
          y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        const steps = 8;
        for (let step = 1; step <= steps; step += 1) {
          const x = Math.round(before.thumb.center + ((targetX - before.thumb.center) * step) / steps);
          await page.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
            button: 'left',
            buttons: 1,
          });
          await sleep(16);
        }
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: targetX,
          y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        await sleep(260);
        const after = await readZoom();
        lines.push(`  ${label}：拖到轨道 ${Math.round(fraction * 100)}%（x=${targetX}）→ ${after.percent}%  thumb=${after.thumb?.center}`);
        return after;
      };

      // ① 跟手：拖到 25% 处，读数应≈129%（5..500 线性），而不是 500%
      const quarter = await dragThumbTo(0.25, '跟手 ①');
      const quarterExpected = percentAt(0.25);
      check(
        `拖到轨道 25% 的位置，百分比读数≈${quarterExpected}%（不是"一动就 500%"）`,
        Math.abs(quarter.percent - quarterExpected) <= 12,
        `实际 ${quarter.percent}%`,
      );
      check(
        '拖动时 thumb 跟着指针走（thumb 中心≈指针落点 ±4px）',
        Math.abs(quarter.thumb.center - Math.round(quarter.track.left + quarter.track.width * 0.25)) <= 4,
        `thumb=${quarter.thumb.center}`,
      );
      check(
        `百分比读数与画布真 transform scale 一致（${quarter.percent}% ↔ scale ${quarter.scale}）`,
        quarter.scale !== null && Math.abs(quarter.percent - Math.round(quarter.scale * 100)) <= 1,
      );

      // ② 单调：往右拖变大
      const far = await dragThumbTo(0.6, '跟手 ②');
      check(
        `再往右拖到轨道 60% → 百分比变大（≈${percentAt(0.6)}%）`,
        far.percent > quarter.percent && Math.abs(far.percent - percentAt(0.6)) <= 12,
        `${quarter.percent}% → ${far.percent}%`,
      );

      // ③ 单调：往左拖变小
      const near = await dragThumbTo(0.1, '跟手 ③');
      check(
        `再往左拖到轨道 10% → 百分比变小（≈${percentAt(0.1)}%）`,
        near.percent < far.percent && Math.abs(near.percent - percentAt(0.1)) <= 12,
        `${far.percent}% → ${near.percent}%`,
      );

      // ③.5 点轨道（不是拖 thumb）也要跳到位 —— Radix 把 pointerdown 挂在 Root 上
      const trackX = Math.round(near.track.left + near.track.width * 0.8);
      await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: trackX,
        y: near.thumb.top,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: trackX,
        y: near.thumb.top,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(260);
      const trackClick = await readZoom();
      check(
        `直接点轨道 80% 处也要跳到位（≈${percentAt(0.8)}%）`,
        Math.abs(trackClick.percent - percentAt(0.8)) <= 12,
        `实际 ${trackClick.percent}%`,
      );

      // ④ 点百分比按钮 → 回 100%
      const clicked = await evaluate(`(() => {
        const bar = document.querySelector('[data-dsh-aifisher-canvas="shell"] [aria-label="画布缩放"]')?.parentElement;
        const button = [...(bar?.querySelectorAll('button') ?? [])].find((node) => /^\\d+%$/.test(String(node.textContent || '').trim()));
        if (!button) return false;
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await sleep(260);
      const reset = await readZoom();
      check('点百分比按钮回到 100%',
        Boolean(clicked) && reset.percent === 100 && reset.scale !== null && Math.abs(reset.scale - 1) <= 0.011,
        `percent=${reset.percent} scale=${reset.scale}`);

      // ⑤ 键盘：聚焦 thumb 后按 ArrowRight → +5%（Radix 的键盘步进，无障碍可用）
      await page.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: reset.thumb.center,
        y: reset.thumb.top,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: reset.thumb.center,
        y: reset.thumb.top,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      await sleep(200);
      const focused = await evaluate(
        'document.activeElement?.getAttribute("data-slot") === "slider-thumb" || document.activeElement?.getAttribute("role") === "slider"',
      );
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await sleep(220);
      const keyed = await readZoom();
      check('聚焦 thumb 后按方向键 → 缩放按 5% 步进变化',
        Boolean(focused) && keyed.percent === reset.percent + 5,
        `focused=${focused} ${reset.percent}% → ${keyed.percent}%`);

      if (DUMP) {
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
        for (const line of consoleLines.slice(-20)) lines.push(`    ${line.slice(0, 300)}`);
      }

      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = join(SHOTS, 'zoom-live.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      lines.push(`  截图：${shotPath}`);
    }
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
