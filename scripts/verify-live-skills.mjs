/**
 * 真机验收：**在画布里能不能正常用技能**（2026-10-18，用户原话
 * 「检查一下我是否能在画布正常使用skill技能，与画布进行协作」）。
 *
 * 为什么必须真机：这条链上的每一环都只存在于**真 DSH 内核 + 真浏览器**里 ——
 *   1. 画布右侧会话栏渲染的是内核原生会话（`conversation.content` 的 embedded occurrence），
 *      它的 composer 工具行是不是照样渲染 `conversation.input.right` 槽位（技能按钮就注册在那里），
 *      jsdom 里根本没有这套槽位渲染器；
 *   2. 技能按钮点开后列出的技能来自 host 半的扫描（`$DSH_HOME/skills` …），
 *      列表内容只有真机才看得到；
 *   3. 「与画布协作」＝同一个会话里 `canvas_control` 能操作画布，这一条靠 Agent 侧的
 *      canvas_control:skills / skillLoad 两个动作 + 画布 read 验证（脚本里也验 API 那一层）。
 *
 * 做法：headless Chrome + CDP 打开**正在跑的** DSH 页面 → 点侧边栏「无限画布」→
 * 在右侧会话栏里验技能按钮/技能列表 → 截图。
 * 另外直接打 host 的两个技能端点，确认「画布侧技能目录」能看到用户自己的技能。
 *
 * 用法：node scripts/verify-live-skills.mjs [baseUrl] [--keep]
 *   默认 baseUrl = http://127.0.0.1:19387 （桌面端）
 *   --keep 不删临时 Chrome 用户目录
 *
 * 只读验收：只点面板/按钮，**不发消息、不改画布内容**。
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installAuthCookie, localAuthCookie } from './lib/dsh-live-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:19387';
const KEEP = process.argv.includes('--keep');
const DUMP = process.argv.includes('--dump');
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9335);
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
const info = (text) => lines.push(`INFO  ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error('找不到 Chrome/Edge，跳过真机验收。');
  process.exit(0);
}

mkdirSync(SHOTS, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'dsh-live-skills-'));
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

// ---------------------------------------------------------------- 第一步：host 端点

lines.push('── 画布侧技能目录（host 端点 / 运行中的 DSH）──');
lines.push('  说明：这一段打的是**正在跑的 DSH 进程**。v1.44 改的是 host 半 → 没重启 DSH 之前这三条必然红，');
lines.push('        重启后应转绿；不想等重启就看下面那段「磁盘构建 + 真技能目录」。');
const SKILLS_URL = `${BASE}/api/aifisher/skills`;
let apiSkills = [];
try {
  const response = await fetch(SKILLS_URL);
  const body = await response.json();
  apiSkills = Array.isArray(body.skills) ? body.skills : [];
  check('GET /api/aifisher/skills 200', response.ok, String(response.status));
  check(
    '画布侧技能目录能看到用户自己的技能（≥10 条，不是只剩 bundled）',
    apiSkills.length >= 10,
    `count=${apiSkills.length} names=${apiSkills.map((s) => s.name).join(',')}`,
  );
  const sample = apiSkills.find((s) => s.name === 'image-prompt-generator');
  check('目录里含用户技能 image-prompt-generator', Boolean(sample), JSON.stringify(sample ?? null));
  if (sample) {
    const single = await fetch(`${SKILLS_URL}/${sample.name}`);
    const detail = await single.json().catch(() => ({}));
    check(
      'GET /api/aifisher/skills/:name 能拿到完整正文（skillLoad 同一份实现）',
      single.ok && typeof detail.skill?.content === 'string' && detail.skill.content.length > 200,
      `${single.status} len=${detail.skill?.content?.length ?? 0}`,
    );
  }
} catch (error) {
  check('GET /api/aifisher/skills 可用', false, error.message);
}

// ---------------------------------------------------------------- 第一步之二：构建产物 + 真技能数据
//
// 上面的端点打的是**运行中的 DSH**：host 半改了必须重启 DSH 才会变。所以这里再单独跑一遍
// 「磁盘上刚构建出来的那份 host 代码」+ **真的技能目录**（临时 DSH_HOME，`skills` 是指向
// 真目录的 junction），这样「修好了没有」当场就有结论，不用等重启。

lines.push('');
lines.push('── 画布侧技能目录（磁盘构建 + 真技能目录）──');
{
  const realSkillsDir = join(process.env.DSH_HOME ?? join(tmpdir(), 'none'), 'skills');
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-skills-probe-'));
  const restoreEnv = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  try {
    mkdirSync(tempHome, { recursive: true });
    if (existsSync(realSkillsDir)) {
      // junction 不需要管理员权限（Windows 上 symlink 需要）；扫盘会跟随链接。
      symlinkSync(realSkillsDir, join(tempHome, 'skills'), 'junction');
    } else {
      mkdirSync(join(tempHome, 'skills'), { recursive: true });
    }
    process.env.DSH_HOME = tempHome;
    process.env.DSH_AGENTS_HOME = join(tempHome, 'agents-home');

    const routes = new Map();
    class FakeResponse extends Writable {
      constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.chunks = [];
      }
      writeHead(status, headers) {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
        return this;
      }
      _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      }
      text() {
        return Buffer.concat(this.chunks).toString('utf8');
      }
    }
    const hostMod = await import(
      `${pathToFileURL(join(ROOT, 'lib/index.js')).href}?skills-probe=${Date.now()}`
    );
    hostMod.apply({
      get(name) {
        if (name === 'webServer') {
          return {
            register(route) {
              routes.set(route.path, route);
              return () => routes.delete(route.path);
            },
          };
        }
        // 只回 bundled 层 —— 真机 host 上下文里就是这个形状（文件系统 provider 在 agent 作用域）
        if (name === 'skills') {
          return { list: async () => [], get: async () => undefined };
        }
        return undefined;
      },
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: () => () => {} },
    });
    const route = routes.get('/api/aifisher/skills');
    const call = async (path) => {
      const res = new FakeResponse();
      const req = Readable.from([]);
      req.method = 'GET';
      req.url = `/api/aifisher/skills${path}`;
      req.headers = {};
      await route.handler(req, res);
      if (!res.writableFinished) await new Promise((r) => res.once('finish', r));
      return res;
    };
    const list = await call('');
    const body = JSON.parse(list.text());
    const names = (body.skills ?? []).map((s) => s.name);
    check(
      '磁盘构建的 host 代码：列表扫到真技能目录里的用户技能（≥10 条）',
      list.statusCode === 200 && names.length >= 10,
      `count=${names.length} ${names.slice(0, 12).join(',')}`,
    );
    const one = await call('/image-prompt-generator');
    const detail = JSON.parse(one.text());
    check(
      '磁盘构建的 host 代码：skillLoad 能读到真 SKILL.md 正文',
      one.statusCode === 200 && (detail.skill?.content?.length ?? 0) > 200,
      `${one.statusCode} len=${detail.skill?.content?.length ?? 0}`,
    );
  } catch (error) {
    check('磁盘构建的 host 代码：技能目录探针跑通', false, error.message);
  } finally {
    if (restoreEnv.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = restoreEnv.DSH_HOME;
    if (restoreEnv.DSH_AGENTS_HOME === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = restoreEnv.DSH_AGENTS_HOME;
    try {
      // junction 只删**链接本身**，绝不 recursive（递归删链接在 Windows 上可能穿透到真目录，
      // 那会把用户真技能删掉）：先 unlink，不行再 rmdir（Windows 上目录型 reparse point 走 rmdir）。
      const link = join(tempHome, 'skills');
      try {
        unlinkSync(link);
      } catch {
        try {
          rmdirSync(link);
        } catch {
          /* 没建成或已经删了 */
        }
      }
    } catch {
      /* 删不掉不影响结论 */
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 第二步：真机页面

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
  else lines.push('  警告：没有拿到本机授权 cookie');
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

  const dismissStartupDialogs = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await evaluate(`(() => {
        const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
          .find((node) => node.getBoundingClientRect().width > 0);
        if (!dialog) return null;
        const buttons = [...dialog.querySelectorAll('button')];
        const primary = buttons.find((b) => String(b.className).includes('_primary_')) ?? buttons[buttons.length - 1];
        primary?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return (primary?.innerText || '').trim();
      })()`);
      if (!result) return true;
      await sleep(500);
    }
    return true;
  };

  const booted = await waitFor('Boolean(document.querySelector("[data-dsh-panel-entry=\\"aifisher-canvas\\"]"))', 45000);
  check('DSH 页面在外部浏览器里能打开（侧边栏出现「无限画布」入口）', Boolean(booted), String(booted));
  await dismissStartupDialogs();

  if (booted) {
    await evaluate(`(() => {
      const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
      const clickable = icon.closest('button, [role="button"], a, li') ?? icon;
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    const shell = await waitFor('Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))', 45000);
    check('画布面板打开（main key=aifisher-canvas 生效）', Boolean(shell));
    await sleep(2500);

    const dock = await evaluate('Boolean(document.querySelector("[data-dsh-aifisher-chat=\\"dock\\"]"))');
    check('右侧会话栏（dock）渲染出来了', Boolean(dock));

    /**
     * 会话栏渲染的是「当前选中的会话」；headless 里全新 profile 打开时没有选中会话，
     * dock 只有一句「未选择会话」提示（没有 composer，也就没有技能按钮）。
     * 所以先像用户一样在侧边栏点一条会话，再点回画布面板 —— 顺序不能反：
     * 点会话会让主区回到 Conversation，画布面板会被卸载。
     */
    const selectSession = async () => {
      const hasConversation = () =>
        evaluate('Boolean(document.querySelector("[data-dsh-aifisher-chat=\\"dock\\"] [data-conversation-content]"))');
      if (await hasConversation()) return true;
      let rowKey = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
        const row = rows.find((candidate) => !/新会话|New chat/i.test(candidate.innerText));
        return row ? row.getAttribute('data-row-key') : null;
      })()`);
      for (let attempt = 0; !rowKey && attempt < 6; attempt += 1) {
        if (attempt === 2) {
          await evaluate(`(() => {
            const row = document.querySelector('[data-row-key^="workspace:"]');
            if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
          })()`);
        }
        await sleep(900);
        rowKey = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
          const row = rows.find((candidate) => !/新会话|New chat/i.test(candidate.innerText));
          return row ? row.getAttribute('data-row-key') : null;
        })()`);
      }
      if (!rowKey) return false;
      await evaluate(`(() => {
        const row = document.querySelector('[data-row-key="${rowKey}"]');
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await sleep(2500);
      // 回到画布面板
      await evaluate(`(() => {
        const icon = document.querySelector('[data-dsh-panel-entry="aifisher-canvas"]');
        (icon.closest('button, [role="button"], a, li') ?? icon)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      await waitFor('Boolean(document.querySelector("[data-dsh-aifisher-canvas=\\"shell\\"]"))', 30000);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await hasConversation()) return true;
        await sleep(700);
      }
      return false;
    };
    const sessionReady = await selectSession();
    check('会话栏里是内核原生会话正文（选中一条会话后）', sessionReady === true, String(sessionReady));

    /** 画布会话栏输入框里当前的文字（没有输入框就空串）。 */
    const readComposerText = () =>
      evaluate(`(() => {
        const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
        const editable = dock?.querySelector('[contenteditable="true"]');
        return editable ? (editable.innerText || editable.textContent || '').trim() : '';
      })()`);

    /**
     * 清空画布会话栏的输入框。
     *
     * ⚠️ 不要用 `document.execCommand('selectAll')`：在 contenteditable 里它有时选中的是
     * **整个文档**，delete 不一定删掉输入框里的字（真机踩过：探针跑完留下 `//image-prompt-generator`
     * 这种草稿）。这里两级：① 自己建一个只覆盖 editable 的 Range 删；② 还剩下就补一次
     * 「全选 + 退格」的真键盘事件（走 CDP，等于用户自己按），并把清空后的文本回给调用方。
     */
    const clearComposer = async () => {
      await evaluate(`(() => {
        const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
        const editable = dock?.querySelector('[contenteditable="true"]');
        if (!editable) return false;
        editable.focus();
        const range = document.createRange();
        range.selectNodeContents(editable);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete', false, null);
        editable.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      let left = await readComposerText();
      if (left !== '') {
        await page.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
          code: 'KeyA',
          key: 'a',
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          modifiers: 2,
          windowsVirtualKeyCode: 65,
          code: 'KeyA',
          key: 'a',
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          windowsVirtualKeyCode: 8,
          code: 'Backspace',
          key: 'Backspace',
        });
        await page.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          windowsVirtualKeyCode: 8,
          code: 'Backspace',
          key: 'Backspace',
        });
        await sleep(300);
        left = await readComposerText();
      }
      return left;
    };

    // ------------------------------------------------ 技能按钮是否出现在画布会话栏里
    const picker = await evaluate(`(() => {
      const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
      const box = dock?.querySelector('[data-dsh-skill-picker="1"]');
      const button = box?.querySelector('button[aria-label="选择技能"]') ?? null;
      if (!dock) return { stage: 'no-dock' };
      if (!box || !button) return { stage: 'no-picker', dockText: (dock.innerText || '').slice(0, 160) };
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        stage: 'ok',
        inDock: dock.contains(button),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        visible: rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden',
        title: button.getAttribute('title') ?? '',
      };
    })()`);
    check(
      '画布会话栏的 composer 工具行里有技能按钮（与主对话同一个槽位 conversation.input.right）',
      picker.stage === 'ok' && picker.inDock === true && picker.visible === true,
      JSON.stringify(picker),
    );

    // 真点技能按钮 → 技能面板 → 列出技能
    let picked = null;
    if (picker.stage === 'ok') {
      await evaluate(`(() => {
        const button = document.querySelector('[data-dsh-aifisher-chat="dock"] button[aria-label="选择技能"]');
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`);
      const panelOpen = await waitFor(
        'Boolean(document.querySelector(\'input[placeholder^="搜索技能"]\'))',
        8000,
      );
      check('点技能按钮后技能面板打开（搜索框出现）', Boolean(panelOpen));

      if (panelOpen) {
        // 面板先渲染「加载中…」，技能列表是异步取回来的：轮询到真的有行为止
        // （第一版没等，读到 0 条假红过一次）。
        let listed = { count: 0, names: [], status: '' };
        for (let attempt = 0; attempt < 20; attempt += 1) {
          listed = await evaluate(`(() => {
            const box = document.querySelector('[data-dsh-skill-picker="1"]');
            const rows = [...(box?.querySelectorAll('button') ?? [])]
              .map((b) => (b.innerText || '').trim().split('\\n')[0])
              .filter((text) => text.startsWith('/'));
            return {
              count: rows.length,
              names: rows.map((text) => text.replace(/^\\//, '')),
              status: (box?.innerText || '').split('\\n').slice(0, 3).join(' | '),
            };
          })()`);
          if (listed.count > 0) break;
          await sleep(400);
        }
        info(`技能面板列出 ${listed.count} 条：${listed.names.slice(0, 12).join(', ')}${listed.count > 12 ? ', …' : ''}`);
        check(
          '面板里能看到用户自己的技能（≥10 条，含 image-prompt-generator）',
          listed.count >= 10 && listed.names.includes('image-prompt-generator'),
          `count=${listed.count} status=${listed.status}`,
        );
        picked = listed;

        // 面板开着时截图（交付图 / 取证图）
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        const shotPath = join(SHOTS, 'skills-live.png');
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        try {
          mkdirSync(join(ROOT, 'docs', 'shots'), { recursive: true });
          writeFileSync(join(ROOT, 'docs', 'shots', 'canvas-skills.png'), Buffer.from(shot.data, 'base64'));
        } catch {
          /* 交付图写不进去不影响结论 */
        }
        lines.push(`  截图：${shotPath}（交付图另存 docs/shots/canvas-skills.png）`);

        // 选一个技能 → 应当把 `/技能名` 插进画布会话栏的输入框（不发送）
        const inserted = await evaluate(`(() => {
          const box = document.querySelector('[data-dsh-skill-picker="1"]');
          const row = [...(box?.querySelectorAll('button') ?? [])]
            .find((b) => (b.innerText || '').trim().startsWith('/image-prompt-generator'));
          if (!row) return { ok: false, reason: 'row-missing' };
          row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true };
        })()`);
        await sleep(600);
        const composerText = await evaluate(`(() => {
          const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
          const editable = dock?.querySelector('[contenteditable="true"]');
          return editable ? (editable.innerText || editable.textContent || '').trim() : '(no composer)';
        })()`);
        check(
          '点选技能后 `/技能名` 落进画布会话栏的输入框（不发送，只验插入）',
          inserted.ok === true && String(composerText).includes('/image-prompt-generator'),
          `composer="${String(composerText).slice(0, 80)}"`,
        );
        // 插入后的取证图：画布 + 会话栏输入框里的 `/image-prompt-generator`
        const insertedShot = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(SHOTS, 'skills-live-inserted.png'), Buffer.from(insertedShot.data, 'base64'));
        try {
          writeFileSync(join(ROOT, 'docs', 'shots', 'canvas-skills-inserted.png'), Buffer.from(insertedShot.data, 'base64'));
        } catch {
          /* 同上 */
        }
        // 清掉刚插入的手势，别把草稿留在输入框里（只读验收）
        await clearComposer();
        await evaluate(`(() => {
          document.querySelector('[data-dsh-aifisher-chat="dock"] button[aria-label="选择技能"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        })()`);
      }
    }

    // ------------------------------------------------ 手打 `/` 的手势在画布会话栏里认不认
    //
    // 技能按钮那条路已经验过；这条验的是「不用按钮、直接在画布输入框里打 `/技能名`」——
    // 也就是内核自己的 inputTriggers（官方 `/` 菜单）在画布这个 embedded composer 里
    // 有没有被接上。只读：打一个 `/`、读菜单、清掉，不发送。
    const slashMenu = await evaluate(`(() => {
      const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
      const editable = dock?.querySelector('[contenteditable="true"]');
      if (!editable) return { stage: 'no-composer' };
      editable.focus();
      const before = new Set([...document.querySelectorAll('body *')]);
      document.execCommand('insertText', false, '/');
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      return { stage: 'typed', added: 0, before: before.size };
    })()`);
    if (slashMenu?.stage === 'typed') {
      await sleep(1200);
      const menu = await evaluate(`(() => {
        const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
        const candidates = [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"]')]
          .filter((node) => node.getBoundingClientRect().height > 4);
        const rows = candidates.flatMap((node) =>
          [...node.querySelectorAll('[role="option"], [role="menuitem"], li, button')].map((row) =>
            (row.innerText || '').trim().split('\\n')[0],
          ),
        );
        return {
          menus: candidates.length,
          rows: rows.filter((text) => text.length > 0).slice(0, 24),
          composerText: (dock?.querySelector('[contenteditable="true"]')?.textContent || '').slice(0, 40),
        };
      })()`);
      const skillRows = (menu.rows ?? []).map((text) => String(text).trim().replace(/^\/+/, ''));
      info(
        `手打 «/» 后的候选菜单：menus=${menu.menus} rows=${(menu.rows ?? []).length} 前几条=${skillRows.slice(0, 6).join(' | ')}`,
      );
      check(
        '手打 «/» 能在画布会话栏里唤起技能候选（内核 inputTriggers 在 embedded composer 里也生效）',
        skillRows.includes('image-prompt-generator'),
        `rows=${(menu.rows ?? []).length} composer="${menu.composerText ?? ''}"`,
      );
      // 清掉刚打的 `/`，别把草稿留在输入框里
      await clearComposer();
    }

    // 只读验收的收尾：输入框必须是空的（否则这次探针会在别人会话里留草稿）
    const composerLeft = await evaluate(`(() => {
      const dock = document.querySelector('[data-dsh-aifisher-chat="dock"]');
      const editable = dock?.querySelector('[contenteditable="true"]');
      if (!editable) return { text: '', html: '(no editable)' };
      return {
        text: (editable.innerText || editable.textContent || '').trim(),
        html: editable.tagName + '.' + String(editable.className || '').slice(0, 60) + ' inner=' + editable.innerHTML.slice(0, 120),
      };
    })()`);
    check(
      '探针收尾：画布会话栏的输入框已清空（没在用户会话里留草稿）',
      composerLeft.text === '',
      `left="${String(composerLeft.text).slice(0, 60)}" ${DUMP ? composerLeft.html : ''}`,
    );

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
      lines.push('  ── 控制台（末 20 条）──');
      for (const line of consoleLines.slice(-20)) lines.push(`    ${line.slice(0, 260)}`);
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