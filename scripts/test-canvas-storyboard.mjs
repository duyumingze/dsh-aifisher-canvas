/**
 * 画布助手 P1 · 轻量分镜板回归（v1.59）。
 *
 * 背景（路线图 P1）：「轻量分镜板：按镜头顺序排列/播放，不搬完整导演台」。
 *
 * 本套件验证：
 *   1. 镜头顺序 = 标题里的镜头号 → 坐标兜底；Text/Audio 不算镜头；
 *   2. 缩略图取 resultUrl / resultUrls[0]，没有画面时留空；
 *   3. 真画布：点「分镜」按钮出现面板，卡片顺序就是镜头顺序；
 *   4. 点「播放」进入播放态，1.5s 后自动前进到下一张；
 *   5. 关闭面板收起、按钮还在。
 *
 * 用法：node scripts/test-canvas-storyboard.mjs   （需要先 build）
 */
import { mountCanvasApp, createCanvasDom, seedResume, startHost, settle } from './lib/canvas-harness.mjs';
import { rmSync } from 'node:fs';

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

const host = await startHost();
const projectId = 'storyboard-proj';
{
  await host.hostApi('POST', '/workflows', {
    id: projectId,
    revision: 0,
    title: '分镜板验证',
    nodes: [
      { id: 'shot-c', type: 'Image', title: '镜头 3', x: 1200, y: 0, status: 'idle' },
      { id: 'shot-a', type: 'Image', title: '镜头 1', x: 0, y: 0, status: 'success', resultUrl: '/a.png' },
      { id: 'shot-b', type: 'Image', title: '镜头 2', x: 600, y: 0, status: 'error' },
      { id: 'text-1', type: 'Text', title: '剧本', x: -400, y: 0, textContent: '雨夜' },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

// 先建 DOM 再动态 import 画布产物：canvas-app.js 是浏览器 ESM，import 时就假定有 window。
const { window } = await createCanvasDom({ dispatch: host.dispatch });
const canvasApp = await import('../lib/canvas/canvas-app.js');
const { buildStoryboardShots, storyboardNumber } = canvasApp;

// ---------------------------------------------------------------- 1. 纯逻辑：解析与排序

{
  check('「镜头 2」→ 2', storyboardNumber('镜头 2') === 2, String(storyboardNumber('镜头 2')));
  check('「分镜03」→ 3', storyboardNumber('分镜03') === 3, String(storyboardNumber('分镜03')));
  check('「1920x1080」→ null', storyboardNumber('1920x1080') === null, String(storyboardNumber('1920x1080')));

  const shots = buildStoryboardShots([
    { id: 's3', type: 'Video', title: '镜头 3', x: 0, y: 0, resultUrls: ['/v.mp4'] },
    { id: 's1', type: 'Image', title: '镜头 1', x: 900, y: 900, resultUrl: '/a.png' },
    { id: 's2', type: 'Image', title: '镜头 2', x: 500, y: 500 },
    { id: 't', type: 'Text', title: '剧本', textContent: '…' },
    { id: 'audio', type: 'Audio', title: 'BGM' },
  ]);
  check(
    '按镜头号排序、Text/Audio 不进分镜板',
    JSON.stringify(shots.map((shot) => shot.id)) === JSON.stringify(['s1', 's2', 's3']),
    JSON.stringify(shots.map((shot) => shot.id)),
  );
  check(
    '缩略图取 resultUrl / resultUrls[0]',
    shots[0]?.thumb === '/a.png' && shots[2]?.thumb === '/v.mp4',
    JSON.stringify(shots.map((shot) => shot.thumb)),
  );
  check('没有画面的镜头 thumb 为空串', shots[1]?.thumb === '', JSON.stringify(shots[1]?.thumb));
}

// ---------------------------------------------------------------- 2. 真画布

seedResume(window, projectId);
const { handle } = await mountCanvasApp(window);
await settle(1600);

{
  const toggle = window.document.querySelector('[data-fisherai-storyboard-toggle="true"]');
  check(
    '画布底部出现「分镜」按钮（带镜头数）',
    Boolean(toggle) && String(toggle.textContent).includes('分镜'),
    String(toggle?.textContent ?? '(没有按钮)').slice(0, 60),
  );

  toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(200);
  const panel = window.document.querySelector('[data-fisherai-storyboard="true"]');
  check('点按钮打开分镜板', Boolean(panel), '');
  const cards = [...(panel?.querySelectorAll('[data-fisherai-storyboard-shot]') ?? [])];
  check(
    '分镜板按镜头顺序列出 3 张（Text 不进去）',
    cards.length === 3 &&
      JSON.stringify(cards.map((card) => card.getAttribute('data-fisherai-storyboard-shot'))) ===
        JSON.stringify(['shot-a', 'shot-b', 'shot-c']),
    JSON.stringify(cards.map((card) => card.getAttribute('data-fisherai-storyboard-shot'))),
  );
  check(
    '卡片带序号与缩略图',
    String(cards[0]?.textContent ?? '').includes('1') && Boolean(cards[0]?.querySelector('img')),
    String(cards[0]?.textContent ?? '').slice(0, 60),
  );

  const play = [...(panel?.querySelectorAll('button') ?? [])].find((button) =>
    String(button.textContent).includes('播放'),
  );
  play?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(200);
  check(
    '点播放进入播放态',
    panel?.getAttribute('data-fisherai-storyboard-playing') === 'true',
    String(panel?.getAttribute('data-fisherai-storyboard-playing')),
  );

  await settle(1800);
  check(
    '播放会自动前进到下一张（当前 2）',
    String(panel?.textContent ?? '').includes('当前 2'),
    String(panel?.textContent ?? '').slice(0, 120),
  );

  const close = [...(panel?.querySelectorAll('button') ?? [])].find(
    (button) => button.getAttribute('aria-label') === '关闭分镜板',
  );
  close?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(150);
  check(
    '关闭分镜板后面板消失（按钮还在）',
    window.document.querySelector('[data-fisherai-storyboard="true"]') === null &&
      Boolean(window.document.querySelector('[data-fisherai-storyboard-toggle="true"]')),
    '',
  );

  try {
    handle.dispose();
  } catch {
    /* 卸载失败不影响结论 */
  }
}

rmSync(host.fakeHome, { recursive: true, force: true });

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
