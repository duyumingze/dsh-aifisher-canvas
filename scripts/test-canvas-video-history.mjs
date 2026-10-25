/**
 * 「视频生成历史」回归（v1.64）。
 *
 * 用户原话（2026-10-23）：「仿照图像生成历史记录，做视频生成历史记录功能」。
 *
 * 参照物是图片节点早就有的那套：每次生成把结果**并进** `resultUrls`，节点头部一枚
 * `历史 N` 药丸，点开在节点周围扇形摊出前面那些（每张可下载 / 设为主图）。
 * 视频侧以前每生成一次就覆盖上一条，贵一点的片子重跑一次就永远找不回来了。
 *
 * 这个套件守两段：
 *   A. **纯逻辑**（构建产物 `canvasApp.mergeVideoResultHistory` 等）：
 *      合并去重 / 主结果永远置顶 / 上限 / 「设为主视频」换位时清掉上一帧与旧比例 /
 *      药丸文案（本次 / 历史）。
 *   B. **真 DOM**（jsdom 里真挂画布、真点按钮）：
 *      视频节点头部有药丸 → 点开摊出历史、每条都是真 `<video>` → 点「设为主视频」
 *      换的是节点数据（存盘后也是它）、旧历史一条不丢；顺手钉住图片节点那枚
 *      `历史 N` 还在（v1.64 把 renderHeader 挪进 previewProps，别把图片带坏）。
 *
 * 用法：node scripts/test-canvas-video-history.mjs   （需要先 build）
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasDom, mountCanvasApp, seedResume, settle, startHost } from './lib/canvas-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const lines = [];
let failures = 0;
const check = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  lines.push(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`);
};

async function waitFor(probe, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await probe();
    if (last) return last;
  }
  return last;
}

const PROJECT_ID = 'proj-canvas-video-history';
const MEDIA = (kind, file) => `/api/aifisher/canvas/media/${PROJECT_ID}/${kind}/${file}`;
const V1 = MEDIA('videos', 'history-1.mp4');
const V2 = MEDIA('videos', 'history-2.mp4');
const V3 = MEDIA('videos', 'history-3.mp4');
const I1 = MEDIA('images', 'history-a.png');
const I2 = MEDIA('images', 'history-b.png');

const host = await startHost();
{
  const videoNode = {
    id: 'video-host',
    type: 'Video',
    x: 0,
    y: 0,
    title: '视频历史验证',
    prompt: '一只在雨里跑的小狗',
    status: 'success',
    model: 'Seedance 2.5 Standard · API',
    videoModel: 'Seedance 2.5 Standard · API',
    resultUrl: V1,
    resultUrls: [V1, V2, V3],
    currentResultCount: 1,
    resultAspectRatio: '1920/1080',
    aspectRatio: '16:9',
    duration: 5,
    parentIds: [],
    projectId: PROJECT_ID,
    width: 320,
    height: 180,
  };
  const imageNode = {
    id: 'image-host',
    type: 'Image',
    x: 0,
    y: 420,
    title: '图片历史验证',
    prompt: '同一只小狗',
    status: 'success',
    model: 'GPT Image 2 · API',
    imageModel: 'GPT Image 2 · API',
    resultUrl: I1,
    resultUrls: [I1, I2],
    currentResultCount: 1,
    resultAspectRatio: '320/240',
    aspectRatio: '4:3',
    parentIds: [],
    projectId: PROJECT_ID,
    width: 320,
    height: 240,
  };
  const save = await host.hostApi('POST', '/workflows', {
    id: PROJECT_ID,
    revision: 0,
    title: '视频生成历史验证',
    nodes: [videoNode, imageNode],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  check('预置「一条视频带 3 条历史 + 一张图带 2 条历史」的项目', save.status === 200,
    String(save.text).slice(0, 120));
}

const { window } = await createCanvasDom({ dispatch: host.dispatch });
seedResume(window, PROJECT_ID);
const { canvasApp, handle } = await mountCanvasApp(window);
await settle(1500);
const doc = window.document;

// ---------------------------------------------------------------- A) 纯逻辑（跑构建产物）
{
  const {
    VIDEO_RESULT_HISTORY_LIMIT,
    mergeVideoResultHistory,
    promoteVideoResult,
    videoHistoryItems,
    videoHistoryLabel,
    videoCurrentResultCount,
    videoResultUrls,
  } = canvasApp;
  check('产物导出了视频生成历史的纯函数',
    [mergeVideoResultHistory, promoteVideoResult, videoHistoryLabel, videoResultUrls]
      .every((value) => typeof value === 'function'));
  check('历史上限是 12 条（不是图片那 20）',
    VIDEO_RESULT_HISTORY_LIMIT === 12, String(VIDEO_RESULT_HISTORY_LIMIT));

  const node = { resultUrl: 'a.mp4', resultUrls: ['a.mp4'] };
  const merged = mergeVideoResultHistory(node, ['b.mp4', 'c.mp4']);
  check('合并：新结果排最前，旧的那条接在后面',
    merged.resultUrl === 'b.mp4' &&
      JSON.stringify(merged.resultUrls) === JSON.stringify(['b.mp4', 'c.mp4', 'a.mp4']),
    JSON.stringify(merged));
  check('合并：currentResultCount 记的是本批条数（本次 2）', merged.currentResultCount === 2,
    String(merged.currentResultCount));

  const again = mergeVideoResultHistory({ resultUrl: 'a.mp4', resultUrls: ['a.mp4', 'b.mp4'] }, ['a.mp4']);
  check('合并：同一批重复回归的 URL 只留一条（不会越滚越长）',
    JSON.stringify(again.resultUrls) === JSON.stringify(['a.mp4', 'b.mp4']),
    JSON.stringify(again.resultUrls));

  const full = {
    resultUrl: 'u0.mp4',
    resultUrls: Array.from({ length: VIDEO_RESULT_HISTORY_LIMIT }, (_, index) => `u${index}.mp4`),
  };
  const capped = mergeVideoResultHistory(full, ['new.mp4']);
  check(`合并：超过上限（${VIDEO_RESULT_HISTORY_LIMIT} 条）就丢最旧的`,
    capped.resultUrls.length === VIDEO_RESULT_HISTORY_LIMIT &&
      capped.resultUrls[0] === 'new.mp4' &&
      !capped.resultUrls.includes('u11.mp4'),
    `${capped.resultUrls.length} 条 / 尾=${capped.resultUrls.at(-1)}`);

  const promoted = promoteVideoResult({ resultUrl: 'a.mp4', resultUrls: ['a.mp4', 'b.mp4', 'c.mp4'] }, 'c.mp4');
  check('换主视频：选中的那条到第一位，其余顺序不乱',
    promoted?.resultUrl === 'c.mp4' &&
      JSON.stringify(promoted?.resultUrls) === JSON.stringify(['c.mp4', 'b.mp4', 'a.mp4']),
    JSON.stringify(promoted));
  check('换主视频：清掉上一帧（lastFrame 是跟着上一条片子的）',
    promoted && 'lastFrame' in promoted && promoted.lastFrame === undefined,
    JSON.stringify(promoted?.lastFrame));
  check('换主视频：清掉旧片比例（新片加载完会重新量）',
    promoted && 'resultAspectRatio' in promoted && promoted.resultAspectRatio === undefined,
    JSON.stringify(promoted?.resultAspectRatio));
  check('换主视频：已经就是主视频 / 不在历史里 → 什么都不做',
    promoteVideoResult({ resultUrl: 'a.mp4', resultUrls: ['a.mp4', 'b.mp4'] }, 'a.mp4') === null &&
      promoteVideoResult({ resultUrl: 'a.mp4', resultUrls: ['a.mp4'] }, 'zz.mp4') === null);

  check('文案：本批 1 条 + 历史 3 条 →「本次 1 · 历史 3」',
    videoHistoryLabel({ resultUrls: [V1, V2, V3], currentResultCount: 1 }) === '本次 1 · 历史 3',
    videoHistoryLabel({ resultUrls: [V1, V2, V3], currentResultCount: 1 }));
  check('文案：本批把历史全占了 →「本次 2」',
    videoHistoryLabel({ resultUrls: [V1, V2], currentResultCount: 2 }) === '本次 2',
    videoHistoryLabel({ resultUrls: [V1, V2], currentResultCount: 2 }));
  check('文案：老数据没有 currentResultCount →「历史 N」',
    videoHistoryLabel({ resultUrls: [V1, V2] }) === '历史 2',
    videoHistoryLabel({ resultUrls: [V1, V2] }));
  check('老数据只有 resultUrl 时也能读成 1 条',
    JSON.stringify(videoResultUrls({ resultUrl: V1 })) === JSON.stringify([V1]) &&
      videoCurrentResultCount({ resultUrl: V1 }) === null);
  check('历史条目从第 2 条起算（主视频不在扇形里）',
    JSON.stringify(videoHistoryItems({ resultUrl: V1, resultUrls: [V1, V2, V3] })) ===
      JSON.stringify([{ url: V2, index: 1 }, { url: V3, index: 2 }]));

  // 组装层真的把桥挂出去了（vendor 那几处只认 window 上的桥；没挂就等于功能没接上）
  const bridge = window.__FISHERAI_VIDEO_RESULT_HISTORY__;
  check('装配层把桥挂到了 window（merge / promote / label 三个都在）',
    !!bridge && ['merge', 'promote', 'label', 'urls'].every((key) => typeof bridge[key] === 'function'),
    Object.keys(bridge ?? {}).join(','));
}

// 源码级：vendor 那三处接线不能在上游改写法时静默失效（构建期锚点会先报错，这里再钉一次产物）
{
  const generation = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/generation/canvasGeneration.ts'),
    'utf8',
  );
  const recovery = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/generation/generationRecovery.ts'),
    'utf8',
  );
  const cards = readFileSync(join(ROOT, 'vendor/aifisher/src/stable/nodes/canvasMediaCards.tsx'), 'utf8');
  const player = readFileSync(
    join(ROOT, 'vendor/aifisher/src/stable/media/canvasVideoPlayer.tsx'),
    'utf8',
  );
  check('vendor：视频生成成功时走历史合并（不是覆盖 resultUrls）',
    generation.includes('__FISHERAI_VIDEO_RESULT_HISTORY__') && generation.includes('mergeVideoHistory'));
  check('vendor：结果回收（刷新/断线）也给视频留历史',
    recovery.includes('mergeResultHistory(node, result.type') &&
      recovery.includes("result.type === 'video'"));
  check('vendor：视频卡的头部由播放器画（药丸才有地方放）',
    cards.includes('renderHeader: (historyControl: ReactTypes.ReactNode)') &&
      !cards.includes("{(kind !== 'Image' || !(props.isVisible ?? true))"));
  check('vendor：播放器里真的有药丸与「设为主视频」',
    player.includes('data-fisherai-video-history-indicator') && player.includes('设为主视频'));
}

// ---------------------------------------------------------------- B) 真 DOM：药丸 → 扇形 → 设为主视频
const videoCard = await waitFor(() => doc.querySelector('[data-node-id="video-host"]'));
check('画布上渲染出视频节点', !!videoCard);
const indicator = () => videoCard?.querySelector('[data-fisherai-video-history-indicator="true"]') ?? null;
const titleHeader = () => videoCard?.querySelector('[data-af-node-title]') ?? null;
const mainVideoSrc = () =>
  videoCard?.querySelector('[data-fisherai-video-streaming] video')?.getAttribute('src') ?? null;
const historyItems = () => [...(videoCard?.querySelectorAll('[data-fisherai-video-history]') ?? [])];

check('视频节点头部还在（历史药丸是加在标题那一行，不是把头部挤掉）', !!titleHeader(),
  titleHeader()?.textContent ?? '(missing)');
check('头部有「历史 N」药丸（与图片节点同款）', !!indicator(),
  indicator()?.textContent ?? `buttons=${videoCard?.querySelectorAll('button').length ?? 0}`);
check('药丸写着「历史 3」', (indicator()?.textContent ?? '').includes('历史 3'),
  indicator()?.textContent ?? '(missing)');
check('药丸的可读标签是「本次 1 · 历史 3」（同一份文案口径）',
  (indicator()?.getAttribute('aria-label') ?? '') === '本次 1 · 历史 3',
  indicator()?.getAttribute('aria-label') ?? '(missing)');
check('初始只摊着主视频一条（历史默认收起）', historyItems().length === 0,
  String(historyItems().length));

{
  indicator()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(400);
  const items = historyItems();
  check('点药丸 → 摊出 2 条历史', items.length === 2, String(items.length));
  check('摊出来的都是真 <video>（点开就能预览，不是缩略图占位）',
    items.every((item) => item.querySelector('video') !== null),
    items.map((item) => item.querySelector('video')?.tagName ?? 'none').join(','));
  check('历史条目的顺序是第 2、3 条（主视频之后那一串）',
    JSON.stringify(items.map((item) => item.getAttribute('data-fisherai-video-history'))) ===
      JSON.stringify([V2, V3]),
    JSON.stringify(items.map((item) => item.getAttribute('data-fisherai-video-history'))));
  check('每条历史都有「下载历史视频 N」与「设为主视频」',
    items.every(
      (item) =>
        item.querySelector('button[aria-label^="下载历史视频"]') !== null &&
        [...item.querySelectorAll('button')].some((button) => (button.textContent ?? '').includes('设为主视频')),
    ));
  check('药丸变成展开态（再点一次能收起来）',
    indicator()?.getAttribute('aria-expanded') === 'true',
    indicator()?.getAttribute('aria-expanded') ?? '(missing)');

  // 点第 3 条历史（V3）的「设为主视频」
  const target = items[1];
  const promoteButton = [...target.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('设为主视频'),
  );
  promoteButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle(600);
  check('点「设为主视频」→ 卡上换成那一条', mainVideoSrc() === V3, mainVideoSrc() ?? '(null)');
  check('换完之后扇形自动收起（摊着的是上一组历史）', historyItems().length === 0,
    String(historyItems().length));
  check('药丸还在、条数没变（换主视频不丢历史）',
    (indicator()?.textContent ?? '').includes('历史 3'), indicator()?.textContent ?? '(missing)');
}

// 存盘后节点数据就是换过的那条（刷新不会跳回去）
await settle(4200);
{
  const saved = await host.hostApi('GET', `/workflows/${PROJECT_ID}`);
  const savedNode = (saved.json().nodes ?? []).find((item) => item.id === 'video-host');
  check('存盘后主视频是换上去的那条', savedNode?.resultUrl === V3, savedNode?.resultUrl ?? '(missing)');
  check('存盘后三条历史一条不少（V3 在前，其余原样）',
    JSON.stringify(savedNode?.resultUrls) === JSON.stringify([V3, V2, V1]),
    JSON.stringify(savedNode?.resultUrls));
  check('存盘后上一帧 / 旧比例已清掉（不会拿上一条片子的帧当首尾帧）',
    savedNode?.lastFrame === undefined && savedNode?.resultAspectRatio === undefined,
    `lastFrame=${String(savedNode?.lastFrame).slice(0, 20)} ratio=${savedNode?.resultAspectRatio}`);
}

// ---------------------------------------------------------------- C) 图片那套不能被带坏
{
  const imageCard = doc.querySelector('[data-node-id="image-host"]');
  const imageIndicator = imageCard?.querySelector('[data-fisherai-result-stack-indicator="true"]') ?? null;
  check('图片节点的「历史 N」还在（v1.64 挪过 renderHeader，不能把它弄丢）', !!imageIndicator,
    imageIndicator?.textContent ?? '(missing)');
  check('图片药丸仍然写着「历史 2」', (imageIndicator?.textContent ?? '').includes('历史 2'),
    imageIndicator?.textContent ?? '(missing)');
}

// ---------------------------------------------------------------- D) 文档与 README 对得上（与其它套件同一条口径）
{
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  check('README 写了「生成历史」与「设为主视频」',
    readme.includes('生成历史') && readme.includes('设为主视频'));
  const usage = readFileSync(join(ROOT, '使用说明.md'), 'utf8');
  check('使用说明写清了「历史 N」怎么用（含 4.4 一节与设为主视频）',
    usage.includes('历史 N') && usage.includes('设为主视频') && usage.includes('4.4'));
  const dev = readFileSync(join(ROOT, 'README.dev.md'), 'utf8');
  check('README.dev 记了这轮改动（v1.64 视频生成历史 + 补丁 3.8w）',
    dev.includes('v1.64') && dev.includes('视频生成历史') && dev.includes('3.8w'));
}

// ---------------------------------------------------------------- E) 渲染期没有运行时错误
{
  const diag = await host.hostApi('GET', '/diagnostics?limit=50');
  const errors = (diag.json().entries ?? []).filter((entry) => entry.level === 'error');
  check('整轮没有运行时错误（视频历史没把画布弄崩）', errors.length === 0,
    errors.map((entry) => entry.message).join(' | ') || '(none)');
}

if (handle) {
  try {
    handle.dispose();
  } catch (error) {
    check('dispose 不抛错', false, String(error));
  }
}

const pass = lines.filter((line) => line.startsWith('PASS')).length;
lines.push('');
lines.push(`SUMMARY pass=${pass} fail=${failures}`);
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
